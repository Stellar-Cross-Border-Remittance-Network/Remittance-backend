import { afterEach, describe, expect, it, vi } from 'vitest';

import { anchors, sepTransactions } from '../../src/db/schema.js';
import { createSep24Service } from '../../src/modules/sep24/Sep24Service.js';
import { createTestDb } from '../helpers/testDb.js';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function seedAnchor(db: Awaited<ReturnType<typeof createTestDb>>, overrides: Partial<typeof anchors.$inferInsert> = {}) {
  const row = await db
    .insert(anchors)
    .values({
      home_domain: 'anchor.example.com',
      transfer_server_sep24: 'https://anchor.example.com/sep24',
      sep24_enabled: true,
      ...overrides,
    })
    .returning({ id: anchors.id });
  return row[0]!.id;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Sep24Service', () => {
  it('creates an interactive deposit and persists the transaction', async () => {
    const db = await createTestDb();
    const anchorId = await seedAnchor(db);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          id: 'anchor-tx-1',
          url: 'https://anchor.example.com/interactive?token=abc',
          more_info_url: 'https://anchor.example.com/more/1',
        }),
      ),
    );
    const service = createSep24Service(db);
    const result = await service.deposit({
      anchorId,
      assetCode: 'USDC',
      account: 'GACCOUNT',
      amount: '100',
      jwt: 'anchor-jwt',
    });
    expect(result.url).toBe('https://anchor.example.com/interactive?token=abc');
    expect(result.status).toBe('pending');

    const rows = await db.select().from(sepTransactions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.protocol).toBe('sep24');
    expect(rows[0]!.anchor_tx_id).toBe('anchor-tx-1');
    expect(rows[0]!.interactive_url).toContain('token=abc');
    expect(rows[0]!.kind).toBe('deposit');
  });

  it('creates a withdrawal', async () => {
    const db = await createTestDb();
    const anchorId = await seedAnchor(db);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 'w-1', url: 'https://anchor.example.com/w' })));
    const service = createSep24Service(db);
    const result = await service.withdraw({
      anchorId,
      assetCode: 'NGN',
      account: 'GACCOUNT',
      jwt: 'jwt',
    });
    expect(result.id).toBeTruthy();
    const rows = await db.select().from(sepTransactions);
    expect(rows[0]!.kind).toBe('withdraw');
    expect(rows[0]!.asset_out).toBe('NGN');
  });

  it('rejects anchors without SEP-24', async () => {
    const db = await createTestDb();
    const anchorId = await seedAnchor(db, { transfer_server_sep24: null, sep24_enabled: false });
    const service = createSep24Service(db);
    await expect(
      service.deposit({ anchorId, assetCode: 'USDC', account: 'G', jwt: 'jwt' }),
    ).rejects.toThrow(/does not support SEP-24/i);
  });

  it('rejects a deposit response without a transaction id', async () => {
    const db = await createTestDb();
    const anchorId = await seedAnchor(db);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ url: 'https://x' })));
    const service = createSep24Service(db);
    await expect(
      service.deposit({ anchorId, assetCode: 'USDC', account: 'G', jwt: 'jwt' }),
    ).rejects.toThrow(/missing transaction id/i);
  });

  it('maps anchor failures to upstream errors', async () => {
    const db = await createTestDb();
    const anchorId = await seedAnchor(db);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('anchor down')));
    const service = createSep24Service(db);
    await expect(
      service.deposit({ anchorId, assetCode: 'USDC', account: 'G', jwt: 'jwt' }),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it('looks up transaction status', async () => {
    const db = await createTestDb();
    const anchorId = await seedAnchor(db);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ transaction: { id: 't1', status: 'completed' } })),
    );
    const service = createSep24Service(db);
    const body = await service.transactionStatus(anchorId, 't1', 'jwt');
    expect((body.transaction as { status: string }).status).toBe('completed');
  });

  it('throws upstream when the anchor rejects a status lookup', async () => {
    const db = await createTestDb();
    const anchorId = await seedAnchor(db);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'x' }, 404)));
    const service = createSep24Service(db);
    await expect(service.transactionStatus(anchorId, 't1', 'jwt')).rejects.toMatchObject({
      statusCode: 502,
    });
  });
});