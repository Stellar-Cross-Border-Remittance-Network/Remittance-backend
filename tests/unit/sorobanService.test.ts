import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Keypair } from '@stellar/stellar-sdk';

import { createSorobanService } from '../../src/modules/soroban/SorobanService.js';
import { createTestDb } from '../helpers/testDb.js';

// Mock the generated bindings client (dynamic import) and the RPC module.
let lastArgs: Record<string, unknown> = {};
const signAndSendMock = vi.fn();
const toXDRMock = vi.fn().mockReturnValue('AAAA-UXOR');

class FakeClient {
  constructor(opts: Record<string, unknown>) {
    this.opts = opts;
  }
  opts: Record<string, unknown>;
  async create_remittance(args: Record<string, unknown>) {
    lastArgs = args;
    signAndSendMock.mockResolvedValueOnce({ result: { ok: '0' } });
    return { signAndSend: signAndSendMock, toXDR: toXDRMock };
  }
  async fund_remittance(args: Record<string, unknown>) {
    lastArgs = args;
    signAndSendMock.mockResolvedValueOnce({ result: { ok: undefined } });
    return { signAndSend: signAndSendMock, toXDR: toXDRMock };
  }
  async begin_processing(args: Record<string, unknown>) {
    lastArgs = args;
    signAndSendMock.mockResolvedValueOnce({ result: { ok: undefined } });
    return { signAndSend: signAndSendMock, toXDR: toXDRMock };
  }
  async authorize_settlement(args: Record<string, unknown>) {
    lastArgs = args;
    signAndSendMock.mockResolvedValueOnce({ result: { ok: undefined } });
    return { signAndSend: signAndSendMock, toXDR: toXDRMock };
  }
  async release(args: Record<string, unknown>) {
    lastArgs = args;
    signAndSendMock.mockResolvedValueOnce({ result: { ok: { recipient_amount: 995000000n, platform_fee: 5000000n, corridor_fee: 0n, anchor_fee: 0n } } });
    return { signAndSend: signAndSendMock };
  }
  async refund(args: Record<string, unknown>) {
    lastArgs = args;
    signAndSendMock.mockResolvedValueOnce({ result: { ok: 1000000000n } });
    return { signAndSend: signAndSendMock, toXDR: toXDRMock };
  }
  async get_remittance(args: Record<string, unknown>) {
    lastArgs = args;
    return { result: { ok: { id: '0', status: 'Funded', sender: 'G' } } };
  }
  async status_of(args: Record<string, unknown>) {
    lastArgs = args;
    return { result: { ok: 'Funded' } };
  }
  async remittance_count(args: Record<string, unknown>) {
    lastArgs = args;
    return { result: { ok: 3 } };
  }
}

vi.mock('../../src/modules/soroban/bindings/src/index.js', () => ({
  Client: FakeClient,
}));

let getTxStatus = 'SUCCESS';
vi.mock('@stellar/stellar-sdk/rpc', () => ({
  rpc: {
    Server: class {
      async getTransaction() {
        return { status: getTxStatus, error: 'boom' };
      }
      async sendTransaction() {
        return { status: 'PENDING' };
      }
    },
  },
}));

let REMITTANCE_ID = '00000000-0000-4000-8000-000000000001';

async function seedRemittance(db: Awaited<ReturnType<typeof createTestDb>>): Promise<string> {
  const { remittances } = await import('../../src/db/schema.js');
  const row = await db
    .insert(remittances)
    .values({
      recipient_address: 'r',
      recipient_stellar_account: 'GRECIP',
      source_asset: 'USDC:GUSDC',
      source_amount_stroops: 1000000000n,
      destination_asset: 'NGN:GNGN',
      expected_destination_amount_stroops: 995000000n,
      corridor: 'US/NG',
      quote_hash: 'ab'.repeat(32),
      expiry: new Date(Date.now() + 60_000),
    })
    .returning({ id: remittances.id });
  return row[0]!.id;
}

const commitment = {
  sender: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  recipient: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  sourceAsset: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  sourceAmountStroops: 1000000000n,
  destinationAsset: 'NGN',
  expectedDestinationAmountStroops: 995000000n,
  corridor: 'US/NG',
  quoteHash: 'ab'.repeat(32),
  expiry: 2000000000,
};

describe('SorobanService', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
    REMITTANCE_ID = await seedRemittance(db);
    lastArgs = {};
    getTxStatus = 'SUCCESS';
    signAndSendMock.mockReset();
  });

  it('derives SAC addresses for native and issued assets', () => {
    const service = createSorobanService(db);
    expect(service.sacAddress('XLM')).toMatch(/^C/);
    const issued = service.sacAddress('USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
    expect(issued).toMatch(/^C/);
    expect(() => service.sacAddress('bogus')).toThrow();
  });

  it('builds role signers from env secrets', () => {
    const service = createSorobanService(db);
    const signer = service.roleSigner('oracle');
    expect(signer.publicKey).toMatch(/^G[A-Z0-9]{55}$/);
    expect(signer.secret).toBeTruthy();
  });

  it('creates a remittance and returns the on-chain id', async () => {
    const service = createSorobanService(db);
    const { id } = await service.createRemittance(commitment, { publicKey: commitment.sender, secret: 'S' });
    expect(id).toBe('0');
    expect(lastArgs.sender).toBeTruthy();
    expect(lastArgs.source_asset).toMatch(/^C/);
    expect(lastArgs.source_amount).toBe('1000000000');
    expect(lastArgs.quote_hash).toEqual(Buffer.from('ab'.repeat(32), 'hex'));
    expect(lastArgs.expiry).toBe(2000000000n);
  });

  it('funds, processes and authorizes settlement', async () => {
    const service = createSorobanService(db);
    await service.fundRemittance('0', { publicKey: commitment.sender, secret: 'S' }, REMITTANCE_ID);
    await service.beginProcessing('0', service.roleSigner('oracle'), REMITTANCE_ID);
    await service.authorizeSettlement('0', commitment, service.roleSigner('oracle'), REMITTANCE_ID);
    expect(lastArgs.id).toBe(0n);
  });

  it('releases and converts the summary from stroops', async () => {
    const service = createSorobanService(db);
    const summary = await service.release('0', REMITTANCE_ID);
    expect(summary.recipient_amount).toBe('99.5');
    expect(summary.platform_fee).toBe('0.5');
  });

  it('refunds and converts the amount', async () => {
    const service = createSorobanService(db);
    const amount = await service.refund('0', service.roleSigner('admin'), REMITTANCE_ID);
    expect(amount).toBe('100');
  });

  it('reads state from the contract', async () => {
    const service = createSorobanService(db);
    expect(await service.remittanceCount()).toBe(3);
    const rec = await service.getRemittance('0');
    expect(rec.status).toBe('Funded');
    expect(await service.statusOf('0')).toBe('Funded');
  });

  it('waits for transaction finality and surfaces failures', async () => {
    const service = createSorobanService(db);
    await expect(service.waitForTransaction('abc')).resolves.toBeUndefined();
    getTxStatus = 'FAILED';
    await expect(service.waitForTransaction('abc', 5000)).rejects.toThrow(/failed/i);
  });

  it('prepares unsigned envelopes for on-device signing', async () => {
    const service = createSorobanService(db);
    expect(await service.prepareCreateRemittance(commitment, commitment.sender)).toBe('AAAA-UXOR');
    expect(await service.prepareFundRemittance('0', commitment.sender)).toBe('AAAA-UXOR');
    expect(await service.prepareRefund('0', commitment.sender)).toBe('AAAA-UXOR');
  });

  it('submits a signed envelope and returns its hash', async () => {
    const { Account, Operation, TransactionBuilder, Asset } = await import('@stellar/stellar-sdk');
    const kp = Keypair.random();
    const envelope = new TransactionBuilder(new Account(kp.publicKey(), '-1'), {
      fee: '100',
      networkPassphrase: 'Test SDF Network ; September 2015',
    })
      .addOperation(Operation.payment({ destination: kp.publicKey(), asset: Asset.native(), amount: '1' }))
      .setTimeout(300)
      .build()
      .toXDR();
    const service = createSorobanService(db);
    const { txHash } = await service.submitEnvelope(envelope, 5000);
    expect(txHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records failed invocations with the error', async () => {
    const service = createSorobanService(db);
    signAndSendMock.mockRejectedValueOnce(new Error('rejected by RPC'));
    await expect(
      service.fundRemittance('0', { publicKey: commitment.sender, secret: 'S' }, REMITTANCE_ID),
    ).rejects.toThrow(/rejected by RPC/);
    const { sorobanTransactions } = await import('../../src/db/schema.js');
    const rows = await db.select().from(sorobanTransactions);
    expect(rows.some((r) => r.status === 'failed' && r.error?.includes('rejected'))).toBe(true);
  });
});