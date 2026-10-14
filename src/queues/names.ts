/**
 * Queue topology. Eight queues keep failure isolation (a stuck notification provider can never
 * delay refunds) without a queue per job type.
 */
export const QUEUES = {
  booking: 'booking-jobs',
  payment: 'payment-jobs',
  refund: 'refund-jobs',
  payout: 'payout-jobs',
  wallet: 'wallet-jobs',
  reconciliation: 'reconciliation-jobs',
  notification: 'notification-jobs',
  alert: 'alert-jobs',
  marketplace: 'marketplace-jobs',
} as const;
export type QueueKey = keyof typeof QUEUES;
export type QueueName = (typeof QUEUES)[QueueKey];
export const QUEUE_NAMES: QueueName[] = Object.values(QUEUES);

export interface QueueStats {
  queue: QueueName;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  paused: number;
  /** Age in seconds of the oldest waiting job (0 if none). */
  oldestWaitingSeconds: number;
}

export interface WorkerInfo {
  id: string;
  startedAt: string;
  lastSeenAt: string;
  queues: QueueName[];
  pid: number;
}

export interface EnqueueOptions {
  /** Deterministic id: adding the same id twice while the job exists is a no-op. */
  jobId?: string;
  delayMs?: number;
}

export interface JobRetryPolicy {
  attempts: number;
  backoffBaseMs: number;
  removeOnCompleteCount: number;
  removeOnFailCount: number;
}

/**
 * Orchestration backend. BullMQ/Redis in production, an in-memory implementation in unit tests.
 * It carries job REFERENCES only (ids), never financial state: MongoDB stays the source of truth.
 */
export interface QueueBackend {
  readonly kind: string;
  /** Returns false when a job with that id already exists (de-duplicated). */
  add(
    queue: QueueName,
    name: string,
    data: Record<string, unknown>,
    opts?: EnqueueOptions,
  ): Promise<boolean>;
  upsertScheduler(
    queue: QueueName,
    schedulerId: string,
    everyMs: number,
    name: string,
    data?: Record<string, unknown>,
  ): Promise<void>;
  removeScheduler(queue: QueueName, schedulerId: string): Promise<void>;
  listSchedulers(queue: QueueName): Promise<{ id: string; everyMs?: number; name: string }[]>;
  stats(queue: QueueName): Promise<QueueStats>;
  heartbeat(info: WorkerInfo, ttlSeconds: number): Promise<void>;
  removeHeartbeat(id: string): Promise<void>;
  workers(): Promise<WorkerInfo[]>;
  close(): Promise<void>;
}
