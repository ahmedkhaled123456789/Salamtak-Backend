import '../../common/openapi/extend';
import { z } from 'zod';

/** Nurse search card (OpenAPI documentation). */
export const NurseCardSchema = z.object({
  id: z.string().openapi({ description: 'Nurse profile id (use as nurseId when booking)' }),
  serviceIds: z.array(z.string()).openapi({ description: 'Ids of the services this nurse currently offers' }),
  dailyRateMinor: z.number().nullable().openapi({ description: "The nurse's own daily rate in fils, if set" }),
  displayName: z.string(),
  imageUrl: z.string().nullable().openapi({ description: 'Public photo, relative to the API origin' }),
  bio: z.string().nullable(),
  yearsOfExperience: z.number(),
  specializations: z.array(z.string()),
  languages: z.array(z.string()),
  gender: z.string().nullable(),
  averageRating: z.number(),
  totalReviews: z.number(),
  totalCompletedBookings: z.number(),
  city: z.string().nullable(),
  serviceRadiusKm: z.number(),
  distanceKm: z.number().nullable(),
  price: z
    .object({
      unit: z.enum(['HOURLY', 'DAILY']),
      unitAmountMinor: z.number().int(),
      currency: z.literal('AED'),
    })
    .nullable(),
  matchScore: z.number().nullable().openapi({ description: '0-100, only for sort=relevance' }),
  available: z.boolean().nullable(),
});
