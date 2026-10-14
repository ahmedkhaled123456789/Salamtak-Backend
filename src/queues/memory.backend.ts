import type { EnqueueOptions, QueueBackend, QueueName, QueueStats, WorkerInfo } from './names';

export interface MemoryJob {
  queue: QueueName;
  name: string;
  data: Record<string, unknown>;
  jobId?: string;
  delayMs?: number;
  addedAt: number;
}

/**
 * In-memory backend for unit/integration tests of the handlers and the scheduler: records what would
 * be enqueued, de-duplicates on jobId exactly like BullMQ, and can simulate an unavailable Redis.
 */
export class MemoryQueueBackend implements QueueBackend {
  readonly kind = 'memory';
  readonly jobs: MemoryJob[] = [];
  readonly schedulers = new Map<string, { queue: QueueName; everyMs: number; name: string }>();
  private beats = new Map<string, WorkerInfo>();
  /** When true every call rejects, like a Redis outage. */
  unavailable = false;

  private guard(): void {
    if (this.unavailable) throw new Error('Redis connection is closed');
  }

  async add(
    queue: QueueName,
    name: string,
    data: Record<string, unknown>,
    opts: EnqueueOptions = {},
  ): Promise<boolean> {
    this.guard();
    if (opts.jobId && this.jobs.some((j) => j.queue === queue && j.jobId === opts.jobId))
      return false;
    this.jobs.push({
      queue,
      name,
      data,
      jobId: opts.jobId,
      delayMs: opts.delayMs,
      addedAt: Date.now(),
    });
    return true;
  }

  async upsertScheduler(
    queue: QueueName,
    id: string,
    everyMs: number,
    name: string,
  ): Promise<void> {
    this.guard();
    this.schedulers.set(`${queue}:${id}`, { queue, everyMs, name });
  }
  async removeScheduler(queue: QueueName, id: string): Promise<void> {
    this.guard();
    this.schedulers.delete(`${queue}:${id}`);
  }
  async listSchedulers(queue: QueueName) {
    this.guard();
    return [...this.schedulers.entries()]
      .filter(([, v]) => v.queue === queue)
      .map(([k, v]) => ({ id: k.slice(queue.length + 1), everyMs: v.everyMs, name: v.name }));
  }

  async stats(queue: QueueName): Promise<QueueStats> {
    this.guard();
    const mine = this.jobs.filter((j) => j.queue === queue);
    const oldest = mine.length ? Math.min(...mine.map((j) => j.addedAt)) : undefined;
    return {
      queue,
      waiting: mine.length,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
      paused: 0,
      oldestWaitingSeconds: oldest ? Math.round((Date.now() - oldest) / 1000) : 0,
    };
  }

  async heartbeat(info: WorkerInfo): Promise<void> {
    this.guard();
    this.beats.set(info.id, info);
  }
  async removeHeartbeat(id: string): Promise<void> {
    this.beats.delete(id);
  }
  async workers(): Promise<WorkerInfo[]> {
    this.guard();
    return [...this.beats.values()];
  }
  async close(): Promise<void> {
    this.jobs.length = 0;
  }

  /** Test helper: take and clear the recorded jobs. */
  drain(queue?: QueueName): MemoryJob[] {
    const out = this.jobs.filter((j) => !queue || j.queue === queue);
    for (const j of out) this.jobs.splice(this.jobs.indexOf(j), 1);
    return out;
  }
}
