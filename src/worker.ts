import { connectDatabase, disconnectDatabase, initModels } from './config/database';
import { logger } from './config/logger';
import { flushMonitoring, initMonitoring, reportError } from './config/monitoring';
import { registerFinancialHooks } from './modules/finance';
import { registerCouponHooks } from './modules/coupons';
import { registerNotificationHooks } from './modules/notifications';
import { startWorkers } from './jobs';
import { BullQueueBackend, setQueueBackend } from './queues';

/**
 * Standalone worker process (`npm run worker`): BullMQ workers + scheduler sync, no HTTP.
 * Any number of these can run next to the API; jobs are idempotent and leases are in MongoDB.
 */
async function main(): Promise<void> {
  initMonitoring('worker');
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason instanceof Error ? reason.message : String(reason) }, 'Unhandled promise rejection');
    reportError(reason);
  });
  await connectDatabase();
  await initModels();
  registerFinancialHooks();
  registerNotificationHooks();
  registerCouponHooks();
  const backend = new BullQueueBackend();
  setQueueBackend(backend);
  const runtime = await startWorkers(backend);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'Worker shutting down');
    await runtime.close(); // waits for active jobs to finish
    await backend.close();
    await disconnectDatabase();
    await flushMonitoring();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, 'Worker failed to start');
  process.exit(1);
});
