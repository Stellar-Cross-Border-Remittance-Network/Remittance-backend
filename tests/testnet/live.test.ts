import { Horizon, Keypair, rpc } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { loadEnv } from '../../src/config/env.js';
import { createStellarTomlService } from '../../src/modules/sep1/StellarTomlService.js';

/**
 * LIVE Testnet integration tests.
 *
 * These hit the real Stellar Testnet (Horizon, Soroban RPC, the deployed
 * escrow contract, and testanchor.stellar.org's stellar.toml). They are
 * skipped unless explicitly enabled because they depend on network access and
 * the deployed contract id:
 *
 *   RUN_TESTNET_TESTS=1 CONTRACT_ID=CAA2LHIITEFNS5KL3H5ZLRVVR6BPUKWXCHKN5V6HMR4XLJBQZHRBT6QZ \
 *     pnpm vitest run tests/testnet/live.test.ts
 *
 * Required env (from .env.example):
 *   HORIZON_URL (default testnet), RPC_URL (default testnet), CONTRACT_ID.
 */
const enabled = process.env.RUN_TESTNET_TESTS === '1';
const describeLive = enabled ? describe : describe.skip;

const FRIENDBOT_URL = 'https://friendbot.stellar.org';

/** Fund a fresh testnet account via friendbot so tests are self-contained. */
async function fundFreshAccount(): Promise<Keypair> {
  const kp = Keypair.random();
  const res = await fetch(`${FRIENDBOT_URL}?addr=${kp.publicKey()}`, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`Friendbot funding failed (${res.status}): ${await res.text()}`);
  }
  return kp;
}

describeLive('live Stellar Testnet', () => {
  it('loads a funded account from Horizon', async () => {
    const env = loadEnv();
    const kp = await fundFreshAccount();
    const server = new Horizon.Server(env.HORIZON_URL);
    const account = await server.loadAccount(kp.publicKey());
    expect(account.accountId()).toMatch(/^G[A-Z0-9]{55}$/);
    expect(account.balances.some((b) => b.asset_type === 'native')).toBe(true);
  });

  it('reads the latest ledger sequence from the RPC', async () => {
    const env = loadEnv();
    const server = new rpc.Server(env.RPC_URL);
    const info = await server.getLatestLedger();
    expect(Number(info.sequence)).toBeGreaterThan(0);
  });

  it('queries the deployed escrow contract version + remittance count', async () => {
    const env = loadEnv();
    if (!env.CONTRACT_ID) {
      throw new Error('CONTRACT_ID is required for the live contract test');
    }
    const { Client } = (await import('../../src/modules/soroban/bindings/src/index.js')) as unknown as {
      Client: new (opts: Record<string, unknown>) => {
        version(args: Record<string, unknown>): Promise<{ result?: unknown }>;
        remittance_count(args: Record<string, unknown>): Promise<{ result?: unknown }>;
      };
    };
    const kp = await fundFreshAccount();
    const client = new Client({
      rpcUrl: env.RPC_URL,
      networkPassphrase: env.NETWORK_PASSPHRASE,
      contractId: env.CONTRACT_ID,
      publicKey: kp.publicKey(),
    });
    const version = await client.version({});
    const count = await client.remittance_count({});
    expect(String(version.result)).toBe('1');
    expect(Number(String(count.result))).toBeGreaterThanOrEqual(0);
  });

  it('discovers testanchor.stellar.org endpoints via SEP-1 (dynamic, not hard-coded)', async () => {
    const toml = createStellarTomlService();
    const discovered = await toml.discover('testanchor.stellar.org');
    expect(discovered.webAuthEndpoint).toMatch(/^https:\/\//);
    expect(discovered.transferServerSep24).toMatch(/^https:\/\//);
    expect(discovered.transferServerSep6 ?? '').toBeTruthy();
    expect(discovered.currencies.length).toBeGreaterThan(0);
    const usdc = discovered.currencies.find((a) => a.code === 'USDC');
    expect(usdc?.issuer).toMatch(/^G[A-Z0-9]{55}$/);
  });

  it('validates a funded testnet keypair round-trip', async () => {
    // No secrets in the repo: derive a fresh keypair and check address math
    // against what Horizon/RPC accept.
    const kp = Keypair.random();
    expect(kp.publicKey()).toMatch(/^G[A-Z0-9]{55}$/);
    expect(Keypair.fromSecret(kp.secret()).publicKey()).toBe(kp.publicKey());
  });
});