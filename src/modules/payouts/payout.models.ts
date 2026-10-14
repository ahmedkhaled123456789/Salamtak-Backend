import { Schema, model } from 'mongoose';

/** PROVIDER_PAID = the provider paid the nurse; only LOCAL settlement is pending (never a failure). */
export const PAYOUT_STATUSES = [
  'PENDING',
  'PROCESSING',
  'PROVIDER_PAID',
  'PAID',
  'FAILED',
  'CANCELLED',
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/**
 * Where a nurse is paid. Only the provider's own token/reference and non-sensitive display data are
 * stored: never raw IBAN/account numbers or card data.
 */
const payoutMethodSchema = new Schema(
  {
    nurseId: { type: Schema.Types.ObjectId, ref: 'NurseProfile', required: true },
    provider: { type: String, required: true },
    providerRef: { type: String, required: true, maxlength: 120 },
    last4: { type: String, match: /^\d{4}$/ },
    bankName: { type: String, maxlength: 80 },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
payoutMethodSchema.index({ nurseId: 1 }, { unique: true });
export const PayoutMethod = model('PayoutMethod', payoutMethodSchema, 'payoutMethods');

const fils = {
  type: Number,
  required: true,
  min: 1,
  validate: { validator: Number.isSafeInteger, message: 'must be an integer in fils' },
};

const payoutSchema = new Schema(
  {
    nurseId: { type: Schema.Types.ObjectId, ref: 'NurseProfile', required: true },
    walletId: { type: Schema.Types.ObjectId, ref: 'Wallet', required: true },
    amountMinor: fils,
    currency: { type: String, enum: ['AED'], default: 'AED' },
    status: { type: String, enum: PAYOUT_STATUSES, required: true, default: 'PENDING' },
    provider: { type: String, required: true },
    providerRef: { type: String, required: true }, // token copy at request time
    providerPayoutId: String,
    providerPaidAt: Date,
    finalizeAttempts: { type: Number, default: 0 },
    finalizeError: { type: String, maxlength: 400 },
    /** idempotency-key generation: bumped only after the provider DEFINITIVELY reported failure */
    providerKeySeq: { type: Number, default: 0 },
    processingSince: Date,
    attempts: { type: Number, default: 0 },
    failureCount: { type: Number, default: 0 },
    lastAttemptAt: Date,
    nextRetryAt: Date,
    lastError: { type: String, maxlength: 400 },
    idempotencyKey: { type: String, required: true },
    paidAt: Date,
    failedAt: Date,
    cancelledAt: Date,
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
payoutSchema.index({ idempotencyKey: 1 }, { unique: true });
// One open payout per nurse: a second concurrent request cannot start while one is in flight.
payoutSchema.index(
  { nurseId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['PENDING', 'PROCESSING', 'PROVIDER_PAID'] } },
  },
);
payoutSchema.index({ nurseId: 1, createdAt: -1 });
payoutSchema.index({ status: 1, nextRetryAt: 1 });
payoutSchema.index({ providerPayoutId: 1 }, { sparse: true });
export const Payout = model('Payout', payoutSchema, 'payouts');
export type PayoutDoc = InstanceType<typeof Payout>;
