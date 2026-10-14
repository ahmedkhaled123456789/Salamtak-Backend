import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../config/env';
import { logger } from '../config/logger';
import {
  QUEUE_NAMES,
  type EnqueueOptions,
  type JobRetryPolicy,
  type QueueBackend,
  type QueueName,
  type QueueStats,
  type WorkerInfo,
} from './names';

export interface BullBackendOptions {
  redisUrl?: string;
  prefix?: string;
  retry?: Partial<JobRetryPolicy>;
}

const DEFAULT_RETRY: JobRetryPolicy = {
  attempts: 5,
  backoffBaseMs: 2000,
  removeOnCompleteCount: 1000,
  removeOnFailCount: 5000,
};

/**
 * BullMQ implementation of the queue backend. Redis holds ONLY job orchestration state
 * (waiting/delayed/failed lists, schedulers, worker heartbeats): losing it delays background work
 * but can never change a booking, payment, refund, wallet or payout, because every handler re-reads
 * MongoDB and the domain services own idempotency.
 */
export class BullQueueBackend implements QueueBackend {
  readonly kind = 'bullmq';
  readonly connection: IORedis;
  readonly prefix: string;
  readonly retry: JobRetryPolicy;
  private queues = new Map<QueueName, Queue>();

  constructor(opts: BullBackendOptions = {}) {
    this.prefix = opts.prefix ?? env.QUEUE_PREFIX;
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
    // BullMQ requires maxRetriesPerRequest=null on its connections.
    this.connection = new IORedis(opts.redisUrl ?? env.REDIS_URL, { maxRetriesPerRequest: null });
    this.connection.on('error', (err) => logger.error({ err: err.message }, 'Queue Redis error'));
  }

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.connection,
        prefix: this.prefix,
        defaultJobOptions: {
          attempts: this.retry.attempts,
          backoff: { type: 'exponential', delay: this.retry.backoffBaseMs },
          removeOnComplete: { count: this.retry.removeOnCompleteCount },
          removeOnFail: { count: this.retry.removeOnFailCount },
        },
      });
      q.on('error', (err) => logger.error({ queue: name, err: err.message }, 'Queue error'));
      this.queues.set(name, q);
    }
    return q;
  }

  async add(
    queue: QueueName,
    name: string,
    data: Record<string, unknown>,
    opts: EnqueueOptions = {},
  ): Promise<boolean> {
    const q = this.queue(queue);
    if (opts.jobId && (await q.getJob(opts.jobId))) return false; // already queued / retained
    await q.add(name, data, {
      ...(opts.jobId && { jobId: opts.jobId }),
      ...(opts.delayMs && { delay: opts.delayMs }),
    });
    return true;
  }

  async upsertScheduler(
    queue: QueueName,
    schedulerId: string,
    everyMs: number,
    name: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    await this.queue(queue).upsertJobScheduler(
      schedulerId,
      { every: everyMs },
      {
        name,
        data,
        // a scheduled sweep that fails is simply repeated on the next tick
        opts: { attempts: 1 },
      },
    );
  }

  async removeScheduler(queue: QueueName, schedulerId: string): Promise<void> {
    await this.queue(queue).removeJobScheduler(schedulerId);
  }

  async listSchedulers(queue: QueueName) {
    const rows = await this.queue(queue).getJobSchedulers();
    return rows.map((r) => ({
      id: String(r.key ?? r.id),
      everyMs: r.every ? Number(r.every) : undefined,
      name: String(r.name),
    }));
  }

  async stats(queue: QueueName): Promise<QueueStats> {
    const q = this.queue(queue);
    const c = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
    const [oldest] = await q.getJobs(['waiting'], 0, 0, true);
    return {
      queue,
      waiting: c.waiting ?? 0,
      active: c.active ?? 0,
      delayed: c.delayed ?? 0,
      failed: c.failed ?? 0,
      completed: c.completed ?? 0,
      paused: (await q.isPaused()) ? (c.waiting ?? 0) : 0,
      oldestWaitingSeconds: oldest
        ? Math.max(0, Math.round((Date.now() - oldest.timestamp) / 1000))
        : 0,
    };
  }

  private hbKey = (id: string) => `${this.prefix}:workers:${id}`;

  async heartbeat(info: WorkerInfo, ttlSeconds: number): Promise<void> {
    await this.connection.set(this.hbKey(info.id), JSON.stringify(info), 'EX', ttlSeconds);
  }

  async removeHeartbeat(id: string): Promise<void> {
    await this.connection.del(this.hbKey(id));
  }

  async workers(): Promise<WorkerInfo[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.connection.scan(
        cursor,
        'MATCH',
        `${this.prefix}:workers:*`,
        'COUNT',
        100,
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    if (!keys.length) return [];
    const vals = await this.connection.mget(keys);
    return vals.filter((v): v is string => !!v).map((v) => JSON.parse(v) as WorkerInfo);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
    await this.connection.quit().catch(() => this.connection.disconnect());
  }

  /** Test/ops helper: remove every job of every queue (never used by the application). */
  async obliterateAll(): Promise<void> {
    for (const n of QUEUE_NAMES) await this.queue(n).obliterate({ force: true });
  }
}
