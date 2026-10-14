import { logger } from '../config/logger';
import { BullQueueBackend } from './bullmq.backend';
import type { EnqueueOptions, QueueBackend, QueueName } from './names';

export * from './names';
export { BullQueueBackend } from './bullmq.backend';
export { MemoryQueueBackend } from './memory.backend';

const ENQUEUE_TIMEOUT_MS = 3000;
let backend: QueueBackend | undefined;

/** The process-wide queue backend (BullMQ by default; tests install an in-memory one). */
export function getQueueBackend(): QueueBackend {
  if (!backend) backend = new BullQueueBackend();
  return backend;
}
export function setQueueBackend(b: QueueBackend | undefined): void {
  backend = b;
}
export async function closeQueueBackend(): Promise<void> {
  const b = backend;
  backend = undefined;
  await b?.close();
}

/**
 * Best-effort enqueue for code paths that must never fail because Redis is unavailable. A lost
 * enqueue is harmless: every job type is also picked up by the scheduler's periodic sweep, which
 * reads the authoritative state from MongoDB.
 */
export async function enqueue(
  queue: QueueName,
  name: string,
  data: Record<string, unknown>,
  opts?: EnqueueOptions,
): Promise<boolean> {
  try {
    // bounded: with Redis down the client would otherwise queue the command forever
    return await Promise.race([
      getQueueBackend().add(queue, name, data, opts),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('enqueue timed out')), ENQUEUE_TIMEOUT_MS).unref(),
      ),
    ]);
  } catch (err) {
    logger.warn(
      { queue, job: name, err: (err as Error).message },
      'Could not enqueue job (the periodic sweep will pick the work up)',
    );
    return false;
  }
}
