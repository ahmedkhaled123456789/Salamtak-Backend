import '../../common/openapi/extend';
import { z } from 'zod';
import { BILLING_UNITS, SERVICE_CATEGORIES } from './service.models';

/** Service payload as returned by the catalogue endpoints (OpenAPI documentation). */
export const ServiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  category: z.enum(SERVICE_CATEGORIES),
  isActive: z.boolean(),
  billingUnit: z.enum(BILLING_UNITS),
  minDurationMinutes: z.number(),
  maxDurationMinutes: z.number(),
  expectedDurationMinutes: z.number().nullable(),
  sortOrder: z.number(),
  imageUrl: z.string().nullable().openapi({ description: 'Public picture, relative to the API origin' }),
  currency: z.literal('AED').optional(),
  baseRatesMinor: z
    .object({
      hourly: z.number().nullable(),
      daily: z.number().nullable(),
      weekendSurchargeBps: z.number().nullable(),
      holidaySurchargeBps: z.number().nullable(),
    })
    .optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
