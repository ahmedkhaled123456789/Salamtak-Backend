import { AlertService } from '../modules/alerts';
import { ReconciliationService } from '../modules/finance';
import { withJobLock } from './job-lock';

const LOCK_TTL_MS = 15 * 60_000;
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * Scheduled reconciliation. The reconciliation service itself is READ-ONLY; this job only turns its
 * findings into alerts (one per failing check, de-duplicated by key and re-opened on recurrence) and
 * resolves the alert of a check that passes again. It never repairs or mutates financial data, and an
 * overlapping run is skipped via a Mongo lease.
 */
export async function runScheduledReconciliation(): Promise<Record<string, unknown>> {
  const res = await withJobLock('reconciliation', LOCK_TTL_MS, async () => {
    const report = await ReconciliationService.run();
    const failing: string[] = [];
    for (const c of report.checks) {
      const key = `reconciliation-drift:${slug(c.name)}`;
      if (c.ok) {
        await AlertService.resolveByKey(key, 'Reconciliation check passes again');
        continue;
      }
      failing.push(c.name);
      await AlertService.raise({
        key,
        type: 'RECONCILIATION_DRIFT',
        severity: 'CRITICAL',
        entity: 'Reconciliation',
        message: `Reconciliation check failed: ${c.name}`,
        // ids and amounts only: the problem strings never contain personal or payment data
        data: { check: c.name, problems: c.problems.slice(0, 5), checked: c.checked },
        reopen: true,
      });
    }
    return { ok: report.ok, failing };
  });
  return res.acquired ? res.value : { skipped: 'ALREADY_RUNNING' };
}
