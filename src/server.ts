import http from 'node:http';
import { createApp } from './app';
import { connectDatabase, disconnectDatabase, initModels } from './config/database';
import { env } from './config/env';
import { logger } from './config/logger';
import { flushMonitoring, initMonitoring, reportError } from './config/monitoring';
import { startInlineJobs } from './modules/finance';
import { disconnectRedis, getRedis } from './config/redis';
import { attachChatSocket } from './modules/chat';
import { startWorkers, type WorkerRuntime } from './jobs';
import { closeQueueBackend, getQueueBackend, setQueueBackend, type BullQueueBackend } from './queues';
import { InlineQueueBackend } from './jobs/inline.backend';

const SHUTDOWN_TIMEOUT_MS = 25_000;

async function main(): Promise<void> {
  initMonitoring('api');
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason instanceof Error ? reason.message : String(reason) }, 'Unhandled promise rejection');
    reportError(reason);
  });
  if (env.jwt.ephemeralKeys) {
    logger.warn(
      'JWT keys not configured: using an ephemeral keypair (dev only). Run `npm run keys:generate`.',
    );
  }
  await connectDatabase();
  await initModels(); // creates/validates all indexes
  const redis = getRedis();
  await redis.ping();
  logger.info('Redis connected');

  // Background jobs. RUN_WORKERS runs BullMQ workers + scheduler inside this process; larger
  // deployments run `npm run worker` separately. The API never depends on them for correctness.
  let workers: WorkerRuntime | undefined;
  if (env.REDIS_URL === 'memory') {
    // no Redis: jobs run inline; periodic work comes from POST /internal/cron/sweep
    setQueueBackend(new InlineQueueBackend());
    logger.warn('REDIS_URL=memory: inline jobs, in-process rate limits (demo/serverless mode)');
  } else if (env.RUN_WORKERS) {
    workers = await startWorkers(getQueueBackend() as BullQueueBackend);
  } else if (env.INLINE_JOBS) {
    startInlineJobs();
    logger.info(
      'Inline finance sweeps enabled (INLINE_JOBS=true); BullMQ replaces this in Phase 4',
    );
  }
  const server = http.createServer(createApp());
  const io = attachChatSocket(server);
  server.on('error', (err) => {
    logger.fatal({ err: err.message }, 'HTTP server error');
    process.exit(1);
  });
  server.listen(env.PORT, () =>
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening'),
  );

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'Shutting down');
    // Never hang a deploy: if draining stalls (stuck job, open socket), exit anyway.
    setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    // 0) stop accepting connections and let in-flight requests finish before the databases go away
    // (registered before io.close(), which closes the same HTTP server and drops chat sockets)
    const drained = new Promise<void>((resolve) => server.close(() => resolve()));
    void io.close();
    await drained;
    // 1) stop taking jobs and let active ones finish, 2) close queue connections, 3) databases
    await workers?.close().catch(() => undefined);
    await closeQueueBackend().catch(() => undefined);
    await Promise.allSettled([disconnectDatabase(), disconnectRedis(), flushMonitoring()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, 'Failed to start');
  process.exit(1);
});
