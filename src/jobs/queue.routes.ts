import '../common/openapi/extend';
import { z } from 'zod';
import { createApi } from '../common/openapi/route';
import { QUEUE_NAMES, getQueueBackend } from '../queues';
import { queueSnapshot } from './queue-health';

const QueueStatsSchema = z.object({
  queue: z.string(),
  waiting: z.number().int(),
  active: z.number().int(),
  delayed: z.number().int(),
  failed: z.number().int(),
  completed: z.number().int(),
  paused: z.number().int(),
  oldestWaitingSeconds: z.number().int(),
});

const api = createApi('Operations');

/** Never let a Redis outage hang an admin request. */
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error('Queue backend timeout')), ms).unref(),
    ),
  ]);

api.route({
  method: 'get',
  path: '/admin/queues',
  summary: 'Background queue health',
  description:
    'Counts per queue (waiting, active, delayed, failed, completed), the age of the oldest waiting job, registered schedules and worker heartbeats. Job payloads and Redis internals are never exposed. If Redis is unavailable the response says `available: false`: background jobs are delayed, financial state is unaffected (MongoDB is the source of truth).',
  permission: 'admin:queues:read',
  response: z.object({
    available: z.boolean(),
    backend: z.string(),
    error: z.string().nullable(),
    queues: z.array(QueueStatsSchema),
    schedulers: z.array(
      z.object({ queue: z.string(), job: z.string(), everySeconds: z.number().nullable() }),
    ),
    workers: z.array(
      z.object({
        id: z.string(),
        startedAt: z.string(),
        lastSeenAt: z.string(),
        queues: z.array(z.string()),
        alive: z.boolean(),
      }),
    ),
  }),
  handler: async () => {
    const backend = getQueueBackend();
    try {
      const [snap, schedulers] = await withTimeout(
        Promise.all([
          queueSnapshot(),
          Promise.all(
            QUEUE_NAMES.map(async (q) =>
              (await backend.listSchedulers(q)).map((s) => ({
                queue: q as string,
                job: s.name,
                everySeconds: s.everyMs ? Math.round(s.everyMs / 1000) : null,
              })),
            ),
          ),
        ]),
        3000,
      );
      return {
        available: true,
        backend: backend.kind,
        error: null,
        queues: snap.queues,
        schedulers: schedulers.flat(),
        workers: snap.workers.map((w) => ({
          id: w.id,
          startedAt: w.startedAt,
          lastSeenAt: w.lastSeenAt,
          queues: w.queues,
          alive: w.alive,
        })),
      };
    } catch (err) {
      return {
        available: false,
        backend: backend.kind,
        error: (err as Error).message.slice(0, 120),
        queues: [],
        schedulers: [],
        workers: [],
      };
    }
  },
});

export default api.router;
