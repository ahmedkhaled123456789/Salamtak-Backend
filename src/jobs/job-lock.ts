import { randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';

/**
 * Short-lived mutual exclusion for jobs that must not overlap (reconciliation). It lives in MongoDB
 * on purpose: the lock does not depend on Redis being healthy, and it expires by itself if the
 * holder crashes. It is an efficiency guard only: every protected operation is also safe to run twice.
 */
const lockSchema = new Schema(
  {
    _id: { type: String, required: true },
    owner: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false, timestamps: true },
);
lockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 }); // housekeeping only
export const JobLock = model('JobLock', lockSchema, 'jobLocks');

export async function withJobLock<T>(
  name: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const owner = randomUUID();
  const now = new Date();
  try {
    const r = await JobLock.updateOne(
      { _id: name, expiresAt: { $lte: now } },
      { $set: { owner, expiresAt: new Date(now.getTime() + ttlMs) } },
      { upsert: true },
    );
    if (r.matchedCount === 0 && r.upsertedCount === 0) return { acquired: false };
  } catch (err) {
    // duplicate key on the upsert path => somebody else holds an unexpired lock
    if ((err as { code?: number }).code === 11000) return { acquired: false };
    throw err;
  }
  try {
    return { acquired: true, value: await fn() };
  } finally {
    await JobLock.deleteOne({ _id: name, owner }).catch(() => undefined);
  }
}
