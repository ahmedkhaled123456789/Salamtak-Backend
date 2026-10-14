import { Schema, model, type InferSchemaType } from 'mongoose';
import { geoPointSchema } from '../../common/types/geo';

const patientProfileSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    emergencyContact: {
      name: { type: String, trim: true, maxlength: 120 },
      phone: { type: String, trim: true, match: /^\+[1-9]\d{7,14}$/ },
      relation: { type: String, trim: true, maxlength: 60 },
    },
    address: { type: String, trim: true, maxlength: 300 },
    city: { type: String, trim: true, maxlength: 100 },
    country: { type: String, trim: true, maxlength: 100 },
    location: { type: geoPointSchema },
    // Basic, non-medical notes only. Medical data belongs in patientHealthProfiles (later phase).
    notes: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);

patientProfileSchema.index({ userId: 1 }, { unique: true });
patientProfileSchema.index({ location: '2dsphere' }, { sparse: true });

export type PatientProfileAttrs = InferSchemaType<typeof patientProfileSchema>;
export const PatientProfile = model('PatientProfile', patientProfileSchema, 'patientProfiles');
export type PatientProfileDoc = InstanceType<typeof PatientProfile>;
