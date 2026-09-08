import { afterEach, describe, expect, it, vi } from 'vitest';

import { anchors, sepTransactions } from '../../src/db/schema.js';
import { createSep6Service } from '../../src/modules/sep6/Sep6Service.js';
import { createTestDb } from '../helpers/testDb.js';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function seedAnchor(
  db: Awaited<ReturnType<typeof createTestDb>>,
  overrides: Partial<typeof anchors.$inferInsert> = {},
) {
  const row = await db
    .insert(anchors)
    .values({
      home_domain: 'anchor.example.com',
      transfer_server_sep6: 'https://anchor.example.com/sep6',
      transfer_server_sep24: 'https://anchor.example.com/sep24',
      sep6_enabled: true,
      sep24_enabled: true,
      ...overrides,
    })
    .returning({ id: anchors.id });
  return row[0]!.id;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Sep6Service', () => {
  it('performs a programmatic deposit (SEP6 preference)', async () => {
    const db = await createTestDb();
    const anchorId = await seedAnchor(db);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          id: 'sep6-tx-1',
          status: 'pending',
          instructions: { bank_account: { name: 'Acme', account_number: '0123' } },
        }),
      ),
    );
    const service = createSep6Service(db);
    const result = await service.deposit({
      anchorId,
      assetCode: 'NGN',
      account: 'GACCOUNT',
      amount: '100',
      jwt: 'jwt',
      preference: 'SEP6',
    });
    expect(result.protocol).toBe('sep6');
    expect(result.instructions).toBeTruthy();
    const rows = await db.select().from(sepTransactions);
    expect(rows[0]!.protocol).toBe('sep6');
    expect(rows[0]!.anchor_tx_id).toBe('sep6-tx-1');
  });

  it('AUTO prefers SEP-24 and falls back to SEP-6 when the anchor errors', async () => {
    const db = await createTestDb();
    const anchorId = await seedAnchor(db);
    const fetchMock = vi
      .fn()
      // SEP-24 deposit attempt fails at the anchor…
      .mockResolvedValueOnce(jsonResponse({ error: 'interactive unavailable' }, 400))
      // …then SEP-6 succeeds.
      .mockResolvedValueOnce(jsonResponse({ id: 'sep6-after-fallback', status: 'pending' }));
    vi.stubGlobal('fetch', fetchMock);
    const service = createSep6Service(db);
    const result = await service.deposit({
      anchorId,
      assetCode: 'NGN',
      account: 'GACCOUNT',
      jwt: 'jwt',
      preference: 'AUTO',
    });
    expect(result.protocol).toBe('sep6');
    // The result id is the internal transaction row id; the anchor's id is
    // kept in the stored row.
    expect(typeof result.id).toBe('string');
    expect(result.instructions?.id).toBe('sep6-after-fallback');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('AUTO uses SEP-24 when it succeeds', async () => {
    const db = await createTestDb();
    const anchorId = await seedAnchor(db);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          id: 'sep24-tx',
          url: 'https://anchor.example.com/interactive?token=x',
        }),
      ),
    );
    const service = createSep6Service(db);
    const result = await service.deposit({
      anchorId,
      assetCode: 'NGN',
      account: 'GACCOUNT',
      jwt: 'jwt',
      preference: 'AUTO',
    });
    expect(result.protocol).toBe('sep24');
    expect(result.url).toContain('interactive');
  });

  it('SEP24 preference surfaces the anchor error instead of falling back', async () => {
    const db = await createTestDb();
    const anchorId = await seedAnchor(db);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 400)));
    const service = createSep6Service(db);
    await expect(
      service.deposit({
        anchorId,
        assetCode: 'NGN',
        account: 'GACCOUNT',
        jwt: 'jwt',
        preference: 'SEP24',
      }),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it('rejects an anchor that supports neither protocol', async () => {
    const db = await createTestDb();
    const anchorId = await seedAnchor(db, {
      transfer_server_sep24: null,
      sep24_enabled: false,
      transfer_server_sep6: null,
      sep6_enabled: false,
    });
    const service = createSep6Service(db);
    await expect(
      service.withdraw({ anchorId, assetCode: 'NGN', account: 'G', jwt: 'jwt', preference: 'SEP6' }),
    ).rejects.toThrow(/supports neither/i);
  });

  it('looks up SEP-6 transaction status', async () => {
    const db = await createTestDb();
    const anchorId = await seedAnchor(db);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ transaction: { id: 't', status: 'completed' } })),
    );
    const service = createSep6Service(db);
    const body = await service.transactionStatus(anchorId, 't', 'jwt');
    expect((body.transaction as { status: string }).status).toBe('completed');
  });
});