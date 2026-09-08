import { describe, expect, it, vi } from 'vitest';

import { anchors, remittances, sepTransactions } from '../../src/db/schema.js';
import { encryptSecret } from '../../src/lib/crypto.js';
import { createJobManager } from '../../src/modules/remittance/jobs.js';
import { createTestDb } from '../helpers/testDb.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

async function seedRemittance(
  db: Awaited<ReturnType<typeof createTestDb>>,
  status: string,
  opts: { expired?: boolean; contractId?: string } = {},
) {
  const row = await db
    .insert(remittances)
    .values({
      recipient_address: 'r',
      recipient_stellar_account: 'GRECIP',
      source_asset: 'USDC:GUSDC',
      source_amount_stroops: 1000000000n,
      destination_asset: 'NGN:GNGN',
      expected_destination_amount_stroops: 1n,
      corridor: 'US/NG',
      quote_hash: 'h'.repeat(64),
      status,
      lifecycle: status === 'CREATED' ? 'QUOTE_CREATED' : 'TRANSFER_INITIATED',
      contract_remittance_id: opts.contractId ?? null,
      expiry: opts.expired ? new Date(Date.now() - 1000) : new Date(Date.now() + 60_000),
    })
    .returning({ id: remittances.id });
  return row[0]!.id;
}

describe('JobManager maintenance passes', () => {
  it('expires CREATED remittances past their business expiry', async () => {
    const db = await createTestDb();
    await seedRemittance(db, 'CREATED', { expired: true });
    await seedRemittance(db, 'CREATED', { expired: false });
    const jobs = createJobManager(db, {} as never, logger as never);
    const refunded = await jobs.runExpirySweep();
    expect(refunded).toBe(0);
    const rows = await db.select().from(remittances);
    const expired = rows.find((r) => r.expiry.getTime() < Date.now());
    expect(expired?.status).toBe('EXPIRED');
    const fresh = rows.find((r) => r.expiry.getTime() >= Date.now());
    expect(fresh?.status).toBe('CREATED');
  });

  it('auto-refunds funded remittances past expiry through the contract', async () => {
    const db = await createTestDb();
    await seedRemittance(db, 'FUNDED', { expired: true, contractId: '0' });
    const soroban = {
      roleSigner: () => ({ publicKey: 'G', secret: 's' }),
      refund: vi.fn().mockResolvedValue('100'),
    };
    const jobs = createJobManager(db, { soroban } as never, logger as never);
    const refunded = await jobs.runExpirySweep();
    expect(refunded).toBe(1);
    expect(soroban.refund).toHaveBeenCalledWith('0', expect.anything(), expect.anything());
    const rows = await db.select().from(remittances);
    expect(rows[0]!.status).toBe('REFUNDED');
    expect(rows[0]!.settled_at).toBeTruthy();
  });

  it('keeps going when a refund fails', async () => {
    const db = await createTestDb();
    await seedRemittance(db, 'FUNDED', { expired: true, contractId: '0' });
    await seedRemittance(db, 'FUNDED', { expired: true, contractId: '1' });
    const soroban = {
      roleSigner: () => ({ publicKey: 'G', secret: 's' }),
      refund: vi
        .fn()
        .mockRejectedValueOnce(new Error('rpc down'))
        .mockResolvedValueOnce('50'),
    };
    const jobs = createJobManager(db, { soroban } as never, logger as never);
    const refunded = await jobs.runExpirySweep();
    expect(refunded).toBe(1);
  });

  it('polls anchor transactions and settles completed ones', async () => {
    const db = await createTestDb();
    const remittanceId = await seedRemittance(db, 'PROCESSING', { contractId: '0' });
    const anchor = await db
      .insert(anchors)
      .values({ home_domain: 'anchor.example.com', sep24_enabled: true })
      .returning({ id: anchors.id });
    await db.insert(sepTransactions).values({
      remittance_id: remittanceId,
      kind: 'deposit',
      protocol: 'sep24',
      anchor_id: anchor[0]!.id,
      anchor_tx_id: 'atx-1',
      anchor_jwt_encrypted: encryptSecret('anchor-jwt'),
      status: 'pending',
    });
    const remittance = {
      onAnchorStatus: vi.fn().mockResolvedValue(undefined),
    };
    const sep24 = {
      transactionStatus: vi.fn().mockResolvedValue({
        transaction: { id: 'atx-1', status: 'completed' },
      }),
    };
    const sep6 = { transactionStatus: vi.fn() };
    const jobs = createJobManager(
      db,
      { remittance, sep24, sep6 } as never,
      logger as never,
    );
    const completed = await jobs.pollAnchorTransactions();
    expect(completed).toBe(1);
    expect(remittance.onAnchorStatus).toHaveBeenCalledWith(remittanceId, 'completed');
    const rows = await db.select().from(sepTransactions);
    expect(rows[0]!.status).toBe('completed');
    expect(rows[0]!.anchor_tx_status).toBe('completed');
  });

  it('routes payment events inline when Redis is disabled', async () => {
    const db = await createTestDb();
    const remittance = { applyPaymentEvent: vi.fn().mockResolvedValue(undefined) };
    const jobs = createJobManager(db, { remittance } as never, logger as never);
    await jobs.enqueuePaymentEvent('rid', { cursor: 'c', account: 'GA', type: 'payment' });
    expect(remittance.applyPaymentEvent).toHaveBeenCalledOnce();
  });
});