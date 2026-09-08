import { Account, Asset, BASE_FEE, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { eq } from 'drizzle-orm';

import { loadEnv } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import { stellarTransactions } from '../../db/schema.js';
import { badRequest } from '../../lib/errors.js';
import type { SigningService } from '../signing/SigningService.js';
import type { HorizonService, StrictSendPath } from '../horizon/HorizonService.js';

export interface PathPlanInput {
  sendAsset: string; // 'USDC:G...' or 'XLM'
  sendAmount: string; // human decimal
  destAsset: string;
  destAccount: string;
}

export interface PathPlan {
  sendAsset: string;
  sendAmount: string;
  destAsset: string;
  destAccount: string;
  /** Real paths returned by Horizon — never fabricated. */
  paths: StrictSendPath[];
  best: StrictSendPath;
}

export interface PreparedPathPayment {
  stellarTransactionId: string;
  envelopeXdr: string;
  destinationMin: string;
  path: string[];
}

export function parseAsset(spec: string): Asset {
  if (spec === 'XLM') {
    return Asset.native();
  }
  const match = /^([A-Z0-9]{1,12}):(G[A-Z0-9]{55})$/.exec(spec);
  if (!match) {
    throw badRequest(`Invalid asset spec (expected CODE:ISSUER or XLM): ${spec}`);
  }
  return new Asset(match[1]!, match[2]!);
}

export function assetToString(a: Asset): string {
  return a.isNative() ? 'XLM' : `${a.getCode()}:${a.getIssuer()}`;
}

export interface PathPaymentService {
  plan(input: PathPlanInput): Promise<PathPlan>;
  /**
   * Build the PathPaymentStrictSend transaction. When a signing secret is
   * provided the envelope is signed; otherwise it is returned unsigned for
   * the client (non-custodial) to sign.
   */
  prepare(input: {
    senderPublicKey: string;
    secretEncrypted?: string;
    plan: PathPlan;
    slippageBps?: number;
    remittanceId?: string;
  }): Promise<PreparedPathPayment>;
  /** Submit a signed envelope and record its on-chain status. */
  submit(input: {
    envelopeXdr: string;
    stellarTransactionId: string;
    remittanceId?: string;
  }): Promise<{ hash: string; status: 'submitted' }>;
}

export function createPathPaymentService(
  db: Db,
  horizon: HorizonService,
  signing: SigningService,
): PathPaymentService {
  return {
    async plan(input) {
      const sendAsset = parseAsset(input.sendAsset);
      parseAsset(input.destAsset); // validate format before querying
      const paths = await horizon.strictSendPaths({
        sourceAsset: sendAsset,
        sourceAmount: input.sendAmount,
        destinationAccount: input.destAccount,
      });
      if (paths.length === 0) {
        throw badRequest('No Stellar path exists for this pair');
      }
      // Best path = highest destination amount for the fixed source amount.
      paths.sort(
        (a, b) => Number.parseFloat(b.destinationAmount) - Number.parseFloat(a.destinationAmount),
      );
      const best = paths[0]!;
      return { ...input, paths, best };
    },

    async prepare({ senderPublicKey, secretEncrypted, plan, slippageBps = 500, remittanceId }) {
      const env = loadEnv();
      const accountRecord = await horizon.loadAccount(senderPublicKey);
      const account = new Account(senderPublicKey, accountRecord.sequence);
      const best = plan.best;
      const bestDest = Number.parseFloat(best.destinationAmount);
      const destinationMin = (bestDest * (1 - slippageBps / 10_000)).toFixed(7);

      const sendAsset = parseAsset(plan.sendAsset);
      const destAsset = parseAsset(plan.destAsset);
      const pathAssets = best.path.map(parseAsset);

      const fee = BASE_FEE;
      const tx = new TransactionBuilder(account, {
        fee,
        networkPassphrase: env.NETWORK_PASSPHRASE,
      })
        .addOperation(
          Operation.pathPaymentStrictSend({
            sendAsset,
            sendAmount: plan.sendAmount,
            destination: plan.destAccount,
            destAsset,
            destMin: destinationMin,
            path: pathAssets,
          }),
        )
        .setTimeout(300)
        .build();

      let envelopeXdr: string;
      if (secretEncrypted) {
        envelopeXdr = await signing.signTransaction(
          tx.toXDR(),
          { publicKey: senderPublicKey, secretEncrypted },
          env.NETWORK_PASSPHRASE,
        );
      } else {
        envelopeXdr = tx.toXDR();
      }

      const inserted = await db
        .insert(stellarTransactions)
        .values({
          remittance_id: remittanceId ?? null,
          account: senderPublicKey,
          operation_type: 'path_payment_strict_send',
          asset_in: plan.sendAsset,
          amount_in: plan.sendAmount,
          asset_out: plan.destAsset,
          amount_out: destinationMin,
          destination: plan.destAccount,
          path: best.path,
          envelope_xdr: envelopeXdr,
          sequence: BigInt(accountRecord.sequence),
          status: 'pending',
        })
        .returning({ id: stellarTransactions.id, envelope_xdr: stellarTransactions.envelope_xdr });

      return {
        stellarTransactionId: inserted[0]!.id,
        envelopeXdr: inserted[0]!.envelope_xdr ?? envelopeXdr,
        destinationMin,
        path: best.path,
      };
    },

    async submit({ envelopeXdr, stellarTransactionId, remittanceId }) {
      const result = await horizon.submitTransaction(envelopeXdr);
      const hash = result.hash;
      await db
        .update(stellarTransactions)
        .set({ tx_hash: hash, status: 'submitted', updated_at: new Date() })
        .where(
          eq(stellarTransactions.id, stellarTransactionId),
        );
      return { hash, status: 'submitted' as const };
    },
  };
}