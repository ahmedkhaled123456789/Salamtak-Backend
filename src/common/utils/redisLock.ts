import { randomUUID } from 'node:crypto';
import { getRedis } from '../../config/redis';
import { logger } from '../../config/logger';

const RELEASE_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('redis timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * BEST-EFFORT distributed lock. It only reduces wasted contention between API instances.
 * Correctness NEVER depends on it:
 *   - if Redis is down/slow we run `fn` without a lock;
 *   - if the lock is held we wait briefly, then run `fn` anyway;
 * MongoDB (transaction + per-nurse write guard + unique slot index) is the source of truth.
 */
export async function withBestEffortLock<T>(
  key: string,
  fn: () => Promise<T>,
  opts: { ttlMs?: number; attempts?: number; retryDelayMs?: number; redisTimeoutMs?: number } = {},
): Promise<T> {
  const { ttlMs = 10_000, attempts = 5, retryDelayMs = 40, redisTimeoutMs = 150 } = opts;
  const token = randomUUID();
  let held = false;
  try {
    const redis = getRedis();
    for (let i = 0; i < attempts && !held; i++) {
      const ok = await withTimeout(redis.set(key, token, 'PX', ttlMs, 'NX'), redisTimeoutMs);
      if (ok === 'OK') held = true;
      else await sleep(retryDelayMs);
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, key },
      'Redis lock unavailable; continuing without it',
    );
  }
  try {
    return await fn();
  } finally {
    if (held) {
      try {
        await withTimeout(
          getRedis().eval(RELEASE_LUA, 1, key, token) as Promise<unknown>,
          redisTimeoutMs,
        );
      } catch {
        /* lock expires by TTL */
      }
    }
  }
}
