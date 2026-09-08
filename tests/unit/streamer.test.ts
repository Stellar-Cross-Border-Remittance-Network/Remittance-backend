import { describe, expect, it, vi, afterEach } from 'vitest';

import { streamCursors } from '../../src/db/schema.js';
import { PaymentStreamer } from '../../src/modules/horizon/PaymentStreamer.js';
import { createTestDb } from '../helpers/testDb.js';

type StreamHandlers = { onmessage: (r: Record<string, unknown>) => void; onerror: () => void };

function fakeHorizon() {
  const streamCalls: Array<{ account: string; cursor: string; handlers: StreamHandlers }> = [];
  const chain = {
    payments: () => ({
      forAccount: (account: string) => ({
        cursor: (cursor: string) => ({
          stream: (handlers: StreamHandlers) => {
            streamCalls.push({ account, cursor, handlers });
            return { close: vi.fn() };
          },
        }),
      }),
    }),
  };
  return { service: { raw: () => chain }, streamCalls };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

function paymentRecord(cursor: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'payment',
    paging_token: cursor,
    asset_type: 'native',
    amount: '5.0000000',
    from: 'GSENDER',
    to: 'GRECIP',
    transaction_hash: `tx-${cursor}`,
    ...overrides,
  };
}

describe('PaymentStreamer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('streams new events, persists them and advances the cursor', async () => {
    const db = await createTestDb();
    const horizon = fakeHorizon();
    const handled: string[][] = [];
    const streamer = new PaymentStreamer(
      db,
      horizon.service as never,
      async (events) => {
        handled.push(events.map((e) => e.cursor));
      },
      logger as never,
    );
    await streamer.start(['GACCOUNT']);
    expect(horizon.streamCalls).toHaveLength(1);
    expect(horizon.streamCalls[0]!.cursor).toBe('now'); // no persisted cursor yet

    // The streamer fire-and-forgets onMessage; let the async work settle.
    horizon.streamCalls[0]!.handlers.onmessage(paymentRecord('c1'));
    await vi.waitFor(() => expect(handled).toEqual([['c1']]));
    const cursors = await db.select().from(streamCursors);
    expect(cursors[0]!.account).toBe('GACCOUNT');
    expect(cursors[0]!.cursor).toBe('c1');

    // Duplicate cursor + account: deduped, handler not called again.
    horizon.streamCalls[0]!.handlers.onmessage(paymentRecord('c1'));
    await new Promise((r) => setTimeout(r, 20));
    expect(handled).toHaveLength(1);
  });

  it('resumes from the persisted cursor after a restart', async () => {
    const db = await createTestDb();
    await db.insert(streamCursors).values({ account: 'GACCOUNT', cursor: 'c42' });
    const horizon = fakeHorizon();
    const streamer = new PaymentStreamer(db, horizon.service as never, async () => undefined, logger as never);
    await streamer.start(['GACCOUNT']);
    expect(horizon.streamCalls[0]!.cursor).toBe('c42');
    await streamer.stop();
  });

  it('reconnects with backoff after a stream error', async () => {
    vi.useFakeTimers();
    const db = await createTestDb();
    const horizon = fakeHorizon();
    const streamer = new PaymentStreamer(db, horizon.service as never, async () => undefined, logger as never);
    await streamer.start(['GACCOUNT']);
    expect(horizon.streamCalls).toHaveLength(1);
    horizon.streamCalls[0]!.handlers.onerror();
    // Backoff timer fires -> watch() re-subscribes.
    await vi.advanceTimersByTimeAsync(1100);
    expect(horizon.streamCalls).toHaveLength(2);
    await streamer.stop();
  });
});