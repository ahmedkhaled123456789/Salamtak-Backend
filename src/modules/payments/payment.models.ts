import { Schema, model } from 'mongoose';

export const PAYMENT_STATUSES = [
  'PENDING',
  'PROCESSING',
  'PAID',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

const fils = {
  type: Number,
  required: true,
  min: 0,
  validate: { validator: Number.isSafeInteger, message: 'must be an integer in fils' },
};

/**
 * One document per payment attempt. `PAID` is set ONLY by the verified provider webhook; nothing a
 * client sends can move a payment to PAID. The provider's client secret is never stored.
 */
const paymentSchema = new Schema(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    nurseId: { type: Schema.Types.ObjectId, ref: 'NurseProfile', required: true },
    provider: { type: String, required: true },
    providerTransactionId: { type: String },
    reference: { type: String, required: true },
    amountMinor: fils, // copied from the booking's pricing snapshot, never from the client
    currency: { type: String, enum: ['AED'], default: 'AED' },
    status: { type: String, enum: PAYMENT_STATUSES, required: true, default: 'PENDING' },
    refundedMinor: { ...fils, default: 0 },
    /** APPLIED: settled the booking; LATE_REFUND: arrived when the booking was no longer payable. */
    settlement: { type: String, enum: ['APPLIED', 'LATE_REFUND', 'DUPLICATE_REFUND'] },
    paidAt: Date,
    /** provider-verified payment time (when trusted) and which clock decided the hold check */
    providerPaidAt: Date,
    paidTimeSource: { type: String, enum: ['PROVIDER', 'PROCESSING'] },
    failedAt: Date,
    failureReason: { type: String, maxlength: 200 },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
paymentSchema.index({ providerTransactionId: 1 }, { unique: true, sparse: true });
paymentSchema.index({ reference: 1 }, { unique: true });
paymentSchema.index({ bookingId: 1, status: 1 });
// At most one OPEN payment attempt per booking (concurrent POST /payments/create cannot fork two intents).
paymentSchema.index(
  { bookingId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['PENDING', 'PROCESSING'] } } },
);
paymentSchema.index({ patientId: 1, createdAt: -1 });
paymentSchema.index({ status: 1, createdAt: -1 });
export const Payment = model('Payment', paymentSchema, 'payments');
export type PaymentDoc = InstanceType<typeof Payment>;

/** Inbox of provider deliveries: dedup + audit. Unique {provider, eventId} makes duplicates harmless. */
const webhookSchema = new Schema(
  {
    provider: { type: String, required: true },
    eventId: { type: String, required: true },
    eventType: { type: String, required: true },
    payloadHash: { type: String, required: true },
    receivedAt: { type: Date, required: true, default: () => new Date() },
    processedAt: Date,
    processingStatus: {
      type: String,
      enum: ['RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED'],
      required: true,
      default: 'RECEIVED',
    },
    attempts: { type: Number, default: 0 },
    leaseUntil: Date,
    errorMessage: { type: String, maxlength: 500 },
    outcome: { type: String, maxlength: 100 },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
webhookSchema.index({ provider: 1, eventId: 1 }, { unique: true });
webhookSchema.index({ processingStatus: 1, receivedAt: 1 });
export const PaymentWebhook = model('PaymentWebhook', webhookSchema, 'paymentWebhooks');
export type PaymentWebhookDoc = InstanceType<typeof PaymentWebhook>;
