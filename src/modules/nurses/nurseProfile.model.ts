import { Schema, model, type InferSchemaType } from 'mongoose';
import { GENDERS } from '../users';
import { geoPointSchema } from '../../common/types/geo';

export const NURSE_STATUSES = ['PENDING', 'ACTIVE', 'INACTIVE', 'SUSPENDED'] as const;
export const VERIFICATION_STATUSES = [
  'PENDING',
  'UNDER_REVIEW',
  'VERIFIED',
  'REJECTED',
  'EXPIRED',
] as const;
export type NurseStatus = (typeof NURSE_STATUSES)[number];
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

const minorUnits = {
  type: Number,
  min: 0,
  validate: {
    validator: Number.isSafeInteger,
    message: 'must be an integer amount in minor units (fils)',
  },
};

const nurseProfileSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    bio: { type: String, trim: true, maxlength: 2000 },
    yearsOfExperience: { type: Number, min: 0, max: 70, default: 0 },
    specializations: {
      type: [{ type: String, trim: true, lowercase: true, maxlength: 60 }],
      default: [],
    },
    languages: {
      type: [{ type: String, trim: true, lowercase: true, maxlength: 40 }],
      default: [],
    },
    gender: { type: String, enum: GENDERS },
    dailyRateMinor: minorUnits,
    hourlyRateMinor: minorUnits,
    serviceRadiusKm: { type: Number, min: 0, max: 200, default: 10 },
    location: { type: geoPointSchema },
    address: { type: String, trim: true, maxlength: 300 },
    city: { type: String, trim: true, maxlength: 100 },
    country: { type: String, trim: true, maxlength: 100 },
    status: { type: String, enum: NURSE_STATUSES, default: 'PENDING' },
    verificationStatus: { type: String, enum: VERIFICATION_STATUSES, default: 'PENDING' },
    statusReason: { type: String, maxlength: 500 },
    averageRating: { type: Number, default: 0, min: 0, max: 5 },
    totalReviews: { type: Number, default: 0, min: 0 },
    ratingSum: { type: Number, default: 0, min: 0 },
    totalCompletedBookings: { type: Number, default: 0, min: 0 },
    /** Denormalized: status === ACTIVE && verificationStatus === VERIFIED. Maintained by NurseService only. */
    isBookable: { type: Boolean, default: false },
    /** Per-nurse write guard that serializes concurrent booking transactions (used from Phase 2). */
    bookingSeq: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);

nurseProfileSchema.index({ userId: 1 }, { unique: true });
nurseProfileSchema.index({ location: '2dsphere' }, { sparse: true });
nurseProfileSchema.index({ isBookable: 1, averageRating: -1 });
nurseProfileSchema.index({ status: 1 });
nurseProfileSchema.index({ verificationStatus: 1 });
nurseProfileSchema.index({ specializations: 1 });
nurseProfileSchema.index({ languages: 1 });
nurseProfileSchema.index({ gender: 1, isBookable: 1 });
nurseProfileSchema.index({ averageRating: -1 });

export const computeBookable = (status: NurseStatus, verification: VerificationStatus): boolean =>
  status === 'ACTIVE' && verification === 'VERIFIED';

export type NurseProfileAttrs = InferSchemaType<typeof nurseProfileSchema>;
export const NurseProfile = model('NurseProfile', nurseProfileSchema, 'nurseProfiles');
export type NurseProfileDoc = InstanceType<typeof NurseProfile>;
