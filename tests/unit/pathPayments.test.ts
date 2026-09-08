import { describe, expect, it, vi } from 'vitest';

import { Keypair } from '@stellar/stellar-sdk';

import { stellarTransactions } from '../../src/db/schema.js';
import { createPathPaymentService, parseAsset, assetToString } from '../../src/modules/pathPayments/PathPaymentService.js';
import { createTestDb } from '../helpers/testDb.js';
import { createLocalSigningService } from '../../src/modules/signing/SigningService.js';

const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

// The HorizonService already maps records to StrictSendPath; the fake returns
// the mapped shape.
function fakeHorizon(paths: Array<{
  sourceAmount: string;
  destinationAmount: string;
  sourceAsset: string;
  destinationAsset: string;
  path: string[];
}> = []) {
  return {
    strictSendPaths: vi.fn().mockResolvedValue(paths),
    loadAccount: vi.fn().mockResolvedValue({
      id: 'G',
      sequence: '1234',
      balances: [],
      signers: [],
      thresholds: { low: 1, med_threshold: 1, high_threshold: 1 },
    }),
    submitTransaction: vi.fn().mockResolvedValue({ hash: 'hash123', ledger: 42 }),
    raw: vi.fn(),
  };
}

describe('PathPaymentService', () => {
  it('parses and formats assets', () => {
    expect(assetToString(parseAsset('XLM'))).toBe('XLM');
    expect(assetToString(parseAsset(`USDC:${USDC_ISSUER}`))).toBe(`USDC:${USDC_ISSUER}`);
    expect(() => parseAsset('not-an-asset')).toThrow();
  });

  it('plans a path, keeping only real Horizon results', async () => {
    const db = await createTestDb();
    const horizon = fakeHorizon([
      {
        sourceAmount: '10',
        destinationAmount: '149000',
        sourceAsset: `USDC:${USDC_ISSUER}`,
        destinationAsset: `NGN:${USDC_ISSUER}`,
        path: ['XLM', `USDC:${USDC_ISSUER}`],
      },
      {
        sourceAmount: '10',
        destinationAmount: '148000',
        sourceAsset: `USDC:${USDC_ISSUER}`,
        destinationAsset: `NGN:${USDC_ISSUER}`,
        path: [],
      },
    ]);
    const service = createPathPaymentService(db, horizon as never, createLocalSigningService());
    const plan = await service.plan({
      sendAsset: `USDC:${USDC_ISSUER}`,
      sendAmount: '10',
      destAsset: `NGN:${USDC_ISSUER}`,
      destAccount: 'GRECIP',
    });
    expect(plan.paths).toHaveLength(2);
    // Best = highest destination amount.
    expect(plan.best.destinationAmount).toBe('149000');
    expect(plan.best.path[0]).toBe('XLM');
  });

  it('refuses to plan when no path exists (never fabricates)', async () => {
    const db = await createTestDb();
    const horizon = fakeHorizon([]);
    const service = createPathPaymentService(db, horizon as never, createLocalSigningService());
    await expect(
      service.plan({
        sendAsset: 'XLM',
        sendAmount: '10',
        destAsset: `USDC:${USDC_ISSUER}`,
        destAccount: 'GRECIP',
      }),
    ).rejects.toThrow(/no stellar path/i);
  });

  it('prepares a signed strict-send transaction with slippage', async () => {
    const db = await createTestDb();
    const kp = Keypair.random();
    const destKp = Keypair.random();
    const horizon = fakeHorizon([
      {
        sourceAmount: '10',
        destinationAmount: '1000',
        sourceAsset: 'XLM',
        destinationAsset: `USDC:${USDC_ISSUER}`,
        path: [],
      },
    ]);
    const signing = createLocalSigningService();
    const encrypted = await signing.importSecret(kp.publicKey(), kp.secret());
    const service = createPathPaymentService(db, horizon as never, signing);
    const plan = await service.plan({
      sendAsset: 'XLM',
      sendAmount: '10',
      destAsset: `USDC:${USDC_ISSUER}`,
      destAccount: destKp.publicKey(),
    });
    const prepared = await service.prepare({
      senderPublicKey: kp.publicKey(),
      secretEncrypted: encrypted,
      plan,
      slippageBps: 500,
    });
    expect(prepared.destinationMin).toBe('950.0000000');
    expect(prepared.path).toEqual([]);
    const rows = await db.select().from(stellarTransactions);
    expect(rows[0]!.operation_type).toBe('path_payment_strict_send');
    expect(rows[0]!.sequence).toBe(1234n);
    expect(rows[0]!.status).toBe('pending');
  });

  it('prepares an unsigned envelope when no secret is available', async () => {
    const db = await createTestDb();
    const kp = Keypair.random();
    const destKp = Keypair.random();
    const horizon = fakeHorizon([
      {
        sourceAmount: '1',
        destinationAmount: '100',
        sourceAsset: 'XLM',
        destinationAsset: 'XLM',
        path: [],
      },
    ]);
    const service = createPathPaymentService(db, horizon as never, createLocalSigningService());
    const plan = await service.plan({
      sendAsset: 'XLM',
      sendAmount: '1',
      destAsset: 'XLM',
      destAccount: destKp.publicKey(),
    });
    const prepared = await service.prepare({ senderPublicKey: kp.publicKey(), plan });
    expect(prepared.envelopeXdr).toBeTruthy();
    const rows = await db.select().from(stellarTransactions);
    expect(rows[0]!.envelope_xdr).toBe(prepared.envelopeXdr);
  });

  it('submits and records the on-chain hash', async () => {
    const db = await createTestDb();
    const horizon = fakeHorizon();
    const service = createPathPaymentService(db, horizon as never, createLocalSigningService());
    const inserted = await db
      .insert(stellarTransactions)
      .values({
        account: 'G',
        operation_type: 'path_payment_strict_send',
        status: 'pending',
      })
      .returning({ id: stellarTransactions.id });
    const result = await service.submit({
      envelopeXdr: 'AAAA',
      stellarTransactionId: inserted[0]!.id,
    });
    expect(result.hash).toBe('hash123');
    expect(horizon.submitTransaction).toHaveBeenCalledOnce();
    const rows = await db.select().from(stellarTransactions);
    expect(rows[0]!.tx_hash).toBe('hash123');
    expect(rows[0]!.status).toBe('submitted');
  });
});