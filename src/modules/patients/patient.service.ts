import type { ClientSession } from 'mongoose';
import { NotFoundError } from '../../common/errors';
import { fromGeoPoint, toGeoPoint, type LatLng } from '../../common/types/geo';
import { PatientProfile, type PatientProfileDoc } from './patientProfile.model';

export interface UpdatePatientInput {
  emergencyContact?: { name?: string; phone?: string; relation?: string };
  address?: string;
  city?: string;
  country?: string;
  location?: LatLng | null;
  notes?: string;
}

export function toPatientDTO(p: PatientProfileDoc) {
  return {
    id: String(p._id),
    userId: String(p.userId),
    emergencyContact: p.emergencyContact ?? null,
    address: p.address ?? null,
    city: p.city ?? null,
    country: p.country ?? null,
    location: fromGeoPoint(p.location),
    notes: p.notes ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export const PatientService = {
  async createEmpty(userId: string, session?: ClientSession): Promise<void> {
    await PatientProfile.create([{ userId }], { session });
  },

  async getByUserId(userId: string): Promise<PatientProfileDoc> {
    const profile = await PatientProfile.findOne({ userId });
    if (!profile) throw new NotFoundError('Patient profile not found', 'PATIENT_PROFILE_NOT_FOUND');
    return profile;
  },

  async update(userId: string, input: UpdatePatientInput): Promise<PatientProfileDoc> {
    const { location, emergencyContact, ...rest } = input;
    const $set: Record<string, unknown> = { ...rest };
    const $unset: Record<string, 1> = {};
    if (emergencyContact) {
      for (const [k, v] of Object.entries(emergencyContact)) $set[`emergencyContact.${k}`] = v;
    }
    if (location === null) $unset.location = 1;
    else if (location) $set.location = toGeoPoint(location);

    const update: Record<string, unknown> = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;

    const profile = await PatientProfile.findOneAndUpdate({ userId }, update, {
      new: true,
      runValidators: true,
    });
    if (!profile) throw new NotFoundError('Patient profile not found', 'PATIENT_PROFILE_NOT_FOUND');
    return profile;
  },
};
