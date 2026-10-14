import { Schema, model } from 'mongoose';

export const REVIEW_STATUSES = ['ACTIVE', 'HIDDEN', 'FLAGGED'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * The source data for nurse ratings. NurseProfile.averageRating / totalReviews / ratingSum are a
 * denormalised cache maintained in the same transaction and reconcilable from this collection.
 * Only ACTIVE reviews are public and counted; HIDDEN and FLAGGED are neither.
 */
const reviewSchema = new Schema(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    nurseId: { type: Schema.Types.ObjectId, ref: 'NurseProfile', required: true },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
      validate: { validator: Number.isInteger, message: 'rating must be an integer 1-5' },
    },
    comment: { type: String, trim: true, maxlength: 1000 },
    status: { type: String, enum: REVIEW_STATUSES, default: 'ACTIVE' },
    moderatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    moderatedAt: Date,
    moderationReason: { type: String, maxlength: 500 },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
// one review per booking, enforced by the database
reviewSchema.index({ bookingId: 1 }, { unique: true });
reviewSchema.index({ nurseId: 1, status: 1, createdAt: -1 });
reviewSchema.index({ patientId: 1, createdAt: -1 });
reviewSchema.index({ status: 1, createdAt: -1 });
export const Review = model('Review', reviewSchema, 'reviews');
export type ReviewDoc = InstanceType<typeof Review>;
