import { UnrecoverableError } from 'bullmq';
import { AppError } from '../common/errors';
import { logger } from '../config/logger';
import { JOBS, type JobContext } from './definitions';
import { reportError } from '../config/monitoring';

export interface JobMeta {
  jobId?: string;
  /** 1-based attempt number. */
  attempt?: number;
  now?: Date;
}

/** Reference ids safe to log (never names, addresses, notes or payment data). */
const SAFE_REFS = [
  'bookingId',
  'paymentId',
  'refundId',
  'payoutId',
  'deliveryId',
  'userId',
] as const;
const refsOf = (data: Record<string, unknown>) =>
  Object.fromEntries(SAFE_REFS.filter((k) => typeof data[k] === 'string').map((k) => [k, data[k]]));

/**
 * Runs one job through its domain-service adapter with structured logging and the retry
 * classification: invalid payloads, unknown jobs and 4xx domain errors are permanent
 * (UnrecoverableError, never retried); everything else (database/Redis/provider hiccups) throws
 * as-is and is retried by the queue with exponential backoff. The retry count is NEVER the
 * financial idempotency mechanism: the services are.
 */
export async function executeJob(
  name: string,
  data: Record<string, unknown>,
  meta: JobMeta = {},
): Promise<Record<string, unknown>> {
  const started = Date.now();
  const def = JOBS[name];
  const base = {
    jobId: meta.jobId,
    jobName: name,
    attempt: meta.attempt ?? 1,
    ...refsOf(data ?? {}),
  };
  if (!def) {
    logger.error({ ...base, outcome: 'UNKNOWN_JOB' }, 'Job rejected');
    throw new UnrecoverableError(`Unknown job ${name}`);
  }
  const parsed = def.schema.safeParse(data ?? {});
  if (!parsed.success) {
    logger.error({ ...base, queue: def.queue, outcome: 'INVALID_PAYLOAD' }, 'Job rejected');
    throw new UnrecoverableError(`Invalid payload for ${name}`);
  }
  const ctx: JobContext = {
    now: meta.now ?? new Date(),
    jobId: meta.jobId,
    attempt: meta.attempt ?? 1,
  };
  try {
    const result = await def.run(parsed.data as never, ctx);
    logger.info(
      { ...base, queue: def.queue, durationMs: Date.now() - started, outcome: 'OK', result },
      'Job completed',
    );
    return result;
  } catch (err) {
    const e = err as Error;
    const permanent = err instanceof AppError && err.statusCode < 500;
    logger.warn(
      {
        ...base,
        queue: def.queue,
        durationMs: Date.now() - started,
        outcome: permanent ? 'PERMANENT_FAILURE' : 'RETRYABLE_FAILURE',
        err: e.message.slice(0, 200),
      },
      'Job failed',
    );
    // business outcomes (AppError) are expected; anything else is a bug worth a report
    if (!(err instanceof AppError)) reportError(err, { path: `job:${base.jobName}` });
    if (permanent) throw new UnrecoverableError(e.message);
    throw err;
  }
}
