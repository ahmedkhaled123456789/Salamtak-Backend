/**
 * Vercel serverless entry (see ../vercel.json): the same Express app as `src/server.ts`, without the long-running
 * parts — no Socket.IO (live chat updates; the REST chat API still works) and no BullMQ workers (with REDIS_URL=memory
 * jobs run inline and Vercel Cron calls /internal/cron/sweep). The MongoDB connection is reused across invocations.
 *
 * The app is loaded lazily so a boot failure (e.g. invalid/missing environment variables) is reported as a JSON 500
 * with the reason instead of an opaque FUNCTION_INVOCATION_FAILED. Env errors only name variables, never values.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

type Boot = { app: (req: never, res: never) => void; connect: () => Promise<unknown>; logError: (msg: string) => void };
let boot: Promise<Boot> | null = null;
let ready: Promise<unknown> | null = null;

async function load(): Promise<Boot> {
  const { initMonitoring } = await import('../src/config/monitoring');
  const { env } = await import('../src/config/env');
  const { createApp } = await import('../src/app');
  const { connectDatabase } = await import('../src/config/database');
  const { logger } = await import('../src/config/logger');
  const { InlineQueueBackend } = await import('../src/jobs/inline.backend');
  const { setQueueBackend } = await import('../src/queues');
  initMonitoring('api');
  if (env.REDIS_URL === 'memory') setQueueBackend(new InlineQueueBackend());
  return {
    app: createApp() as never,
    connect: connectDatabase,
    logError: (msg) => logger.error({ err: msg }, 'Database connection failed'),
  };
}

function send(res: ServerResponse, status: number, body: object): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let b: Boot;
  try {
    b = await (boot ??= load());
  } catch (err) {
    boot = null;
    const message = (err as Error).message;
    console.error('Boot failed:', message);
    send(res, 500, { success: false, errorCode: 'BOOT_FAILED', message });
    return;
  }
  ready ??= b.connect().catch((err: Error) => {
    ready = null; // retry on the next request
    throw err;
  });
  try {
    await ready;
  } catch (err) {
    b.logError((err as Error).message);
    send(res, 503, { success: false, errorCode: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' });
    return;
  }
  b.app(req as never, res as never);
}
