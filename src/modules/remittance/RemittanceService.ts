import { and, desc, eq } from 'drizzle-orm';

import { loadEnv } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import {
  auditEvents,
  paymentEvents,
  quotes,
  remittances,
  sepTransactions,
  sorobanTransactions,
  stellarAccounts,
  stellarTransactions,
  type Remittance,
} from '../../db/schema.js';
import { fromStroops, toStroops } from '../../lib/amounts.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import type { QuoteService } from '../quotes/QuoteService.js';
import type { SorobanService, ContractCommitment, Signer } from '../soroban/SorobanService.js';
import type { NormalizedPayment } from '../horizon/payments.js';
import {
  canTransition,
  isRemittanceStatus,
  type LifecyclePhase,
  type RemittanceStatus,
} from './state.js';

export const MAX_CONTRACT_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface CreateRemittanceInput {
  quoteId: string;
  senderAccountId: string;
  /** Off-chain destination identifier (phone / bank / wallet id). */
  recipientAddress: string;
  /** Stellar account that receives the released escrow (release pays this). */
  recipientStellarAccount: string;
  anchorId?: string;
  corridor?: string;
}

export interface RemittanceService {
  create(input: CreateRemittanceInput, userId: string): Promise<Record<string, unknown>>;
  fund(id: string, userId: string): Promise<Record<string, unknown>>;
  /** Oracle: move a funded remittance into corridor processing. */
  beginProcessing(id: string): Promise<void>;
  /** Oracle: attest settlement + release escrow. Called when the anchor completes. */
  authorizeAndRelease(id: string): Promise<Record<string, unknown>>;
  release(id: string, userId: string): Promise<Record<string, unknown>>;
  refund(id: string, userId: string): Promise<Record<string, unknown>>;
  get(id: string, userId: string): Promise<Record<string, unknown>>;
  events(id: string, userId: string): Promise<unknown[]>;
  /**
   * Non-custodial path: the app signed and submitted a Soroban transaction.
   * Confirms execution, then reconciles the created remittance id by reading
   * back the latest contract record and matching the quote hash.
   */
  confirmSorobanSubmission(
    id: string,
    input: { txHash: string; method: 'create_remittance' | 'fund_remittance' },
    userId: string,
  ): Promise<void>;
  /** Called by the anchor-transfer routes once a SEP transaction exists. */
  onAnchorTransferStarted(id: string): Promise<void>;
  /** Called by the payment streamer/reconciler for every new normalized event. */
  applyPaymentEvent(remittanceId: string, event: NormalizedPayment): Promise<void>;
  onAnchorStatus(id: string, anchorStatus: string): Promise<void>;
}

function asRemittanceStatus(value: string) {
  return isRemittanceStatus(value) ? value : 'CREATED';
}

export function createRemittanceService(
  db: Db,
  quotesService: QuoteService,
  soroban: SorobanService,
): RemittanceService {
  const env = loadEnv();

  function assertOwner(r: Remittance, userId: string): void {
    if (r.sender_user_id && r.sender_user_id !== userId) {
      throw forbidden('Not the owner of this remittance');
    }
  }

  async function loadOwned(id: string, userId: string): Promise<Remittance> {
    const rows = await db.select().from(remittances).where(eq(remittances.id, id)).limit(1);
    if (rows.length === 0) {
      throw notFound('Remittance not found');
    }
    const r = rows[0]!;
    assertOwner(r, userId);
    return r;
  }

  async function loadSenderAccount(accountId: string, userId: string) {
    const rows = await db
      .select()
      .from(stellarAccounts)
      .where(and(eq(stellarAccounts.id, accountId), eq(stellarAccounts.user_id, userId)))
      .limit(1);
    if (rows.length === 0) {
      throw notFound('Sender Stellar account not found');
    }
    return rows[0]!;
  }

  /**
   * Transition a remittance, validating against the *current* persisted state
   * (not a possibly-stale in-memory row) so chained transitions within one
   * request work correctly.
   */
  async function setState(
    id: string,
    status: RemittanceStatus,
    lifecycle: LifecyclePhase,
    extra: Partial<Remittance> = {},
  ): Promise<void> {
    const rows = await db
      .select({ status: remittances.status, settled_at: remittances.settled_at })
      .from(remittances)
      .where(eq(remittances.id, id))
      .limit(1);
    if (rows.length === 0) {
      throw notFound('Remittance not found');
    }
    const current = rows[0]!;
    if (!canTransition(asRemittanceStatus(current.status), status)) {
      throw conflict(`Invalid state transition ${current.status} -> ${status}`);
    }
    await db
      .update(remittances)
      .set({
        status,
        lifecycle,
        settled_at:
          status === 'RELEASED' || status === 'REFUNDED' ? new Date() : current.settled_at,
        updated_at: new Date(),
        ...extra,
      })
      .where(eq(remittances.id, id));
  }

  function commitmentFor(r: Remittance, quote: { quoteHash: string }): ContractCommitment {
    return {
      sender: '', // filled in by callers with the actual public key
      recipient: r.recipient_stellar_account!,
      sourceAsset: r.source_asset,
      sourceAmountStroops: r.source_amount_stroops,
      destinationAsset: r.destination_asset.split(':')[0]!,
      expectedDestinationAmountStroops: r.expected_destination_amount_stroops,
      corridor: r.corridor,
      quoteHash: quote.quoteHash,
      expiry: Math.floor(r.expiry.getTime() / 1000),
    };
  }

  async function senderSigner(r: Remittance, userId: string): Promise<Signer | null> {
    if (!r.sender_account_id) {
      return null;
    }
    const account = await loadSenderAccount(r.sender_account_id, userId);
    if (!account.secret_encrypted) {
      return null; // non-custodial — caller signs in-app
    }
    return { publicKey: account.public_key, secretEncrypted: account.secret_encrypted };
  }

  return {
    async create(input, userId) {
      const quote = await quotesService.assertUsable(input.quoteId, {
        sourceAsset: undefined,
        destinationAsset: undefined,
        sourceAmount: undefined,
      });
      const account = await loadSenderAccount(input.senderAccountId, userId);
      if (input.recipientStellarAccount === account.public_key) {
        throw badRequest('Recipient must differ from sender');
      }
      const corridor =
        input.corridor ??
        `${quote.sourceCountry ?? 'XX'}/${quote.destinationCountry ?? 'XX'}`;
      const expiry = new Date(
        Math.min(quote.expiresAt.getTime(), Date.now() + MAX_CONTRACT_TTL_SECONDS * 1000),
      );

      const inserted = await db
        .insert(remittances)
        .values({
          quote_id: input.quoteId,
          sender_user_id: userId,
          sender_account_id: input.senderAccountId,
          recipient_address: input.recipientAddress,
          recipient_stellar_account: input.recipientStellarAccount,
          source_asset: quote.sourceAsset,
          source_amount_stroops: quote.sourceAmountStroops,
          destination_asset: quote.destinationAsset,
          expected_destination_amount_stroops: quote.destinationAmountStroops,
          corridor,
          quote_hash: quote.quoteHash,
          anchor_id: input.anchorId ?? null,
          status: 'CREATED',
          lifecycle: 'QUOTE_CREATED',
          contract_id: env.CONTRACT_ID ?? null,
          expiry,
        })
        .returning();

      const r = inserted[0]!;
      await db.insert(auditEvents).values({
        actor_id: userId,
        action: 'remittance.create',
        resource_type: 'remittance',
        resource_id: r.id,
        details: { quote_id: input.quoteId, corridor },
      });

      const commitment = commitmentFor(r, quote);
      commitment.sender = account.public_key;
      const signer = await senderSigner(r, userId);

      if (signer) {
        const { id: onchainId } = await soroban.createRemittance(commitment, signer);
        await db
          .update(remittances)
          .set({ contract_remittance_id: onchainId, updated_at: new Date() })
          .where(eq(remittances.id, r.id));
        return { id: r.id, status: 'CREATED', contract_remittance_id: onchainId };
      }
      // Non-custodial: hand the prepared transaction to the app to sign.
      const transactionXdr = await soroban.prepareCreateRemittance(commitment, account.public_key);
      return {
        id: r.id,
        status: 'CREATED',
        approval_required: true,
        approval: { method: 'create_remittance', transactionXdr },
      };
    },

    async fund(id, userId) {
      const r = await loadOwned(id, userId);
      if (r.status !== 'CREATED') {
        throw conflict(`Cannot fund remittance in state ${r.status}`);
      }
      if (r.expiry.getTime() <= Date.now()) {
        throw unprocessable('Remittance has expired', { id });
      }
      if (!r.contract_remittance_id) {
        throw conflict('Remittance has not been created on-chain');
      }
      const quote = await quotesService.getQuote(r.quote_id!);
      const commitment = commitmentFor(r, quote);
      const signer = await senderSigner(r, userId);
      if (!signer) {
        throw unprocessable(
          'Non-custodial funding requires the fund_remittance approval flow — prepare + sign in-app',
        );
      }
      await soroban.fundRemittance(r.contract_remittance_id, signer, r.id);
      await setState(r.id, 'FUNDED', 'TRANSFER_INITIATED');
      await db.insert(auditEvents).values({
        actor_id: userId,
        action: 'remittance.fund',
        resource_type: 'remittance',
        resource_id: r.id,
        details: { contract_remittance_id: r.contract_remittance_id },
      });
      return { id: r.id, status: 'FUNDED' };
    },

    async beginProcessing(id) {
      const rows = await db.select().from(remittances).where(eq(remittances.id, id)).limit(1);
      if (rows.length === 0) {
        throw notFound('Remittance not found');
      }
      const r = rows[0]!;
      if (r.status !== 'FUNDED') {
        return; // idempotent for the polling worker
      }
      const oracle = soroban.roleSigner('oracle');
      await soroban.beginProcessing(r.contract_remittance_id!, oracle, r.id);
      await setState(r.id, 'PROCESSING', 'ANCHOR_PROCESSING');
    },

    async authorizeAndRelease(id) {
      const rows = await db.select().from(remittances).where(eq(remittances.id, id)).limit(1);
      if (rows.length === 0) {
        throw notFound('Remittance not found');
      }
      const r = rows[0]!;
      if (r.status === 'SETTLEMENT_AUTHORIZED') {
        // Re-entry guard — release may already have run; check on-chain state.
        const onchain = await soroban.statusOf(r.contract_remittance_id!);
        if (onchain === 'Released') {
          await setState(r.id, 'RELEASED', 'COMPLETED');
          return { id: r.id, status: 'RELEASED' };
        }
      }
      if (r.status !== 'FUNDED' && r.status !== 'PROCESSING') {
        throw conflict(`Cannot settle remittance in state ${r.status}`);
      }
      if (r.expiry.getTime() <= Date.now()) {
        throw unprocessable('Remittance expired before settlement was authorized');
      }
      const quote = await quotesService.getQuote(r.quote_id!);
      const commitment = commitmentFor(r, quote);
      const sender = await loadSenderAccount(r.sender_account_id!, r.sender_user_id!);
      commitment.sender = sender.public_key;
      const oracle = soroban.roleSigner('oracle');
      await soroban.authorizeSettlement(r.contract_remittance_id!, commitment, oracle, r.id);
      await setState(r.id, 'SETTLEMENT_AUTHORIZED', 'DESTINATION_SETTLEMENT');
      const summary = await soroban.release(r.contract_remittance_id!, r.id);
      await setState(r.id, 'RELEASED', 'COMPLETED');
      await db.insert(auditEvents).values({
        actor_id: null,
        actor_role: 'oracle',
        action: 'remittance.settled',
        resource_type: 'remittance',
        resource_id: r.id,
        details: { summary, contract_remittance_id: r.contract_remittance_id },
      });
      return { id: r.id, status: 'RELEASED', summary };
    },

    async release(id, userId) {
      const r = await loadOwned(id, userId);
      if (r.status !== 'SETTLEMENT_AUTHORIZED') {
        throw conflict(`Cannot release remittance in state ${r.status}`);
      }
      const summary = await soroban.release(r.contract_remittance_id!, r.id);
      await setState(r.id, 'RELEASED', 'COMPLETED');
      return { id: r.id, status: 'RELEASED', summary };
    },

    async refund(id, userId) {
      const r = await loadOwned(id, userId);
      if (r.status !== 'FUNDED' && r.status !== 'PROCESSING') {
        throw conflict(`Cannot refund remittance in state ${r.status}`);
      }
      const expired = r.expiry.getTime() <= Date.now();
      let signer: Signer | undefined;
      if (!expired && r.status === 'FUNDED') {
        signer = (await senderSigner(r, userId)) ?? undefined;
        if (!signer) {
          throw unprocessable('Custodial sender account required for cancellation');
        }
      } else if (!expired && r.status === 'PROCESSING') {
        if (userId) {
          // Emergency refund requires admin — enforced by the contract; here we
          // surface a clear message for regular users.
          throw forbidden('Only the corridor admin can refund a processing remittance');
        }
        signer = soroban.roleSigner('admin');
      } else {
        signer = soroban.roleSigner('fee_payer'); // expired: permissionless
      }
      const amount = await soroban.refund(r.contract_remittance_id!, signer, r.id);
      await setState(r.id, 'REFUNDED', 'REFUNDED');
      await db.insert(auditEvents).values({
        actor_id: userId,
        action: 'remittance.refund',
        resource_type: 'remittance',
        resource_id: r.id,
        details: { amount_stroops: amount, expired },
      });
      return { id: r.id, status: 'REFUNDED', amount };
    },

    async get(id, userId) {
      const r = await loadOwned(id, userId);
      const onchain = r.contract_remittance_id
        ? await soroban.getRemittance(r.contract_remittance_id).catch(() => null)
        : null;
      return {
        id: r.id,
        status: r.status,
        lifecycle: r.lifecycle,
        source_asset: r.source_asset,
        source_amount: fromStroops(r.source_amount_stroops),
        destination_asset: r.destination_asset,
        expected_destination_amount: fromStroops(r.expected_destination_amount_stroops),
        recipient_address: r.recipient_address,
        recipient_stellar_account: r.recipient_stellar_account,
        corridor: r.corridor,
        quote_hash: r.quote_hash,
        expiry: r.expiry,
        created_at: r.created_at,
        settled_at: r.settled_at,
        contract_remittance_id: r.contract_remittance_id,
        contract_status: onchain?.status ?? null,
      };
    },

    async events(id, userId) {
      await loadOwned(id, userId);
      const [payments, sepTxs, sorobanTxs, stellarTxs, audit] = await Promise.all([
        db.select().from(paymentEvents).where(eq(paymentEvents.remittance_id, id)).orderBy(desc(paymentEvents.created_at)),
        db.select().from(sepTransactions).where(eq(sepTransactions.remittance_id, id)).orderBy(desc(sepTransactions.created_at)),
        db.select().from(sorobanTransactions).where(eq(sorobanTransactions.remittance_id, id)).orderBy(desc(sorobanTransactions.created_at)),
        db.select().from(stellarTransactions).where(eq(stellarTransactions.remittance_id, id)).orderBy(desc(stellarTransactions.created_at)),
        db.select().from(auditEvents).where(eq(auditEvents.resource_id, id)).orderBy(desc(auditEvents.created_at)),
      ]);
      const events: Array<Record<string, unknown>> = [];
      for (const p of payments) {
        events.push({ type: 'payment', at: p.created_at, event_type: p.event_type, amount: p.amount, asset: p.asset, from: p.from_addr, to: p.to_addr, cursor: p.cursor });
      }
      for (const t of sorobanTxs) {
        events.push({ type: 'soroban', at: t.created_at, method: t.method, status: t.status, tx_hash: t.tx_hash, error: t.error });
      }
      for (const t of sepTxs) {
        events.push({ type: 'anchor', at: t.created_at, kind: t.kind, protocol: t.protocol, anchor_tx_id: t.anchor_tx_id, status: t.anchor_tx_status });
      }
      for (const t of stellarTxs) {
        events.push({ type: 'stellar', at: t.created_at, operation: t.operation_type, status: t.status, tx_hash: t.tx_hash });
      }
      for (const a of audit) {
        events.push({ type: 'audit', at: a.created_at, action: a.action, details: a.details });
      }
      events.sort((a, b) => new Date(a.at as string).getTime() - new Date(b.at as string).getTime());
      return events;
    },

    async confirmSorobanSubmission(id, { txHash, method }, userId) {
      const r = await loadOwned(id, userId);
      await soroban.waitForTransaction(txHash);
      if (method === 'create_remittance' && !r.contract_remittance_id) {
        // Reconcile: ids are monotonic — the newest record must be ours if the
        // sender and quote hash match.
        const count = await soroban.remittanceCount();
        const candidate = (await soroban.getRemittance(String(count - 1))) as Record<string, unknown>;
        const quote = await quotesService.getQuote(r.quote_id!);
        const account = await loadSenderAccount(r.sender_account_id!, userId);
        if (
          String(candidate.sender ?? '') === account.public_key &&
          String(candidate.quote_hash ?? '') === quote.quoteHash
        ) {
          await db
            .update(remittances)
            .set({ contract_remittance_id: String(count - 1), updated_at: new Date() })
            .where(eq(remittances.id, r.id));
        } else {
          throw unprocessable('On-chain remittance does not match this commitment');
        }
      }
      if (method === 'fund_remittance' && r.status === 'CREATED') {
        await setState(r.id, 'FUNDED', 'TRANSFER_INITIATED');
      }
      await db
        .update(sorobanTransactions)
        .set({ tx_hash: txHash, status: 'confirmed', updated_at: new Date() })
        .where(and(eq(sorobanTransactions.remittance_id, r.id), eq(sorobanTransactions.method, method)));
    },

    async onAnchorTransferStarted(id) {
      const rows = await db.select().from(remittances).where(eq(remittances.id, id)).limit(1);
      if (rows.length === 0 || rows[0]!.status !== 'FUNDED') {
        return;
      }
      await this.beginProcessing(id);
    },

    async applyPaymentEvent(remittanceId, event) {
      const rows = await db.select().from(remittances).where(eq(remittances.id, remittanceId)).limit(1);
      if (rows.length === 0) {
        return;
      }
      const r = rows[0]!;
      const isToRecipient = event.to === r.recipient_stellar_account;
      const isPathPayment = event.type === 'path_payment';
      if (isPathPayment && isToRecipient && r.lifecycle === 'TRANSFER_INITIATED') {
        await db
          .update(remittances)
          .set({ lifecycle: 'STELLAR_PAYMENT_SUBMITTED', updated_at: new Date() })
          .where(eq(remittances.id, r.id));
        return;
      }
      if (isToRecipient && r.lifecycle === 'STELLAR_PAYMENT_SUBMITTED') {
        await db
          .update(remittances)
          .set({ lifecycle: 'STELLAR_PAYMENT_CONFIRMED', updated_at: new Date() })
          .where(eq(remittances.id, r.id));
      }
    },

    async onAnchorStatus(id, anchorStatus) {
      const rows = await db.select().from(remittances).where(eq(remittances.id, id)).limit(1);
      if (rows.length === 0) {
        return;
      }
      const r = rows[0]!;
      if (anchorStatus === 'completed' && (r.status === 'PROCESSING' || r.status === 'FUNDED')) {
        await this.authorizeAndRelease(id);
      }
    },
  };
}