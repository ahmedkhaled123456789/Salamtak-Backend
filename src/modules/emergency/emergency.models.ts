import { Schema, model } from 'mongoose';
import { geoPointSchema } from '../../common/types/geo';

export const EMERGENCY_STATUSES = [
  'PENDING',
  'MATCHING',
  'NURSE_OFFERED',
  'ACCEPTED',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
] as const;
export type EmergencyStatus = (typeof EMERGENCY_STATUSES)[number];
/** Requests that still occupy the patient's single "active emergency" slot. */
export const ACTIVE_EMERGENCY: EmergencyStatus[] = [
  'PENDING',
  'MATCHING',
  'NURSE_OFFERED',
  'ACCEPTED',
];

/**
 * An urgent request for a nurse. It is NOT a parallel booking system: when a nurse accepts, the
 * ordinary booking/payment flow is used (quote, reservation, payment, nurse acceptance, state
 * machine, idempotency). Notes are kept short and non-clinical; they never enter jobs or notifications.
 */
const requestSchema = new Schema(
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    serviceId: { type: Schema.Types.ObjectId, ref: 'Service', required: true },
    location: {
      type: new Schema(
        {
          point: { type: geoPointSchema, required: true },
          address: { type: String, required: true, maxlength: 300 },
          city: { type: String, maxlength: 100 },
        },
        { _id: false },
      ),
      required: true,
    },
    requestedStart: { type: Date, required: true },
    durationMinutes: { type: Number, required: true, min: 60, max: 24 * 60 },
    genderPreference: { type: String, enum: ['MALE', 'FEMALE', 'OTHER'] },
    notes: { type: String, trim: true, maxlength: 200 },
    status: { type: String, enum: EMERGENCY_STATUSES, required: true, default: 'PENDING' },
    statusReason: { type: String, maxlength: 300 },
    expiresAt: { type: Date, required: true },
    offersMade: { type: Number, default: 0 },
    /** bumped when an admin reopens the request, so earlier offers never block a new round */
    round: { type: Number, default: 1 },
    currentOfferId: { type: Schema.Types.ObjectId },
    acceptedNurseId: { type: Schema.Types.ObjectId, ref: 'NurseProfile' },
    acceptedAt: Date,
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking' },
    finalizeAttempts: { type: Number, default: 0 },
    idempotencyKey: { type: String, required: true },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
requestSchema.index({ patientId: 1, idempotencyKey: 1 }, { unique: true });
// a patient can have only ONE live emergency request (duplicate submissions cannot fork matching)
requestSchema.index(
  { patientId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ACTIVE_EMERGENCY } } },
);
requestSchema.index({ status: 1, expiresAt: 1 });
requestSchema.index({ patientId: 1, createdAt: -1 });
export const EmergencyRequest = model('EmergencyRequest', requestSchema, 'emergencyRequests');
export type EmergencyRequestDoc = InstanceType<typeof EmergencyRequest>;

export const OFFER_STATUSES = [
  'OFFERED',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

const offerSchema = new Schema(
  {
    requestId: { type: Schema.Types.ObjectId, ref: 'EmergencyRequest', required: true },
    round: { type: Number, default: 1 },
    nurseId: { type: Schema.Types.ObjectId, ref: 'NurseProfile', required: true },
    nurseUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: OFFER_STATUSES, required: true, default: 'OFFERED' },
    score: Number,
    expiresAt: { type: Date, required: true },
    respondedAt: Date,
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
// a nurse is offered a request at most once; only ONE offer per request can be live
offerSchema.index({ requestId: 1, round: 1, nurseId: 1 }, { unique: true });
offerSchema.index(
  { requestId: 1 },
  { unique: true, partialFilterExpression: { status: 'OFFERED' } },
);
offerSchema.index({ nurseUserId: 1, status: 1, expiresAt: 1 });
offerSchema.index({ status: 1, expiresAt: 1 });
export const EmergencyOffer = model('EmergencyOffer', offerSchema, 'emergencyOffers');
export type EmergencyOfferDoc = InstanceType<typeof EmergencyOffer>;
