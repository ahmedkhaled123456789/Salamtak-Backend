import type { NextFunction, Request, Response } from 'express';
import {
  RateLimiterMemory,
  RateLimiterRedis,
  type RateLimiterAbstract,
} from 'rate-limiter-flexible';
import { env } from '../../config/env';
import { getRedis } from '../../config/redis';
import { TooManyRequestsError } from '../errors';

export interface LimitConfig {
  points: number;
  durationSeconds: number;
  /** Extra key material, e.g. the target email, so one user can't lock out a whole IP. */
  keyExtra?: (req: Request) => string | undefined;
}

const limiters = new Map<string, RateLimiterAbstract>();

function build(name: string, cfg: LimitConfig): RateLimiterAbstract {
  const memory = new RateLimiterMemory({
    points: cfg.points,
    duration: cfg.durationSeconds,
    keyPrefix: `mem:${name}`,
  });
  if (env.RATE_LIMIT_STORE === 'memory' || env.REDIS_URL === 'memory') return memory;
  // Redis is the shared store; if Redis is down we degrade to per-process memory limits (fail-safe, not fail-open).
  return new RateLimiterRedis({
    storeClient: getRedis(),
    points: cfg.points,
    duration: cfg.durationSeconds,
    keyPrefix: `rl:${name}`,
    insuranceLimiter: memory,
  });
}

export function rateLimit(name: string, cfg: LimitConfig) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    let limiter = limiters.get(name);
    if (!limiter) {
      limiter = build(name, cfg);
      limiters.set(name, limiter);
    }
    const extra = cfg.keyExtra?.(req);
    const key = extra ? `${req.ip}:${extra.toLowerCase()}` : (req.ip ?? 'unknown');
    try {
      await limiter.consume(key);
      next();
    } catch (rej) {
      if (rej instanceof Error) return next(rej);
      const retry = Math.ceil(((rej as { msBeforeNext?: number }).msBeforeNext ?? 1000) / 1000);
      _res.setHeader('Retry-After', String(retry));
      next(new TooManyRequestsError(undefined, retry));
    }
  };
}

/** Test helper: drop cached limiters so each test file starts clean. */
export function resetRateLimiters(): void {
  limiters.clear();
}

export const limits = {
  global: { points: 300, durationSeconds: 60 },
  register: { points: 10, durationSeconds: 3600 },
  login: {
    points: 5,
    durationSeconds: 60,
    keyExtra: (req: Request) => (typeof req.body?.email === 'string' ? req.body.email : undefined),
  },
  refresh: { points: 30, durationSeconds: 60 },
  forgotPassword: {
    points: 3,
    durationSeconds: 3600,
    keyExtra: (req: Request) => (typeof req.body?.email === 'string' ? req.body.email : undefined),
  },
  otp: { points: 10, durationSeconds: 600 },
} satisfies Record<string, LimitConfig>;

/**
 * Counts one FAILED attempt (e.g. an invalid webhook signature) for `key` and reports whether the
 * caller is now over the budget. Successful traffic never calls this, so legitimate requests are
 * never throttled by it. Redis is a convenience only: if it is down the per-process limiter applies.
 */
export async function consumeFailure(
  name: string,
  cfg: LimitConfig,
  key: string,
): Promise<{ limited: boolean; retryAfterSeconds: number }> {
  let limiter = limiters.get(name);
  if (!limiter) {
    limiter = build(name, cfg);
    limiters.set(name, limiter);
  }
  try {
    await limiter.consume(key);
    return { limited: false, retryAfterSeconds: 0 };
  } catch (rej) {
    if (rej instanceof Error) return { limited: false, retryAfterSeconds: 0 };
    const ms = (rej as { msBeforeNext?: number }).msBeforeNext ?? 1000;
    return { limited: true, retryAfterSeconds: Math.ceil(ms / 1000) };
  }
}

export const webhookFailureLimit: LimitConfig = { points: 20, durationSeconds: 60 };
