import { Schema, model } from 'mongoose';

export const SERVICE_CATEGORIES = [
  'NURSING',
  'ELDERLY_CARE',
  'POST_SURGERY',
  'CHRONIC_CARE',
  'DAILY_ASSISTANCE',
  'MEDICATION',
  'MONITORING',
  'COMPANIONSHIP',
  'OTHER',
] as const;
export const BILLING_UNITS = ['HOURLY', 'DAILY'] as const;

const serviceSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, trim: true, lowercase: true, maxlength: 140 },
    description: { type: String, trim: true, maxlength: 2000 },
    category: { type: String, enum: SERVICE_CATEGORIES, default: 'OTHER' },
    isActive: { type: Boolean, default: true },
    /** How the service is priced: per hour or per (24h) day. Rates live in servicePrices. */
    billingUnit: { type: String, enum: BILLING_UNITS, required: true },
    minDurationMinutes: { type: Number, required: true, min: 15, max: 60 * 24 * 14 },
    maxDurationMinutes: { type: Number, required: true, min: 15, max: 60 * 24 * 14 },
    /** Informational default shown to clients (e.g. a typical visit). */
    expectedDurationMinutes: { type: Number, min: 15, max: 60 * 24 * 14 },
    /** Optional per-service commission (basis points); falls back to commission.defaultBps. */
    commissionBps: { type: Number, min: 0, max: 10_000 },
    sortOrder: { type: Number, default: 0 },
    /** Public picture of the service (FileObject with purpose SERVICE_IMAGE). */
    imageId: { type: Schema.Types.ObjectId, ref: 'FileObject' },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
serviceSchema.index({ slug: 1 }, { unique: true });
serviceSchema.index({ name: 1 }, { unique: true });
serviceSchema.index({ isActive: 1, category: 1, sortOrder: 1 });
export const Service = model('Service', serviceSchema, 'services');
export type ServiceDoc = InstanceType<typeof Service>;

/** nurse <-> service relation with optional per-nurse rate overrides (fils). */
const nurseServiceOfferSchema = new Schema(
  {
    nurseId: { type: Schema.Types.ObjectId, ref: 'NurseProfile', required: true },
    serviceId: { type: Schema.Types.ObjectId, ref: 'Service', required: true },
    isEnabled: { type: Boolean, default: true },
    hourlyRateMinor: {
      type: Number,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: 'must be an integer in fils' },
    },
    dailyRateMinor: {
      type: Number,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: 'must be an integer in fils' },
    },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
nurseServiceOfferSchema.index({ nurseId: 1, serviceId: 1 }, { unique: true });
nurseServiceOfferSchema.index({ serviceId: 1, isEnabled: 1 });
export const NurseServiceOffer = model(
  'NurseServiceOffer',
  nurseServiceOfferSchema,
  'nurseServices',
);
export type NurseServiceOfferDoc = InstanceType<typeof NurseServiceOffer>;
