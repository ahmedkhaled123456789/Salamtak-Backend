import { Schema, model } from 'mongoose';

export const COUPON_TYPES = ['FIXED', 'PERCENTAGE'] as const;
export type CouponType = (typeof COUPON_TYPES)[number];

const fils = {
  type: Number,
  min: 0,
  validate: { validator: Number.isSafeInteger, message: 'must be an integer in fils' },
};

/**
 * Platform-funded coupon. All money is integer fils, percentages are integer basis points. The
 * discount is always calculated by the server from the booking GROSS; nurse earnings are never reduced.
 */
const couponSchema = new Schema(
  {
    code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: /^[A-Z0-9_-]{3,40}$/,
    },
    description: { type: String, trim: true, maxlength: 300 },
    type: { type: String, enum: COUPON_TYPES, required: true },
    /** FIXED: amount off in fils */
    valueMinor: { ...fils, min: 1 },
    /** PERCENTAGE: basis points (1500 = 15%) */
    valueBps: { type: Number, min: 1, max: 10_000, validate: Number.isInteger },
    maxDiscountMinor: { ...fils, min: 1 },
    minBookingAmountMinor: { ...fils, default: 0 },
    usageLimit: { type: Number, min: 1, validate: Number.isInteger },
    perUserLimit: { type: Number, min: 1, validate: Number.isInteger },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    active: { type: Boolean, default: true },
    applicableServiceIds: { type: [Schema.Types.ObjectId], default: [] },
    applicableNurseIds: { type: [Schema.Types.ObjectId], default: [] },
    /** consumed uses (APPLIED redemptions). Changed only by conditional $inc in transactions. */
    usedCount: { type: Number, default: 0, min: 0 },
    /** bumped on every change to the terms; copied into booking snapshots */
    version: { type: Number, default: 1 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
couponSchema.index({ code: 1 }, { unique: true });
couponSchema.index({ active: 1, endAt: 1 });
export const Coupon = model('Coupon', couponSchema, 'coupons');
export type CouponDoc = InstanceType<typeof Coupon>;

/** One row per booking that consumed a use. RELEASED when an unpaid booking expired or was cancelled. */
const redemptionSchema = new Schema(
  {
    couponId: { type: Schema.Types.ObjectId, ref: 'Coupon', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    code: { type: String, required: true },
    discountMinor: { ...fils, required: true },
    status: { type: String, enum: ['APPLIED', 'RELEASED'], default: 'APPLIED' },
    releasedAt: Date,
    releaseReason: String,
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
redemptionSchema.index({ bookingId: 1 }, { unique: true });
redemptionSchema.index({ couponId: 1, status: 1 });
redemptionSchema.index({ userId: 1, couponId: 1 });
export const CouponRedemption = model('CouponRedemption', redemptionSchema, 'couponRedemptions');

/** Per (coupon, user) usage counter: the conditional increment is what makes perUserLimit race-proof. */
const userUsageSchema = new Schema(
  {
    couponId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    used: { type: Number, default: 0, min: 0 },
  },
  { versionKey: false, strict: 'throw' },
);
userUsageSchema.index({ couponId: 1, userId: 1 }, { unique: true });
export const CouponUserUsage = model('CouponUserUsage', userUsageSchema, 'couponUserUsage');
