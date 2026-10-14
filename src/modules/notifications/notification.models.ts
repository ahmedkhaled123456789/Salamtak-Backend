import { Schema, model } from 'mongoose';

export const CHANNELS = ['IN_APP', 'EMAIL', 'PUSH'] as const;
export type Channel = (typeof CHANNELS)[number];
export const DELIVERY_STATUSES = ['PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * The logical notification (one per recipient + event type + reference). It IS the in-app inbox
 * entry. Texts are generic and carry reference ids only (no clinical details, no secrets).
 */
const notificationSchema = new Schema(
  {
    recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true, maxlength: 60 },
    title: { type: String, required: true, maxlength: 120 },
    body: { type: String, required: true, maxlength: 500 },
    /** Small, safe metadata (ids, amounts, state names). */
    data: { type: Schema.Types.Mixed },
    /** Deterministic business reference, e.g. `<bookingId>:CONFIRMED`. Part of the uniqueness key. */
    referenceKey: { type: String, required: true, maxlength: 200 },
    readAt: Date,
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
// Retries / duplicate events can never create a second logical notification.
notificationSchema.index({ recipientId: 1, type: 1, referenceKey: 1 }, { unique: true });
notificationSchema.index({ recipientId: 1, createdAt: -1 });
notificationSchema.index({ recipientId: 1, readAt: 1, createdAt: -1 });
export const Notification = model('Notification', notificationSchema, 'notifications');
export type NotificationDoc = InstanceType<typeof Notification>;

/** One row per (notification, channel): the delivery state machine. At-least-once with provider-side dedup by reference. */
const deliverySchema = new Schema(
  {
    notificationId: { type: Schema.Types.ObjectId, ref: 'Notification', required: true },
    recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    channel: { type: String, enum: CHANNELS, required: true },
    status: { type: String, enum: DELIVERY_STATUSES, required: true, default: 'PENDING' },
    attempts: { type: Number, default: 0 },
    /** PENDING: when it is due; PROCESSING: lease expiry (a crashed worker's claim lapses). */
    nextAttemptAt: Date,
    providerMessageId: String,
    lastError: { type: String, maxlength: 300 },
    skippedReason: String,
    sentAt: Date,
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
deliverySchema.index({ notificationId: 1, channel: 1 }, { unique: true });
deliverySchema.index({ status: 1, nextAttemptAt: 1 });
export const NotificationDelivery = model(
  'NotificationDelivery',
  deliverySchema,
  'notificationDeliveries',
);
export type NotificationDeliveryDoc = InstanceType<typeof NotificationDelivery>;
