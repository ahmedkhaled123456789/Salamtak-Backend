/**
 * Vercel serverless entry (see ../vercel.json): the same Express app as `src/server.ts`, without the long-running
 * parts — no Socket.IO (live chat updates; the REST chat API still works) and no BullMQ workers (with REDIS_URL=memory
 * jobs run inline and Vercel Cron calls /internal/cron/sweep). The MongoDB connection is reused across invocations.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../src/app';
import { connectDatabase } from '../src/config/database';
import { env } from '../src/config/env';
import { logger } from '../src/config/logger';
import { initMonitoring } from '../src/config/monitoring';
import { InlineQueueBackend } from '../src/jobs/inline.backend';
import { setQueueBackend } from '../src/queues';

initMonitoring('api');
if (env.REDIS_URL === 'memory') setQueueBackend(new InlineQueueBackend());
const app = createApp();
let ready: Promise<unknown> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ready ??= connectDatabase().catch((err: Error) => {
    ready = null; // retry on the next request
    throw err;
  });
  try {
    await ready;
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Database connection failed');
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ success: false, errorCode: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' }));
    return;
  }
  app(req as never, res as never);
}
