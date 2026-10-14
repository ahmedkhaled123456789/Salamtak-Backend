import { Schema, model } from 'mongoose';

export const AVAILABILITY_KINDS = ['WEEKLY', 'DATE', 'BLOCKED'] as const;
export const BLOCK_TYPES = ['VACATION', 'BLOCKED', 'HOLIDAY'] as const;

/**
 * One document per rule. Times are minutes since local midnight in the platform timezone;
 * dates are local calendar dates (YYYY-MM-DD). Bookings themselves are UTC instants.
 */
const nurseAvailabilitySchema = new Schema(
  {
    nurseId: { type: Schema.Types.ObjectId, ref: 'NurseProfile', required: true },
    kind: { type: String, enum: AVAILABILITY_KINDS, required: true },
    dayOfWeek: { type: Number, min: 1, max: 7 }, // WEEKLY, ISO (1=Mon)
    date: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ }, // DATE
    dateFrom: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ }, // BLOCKED (inclusive)
    dateTo: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    blockType: { type: String, enum: BLOCK_TYPES },
    isAvailable: { type: Boolean }, // DATE
    startMinute: { type: Number, min: 0, max: 1439 },
    endMinute: { type: Number, min: 1, max: 1440 },
    reason: { type: String, maxlength: 200 },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);

nurseAvailabilitySchema.index({ nurseId: 1, kind: 1, dayOfWeek: 1 });
nurseAvailabilitySchema.index({ nurseId: 1, kind: 1, date: 1 });
nurseAvailabilitySchema.index({ nurseId: 1, kind: 1, dateFrom: 1, dateTo: 1 });

export const NurseAvailability = model(
  'NurseAvailability',
  nurseAvailabilitySchema,
  'nurseAvailabilities',
);
export type NurseAvailabilityDoc = InstanceType<typeof NurseAvailability>;
