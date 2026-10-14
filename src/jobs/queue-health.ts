import { AlertService } from '../modules/alerts';
import { SettingsService } from '../modules/settings';
import { QUEUE_NAMES, getQueueBackend, type QueueStats, type WorkerInfo } from '../queues';

export interface QueueHealthSnapshot {
  queues: QueueStats[];
  workers: (WorkerInfo & { alive: boolean })[];
}

/** Raw numbers for the admin endpoint and the health alert job. */
export async function queueSnapshot(): Promise<QueueHealthSnapshot> {
  const backend = getQueueBackend();
  const settings = await SettingsService.getAll();
  const staleMs = settings['queue.workerHeartbeatStaleSeconds'] * 1000;
  const [queues, workers] = await Promise.all([
    Promise.all(QUEUE_NAMES.map((q) => backend.stats(q))),
    backend.workers(),
  ]);
  return {
    queues,
    workers: workers.map((w) => ({
      ...w,
      alive: Date.now() - Date.parse(w.lastSeenAt) <= staleMs,
    })),
  };
}

/**
 * Operational alerts from queue statistics: backlog, stuck oldest job, no live worker while work is
 * waiting. Alerts are keyed per queue (never spammed) and resolve themselves when the condition clears.
 */
export async function checkQueueHealth(): Promise<Record<string, unknown>> {
  const settings = await SettingsService.getAll();
  const snap = await queueSnapshot();
  const raised: string[] = [];
  const anyAlive = snap.workers.some((w) => w.alive);
  for (const q of snap.queues) {
    const backlogKey = `queue-backlog:${q.queue}`;
    if (q.waiting > settings['queue.backlogAlertThreshold']) {
      raised.push(backlogKey);
      await AlertService.raise({
        key: backlogKey,
        type: 'QUEUE_BACKLOG',
        severity: 'WARNING',
        entity: 'Queue',
        message: `Queue ${q.queue} has a large backlog`,
        data: {
          queue: q.queue,
          waiting: q.waiting,
          threshold: settings['queue.backlogAlertThreshold'],
        },
        reopen: true,
      });
    } else await AlertService.resolveByKey(backlogKey);

    const stuckKey = `queue-stuck:${q.queue}`;
    if (q.oldestWaitingSeconds > settings['queue.oldestWaitingAlertSeconds']) {
      raised.push(stuckKey);
      await AlertService.raise({
        key: stuckKey,
        type: 'QUEUE_STUCK',
        severity: 'CRITICAL',
        entity: 'Queue',
        message: `Jobs in ${q.queue} have been waiting too long`,
        data: { queue: q.queue, oldestWaitingSeconds: q.oldestWaitingSeconds },
        reopen: true,
      });
    } else await AlertService.resolveByKey(stuckKey);
  }
  const noWorkerKey = 'queue-no-workers';
  const waiting = snap.queues.reduce((n, q) => n + q.waiting, 0);
  if (!anyAlive && waiting > 0) {
    raised.push(noWorkerKey);
    await AlertService.raise({
      key: noWorkerKey,
      type: 'QUEUE_NO_WORKERS',
      severity: 'CRITICAL',
      entity: 'Queue',
      message: 'Jobs are waiting but no worker has reported a heartbeat',
      data: { waiting },
      reopen: true,
    });
  } else await AlertService.resolveByKey(noWorkerKey);
  return {
    queues: snap.queues.length,
    workersAlive: snap.workers.filter((w) => w.alive).length,
    raised,
  };
}
