import { describe, expect, it, vi } from 'vitest';

import { streamCursors } from '../../src/db/schema.js';
import { Reconciler } from '../../src/modules/horizon/Reconciler.js';
import { createTestDb } from '../helpers/testDb.js';

// Real Horizon only returns records AFTER the given cursor. The fake mirrors
// that: pages are keyed by the cursor passed in, and an advanced cursor
// yields an empty page.
function fakeHorizon(pagesByCursor: Record<string, Array<Record<string, unknown>>>) {
  const chain = {
    payments: () => ({
      forAccount: (_account: string) => ({
        cursor: (cursor: string) => ({
          limit: (_n: number) => ({
            call: async () => {
              const records = pagesByCursor[cursor] ?? [];
              return {
                records,
                next: async () => ({ records: [] }),
              };
            },
          }),
        }),
      }),
    }),
  };
  return { service: { raw: () => chain } };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

function record(cursor: string) {
  return {
    type: 'payment',
    paging_token: cursor,
    asset_type: 'native',
    amount: '1.0',
    from: 'GA',
    to: 'GB',
  };
}

describe('Reconciler', () => {
  it('reconciles accounts, persists new events and advances cursors', async () => {
    const db = await createTestDb();
    const horizon = fakeHorizon({ now: [record('p1'), record('p2')] });
    const handled: string[] = [];
    const reconciler = new Reconciler(
      db,
      horizon.service as never,
      async (events) => {
        for (const e of events) {
          handled.push(e.cursor);
        }
      },
      logger as never,
    );
    const processed = await reconciler.reconcileAll(['GACCOUNT']);
    expect(processed).toBe(2);
    expect(handled).toEqual(['p1', 'p2']);
    const cursors = await db.select().from(streamCursors);
    expect(cursors[0]!.cursor).toBe('p2');

    // A second pass finds nothing new (dedupe on cursor).
    const again = await reconciler.reconcileAll(['GACCOUNT']);
    expect(again).toBe(0);
  });

  it('fills gaps from the persisted cursor and stays safe with overlap', async () => {
    const db = await createTestDb();
    await db.insert(streamCursors).values({ account: 'GACCOUNT', cursor: 'p5' });
    const horizon = fakeHorizon({ p5: [record('p6')] });
    const reconciler = new Reconciler(db, horizon.service as never, async () => undefined, logger as never);
    const processed = await reconciler.reconcileAll(['GACCOUNT']);
    expect(processed).toBe(1);
    const cursors = await db.select().from(streamCursors);
    expect(cursors[0]!.cursor).toBe('p6');
  });

  it('swallows a failing pass so the loop keeps running', async () => {
    const db = await createTestDb();
    const broken = {
      payments: () => ({
        forAccount: () => ({
          cursor: () => ({
            limit: () => ({
              call: async () => {
                throw new Error('horizon timeout');
              },
            }),
          }),
        }),
      }),
    };
    const reconciler = new Reconciler(db, broken as never, async () => undefined, logger as never);
    await expect(reconciler.reconcileAll(['GACCOUNT'])).resolves.toBe(0);
  });
});