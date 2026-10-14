import { Schema, model } from 'mongoose';

const fils = {
  type: Number,
  required: true,
  default: 0,
  validate: { validator: Number.isSafeInteger, message: 'must be an integer in fils' },
};

/**
 * Nurse wallet. Balances are denormalised, derived data: they may ONLY be changed by
 * WalletService.apply(), which writes the immutable ledger row in the same MongoDB transaction.
 */
const walletSchema = new Schema(
  {
    nurseId: { type: Schema.Types.ObjectId, ref: 'NurseProfile', required: true },
    availableBalanceMinor: { ...fils, min: 0 },
    pendingBalanceMinor: { ...fils, min: 0 },
    totalEarnedMinor: { ...fils, min: 0 },
    totalWithdrawnMinor: { ...fils, min: 0 },
    currency: { type: String, enum: ['AED'], default: 'AED' },
    version: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
walletSchema.index({ nurseId: 1 }, { unique: true });
export const Wallet = model('Wallet', walletSchema, 'wallets');
export type WalletDoc = InstanceType<typeof Wallet>;

export const LEDGER_TYPES = [
  'EARNING', // payment confirmed: credit to PENDING
  'RELEASE', // PENDING -> AVAILABLE (two rows)
  'REVERSAL', // earnings taken back (refund, dispute refund)
  'REFUND', // reserved: refund-related ledger movements
  'ADJUSTMENT', // admin adjustment / compensating entry (e.g. restore after a failed refund)
  'PAYOUT', // payout requested: AVAILABLE debit
  'PAYOUT_SETTLED', // provider confirmed payout (bookkeeping row, bucket NONE)
  'PAYOUT_REVERSAL', // payout failed/cancelled: AVAILABLE credit back
  'COMMISSION', // reserved
] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

const walletTransactionSchema = new Schema(
  {
    walletId: { type: Schema.Types.ObjectId, ref: 'Wallet', required: true },
    nurseId: { type: Schema.Types.ObjectId, ref: 'NurseProfile', required: true },
    type: { type: String, enum: LEDGER_TYPES, required: true },
    bucket: { type: String, enum: ['PENDING', 'AVAILABLE', 'NONE'], required: true },
    /** Signed change of `bucket`. Zero only for bucket NONE bookkeeping rows. */
    amountMinor: { type: Number, required: true, validate: Number.isSafeInteger },
    balanceBefore: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    /** Signed change to totalEarned / totalWithdrawn carried by this row (for reconciliation). */
    earnedDelta: { type: Number, required: true, default: 0 },
    withdrawnDelta: { type: Number, required: true, default: 0 },
    currency: { type: String, enum: ['AED'], default: 'AED' },
    referenceType: {
      type: String,
      enum: ['BOOKING', 'PAYMENT', 'REFUND', 'PAYOUT', 'MANUAL'],
      required: true,
    },
    referenceId: { type: Schema.Types.ObjectId, required: true },
    idempotencyKey: { type: String, required: true },
    /** Position in this wallet's history (wallet.version after the change). Gap-free: used by reconciliation. */
    seq: { type: Number, required: true, min: 1 },
    note: { type: String, maxlength: 500 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, strict: 'throw' },
);
walletTransactionSchema.index({ idempotencyKey: 1 }, { unique: true });
walletTransactionSchema.index({ walletId: 1, createdAt: -1 });
walletTransactionSchema.index({ walletId: 1, seq: 1 }, { unique: true });
walletTransactionSchema.index({ referenceType: 1, referenceId: 1 });
for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const) {
  walletTransactionSchema.pre(op, () => {
    throw new Error('walletTransactions are append-only');
  });
}
export const WalletTransaction = model(
  'WalletTransaction',
  walletTransactionSchema,
  'walletTransactions',
);
export type WalletTransactionDoc = InstanceType<typeof WalletTransaction>;
