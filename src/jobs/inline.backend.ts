import { logger } from '../config/logger';
import { MemoryQueueBackend, type EnqueueOptions, type QueueBackend, type QueueName } from '../queues';
import { executeJob } from './executor';

/**
 * Queue backend for hosts without Redis or long-running workers (serverless / the portfolio demo, REDIS_URL=memory).
 * Immediate jobs run right away through the normal executor (same payload validation, same idempotent domain
 * services); delayed jobs are only recorded — the periodic sweeps (`POST /internal/cron/sweep`, called by a cron)
 * re-derive all due work from MongoDB, so nothing is lost. A failed job is logged and picked up by the next sweep.
 */
export class InlineQueueBackend implements QueueBackend {
  readonly kind = 'inline';
  /** schedules/stats/heartbeats only (used by the queue-health screen); viewed through the interface */
  private readonly memory: QueueBackend = new MemoryQueueBackend();

  async add(queue: QueueName, name: string, data: Record<string, unknown>, opts: EnqueueOptions = {}): Promise<boolean> {
    if (opts.delayMs && opts.delayMs > 0) return false; // the sweep handles it when due
    try {
      await executeJob(name, data, { jobId: opts.jobId });
    } catch (err) {
      logger.warn({ queue, job: name, err: (err as Error).message }, 'Inline job failed (the next sweep retries it)');
    }
    return true;
  }

  upsertScheduler(...args: Parameters<QueueBackend['upsertScheduler']>) {
    return this.memory.upsertScheduler(...args);
  }
  removeScheduler(...args: Parameters<QueueBackend['removeScheduler']>) {
    return this.memory.removeScheduler(...args);
  }
  listSchedulers(...args: Parameters<QueueBackend['listSchedulers']>) {
    return this.memory.listSchedulers(...args);
  }
  stats(...args: Parameters<QueueBackend['stats']>) {
    return this.memory.stats(...args);
  }
  heartbeat(...args: Parameters<QueueBackend['heartbeat']>) {
    return this.memory.heartbeat(...args);
  }
  removeHeartbeat(...args: Parameters<QueueBackend['removeHeartbeat']>) {
    return this.memory.removeHeartbeat(...args);
  }
  workers() {
    return this.memory.workers();
  }
  async close(): Promise<void> {
    /* nothing to close */
  }
}
