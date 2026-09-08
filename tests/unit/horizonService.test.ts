import { describe, expect, it, vi } from 'vitest';

import { Account, Asset, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

const PASSPHRASE = 'Test SDF Network ; September 2015';

function validEnvelope(): string {
  const kp = Keypair.random();
  return new TransactionBuilder(new Account(kp.publicKey(), '-1'), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.payment({ destination: kp.publicKey(), asset: Asset.native(), amount: '1' }))
    .setTimeout(300)
    .build()
    .toXDR();
}

// Mock only the Horizon.Server class; keep the rest of the SDK real.
const loadAccountMock = vi.fn();
const submitTxMock = vi.fn();
const strictSendMock = vi.fn();

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    Horizon: {
      Server: class FakeServer {
        constructor(public url: string) {}
        loadAccount = loadAccountMock;
        submitTransaction = submitTxMock;
        strictSendPaths() {
          return { call: strictSendMock };
        }
      },
    },
  };
});

import { createHorizonService } from '../../src/modules/horizon/HorizonService.js';

function fakeAccount() {
  return {
    accountId: () => 'GACCOUNT',
    sequence: '100',
    balances: [
      { asset_type: 'native', balance: '10.5' },
      { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GUSDC', balance: '3.0', limit: '100' },
      { asset_type: 'liquidity_pool_shares', balance: '1' },
    ],
    signers: [{ key: 'GACCOUNT', weight: 1 }],
    thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 3 },
  };
}

describe('HorizonService', () => {
  it('loads and normalizes an account record', async () => {
    loadAccountMock.mockResolvedValueOnce(fakeAccount());
    const service = createHorizonService();
    const acc = await service.loadAccount('GACCOUNT');
    expect(acc.sequence).toBe('100');
    expect(acc.balances).toEqual([
      { asset: 'XLM', balance: '10.5' },
      { asset: 'USDC:GUSDC', balance: '3.0', limit: '100' },
    ]);
    expect(acc.thresholds.med_threshold).toBe(2);
  });

  it('maps loadAccount failures to upstream errors', async () => {
    loadAccountMock.mockRejectedValueOnce(new Error('404'));
    const service = createHorizonService();
    await expect(service.loadAccount('GUNKNOWN')).rejects.toMatchObject({ statusCode: 502 });
  });

  it('submits a transaction and returns the hash', async () => {
    submitTxMock.mockResolvedValueOnce({ hash: 'h1', ledger: 7 });
    const service = createHorizonService();
    const res = await service.submitTransaction(validEnvelope());
    expect(res.hash).toBe('h1');
    expect(res.ledger).toBe(7);
  });

  it('surfaces Horizon result codes on rejection', async () => {
    submitTxMock.mockRejectedValueOnce({
      response: { data: { extras: { result_codes: { transaction: 'tx_bad_seq' } } } },
    });
    const service = createHorizonService();
    await expect(service.submitTransaction(validEnvelope())).rejects.toThrow(/tx_bad_seq/);
  });

  it('returns strict-send paths with human-readable hops', async () => {
    strictSendMock.mockResolvedValueOnce({
      records: [
        {
          source_amount: '1',
          destination_amount: '150',
          source_asset_type: 'native',
          destination_asset_type: 'credit_alphanum4',
          destination_asset_code: 'NGN',
          destination_asset_issuer: 'GNGN',
          path: [{ asset_type: 'native' }],
        },
      ],
    });
    const service = createHorizonService();
    const paths = await service.strictSendPaths({
      sourceAsset: { isNative: () => true } as never,
      sourceAmount: '1',
      destinationAccount: 'GRECIP',
    });
    expect(paths[0]!.sourceAsset).toBe('XLM');
    expect(paths[0]!.destinationAsset).toBe('NGN:GNGN');
    expect(paths[0]!.path).toEqual(['XLM']);
  });

  it('maps strict-send failures to upstream errors', async () => {
    strictSendMock.mockRejectedValueOnce(new Error('rate limit'));
    const service = createHorizonService();
    await expect(
      service.strictSendPaths({ sourceAsset: {} as never, sourceAmount: '1', destinationAccount: 'G' }),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it('exposes the raw server for streaming', () => {
    const service = createHorizonService();
    expect(service.raw()).toBeTruthy();
  });
});