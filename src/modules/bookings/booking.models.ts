import { Schema, model } from 'mongoose';
import { geoPointSchema } from '../../common/types/geo';
import { BOOKING_STATUSES } from './booking.states';

const fils = {
  type: Number,
  required: true,
  min: 0,
  validate: { validator: Number.isSafeInteger, message: 'must be an integer in fils' },
};

const lineSchema = new Schema(
  {
    code: { type: String, required: true },
    label: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitAmountMinor: fils,
    amountMinor: fils,
  },
  { _id: false },
);

/** Everything the price was derived from. Never changes after creation. */
const pricingSnapshotSchema = new Schema(
  {
    currency: { type: String, enum: ['AED'], required: true },
    unit: { type: String, enum: ['HOURLY', 'DAILY'], required: true },
    rateMinor: fils,
    rateSource: { type: String, enum: ['SERVICE', 'NURSE_OVERRIDE'], required: true },
    lines: { type: [lineSchema], required: true },
    baseMinor: fils,
    surchargeMinor: fils,
    feesMinor: fils,
    grossMinor: fils,
    discountMinor: fils,
    patientPayableMinor: fils,
    pricingVersion: { type: String, required: true },
    priceRuleIds: { type: [Schema.Types.ObjectId], default: [] },
    quotedAt: { type: Date, required: true },
  },
  { _id: false },
);

const financialSnapshotSchema = new Schema(
  {
    grossMinor: fils,
    discountMinor: fils,
    patientPaidMinor: fils, // amount the patient owes/pays
    platformFundedDiscountMinor: fils,
    commissionBps: { type: Number, required: true, min: 0, max: 10_000 },
    commissionMinor: fils,
    nurseEarningMinor: fils,
    paymentProcessingFeeMinor: fils, // estimate; actual lands in `settlement` (Phase 3)
    platformNetRevenueMinor: { type: Number, required: true, validate: Number.isSafeInteger },
  },
  { _id: false },
);

const bookingSchema = new Schema(
  {
    bookingNumber: { type: String, required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    nurseId: { type: Schema.Types.ObjectId, ref: 'NurseProfile', required: true },
    nurseUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    serviceId: { type: Schema.Types.ObjectId, ref: 'Service', required: true },
    serviceSnapshot: {
      name: { type: String, required: true },
      slug: { type: String, required: true },
      category: { type: String },
      billingUnit: { type: String, enum: ['HOURLY', 'DAILY'], required: true },
    },
    nurseSnapshot: { displayName: { type: String, required: true } },
    patientSnapshot: { displayName: { type: String, required: true } },

    // UTC instants. SOURCE OF TRUTH for conflicts.
    startDateTime: { type: Date, required: true },
    endDateTime: { type: Date, required: true },
    durationMinutes: { type: Number, required: true, min: 1 },
    slotMinutes: { type: Number, required: true },

    location: {
      point: { type: geoPointSchema, required: true },
      address: { type: String, required: true, maxlength: 300 },
      city: { type: String, maxlength: 100 },
      country: { type: String, maxlength: 100 },
    },
    notes: { type: String, maxlength: 1000 },
    genderPreference: { type: String, enum: ['MALE', 'FEMALE', 'OTHER'] },

    pricingSnapshot: { type: pricingSnapshotSchema, required: true },
    financialSnapshot: { type: financialSnapshotSchema, required: true },
    commissionSnapshot: {
      type: new Schema(
        {
          type: { type: String, enum: ['PERCENTAGE', 'FIXED'], required: true },
          bps: { type: Number, required: true },
          fixedMinor: { type: Number, min: 0 },
          platformMinor: fils,
          nurseMinor: fils,
        },
        { _id: false },
      ),
      required: true,
    },
    /** Terms of the coupon applied at creation. Immutable: history never depends on the live coupon. */
    couponSnapshot: {
      type: new Schema(
        {
          couponId: { type: Schema.Types.ObjectId, required: true },
          code: { type: String, required: true },
          type: { type: String, enum: ['FIXED', 'PERCENTAGE'], required: true },
          valueMinor: Number,
          valueBps: Number,
          maxDiscountMinor: Number,
          minBookingAmountMinor: { type: Number, required: true },
          discountMinor: { type: Number, required: true },
          couponVersion: { type: Number, required: true },
        },
        { _id: false },
      ),
    },
    refundPolicySnapshot: {
      tiers: [
        new Schema(
          {
            minHoursBeforeStart: Number,
            refundPercent: Number,
            nurseCompensationPercent: Number,
          },
          { _id: false },
        ),
      ],
    },

    status: { type: String, enum: BOOKING_STATUSES, required: true, default: 'PENDING' },
    statusUpdatedAt: { type: Date, required: true, default: () => new Date() },
    holdExpiresAt: { type: Date },
    nurseResponseDeadline: { type: Date },

    // Mutable, populated by later phases / lifecycle (never part of the immutable snapshots)
    paymentId: { type: Schema.Types.ObjectId },
    paidAt: { type: Date },
    settlement: { type: Schema.Types.Mixed },
    confirmedAt: Date,
    startedAt: Date,
    completedAt: Date,
    /** Set once the nurse's pending earnings for this booking were RELEASEd to available. */
    earningReleasedAt: Date,
    cancelledAt: Date,
    cancelledBy: { type: String },
    statusReason: { type: String, maxlength: 500 },

    /** Refund workflow state (business only in Phase 2.1; the provider refund is Phase 3). */
    refund: {
      type: new Schema(
        {
          status: {
            type: String,
            enum: ['NONE', 'PENDING', 'COMPLETED', 'FAILED'],
            required: true,
          },
          reason: {
            type: String,
            enum: [
              'PATIENT_CANCELLATION',
              'NURSE_REJECTED',
              'NURSE_TIMEOUT',
              'ADMIN_CANCELLATION',
              'ADMIN_RESOLUTION',
            ],
            required: true,
          },
          percent: { type: Number, min: 0, max: 100, required: true },
          amountMinor: fils,
          requestedAt: { type: Date, required: true },
          completedAt: Date,
          providerRefundId: String,
        },
        { _id: false },
      ),
    },
    cancellationOutcome: {
      type: new Schema(
        {
          cancelledBy: { type: String, enum: ['PATIENT', 'ADMIN'], required: true },
          hoursBeforeStart: { type: Number, required: true },
          tierMinHours: Number,
          overridden: { type: Boolean, required: true },
          refundPercent: { type: Number, required: true },
          refundMinor: fils,
          nurseCompensationMinor: fils,
          // may be negative when the platform funds a discount (see allocateRetained)
          platformKeptMinor: { type: Number, required: true, validate: Number.isSafeInteger },
        },
        { _id: false },
      ),
    },
    version: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);

bookingSchema.index({ bookingNumber: 1 }, { unique: true });
bookingSchema.index({ patientId: 1, createdAt: -1 });
bookingSchema.index({ nurseUserId: 1, startDateTime: -1 });
// Availability / overlap query (secondary guard; the slot reservations are the hard guard)
bookingSchema.index({ nurseId: 1, status: 1, startDateTime: 1, endDateTime: 1 });
bookingSchema.index({ serviceId: 1 });
bookingSchema.index({ status: 1, startDateTime: 1 });
bookingSchema.index(
  { status: 1, holdExpiresAt: 1 },
  { partialFilterExpression: { status: 'PAYMENT_PENDING' } },
);
bookingSchema.index(
  { status: 1, nurseResponseDeadline: 1 },
  { partialFilterExpression: { status: 'NURSE_PENDING' } },
);
bookingSchema.index({ status: 1, endDateTime: 1 });

const IMMUTABLE_PATHS = [
  'bookingNumber',
  'patientId',
  'nurseId',
  'nurseUserId',
  'serviceId',
  'serviceSnapshot',
  'nurseSnapshot',
  'patientSnapshot',
  'startDateTime',
  'endDateTime',
  'durationMinutes',
  'slotMinutes',
  'location',
  'pricingSnapshot',
  'financialSnapshot',
  'commissionSnapshot',
  'couponSnapshot',
  'refundPolicySnapshot',
];

function touchedKeys(update: unknown): string[] {
  if (!update || typeof update !== 'object') return [];
  const keys: string[] = [];
  for (const [k, v] of Object.entries(update as Record<string, unknown>)) {
    if (k.startsWith('$') && v && typeof v === 'object') keys.push(...Object.keys(v));
    else keys.push(k);
  }
  return keys;
}

/** Snapshots are immutable and `status` may only change through BookingStateMachine. */
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne'] as const) {
  bookingSchema.pre(op, function () {
    const keys = touchedKeys(this.getUpdate());
    const bad = keys.filter((k) => IMMUTABLE_PATHS.some((p) => k === p || k.startsWith(`${p}.`)));
    if (bad.length) throw new Error(`Booking fields are immutable: ${bad.join(', ')}`);
    const touchesStatus = keys.some((k) => k === 'status' || k === 'version');
    if (
      touchesStatus &&
      !(this.getOptions() as { transitionAuthorized?: boolean }).transitionAuthorized
    ) {
      throw new Error('Booking status can only be changed through BookingStateMachine');
    }
  });
}
for (const op of ['deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  bookingSchema.pre(op, () => {
    throw new Error('Bookings are never deleted');
  });
}

export const Booking = model('Booking', bookingSchema, 'bookings');
export type BookingDoc = InstanceType<typeof Booking>;

// ---------------- items ----------------
const bookingItemSchema = new Schema(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    kind: { type: String, enum: ['BASE', 'SURCHARGE', 'FEE', 'DISCOUNT'], required: true },
    code: { type: String, required: true },
    label: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitAmountMinor: fils,
    amountMinor: fils,
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, strict: 'throw' },
);
bookingItemSchema.index({ bookingId: 1 });
for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'deleteOne',
  'deleteMany',
] as const) {
  bookingItemSchema.pre(op, () => {
    throw new Error('bookingItems are immutable');
  });
}
export const BookingItem = model('BookingItem', bookingItemSchema, 'bookingItems');

// ---------------- history ----------------
const bookingHistorySchema = new Schema(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    previousState: { type: String, enum: [...BOOKING_STATUSES, null] },
    newState: { type: String, enum: BOOKING_STATUSES, required: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorRole: { type: String, enum: ['PATIENT', 'NURSE', 'ADMIN', 'SYSTEM'], required: true },
    reason: { type: String, maxlength: 500 },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, strict: 'throw' },
);
bookingHistorySchema.index({ bookingId: 1, createdAt: 1 });
for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
  'replaceOne',
] as const) {
  bookingHistorySchema.pre(op, () => {
    throw new Error('bookingHistories are append-only');
  });
}
export const BookingHistory = model('BookingHistory', bookingHistorySchema, 'bookingHistories');

// ---------------- reservations ----------------
/**
 * One document per occupied time slot (slotMinutes wide, UTC-aligned). The unique index on
 * {nurseId, slotStart} is the database-enforced "exclusion constraint": two bookings for the same
 * nurse can only coexist if their time ranges share no slot, i.e. they do not overlap.
 * Multiple bookings on the same calendar day are fine as long as their slots are disjoint.
 */
const reservationSchema = new Schema(
  {
    nurseId: { type: Schema.Types.ObjectId, ref: 'NurseProfile', required: true },
    slotStart: { type: Date, required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    state: { type: String, enum: ['HELD', 'CONFIRMED'], required: true },
    expiresAt: { type: Date },
  },
  { versionKey: false, strict: 'throw', timestamps: false },
);
reservationSchema.index({ nurseId: 1, slotStart: 1 }, { unique: true });
reservationSchema.index({ bookingId: 1 });
reservationSchema.index({ state: 1, expiresAt: 1 });
export const BookingReservation = model(
  'BookingReservation',
  reservationSchema,
  'bookingReservations',
);
