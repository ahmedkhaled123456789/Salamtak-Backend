import '../../common/openapi/extend';
import { z } from 'zod';
import { createApi } from '../../common/openapi/route';
import { paginationQuery } from '../../common/pagination';
import { NurseCardSchema, NurseSearchService } from '../nurse-search';
import { ServiceCatalog, ServiceSchema, toServiceDTO } from '../services';
import { SettingsService } from '../settings';

/**
 * Read-only catalogue for the public website (visitors are not logged in). It exposes exactly what
 * the authenticated catalogue already returns to a patient: active services with "from" rates and
 * ACTIVE + VERIFIED nurses by first name + initial. Prices stay informational; the booking quote is binding.
 */
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'invalid id');
const limit = { name: 'public-catalog', config: { points: 120, durationSeconds: 60 } };

const searchQuery = paginationQuery
  .extend({
    serviceId: objectId.optional(),
    gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
    sort: z.enum(['relevance', 'rating', 'price', 'experience']).default('relevance'),
  })
  .strict();

const api = createApi('Public catalogue');

api.route({
  method: 'get',
  path: '/public/services',
  summary: 'Public: active services with base rates and pictures',
  public: true,
  rateLimit: limit,
  response: z.object({ items: z.array(ServiceSchema) }),
  handler: async () => ({ items: await ServiceCatalog.listActive() }),
});

api.route({
  method: 'get',
  path: '/public/services/:slug',
  summary: 'Public: one active service by slug',
  public: true,
  rateLimit: limit,
  params: z.strictObject({ slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i).max(140) }),
  response: ServiceSchema,
  handler: async ({ params }) => {
    const s = await ServiceCatalog.getActiveBySlug(params.slug);
    return toServiceDTO(s, await ServiceCatalog.baseRates(s));
  },
});

api.route({
  method: 'get',
  path: '/public/nurses',
  summary: 'Public: search bookable nurses',
  description: 'Same ranking and filters as `GET /nurses`, without contact details or location.',
  public: true,
  rateLimit: limit,
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
      withinNurseRadius: false,
      sort: query.sort,
      page: query.page,
      limit: query.limit,
    }),
});

api.route({
  method: 'get',
  path: '/public/nurses/:id',
  summary: 'Public: nurse profile',
  public: true,
  rateLimit: limit,
  params: z.strictObject({ id: objectId }),
  handler: ({ params }) => NurseSearchService.profile(params.id, 'PATIENT'),
});

api.route({
  method: 'get',
  path: '/public/policies',
  summary: 'Public: booking, payment-hold and cancellation rules currently in force',
  description:
    'Read from the live platform settings, so the website/app FAQ always shows the policy the backend actually applies. A nurse rejecting or not answering a paid booking is always refunded in full.',
  public: true,
  rateLimit: limit,
  response: z.object({
    currency: z.literal('AED'),
    timezone: z.string(),
    paymentHoldMinutes: z.number(),
    nurseResponseMinutes: z.number(),
    maxAdvanceDays: z.number(),
    cancellationRefunds: z.array(z.object({ minHoursBeforeStart: z.number(), refundPercent: z.number() })),
  }),
  handler: async () => {
    const s = await SettingsService.getAll();
    return {
      currency: 'AED' as const,
      timezone: s['platform.timezone'],
      paymentHoldMinutes: s['booking.holdMinutes'],
      nurseResponseMinutes: s['booking.nurseResponseMinutes'],
      maxAdvanceDays: s['booking.maxAdvanceDays'],
      // nurse compensation shares are internal; only what the patient gets back is public
      cancellationRefunds: [...s['refund.policy']]
        .sort((a, b) => b.minHoursBeforeStart - a.minHoursBeforeStart)
        .map((t) => ({ minHoursBeforeStart: t.minHoursBeforeStart, refundPercent: t.refundPercent })),
    };
  },
});

export default api.router;
