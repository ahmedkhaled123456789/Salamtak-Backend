import { logger } from '../config/logger';
import { SettingsService } from '../modules/settings';
import type { QueueBackend } from '../queues';
import { JOBS, SCHEDULES } from './definitions';

export interface ScheduleSummary {
  enabled: boolean;
  upserted: { job: string; everyMs: number }[];
  removed: string[];
}

/**
 * Registers the recurring jobs. Intervals come from platform settings (nothing hardcoded), and
 * `jobs.schedulerEnabled=false` removes every schedule. `upsertScheduler` is idempotent, so every
 * instance may call this at boot and periodically: a changed setting takes effect on the next sync
 * without any coordination, and there is never more than one schedule per job.
 */
export async function syncSchedules(backend: QueueBackend): Promise<ScheduleSummary> {
  const settings = await SettingsService.getAll();
  const summary: ScheduleSummary = {
    enabled: settings['jobs.schedulerEnabled'],
    upserted: [],
    removed: [],
  };
  for (const s of SCHEDULES) {
    const queue = JOBS[s.job]!.queue;
    if (!summary.enabled) {
      await backend.removeScheduler(queue, s.job);
      summary.removed.push(s.job);
      continue;
    }
    const raw = settings[s.every] as number;
    const everyMs = raw * (s.unit === 'm' ? 60_000 : 1000);
    await backend.upsertScheduler(queue, s.job, everyMs, s.job, {});
    summary.upserted.push({ job: s.job, everyMs });
  }
  logger.info(
    { enabled: summary.enabled, schedules: summary.upserted.length },
    'Job schedules synchronised',
  );
  return summary;
}
