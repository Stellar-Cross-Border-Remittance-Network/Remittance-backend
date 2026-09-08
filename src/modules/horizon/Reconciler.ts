import { loadEnv } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import { streamCursors } from '../../db/schema.js';
import type { Logger } from '../../lib/logger.js';
import type { HorizonService } from './HorizonService.js';
import { latestCursor } from './PaymentStreamer.js';
import { normalizePayment, persistEvents, type NormalizedPayment } from './payments.js';

/**
 * Polling reconciliation — the recovery layer for the SSE stream. If the
 * streamer silently drops events (reconnect gaps, proxy timeouts), polling
 * Horizon for payments after the last persisted cursor fills the hole.
 * Dedupe via unique(cursor, account) makes stream + poll overlap safe.
 */
export class Reconciler {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly horizon: HorizonService,
    private readonly handleEvents: (events: NormalizedPayment[]) => Promise<void>,
    private readonly logger: Logger,
  ) {}

  start(accounts: string[], intervalMs?: number): void {
    const env = loadEnv();
    const interval = intervalMs ?? env.POLL_RECONCILE_INTERVAL_MS;
    this.timer = setInterval(() => void this.reconcileAll(accounts), interval);
    this.timer.unref?.();
    this.logger.info({ accounts, intervalMs: interval }, 'polling reconciler started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Reconcile all watched accounts once (exposed for tests/manual runs). */
  async reconcileAll(accounts: string[]): Promise<number> {
    let total = 0;
    for (const account of accounts) {
      total += await this.reconcileAccount(account);
    }
    return total;
  }

  private async reconcileAccount(account: string): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      const cursor = await latestCursor(this.db, account);
      let page = await this.horizon.raw().payments().forAccount(account).cursor(cursor).limit(200).call();
      let processed = 0;
      while (page.records.length > 0) {
        const events: NormalizedPayment[] = [];
        for (const record of page.records) {
          const normalized = normalizePayment(record as unknown as Record<string, unknown>, account);
          if (normalized) {
            events.push(normalized);
          }
        }
        const fresh = await persistEvents(this.db, events);
        if (fresh.length > 0) {
          await this.handleEvents(fresh);
        }
        processed += events.length;
        const last = events[events.length - 1];
        if (last) {
          await this.db
            .insert(streamCursors)
            .values({ account, cursor: last.cursor, updated_at: new Date() })
            .onConflictDoUpdate({
              target: streamCursors.account,
              set: { cursor: last.cursor, updated_at: new Date() },
            });
        }
        if (!page.records.some((r) => r.paging_token !== undefined)) {
          break;
        }
        page = await page.next();
      }
      return processed;
    } catch (e) {
      this.logger.warn({ account, err: (e as Error).message }, 'reconcile pass failed');
      return 0;
    } finally {
      this.running = false;
    }
  }
}