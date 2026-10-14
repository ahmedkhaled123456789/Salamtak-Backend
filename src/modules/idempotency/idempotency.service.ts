import { createHash, randomUUID } from 'node:crypto';
import { Schema, model, type ClientSession } from 'mongoose';
import { AppError } from '../../common/errors';

/**
 * Persistent idempotency records. MongoDB is the source of truth (a unique index decides who owns
 * a key); Redis is not involved, so Redis outages cannot cause duplicate creations.
 * Records are scoped to (scope, userId, key): another user presenting the same key never sees,
 * collides with, or learns about someone else's record.
 */
const idempotencySchema = new Schema(
  {
    scope: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    key: { type: String, required: true },
    requestHash: { type: String, required: true },
    status: { type: String, enum: ['IN_PROGRESS', 'COMPLETED'], required: true },
    ownerToken: { type: String, required: true },
    lockedUntil: { type: Date, required: true },
    responseStatus: Number,
    response: Schema.Types.Mixed,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, strict: 'throw' },
);
idempotencySchema.index({ scope: 1, userId: 1, key: 1 }, { unique: true });
idempotencySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const IdempotencyKey = model('IdempotencyKey', idempotencySchema, 'idempotencyKeys');

export interface IdempotentResult<T> {
  status: number;
  body: T;
}

export interface IdempotentContext<T> {
  /**
   * Marks the record COMPLETED inside the caller's transaction, so "business effect committed"
   * and "idempotency record completed" are one atomic fact (a crash can never leave a created
   * booking behind a key that would let a retry create a second one).
   */
  complete(session: ClientSession, result: IdempotentResult<T>): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Canonical JSON (sorted keys) hash of the request payload. */
export function hashPayload(payload: unknown): string {
  const canon = (v: unknown): unknown => {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, canon(x)]),
      );
    return v;
  };
  return createHash('sha256')
    .update(JSON.stringify(canon(payload)))
    .digest('hex');
}

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_\-:.]{8,128}$/;

export const IdempotencyService = {
  async execute<T>(
    args: {
      scope: string;
      userId: string;
      key: string;
      requestHash: string;
      /** how long a crashed owner blocks the key before another request may take over */
      lockMs?: number;
      /** how long a duplicate waits for an in-flight original */
      waitMs?: number;
      ttlMs?: number;
    },
    work: (ctx: IdempotentContext<T>) => Promise<IdempotentResult<T>>,
  ): Promise<IdempotentResult<T> & { replayed: boolean }> {
    const { scope, userId, key, requestHash } = args;
    const lockMs = args.lockMs ?? 60_000;
    const waitMs = args.waitMs ?? 15_000;
    const ttlMs = args.ttlMs ?? 24 * 3_600_000;
    const deadline = Date.now() + waitMs;
    const ownerToken = randomUUID();
    const id = { scope, userId, key };

    for (;;) {
      let owned = false;
      try {
        await IdempotencyKey.create({
          ...id,
          requestHash,
          status: 'IN_PROGRESS',
          ownerToken,
          lockedUntil: new Date(Date.now() + lockMs),
          expiresAt: new Date(Date.now() + ttlMs),
        });
        owned = true;
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
      }

      if (!owned) {
        const existing = await IdempotencyKey.findOne(id).lean();
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new AppError(
              422,
              'IDEMPOTENCY_KEY_REUSED',
              'This Idempotency-Key was already used with a different request payload',
            );
          }
          if (existing.status === 'COMPLETED') {
            return {
              status: existing.responseStatus ?? 200,
              body: existing.response as T,
              replayed: true,
            };
          }
          // in progress: take over only if the owner's lock lapsed (owner crashed)
          if (existing.lockedUntil <= new Date()) {
            const taken = await IdempotencyKey.findOneAndUpdate(
              {
                ...id,
                status: 'IN_PROGRESS',
                lockedUntil: { $lte: new Date() },
                ownerToken: existing.ownerToken,
              },
              { $set: { ownerToken, lockedUntil: new Date(Date.now() + lockMs) } },
            );
            if (taken) owned = true;
          }
        }
        if (!owned) {
          if (Date.now() >= deadline) {
            throw new AppError(
              409,
              'IDEMPOTENCY_IN_PROGRESS',
              'A request with this Idempotency-Key is still being processed; retry shortly',
            );
          }
          await sleep(75);
          continue; // re-evaluate (original may have completed or failed and released the key)
        }
      }

      // ---- we own the key ----
      try {
        const ctx: IdempotentContext<T> = {
          complete: async (session, result) => {
            await IdempotencyKey.updateOne(
              { ...id, ownerToken },
              {
                $set: {
                  status: 'COMPLETED',
                  responseStatus: result.status,
                  response: JSON.parse(JSON.stringify(result.body)),
                },
              },
              { session },
            );
          },
        };
        const result = await work(ctx);
        // work() that never called complete() inside a transaction still completes here
        await IdempotencyKey.updateOne(
          { ...id, ownerToken, status: 'IN_PROGRESS' },
          {
            $set: {
              status: 'COMPLETED',
              responseStatus: result.status,
              response: JSON.parse(JSON.stringify(result.body)),
            },
          },
        );
        return { ...result, replayed: false };
      } catch (err) {
        // Failed requests are not cached: release the key so the client can retry.
        await IdempotencyKey.deleteOne({ ...id, ownerToken, status: 'IN_PROGRESS' }).catch(
          () => undefined,
        );
        throw err;
      }
    }
  },
};
