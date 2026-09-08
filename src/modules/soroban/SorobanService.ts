import { Address, Asset, Keypair } from '@stellar/stellar-sdk';
import { eq } from 'drizzle-orm';

import { loadEnv } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import { sorobanTransactions } from '../../db/schema.js';
import { fromStroops, toStroops } from '../../lib/amounts.js';
import { decryptSecret } from '../../lib/crypto.js';
import { internal, unprocessable, upstream } from '../../lib/errors.js';

/** On-chain commitment terms — must mirror the contract's Remittance record. */
export interface ContractCommitment {
  sender: string;
  recipient: string;
  sourceAsset: string; // 'USDC:G...' or 'XLM'
  sourceAmountStroops: bigint;
  destinationAsset: string; // e.g. 'NGN'
  expectedDestinationAmountStroops: bigint;
  corridor: string; // e.g. 'US/NG'
  quoteHash: string; // hex (64 chars)
  expiry: number; // unix seconds
}

export interface Signer {
  publicKey: string;
  /** Encrypted with the service key (user-held secrets at rest). */
  secretEncrypted?: string;
  /** Plaintext secret (env-provided role keys such as ORACLE_SECRET). */
  secret?: string;
}

export interface SorobanService {
  sacAddress(assetSpec: string): string;
  /** Env-provided role signer (admin/oracle/fee operator) for privileged calls. */
  roleSigner(role: 'admin' | 'oracle' | 'fee_operator' | 'fee_payer'): Signer;
  /** Monotonic counter of created remittances — used for non-custodial reconciliation. */
  remittanceCount(): Promise<number>;
  /**
   * Sign (custodial) and submit. Requires a signer with the right role
   * (sender for create/fund, oracle for authorize/begin, admin for
   * emergency refunds). Records every invocation in soroban_transactions.
   */
  createRemittance(commitment: ContractCommitment, signer: Signer): Promise<{ id: string }>;
  fundRemittance(contractRemittanceId: string, sender: Signer, remittanceId?: string): Promise<void>;
  beginProcessing(contractRemittanceId: string, oracle: Signer, remittanceId?: string): Promise<void>;
  authorizeSettlement(
    contractRemittanceId: string,
    commitment: ContractCommitment,
    oracle: Signer,
    remittanceId?: string,
  ): Promise<void>;
  release(contractRemittanceId: string, remittanceId?: string): Promise<Record<string, string>>;
  refund(contractRemittanceId: string, signer?: Signer, remittanceId?: string): Promise<string>;
  getRemittance(contractRemittanceId: string): Promise<Record<string, unknown>>;
  statusOf(contractRemittanceId: string): Promise<string>;
  /** Poll RPC until the given tx succeeds; returns the tx hash. */
  waitForTransaction(txHash: string, timeoutMs?: number): Promise<void>;
  /** Non-custodial path: prepare an unsigned envelope for the client to sign. */
  prepareCreateRemittance(commitment: ContractCommitment, senderPublicKey: string): Promise<string>;
  /** Non-custodial path: prepare the fund_remittance envelope for the sender to sign. */
  prepareFundRemittance(contractRemittanceId: string, senderPublicKey: string): Promise<string>;
  /** Non-custodial path: prepare the refund envelope (sender cancel, pre-processing) for signing. */
  prepareRefund(contractRemittanceId: string, senderPublicKey: string): Promise<string>;
  /**
   * Submit a client-signed envelope to RPC and wait for confirmation. Used by
   * the relay endpoint: the app signs on-device, the backend submits and
   * verifies on-chain state afterwards.
   */
  submitEnvelope(signedXdr: string, timeoutMs?: number): Promise<{ txHash: string }>;
}

/** Generate the Stellar Asset Contract address for a classic asset. */
export function sacAddressFor(assetSpec: string, networkPassphrase: string): string {
  const asset = assetSpec === 'XLM' ? Asset.native() : parseClassic(assetSpec);
  return asset.contractId(networkPassphrase);
}

function parseClassic(spec: string): Asset {
  const match = /^([A-Z0-9]{1,12}):(G[A-Z0-9]{55})$/.exec(spec);
  if (!match) {
    throw unprocessable(`Invalid asset spec: ${spec}`);
  }
  return new Asset(match[1]!, match[2]!);
}

type Assembled = {
  signAndSend(): Promise<{ result?: unknown }>;
  toXDR(): string;
};

type ContractClientLike = {
  create_remittance(args: Record<string, unknown>): Promise<Assembled>;
  fund_remittance(args: Record<string, unknown>): Promise<Assembled>;
  begin_processing(args: Record<string, unknown>): Promise<Assembled>;
  authorize_settlement(args: Record<string, unknown>): Promise<Assembled>;
  release(args: Record<string, unknown>): Promise<Assembled>;
  refund(args: Record<string, unknown>): Promise<Assembled>;
  get_remittance(args: Record<string, unknown>): Promise<{ result?: unknown }>;
  status_of(args: Record<string, unknown>): Promise<{ result?: unknown }>;
  remittance_count(args: Record<string, unknown>): Promise<{ result?: unknown }>;
};

export function createSorobanService(db: Db): SorobanService {
  const env = loadEnv();
  if (!env.CONTRACT_ID) {
    throw internal('CONTRACT_ID is required to invoke the remittance contract');
  }

  async function clientFor(signer?: Signer): Promise<ContractClientLike> {
    const { Client } = (await import('./bindings/src/index.js')) as unknown as {
      Client: new (opts: Record<string, unknown>) => ContractClientLike;
    };
    const opts: Record<string, unknown> = {
      rpcUrl: env.RPC_URL,
      networkPassphrase: env.NETWORK_PASSPHRASE,
      contractId: env.CONTRACT_ID,
    };
    if (signer?.secretEncrypted) {
      opts.publicKey = signer.publicKey;
      opts.secretKey = decryptSecret(signer.secretEncrypted);
    } else if (signer?.secret) {
      opts.publicKey = signer.publicKey;
      opts.secretKey = signer.secret;
    }
    return new Client(opts);
  }

  function envRoleSecret(role: 'admin' | 'oracle' | 'fee_operator' | 'fee_payer'): string {
    const map: Record<string, string | undefined> = {
      admin: env.ADMIN_SECRET,
      oracle: env.ORACLE_SECRET,
      fee_operator: env.FEE_OPERATOR_SECRET,
      fee_payer: env.ADMIN_SECRET ?? env.ORACLE_SECRET ?? env.FEE_OPERATOR_SECRET,
    };
    const secret = map[role];
    if (!secret) {
      throw internal(`Missing ${role.toUpperCase()}_SECRET for contract invocation`);
    }
    return secret;
  }

  async function record(
    method: string,
    remittanceId: string | undefined,
    args: Record<string, unknown>,
    fn: () => Promise<unknown>,
  ): Promise<unknown> {
    const row = await db
      .insert(sorobanTransactions)
      .values({
        remittance_id: remittanceId ?? null,
        method,
        contract_id: env.CONTRACT_ID!,
        function_args: args,
        status: 'pending',
      })
      .returning({ id: sorobanTransactions.id });
    try {
      const result = await fn();
      await db
        .update(sorobanTransactions)
        .set({ status: 'confirmed', updated_at: new Date() })
        .where(eq(sorobanTransactions.id, row[0]!.id));
      return result;
    } catch (e) {
      await db
        .update(sorobanTransactions)
        .set({ status: 'failed', error: (e as Error).message, updated_at: new Date() })
        .where(eq(sorobanTransactions.id, row[0]!.id));
      throw e;
    }
  }

  function commitmentArgs(c: ContractCommitment): Record<string, unknown> {
    const { sender, recipient, sourceAsset, sourceAmountStroops, destinationAsset, expectedDestinationAmountStroops, corridor, quoteHash, expiry } = c;
    return {
      sender: new Address(sender).toString(),
      recipient: new Address(recipient).toString(),
      source_asset: sacAddressFor(sourceAsset, env.NETWORK_PASSPHRASE),
      source_amount: sourceAmountStroops.toString(),
      destination_asset: Buffer.from(destinationAsset, 'utf8'),
      expected_destination_amount: expectedDestinationAmountStroops.toString(),
      corridor: Buffer.from(corridor, 'utf8'),
      quote_hash: Buffer.from(quoteHash.replace(/^0x/, ''), 'hex'),
      expiry: BigInt(expiry),
    };
  }

  function unwrapResult(value: unknown): unknown {
    // Contract functions return soroban-sdk `Result`; the generated client may
    // surface it raw or as {ok: ...} depending on the SDK version.
    if (value && typeof value === 'object' && 'ok' in value && !('sender' in value)) {
      return (value as { ok: unknown }).ok;
    }
    return value;
  }

  return {
    sacAddress(assetSpec) {
      return sacAddressFor(assetSpec, env.NETWORK_PASSPHRASE);
    },

    roleSigner(role) {
      const secret = envRoleSecret(role);
      const kp = Keypair.fromSecret(secret);
      return { publicKey: kp.publicKey(), secret };
    },

    async remittanceCount() {
      const client = await clientFor();
      const res = await client.remittance_count({});
      return Number(String(unwrapResult(res.result) ?? 0));
    },

    async createRemittance(commitment, signer) {
      const args = commitmentArgs(commitment);
      const result = await record(
        'create_remittance',
        undefined,
        args,
        async () => {
          const client = await clientFor(signer);
          const tx = await client.create_remittance(args);
          const res = await tx.signAndSend();
          return unwrapResult(res.result);
        },
      );
      const id = String(result);
      if (!/^\d+$/.test(id)) {
        throw upstream('create_remittance returned an invalid id', { result });
      }
      return { id };
    },

    async fundRemittance(contractRemittanceId, sender, remittanceId) {
      const args = { sender: new Address(sender.publicKey).toString(), id: BigInt(contractRemittanceId) };
      await record('fund_remittance', remittanceId, args, async () => {
        const client = await clientFor(sender);
        const tx = await client.fund_remittance(args);
        await tx.signAndSend();
      });
    },

    async beginProcessing(contractRemittanceId, oracle, remittanceId) {
      const args = { id: BigInt(contractRemittanceId) };
      await record('begin_processing', remittanceId, args, async () => {
        const client = await clientFor(oracle);
        const tx = await client.begin_processing(args);
        await tx.signAndSend();
      });
    },

    async authorizeSettlement(contractRemittanceId, commitment, oracle, remittanceId) {
      const args = { id: BigInt(contractRemittanceId), ...commitmentArgs(commitment) };
      await record('authorize_settlement', remittanceId, args, async () => {
        const client = await clientFor(oracle);
        const tx = await client.authorize_settlement(args);
        await tx.signAndSend();
      });
    },

    async release(contractRemittanceId, remittanceId) {
      const args = { id: BigInt(contractRemittanceId) };
      const result = (await record('release', remittanceId, args, async () => {
        const client = await clientFor();
        const tx = await client.release(args);
        const res = await tx.signAndSend();
        return unwrapResult(res.result);
      })) as Record<string, unknown> | undefined;
      if (!result || typeof result !== 'object') {
        throw upstream('release returned no summary', { result });
      }
      return Object.fromEntries(
        Object.entries(result).map(([k, v]) => [k, fromStroops(BigInt(String(v ?? 0)))]),
      );
    },

    async refund(contractRemittanceId, signer, remittanceId) {
      const args = { id: BigInt(contractRemittanceId) };
      const result = await record('refund', remittanceId, args, async () => {
        const client = await clientFor(signer);
        const tx = await client.refund(args);
        const res = await tx.signAndSend();
        return unwrapResult(res.result);
      });
      return fromStroops(BigInt(String(result ?? 0)));
    },

    async getRemittance(contractRemittanceId) {
      const client = await clientFor();
      const res = await client.get_remittance({ id: BigInt(contractRemittanceId) });
      const result = unwrapResult(res.result);
      return (result as Record<string, unknown>) ?? {};
    },

    async waitForTransaction(txHash, timeoutMs = 90_000) {
      const { rpc } = (await import('@stellar/stellar-sdk/rpc')) as unknown as {
        rpc: { Server: new (url: string) => { getTransaction(hash: string): Promise<unknown> } };
      };
      const server = new rpc.Server(env.RPC_URL);
      const deadline = Date.now() + timeoutMs;
      let last: { status?: string; error?: string } | undefined;
      while (Date.now() < deadline) {
        const res = (await server.getTransaction(txHash)) as {
          status?: string;
          error?: string;
        };
        last = res;
        if (res.status === 'SUCCESS') {
          return;
        }
        if (res.status === 'FAILED') {
          throw upstream(`Soroban transaction failed: ${res.error ?? 'unknown error'}`, { txHash });
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw upstream(`Soroban transaction not confirmed within ${timeoutMs}ms`, { txHash, last });
    },

    async statusOf(contractRemittanceId) {
      const client = await clientFor();
      const res = await client.status_of({ id: BigInt(contractRemittanceId) });
      return String(unwrapResult(res.result) ?? 'UNKNOWN');
    },

    async prepareCreateRemittance(commitment, senderPublicKey) {
      const args = commitmentArgs(commitment);
      const client = await clientFor({ publicKey: senderPublicKey });
      const tx = await client.create_remittance(args);
      return tx.toXDR();
    },

    async prepareFundRemittance(contractRemittanceId, senderPublicKey) {
      const args = { sender: new Address(senderPublicKey).toString(), id: BigInt(contractRemittanceId) };
      const client = await clientFor({ publicKey: senderPublicKey });
      const tx = await client.fund_remittance(args);
      return tx.toXDR();
    },

    async prepareRefund(contractRemittanceId, senderPublicKey) {
      const args = { id: BigInt(contractRemittanceId) };
      const client = await clientFor({ publicKey: senderPublicKey });
      const tx = await client.refund(args);
      return tx.toXDR();
    },

    async submitEnvelope(signedXdr, timeoutMs = 90_000) {
      const { Transaction } = (await import('@stellar/stellar-sdk')) as unknown as {
        Transaction: new (xdr: string, passphrase: string) => {
          hash(): Buffer;
        };
      };
      const tx = new Transaction(signedXdr, env.NETWORK_PASSPHRASE);
      const txHash = tx.hash().toString('hex');
      const { rpc } = (await import('@stellar/stellar-sdk/rpc')) as unknown as {
        rpc: {
          Server: new (url: string) => {
            sendTransaction(tx: unknown): Promise<{ status: string; hash?: string; errorResult?: unknown }>;
          };
        };
      };
      const server = new rpc.Server(env.RPC_URL);
      const res = await server.sendTransaction(tx as unknown);
      if (res.status === 'ERROR') {
        throw upstream('Relayed Soroban transaction was rejected', { txHash, errorResult: res.errorResult });
      }
      if (res.status === 'PENDING' || res.status === 'DUPLICATE' || res.status === 'TRY_AGAIN_LATER') {
        await this.waitForTransaction(txHash, timeoutMs);
      }
      return { txHash };
    },
  };
}