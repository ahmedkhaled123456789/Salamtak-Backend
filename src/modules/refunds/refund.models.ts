import { Schema, model } from 'mongoose';

/**
 * PENDING (retry scheduled) -> PROCESSING (claimed / provider accepted asynchronously)
 *   -> PROVIDER_SUCCEEDED (the provider refunded the customer; only LOCAL finalization is pending)
 *   -> SUCCEEDED.   FAILED = automatic retries exhausted; a later verified provider success can still reconcile it.
 */
export const REFUND_STATUSES = [
  'PENDING',
  'PROCESSING',
  'PROVIDER_SUCCEEDED',
  'SUCCEEDED',
  'FAILED',
] as const;
export const REFUND_REASONS = [
  'PATIENT_CANCELLATION',
  'NURSE_REJECTED',
  'NURSE_TIMEOUT',
  'ADMIN_CANCELLATION',
  'ADMIN_RESOLUTION',
  'BOOKING_EXPIRED_BEFORE_PAYMENT_CONFIRMATION',
  'DUPLICATE_PAYMENT',
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];
export type RefundStatus = (typeof REFUND_STATUSES)[number];

const fils = {
  type: Number,
  required: true,
  min: 0,
  validate: { validator: Number.isSafeInteger, message: 'must be an integer in fils' },
};

/**
 * A refund obligation. It outlives provider failures: PENDING (retry scheduled) -> PROCESSING
 * (claimed) -> SUCCEEDED, or FAILED once automatic retries are exhausted (needs an admin).
 * Only a verified provider success produces SUCCEEDED; everything else leaves the money owed.
 */
const refundSchema = new Schema(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking' }, // absent for late/duplicate-payment refunds
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    provider: { type: String, required: true },
    providerTransactionId: { type: String, required: true },
    amountMinor: { ...fils, min: 1 },
    currency: { type: String, enum: ['AED'], default: 'AED' },
    percent: { type: Number, min: 1, max: 100, required: true },
    type: { type: String, enum: ['FULL', 'PARTIAL'], required: true },
    reason: { type: String, enum: REFUND_REASONS, required: true },
    status: { type: String, enum: REFUND_STATUSES, required: true, default: 'PENDING' },
    /** every provider call, successful or not */
    attempts: { type: Number, default: 0 },
    /** consecutive failed attempts; drives backoff, alerts and the final FAILED */
    failureCount: { type: Number, default: 0 },
    lastAttemptAt: Date,
    nextRetryAt: Date,
    lastError: { type: String, maxlength: 400 },
    lastErrorAt: Date,
    providerRefundId: String,
    providerResponse: Schema.Types.Mixed, // sanitised
    providerSucceededAt: Date,
    /** local finalization attempts after provider success (never counted as provider failures) */
    finalizeAttempts: { type: Number, default: 0 },
    finalizeError: { type: String, maxlength: 400 },
    /** idempotency-key generation: bumped only after the provider DEFINITIVELY reported failure */
    providerKeySeq: { type: Number, default: 0 },
    lastFailedProviderRefundId: String,
    /** when the provider first answered PENDING (drives the maximum processing age) */
    processingSince: Date,
    /** bumped when an admin re-opens a FAILED refund (keeps ledger idempotency keys distinct) */
    generation: { type: Number, default: 1 },
    idempotencyKey: { type: String, required: true },
    succeededAt: Date,
    failedAt: Date,
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
refundSchema.index({ idempotencyKey: 1 }, { unique: true });
// At most one live (or completed) refund per payment => a payment can never be refunded twice.
refundSchema.index(
  { paymentId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ['PENDING', 'PROCESSING', 'PROVIDER_SUCCEEDED', 'SUCCEEDED'] },
    },
  },
);
refundSchema.index({ bookingId: 1 });
refundSchema.index({ status: 1, nextRetryAt: 1 });
refundSchema.index({ providerRefundId: 1 }, { sparse: true });
export const Refund = model('Refund', refundSchema, 'refunds');
export type RefundDoc = InstanceType<typeof Refund>;
