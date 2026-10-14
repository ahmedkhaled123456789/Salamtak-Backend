import '../../common/openapi/extend';
import { z } from 'zod';
import { NURSE_STATUSES, VERIFICATION_STATUSES } from './nurseProfile.model';

const latLng = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export const NurseProfileSchema = z.object({
  id: z.string(),
  userId: z.string(),
  bio: z.string().nullable(),
  yearsOfExperience: z.number(),
  specializations: z.array(z.string()),
  languages: z.array(z.string()),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).nullable(),
  dailyRateMinor: z.number().nullable(),
  hourlyRateMinor: z.number().nullable(),
  currency: z.literal('AED'),
  serviceRadiusKm: z.number(),
  location: latLng.nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  status: z.enum(NURSE_STATUSES),
  verificationStatus: z.enum(VERIFICATION_STATUSES),
  statusReason: z.string().nullable(),
  averageRating: z.number(),
  totalReviews: z.number(),
  totalCompletedBookings: z.number(),
  isBookable: z.boolean().openapi({ description: 'ACTIVE and VERIFIED' }),
  createdAt: z.date(),
  updatedAt: z.date(),
});
