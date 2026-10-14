import type { RequestHandler } from 'express';
import { safeEqual } from '../common/utils/crypto';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { SCHEDULES } from './definitions';
import { executeJob } from './executor';

const BUDGET_MS = 50_000; // stay under a 60 s serverless limit

/**
 * `GET|POST /internal/cron/sweep` — runs every scheduled job once (expire holds, release earnings, refunds, payouts,
 * reconciliation, …). For hosts without long-running workers (Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`).
 * Every job is idempotent, so overlapping or repeated calls are harmless. Disabled (404) when CRON_SECRET is unset.
 */
export const cronSweep: RequestHandler = async (req, res) => {
  const secret = env.CRON_SECRET;
  const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!secret) return void res.status(404).json({ success: false, errorCode: 'ROUTE_NOT_FOUND', message: 'Not found' });
  if (!safeEqual(given, secret)) return void res.status(401).json({ success: false, errorCode: 'UNAUTHORIZED', message: 'Unauthorized' });

  const started = Date.now();
  const ran: { job: string; ok: boolean; ms: number }[] = [];
  for (const { job } of SCHEDULES) {
    if (Date.now() - started > BUDGET_MS) break; // the rest runs on the next call
    const t0 = Date.now();
    try {
      await executeJob(job, {}, { jobId: `cron:${job}:${started}` });
      ran.push({ job, ok: true, ms: Date.now() - t0 });
    } catch {
      ran.push({ job, ok: false, ms: Date.now() - t0 }); // already logged by the executor
    }
  }
  logger.info({ jobs: ran.length, failed: ran.filter((r) => !r.ok).length, ms: Date.now() - started }, 'Cron sweep finished');
  res.json({ success: true, data: { ran, total: SCHEDULES.length, ms: Date.now() - started }, message: 'Swept' });
};
