import { randomUUID } from 'node:crypto';
import { Worker, type Job } from 'bullmq';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { AlertService } from '../modules/alerts';
import { SettingsService } from '../modules/settings';
import { QUEUE_NAMES, type BullQueueBackend, type QueueName } from '../queues';
import { JOBS } from './definitions';
import { executeJob } from './executor';
import { syncSchedules } from './scheduler';

const HEARTBEAT_MS = 15_000;
const HEARTBEAT_TTL_S = 60;
const SCHEDULE_RESYNC_MS = 5 * 60_000;
const clean = (m: string) =>
  m
    .replace(/\b(sk|rk|pk|whsec)_[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 200);

export interface WorkerRuntime {
  readonly id: string;
  close(): Promise<void>;
}

/**
 * Starts one BullMQ Worker per queue plus the scheduler sync and a heartbeat. Several processes may
 * run this at the same time: jobs are delivered at-least-once and every handler is idempotent in the
 * domain services, so duplicate delivery is harmless.
 */
export async function startWorkers(
  backend: BullQueueBackend,
  opts: { queues?: QueueName[]; schedule?: boolean } = {},
): Promise<WorkerRuntime> {
  const id = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const queues = opts.queues ?? QUEUE_NAMES;
  const startedAt = new Date().toISOString();
  const settings = await SettingsService.getAll();
  let closing = false;

  const workers = queues.map((q) => {
    const w = new Worker(
      q,
      (job: Job) =>
        executeJob(job.name, job.data as Record<string, unknown>, {
          jobId: job.id,
          attempt: job.attemptsMade + 1,
        }),
      {
        connection: backend.connection.duplicate(),
        prefix: backend.prefix,
        concurrency: settings['jobs.workerConcurrency'],
      },
    );
    w.on('error', (err) => logger.error({ queue: q, err: err.message }, 'Worker error'));
    w.on('failed', (job, err) => void onJobFailed(q, job, err));
    return w;
  });

  const beat = async () => {
    try {
      await backend.heartbeat(
        { id, startedAt, lastSeenAt: new Date().toISOString(), queues, pid: process.pid },
        HEARTBEAT_TTL_S,
      );
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Worker heartbeat failed (Redis unavailable?)');
    }
  };
  await beat();
  const hb = setInterval(() => void beat(), HEARTBEAT_MS);
  hb.unref();

  let resync: NodeJS.Timeout | undefined;
  if (opts.schedule !== false) {
    const sync = async () => {
      try {
        await syncSchedules(backend);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Schedule sync failed (will retry)');
      }
    };
    await sync();
    resync = setInterval(() => void sync(), SCHEDULE_RESYNC_MS);
    resync.unref();
  }
  logger.info({ workerId: id, queues: queues.length, env: env.NODE_ENV }, 'Workers started');

  return {
    id,
    /**
     * Graceful shutdown: stop taking new jobs, let active jobs finish (financial jobs are never
     * killed mid-flight), then release heartbeats and connections. Idempotent.
     */
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(hb);
      if (resync) clearInterval(resync);
      logger.info({ workerId: id }, 'Workers shutting down (waiting for active jobs)');
      await Promise.allSettled(workers.map((w) => w.close()));
      await backend.removeHeartbeat(id).catch(() => undefined);
      logger.info({ workerId: id }, 'Workers stopped');
    },
  };
}

/** Repeated / exhausted failures become (de-duplicated) operational alerts. */
async function onJobFailed(queue: QueueName, job: Job | undefined, err: Error): Promise<void> {
  if (!job) return;
  try {
    const settings = await SettingsService.getAll();
    const attempts = job.opts.attempts ?? 1;
    const exhausted = job.attemptsMade >= attempts || err.name === 'UnrecoverableError';
    const repeated = job.attemptsMade >= settings['jobs.failureAlertAfterAttempts'];
    if (!exhausted && !repeated) return;
    if (!(job.name in JOBS)) return;
    await AlertService.raise({
      // one alert per job TYPE (not per job id): never a flood
      key: `job-${exhausted ? 'exhausted' : 'failing'}:${queue}:${job.name}`,
      type: exhausted ? 'JOB_EXHAUSTED' : 'JOB_FAILING',
      severity: exhausted ? 'CRITICAL' : 'WARNING',
      entity: 'Job',
      message: `Background job ${job.name} is ${exhausted ? 'failing permanently' : 'failing repeatedly'}`,
      data: {
        queue,
        job: job.name,
        jobId: job.id ?? null,
        attemptsMade: job.attemptsMade,
        error: clean(err.message),
      },
      reopen: true,
    });
  } catch (e) {
    logger.error({ err: (e as Error).message }, 'Could not raise job failure alert');
  }
}
