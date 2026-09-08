import { Queue, Worker, type Job } from 'bullmq';
import { and, eq, inArray, lte } from 'drizzle-orm';
import { Redis } from 'ioredis';

import { loadEnv } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import { remittances, sepTransactions } from '../../db/schema.js';
import { decryptSecret } from '../../lib/crypto.js';
import type { Logger } from '../../lib/logger.js';
import type { RemittanceService } from './RemittanceService.js';
import type { Sep24Service } from '../sep24/Sep24Service.js';
import type { Sep6Service } from '../sep6/Sep6Service.js';
import type { SorobanService } from '../soroban/SorobanService.js';
import type { NormalizedPayment } from '../horizon/payments.js';

const JOB_EXPIRY_SWEEP = 'expiry-sweep';
const JOB_ANCHOR_POLL = 'anchor-poll';
const JOB_PAYMENT_EVENT = 'payment-event';
export const QUEUE_NAME = 'remittance-jobs';

export interface JobManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Route a streamed payment event; falls back to inline processing when Redis is down. */
  enqueuePaymentEvent(remittanceId: string, event: NormalizedPayment): Promise<void>;
  enqueueAnchorStatusPoll(): Promise<void>;
}

interface Services {
  remittance: RemittanceService;
  soroban: SorobanService;
  sep24: Sep24Service;
  sep6: Sep6Service;
}

export function createJobManager(
  db: Db,
  services: Services,
  logger: Logger,
): JobManager {
  const env = loadEnv();
  const redisEnabled = env.STREAM_ENABLED;
  let redis: Redis | undefined;
  let queue: Queue | undefined;
  let worker: Worker | undefined;

  async function expirySweep(): Promise<number> {
    const now = new Date();
    const expired = await db
      .select()
      .from(remittances)
      .where(
        and(
          inArray(remittances.status, ['CREATED', 'FUNDED', 'PROCESSING']),
          lte(remittances.expiry, now),
        ),
      );
    let refunded = 0;
    for (const r of expired) {
      if (r.status === 'CREATED') {
        await db
          .update(remittances)
          .set({ status: 'EXPIRED', lifecycle: 'EXPIRED', updated_at: now })
          .where(eq(remittances.id, r.id));
        continue;
      }
      // Funded/Processing past expiry: contract refund is permissionless and
      // pays the recorded sender.
      if (r.contract_remittance_id) {
        try {
          const payer = services.soroban.roleSigner('fee_payer');
          const amount = await services.soroban.refund(r.contract_remittance_id, payer, r.id);
          await db
            .update(remittances)
            .set({ status: 'REFUNDED', lifecycle: 'REFUNDED', settled_at: now, updated_at: now })
            .where(eq(remittances.id, r.id));
          refunded += 1;
          logger.info({ remittance: r.id, amount }, 'expired remittance auto-refunded');
        } catch (e) {
          logger.error(
            { remittance: r.id, err: (e as Error).message },
            'expired remittance refund failed',
          );
        }
      }
    }
    return refunded;
  }

  async function anchorPoll(): Promise<number> {
    const pending = await db
      .select()
      .from(sepTransactions)
      .where(eq(sepTransactions.status, 'pending'))
      .limit(100);
    let completed = 0;
    for (const tx of pending) {
      if (!tx.anchor_jwt_encrypted) {
        continue;
      }
      try {
        const jwt = decryptSecret(tx.anchor_jwt_encrypted);
        const statusBody =
          tx.protocol === 'sep24'
            ? await services.sep24.transactionStatus(tx.anchor_id!, tx.anchor_tx_id!, jwt)
            : await services.sep6.transactionStatus(tx.anchor_id!, tx.anchor_tx_id!, jwt);
        const status = String(
          (statusBody.transaction as Record<string, unknown> | undefined)?.status ??
            statusBody.status ??
            '',
        );
        await db
          .update(sepTransactions)
          .set({ anchor_tx_status: status, status: status === 'completed' ? 'completed' : 'pending', updated_at: new Date() })
          .where(eq(sepTransactions.id, tx.id));
        if (status === 'completed' && tx.remittance_id) {
          await services.remittance.onAnchorStatus(tx.remittance_id, 'completed');
          completed += 1;
        }
        if (status === 'error' || status === 'failed' || status === 'expired') {
          logger.warn({ sepTx: tx.id, status }, 'anchor transaction failed');
        }
      } catch (e) {
        logger.warn({ sepTx: tx.id, err: (e as Error).message }, 'anchor status poll failed');
      }
    }
    return completed;
  }

  async function handleJob(job: Job): Promise<void> {
    switch (job.name) {
      case JOB_EXPIRY_SWEEP:
        await expirySweep();
        break;
      case JOB_ANCHOR_POLL:
        await anchorPoll();
        break;
      case JOB_PAYMENT_EVENT: {
        const { remittanceId, event } = job.data as {
          remittanceId: string;
          event: NormalizedPayment;
        };
        await services.remittance.applyPaymentEvent(remittanceId, event);
        break;
      }
      default:
        logger.warn({ name: job.name }, 'unknown job');
    }
  }

  return {
    async start() {
      if (!redisEnabled) {
        logger.info('jobs disabled (STREAM_ENABLED=false)');
        return;
      }
      redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
      redis.on('error', (e) => logger.warn({ err: e.message }, 'redis error'));
      queue = new Queue(QUEUE_NAME, { connection: redis });
      worker = new Worker(QUEUE_NAME, handleJob, { connection: redis, concurrency: 5 });
      worker.on('failed', (job, err) =>
        logger.error({ job: job?.name, err: err.message }, 'job failed'),
      );
      await queue.upsertJobScheduler(JOB_EXPIRY_SWEEP, { every: 60_000 }, { name: JOB_EXPIRY_SWEEP });
      await queue.upsertJobScheduler(JOB_ANCHOR_POLL, { every: 30_000 }, { name: JOB_ANCHOR_POLL });
      logger.info('job manager started');
    },

    async stop() {
      await worker?.close();
      await queue?.close();
      await redis?.quit();
      worker = undefined;
      queue = undefined;
      redis = undefined;
    },

    async enqueuePaymentEvent(remittanceId, event) {
      if (queue) {
        await queue.add(JOB_PAYMENT_EVENT, { remittanceId, event }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });
      } else {
        await services.remittance.applyPaymentEvent(remittanceId, event);
      }
    },

    async enqueueAnchorStatusPoll() {
      await queue?.add(JOB_ANCHOR_POLL, {}, { attempts: 1 });
    },
  };
}