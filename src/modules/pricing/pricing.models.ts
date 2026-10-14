import { Schema, model } from 'mongoose';

export const PRICE_KINDS = [
  'HOURLY',
  'DAILY',
  'WEEKEND_SURCHARGE',
  'HOLIDAY_SURCHARGE',
  'FEE',
] as const;
export type PriceKind = (typeof PRICE_KINDS)[number];

const minor = {
  type: Number,
  min: 0,
  validate: { validator: Number.isSafeInteger, message: 'must be an integer (minor units / bps)' },
};

/**
 * Effective-dated rate card. Rows are never edited in place: a change closes the active row
 * (effectiveTo) and inserts a new version, so history stays reconstructable.
 *  - HOURLY / DAILY: base rate in fils per hour / per day
 *  - *_SURCHARGE: percentage in basis points applied to the base amount of affected days
 *  - FEE: fixed fee in fils per booking (code distinguishes multiple fees)
 */
const servicePriceSchema = new Schema(
  {
    serviceId: { type: Schema.Types.ObjectId, ref: 'Service', required: true },
    kind: { type: String, enum: PRICE_KINDS, required: true },
    code: { type: String, required: true, default: 'BASE', maxlength: 40 },
    label: { type: String, maxlength: 100 },
    amountMinor: minor,
    bps: { ...minor, max: 100_000 },
    currency: { type: String, enum: ['AED'], default: 'AED' },
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date },
    /** true for the single open-ended row of a kind/code; false once superseded. */
    isCurrent: { type: Boolean, required: true, default: true },
    version: { type: Number, required: true, default: 1 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
servicePriceSchema.index({ serviceId: 1, kind: 1, code: 1, effectiveFrom: -1 });
// At most one open-ended (current) row per service/kind/code.
servicePriceSchema.index(
  { serviceId: 1, kind: 1, code: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true } },
);
export const ServicePrice = model('ServicePrice', servicePriceSchema, 'servicePrices');
export type ServicePriceDoc = InstanceType<typeof ServicePrice>;

const holidaySchema = new Schema(
  {
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // local date
    name: { type: String, required: true, maxlength: 100 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
holidaySchema.index({ date: 1 }, { unique: true });
export const Holiday = model('Holiday', holidaySchema, 'holidays');

/**
 * Commission rules. Precedence NURSE > SERVICE > GLOBAL, then the service's own `commissionBps`,
 * then the `commission.defaultBps` setting. A rule is PERCENTAGE (integer basis points) or FIXED
 * (fils per booking, capped at gross). Rules are versioned and never edited in place; every booking
 * stores a snapshot of the rule that applied, so later changes never touch historical bookings.
 */
const commissionSchema = new Schema(
  {
    scope: { type: String, enum: ['GLOBAL', 'SERVICE', 'NURSE'], required: true },
    scopeKey: { type: String, required: true }, // GLOBAL | SERVICE:<id> | NURSE:<id>
    serviceId: { type: Schema.Types.ObjectId, ref: 'Service' },
    nurseId: { type: Schema.Types.ObjectId, ref: 'NurseProfile' },
    type: { type: String, enum: ['PERCENTAGE', 'FIXED'], required: true },
    bps: { type: Number, min: 0, max: 10_000, validate: Number.isSafeInteger },
    fixedMinor: { type: Number, min: 0, validate: Number.isSafeInteger },
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date },
    isCurrent: { type: Boolean, required: true, default: true },
    version: { type: Number, required: true, default: 1 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
commissionSchema.index({ scopeKey: 1, effectiveFrom: -1 });
commissionSchema.index(
  { scopeKey: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true } },
);
export const Commission = model('Commission', commissionSchema, 'commissions');
export type CommissionDoc = InstanceType<typeof Commission>;
