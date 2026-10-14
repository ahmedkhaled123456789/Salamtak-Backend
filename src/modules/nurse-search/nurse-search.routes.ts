import '../../common/openapi/extend';
import { z } from 'zod';
import { createApi } from '../../common/openapi/route';
import { paginationQuery } from '../../common/pagination';
import { NurseSearchService, SEARCH_SORTS } from './nurse-search.service';
import { NurseCardSchema } from './nurse-search.schemas';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'invalid id');
const csv = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
const num = (min: number, max: number) => z.coerce.number().min(min).max(max);

const searchQuery = paginationQuery
  .extend({
    serviceId: objectId.optional(),
    gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
    startDateTime: z.coerce
      .date()
      .optional()
      .openapi({ description: 'With endDateTime: only nurses free for the whole range' }),
    endDateTime: z.coerce.date().optional(),
    lat: num(-90, 90).optional(),
    lng: num(-180, 180).optional(),
    maxDistanceKm: num(0, 500).optional(),
    withinNurseRadius: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional()
      .openapi({
        description:
          "Default true when lat/lng given: nurse's own service radius must cover the point",
      }),
    minExperience: num(0, 70).optional(),
    minRating: num(0, 5).optional(),
    minPrice: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .openapi({ description: 'fils per billing unit; requires serviceId' }),
    maxPrice: z.coerce.number().int().min(0).optional(),
    language: csv.optional().openapi({ description: 'Comma separated; any match' }),
    specialization: csv.optional().openapi({ description: 'Comma separated; any match' }),
    sort: z.enum(SEARCH_SORTS).default('relevance'),
  })
  .strict()
  .refine((q) => (q.lat === undefined) === (q.lng === undefined), {
    message: 'lat and lng must be provided together',
    path: ['lat'],
  })
  .refine((q) => (q.startDateTime === undefined) === (q.endDateTime === undefined), {
    message: 'startDateTime and endDateTime must be provided together',
    path: ['startDateTime'],
  });

const api = createApi('Nurse Search');

api.route({
  method: 'get',
  path: '/nurses',
  summary: 'Search nurses',
  description:
    'Only ACTIVE + VERIFIED nurses are ever returned. Geospatial filtering uses a MongoDB 2dsphere `$geoNear`. `sort=relevance` ranks with the matching service (0-100 score); availability filtering and relevance run over at most 300 pre-filtered candidates (`truncated` is true when that cap was hit).',
  permission: 'nurses:search',
  query: searchQuery,
  response: z.object({
    items: z.array(NurseCardSchema),
    meta: z.object({
      page: z.number(),
      limit: z.number(),
      total: z.number(),
      totalPages: z.number(),
    }),
    truncated: z.boolean(),
  }),
  handler: ({ query }) =>
    NurseSearchService.search({
      serviceId: query.serviceId,
      gender: query.gender,
      startDateTime: query.startDateTime,
      endDateTime: query.endDateTime,
      location:
        query.lat !== undefined && query.lng !== undefined
          ? { latitude: query.lat, longitude: query.lng }
          : undefined,
      maxDistanceKm: query.maxDistanceKm,
      withinNurseRadius: query.withinNurseRadius ?? true,
      minExperience: query.minExperience,
      minRating: query.minRating,
      minPrice: query.minPrice,
      maxPrice: query.maxPrice,
      languages: query.language,
      specializations: query.specialization,
      sort: query.sort,
      page: query.page,
      limit: query.limit,
    }),
});

api.route({
  method: 'get',
  path: '/nurses/:id',
  summary: 'Nurse public profile',
  description:
    'Never exposes contact details or exact coordinates. Non-bookable nurses are 404 for patients.',
  permission: 'nurses:search',
  params: z.strictObject({ id: objectId }),
  response: NurseCardSchema.omit({
    distanceKm: true,
    price: true,
    matchScore: true,
    available: true,
  }).extend({
    isBookable: z.boolean(),
    services: z.array(
      z.object({
        serviceId: z.string(),
        name: z.string(),
        slug: z.string(),
        billingUnit: z.enum(['HOURLY', 'DAILY']),
        unitAmountMinor: z.number().nullable(),
        currency: z.literal('AED'),
      }),
    ),
  }),
  handler: ({ params, auth }) => NurseSearchService.profile(params.id, auth.role),
});

api.route({
  method: 'get',
  path: '/nurses/:id/availability',
  summary: 'Nurse working windows and busy periods',
  description:
    'Per local date (platform timezone) working windows from weekly rules/overrides/blocks, plus UTC busy intervals from live bookings. Max 31 days. Booking creation re-validates all of it.',
  permission: 'nurses:search',
  params: z.strictObject({ id: objectId }),
  query: z.strictObject({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  response: z.object({
    timezone: z.string(),
    days: z.array(
      z.object({
        date: z.string(),
        available: z.boolean(),
        blocked: z.string().nullable(),
        windows: z.array(z.object({ start: z.string(), end: z.string() })),
      }),
    ),
    busy: z.array(z.object({ start: z.date(), end: z.date() })),
  }),
  handler: ({ params, query, auth }) =>
    NurseSearchService.availability(params.id, query.from, query.to, auth.role),
});

export default api.router;
