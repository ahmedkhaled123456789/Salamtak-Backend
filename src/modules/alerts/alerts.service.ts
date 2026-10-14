import { Schema, model, type ClientSession } from 'mongoose';
import { logger } from '../../config/logger';

/**
 * Operational alerts for admins (stuck refunds, failed payouts, reconciliation drift, ...).
 * Phase 4 forwards open alerts to the notification channels; until then admins read them via the API.
 * `key` makes raising idempotent: repeating the same condition bumps `count`, never duplicates.
 */
const alertSchema = new Schema(
  {
    key: { type: String, required: true },
    type: { type: String, required: true },
    severity: { type: String, enum: ['INFO', 'WARNING', 'CRITICAL'], required: true },
    entity: { type: String, required: true },
    entityId: { type: Schema.Types.ObjectId },
    message: { type: String, required: true, maxlength: 500 },
    data: { type: Schema.Types.Mixed },
    status: { type: String, enum: ['OPEN', 'RESOLVED'], default: 'OPEN' },
    count: { type: Number, default: 1 },
    lastSeenAt: { type: Date, default: () => new Date() },
    resolvedAt: Date,
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
alertSchema.index({ key: 1 }, { unique: true });
alertSchema.index({ status: 1, severity: 1, createdAt: -1 });
export const AdminAlert = model('AdminAlert', alertSchema, 'adminAlerts');

export interface RaiseAlert {
  key: string;
  type: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  entity: string;
  entityId?: string;
  message: string;
  data?: Record<string, unknown>;
  /** A RESOLVED alert with this key is re-opened (and re-notified) when the condition recurs. */
  reopen?: boolean;
}

/**
 * Seam for notifications (Phase 4): called ONCE when an alert is first created (not on repeats),
 * inside the caller's transaction when there is one. Alerts never depend on the notification module.
 */
type AlertCreatedHook = (alert: RaiseAlert, session?: ClientSession) => Promise<void>;
let onCreated: AlertCreatedHook | undefined;
export const setAlertCreatedHook = (h: AlertCreatedHook | undefined): void => {
  onCreated = h;
};

export const AlertService = {
  async raise(a: RaiseAlert, session?: ClientSession): Promise<void> {
    logger.warn({ alert: a.type, key: a.key, entity: a.entity }, `ALERT ${a.message}`);
    const reopened =
      a.reopen &&
      (
        await AdminAlert.updateOne(
          { key: a.key, status: 'RESOLVED' },
          { $set: { status: 'OPEN' }, $unset: { resolvedAt: 1, resolvedBy: 1 } },
          { session },
        )
      ).modifiedCount === 1;
    const res = await AdminAlert.updateOne(
      { key: a.key },
      {
        $setOnInsert: {
          type: a.type,
          severity: a.severity,
          entity: a.entity,
          entityId: a.entityId,
          message: a.message,
          status: 'OPEN',
        },
        $set: { data: a.data, lastSeenAt: new Date() },
        $inc: { count: 1 },
      },
      { upsert: true, session },
    );
    if ((res.upsertedCount === 1 || reopened) && onCreated) {
      try {
        await onCreated(a, session);
      } catch (err) {
        // a notification problem must never break the operation that raised the alert
        logger.error({ err: (err as Error).message, key: a.key }, 'Alert notification hook failed');
      }
    }
  },

  /** Resolves an open alert by its idempotency key (e.g. when the underlying problem fixed itself). */
  async resolveByKey(key: string, note?: string, session?: ClientSession): Promise<void> {
    await AdminAlert.updateOne(
      { key, status: 'OPEN' },
      { $set: { status: 'RESOLVED', resolvedAt: new Date(), ...(note && { message: note }) } },
      { session },
    );
  },

  async resolve(id: string, by?: string): Promise<boolean> {
    const r = await AdminAlert.updateOne(
      { _id: id, status: 'OPEN' },
      { $set: { status: 'RESOLVED', resolvedAt: new Date(), resolvedBy: by } },
    );
    return r.modifiedCount === 1;
  },
};
