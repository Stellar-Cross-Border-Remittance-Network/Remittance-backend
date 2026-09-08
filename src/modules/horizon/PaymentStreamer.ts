import { eq } from 'drizzle-orm';

import { loadEnv } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import { streamCursors } from '../../db/schema.js';
import type { Logger } from '../../lib/logger.js';
import type { HorizonService } from './HorizonService.js';
import { normalizePayment, persistEvents, type NormalizedPayment } from './payments.js';

export type PaymentEventHandler = (events: NormalizedPayment[]) => Promise<void>;

interface StreamHandle {
  close(): void;
}

/**
 * Durable payment streaming for relevant accounts. Cursors are persisted in
 * Postgres so a crash mid-stream resumes exactly where it stopped. On stream
 * errors it reconnects with exponential backoff; the separate polling
 * reconciler is the recovery path for silent gaps.
 */
export class PaymentStreamer {
  private handles = new Map<string, StreamHandle>();
  private backoff = new Map<string, number>();
  private stopped = false;
  private retries = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly horizon: HorizonService,
    private readonly handleEvents: PaymentEventHandler,
    private readonly logger: Logger,
  ) {}

  async start(accounts: string[]): Promise<void> {
    await Promise.all(accounts.map((account) => this.watch(account)));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const h of this.handles.values()) {
      h.close();
    }
    this.handles.clear();
  }

  /** Subscribe to one account, starting from its persisted cursor. */
  private async watch(account: string): Promise<void> {
    if (this.stopped) {
      return;
    }
    const cursor = await this.loadCursor(account);
    let closed = false;
    let handle: StreamHandle | null = null;

    const onMessage = async (record: Record<string, unknown>): Promise<void> => {
      const normalized = normalizePayment(record, account);
      if (!normalized) {
        return;
      }
      const fresh = await persistEvents(this.db, [normalized]);
      if (fresh.length > 0) {
        await this.handleEvents(fresh);
        await this.setCursor(account, normalized.cursor);
        this.retries.set(account, 0);
      }
    };

    const onError = (): void => {
      if (closed || this.stopped) {
        return;
      }
      handle?.close();
      const attempt = this.retries.get(account) ?? 0;
      this.retries.set(account, attempt + 1);
      const delay = Math.min(1000 * 2 ** attempt, 30_000);
      this.logger.warn({ account, attempt, delayMs: delay }, 'payment stream error; reconnecting');
      setTimeout(() => void this.watch(account), delay);
    };

    try {
      const server = this.horizon.raw();
      const result = server
        .payments()
        .forAccount(account)
        .cursor(cursor)
        .stream({
          onmessage: (msg) => void onMessage(msg as unknown as Record<string, unknown>),
          onerror: onError,
        });
      // The stream returns either a close-handle object or a close function.
      handle = typeof result === 'function' ? { close: result } : result;
      this.handles.set(account, handle);
      this.logger.info({ account, cursor }, 'payment stream connected');
    } catch (e) {
      this.logger.error({ account, err: (e as Error).message }, 'payment stream failed to start');
      onError();
    }
  }

  private async setCursor(account: string, cursor: string): Promise<void> {
    await this.db
      .insert(streamCursors)
      .values({ account, cursor, updated_at: new Date() })
      .onConflictDoUpdate({
        target: streamCursors.account,
        set: { cursor, updated_at: new Date() },
      });
  }

  private async loadCursor(account: string): Promise<string> {
    const rows = await this.db.select().from(streamCursors).where(eq(streamCursors.account, account)).limit(1);
    if (rows.length > 0) {
      return rows[0]!.cursor;
    }
    return 'now';
  }
}

export async function latestCursor(db: Db, account: string): Promise<string> {
  const rows = await db.select().from(streamCursors).where(eq(streamCursors.account, account)).limit(1);
  return rows.length > 0 ? rows[0]!.cursor : 'now';
}