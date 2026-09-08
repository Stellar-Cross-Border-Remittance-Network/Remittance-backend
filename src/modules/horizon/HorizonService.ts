import { Horizon, TransactionBuilder, type Asset } from '@stellar/stellar-sdk';

import { loadEnv } from '../../config/env.js';
import { upstream } from '../../lib/errors.js';

export interface AccountRecord {
  id: string;
  sequence: string;
  balances: Array<{ asset: string; balance: string; limit?: string }>;
  signers: Array<{ key: string; weight: number }>;
  thresholds: { low: number; med_threshold: number; high_threshold: number };
}

export interface StrictSendPath {
  sourceAmount: string;
  destinationAmount: string;
  sourceAsset: string;
  destinationAsset: string;
  path: string[]; // human-readable 'CODE:ISSUER' hops
}

/**
 * Typed wrapper around Horizon. All network reads/writes go through here so
 * tests can substitute a fake Horizon server.
 */
export interface HorizonService {
  loadAccount(address: string): Promise<AccountRecord>;
  submitTransaction(envelopeXdr: string): Promise<{ hash: string; ledger?: number }>;
  /** Real PathPaymentStrictSend paths from Horizon's strict_send_paths endpoint. */
  strictSendPaths(input: {
    sourceAsset: Asset;
    sourceAmount: string;
    destinationAccount: string;
  }): Promise<StrictSendPath[]>;
  raw(): Horizon.Server;
}

export function createHorizonService(): HorizonService {
  const env = loadEnv();
  const server = new Horizon.Server(env.HORIZON_URL, {
    allowHttp: env.ALLOW_INSECURE_HTTP,
  });

  return {
    async loadAccount(address) {
      try {
        const acc = await server.loadAccount(address);
        return {
          id: acc.accountId(),
          sequence: acc.sequence,
          balances: acc.balances.flatMap((b) => {
            if (b.asset_type === 'native') {
              return [{ asset: 'XLM', balance: b.balance }];
            }
            if ('asset_code' in b && b.asset_code) {
              return [{ asset: `${b.asset_code}:${b.asset_issuer}`, balance: b.balance, limit: 'limit' in b ? b.limit : undefined }];
            }
            return []; // liquidity pool shares are not sendable assets
          }),
          signers: acc.signers.map((s) => ({ key: s.key, weight: s.weight })),
          thresholds: {
            low: acc.thresholds.low_threshold,
            med_threshold: acc.thresholds.med_threshold,
            high_threshold: acc.thresholds.high_threshold,
          },
        };
      } catch (e) {
        throw upstream(`Horizon loadAccount failed for ${address}: ${(e as Error).message}`);
      }
    },

    async submitTransaction(envelopeXdr) {
      try {
        const tx = TransactionBuilder.fromXDR(envelopeXdr, env.NETWORK_PASSPHRASE);
        const res = await server.submitTransaction(tx);
        return { hash: res.hash, ledger: res.ledger };
      } catch (e) {
        const err = e as { response?: { data?: { extras?: { result_codes?: { transaction?: string } } } } };
        const code = err.response?.data?.extras?.result_codes?.transaction;
        throw upstream(`Horizon rejected transaction${code ? ` (${code})` : ''}`, {
          message: (e as Error).message,
        });
      }
    },

    async strictSendPaths({ sourceAsset, sourceAmount, destinationAccount }) {
      try {
        const page = await server
          .strictSendPaths(sourceAsset, sourceAmount, destinationAccount)
          .call();
        return page.records.map((p) => ({
          sourceAmount: p.source_amount,
          destinationAmount: p.destination_amount,
          sourceAsset: assetString(p.source_asset_type, p.source_asset_code, p.source_asset_issuer),
          destinationAsset: assetString(
            p.destination_asset_type,
            p.destination_asset_code,
            p.destination_asset_issuer,
          ),
          path: (p.path ?? []).map((hop) =>
            assetString(hop.asset_type, hop.asset_code, hop.asset_issuer),
          ),
        }));
      } catch (e) {
        throw upstream(`Horizon strict_send_paths failed: ${(e as Error).message}`);
      }
    },

    raw() {
      return server;
    },
  };
}

function assetString(type: string, code?: string, issuer?: string): string {
  if (type === 'native') {
    return 'XLM';
  }
  return `${code}:${issuer}`;
}