import '../../common/openapi/extend';
import { z } from 'zod';
import { createApi } from '../../common/openapi/route';
import { auditContext } from '../audit';
import { BookingService, QuoteSchema, toQuoteDTO } from '../bookings';
import { COUPON_TYPES } from './coupon.models';
import { CouponService, toCouponDTO, type CouponInput } from './coupon.service';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'invalid id');
const idParams = z.strictObject({ id: objectId });
const isoDate = z.coerce.date();
const fils = z.number().int().min(1).max(1_000_000_000);
const latLng = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

const CouponSchema = z.object({
  id: z.string(),
  code: z.string(),
  description: z.string().nullable(),
  type: z.enum(COUPON_TYPES),
  valueMinor: z.number().nullable(),
  valueBps: z.number().nullable(),
  maxDiscountMinor: z.number().nullable(),
  minBookingAmountMinor: z.number(),
  usageLimit: z.number().nullable(),
  perUserLimit: z.number().nullable(),
  startAt: z.date(),
  endAt: z.date(),
  active: z.boolean(),
  applicableServiceIds: z.array(z.string()),
  applicableNurseIds: z.array(z.string()),
  usedCount: z.number(),
  version: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
const terms = {
  description: z.string().trim().max(300).optional(),
  type: z.enum(COUPON_TYPES),
  valueMinor: fils.optional().openapi({ description: 'FIXED: amount off in fils' }),
  valueBps: z.number().int().min(1).max(10_000).optional().openapi({
    description: 'PERCENTAGE: basis points (1500 = 15%)',
  }),
  maxDiscountMinor: fils.optional(),
  minBookingAmountMinor: z.number().int().min(0).max(1_000_000_000).optional(),
  usageLimit: z.number().int().min(1).max(10_000_000).optional(),
  perUserLimit: z.number().int().min(1).max(1000).optional(),
  startAt: isoDate,
  endAt: isoDate,
  applicableServiceIds: z.array(objectId).max(100).optional(),
  applicableNurseIds: z.array(objectId).max(500).optional(),
};
const meta = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
});

const api = createApi('Coupons');

api.route({
  method: 'post',
  path: '/coupons/validate',
  summary: 'Validate a coupon and get the resulting quote (patient)',
  description:
    'Runs the full server-side validation (active, validity window, minimum amount, service and nurse eligibility, global and per-user limits) and returns an ordinary signed quote priced WITH the coupon. The discount is always calculated by the server from the gross amount and is platform funded: nurse earnings are unaffected. Nothing is consumed until the booking is created.',
  permission: 'coupons:validate',
  rateLimit: { name: 'coupon-validate', config: { points: 30, durationSeconds: 600 } },
  body: z.strictObject({
    couponCode: z.string().trim().min(3).max(40),
    serviceId: objectId,
    nurseId: objectId,
    startDateTime: isoDate,
    endDateTime: isoDate,
    location: latLng.optional(),
    genderPreference: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  }),
  response: z.object({
    valid: z.literal(true),
    coupon: z.object({ code: z.string(), discountMinor: z.number().int() }),
    quote: QuoteSchema,
  }),
  handler: async ({ auth, body }) => {
    const q = await BookingService.quote(auth.userId, body);
    return { valid: true as const, coupon: q.coupon!, quote: toQuoteDTO(q) };
  },
});

// ---------------------------------------------------------------- admin
api.route({
  method: 'post',
  path: '/admin/coupons',
  summary: 'Create a coupon',
  description:
    'FIXED needs `valueMinor`, PERCENTAGE needs `valueBps`. Codes are unique, case-insensitive. Audit-logged.',
  permission: 'admin:coupons:manage',
  status: 201,
  body: z.strictObject({
    code: z
      .string()
      .trim()
      .min(3)
      .max(40)
      .regex(/^[A-Za-z0-9_-]+$/),
    ...terms,
  }),
  response: CouponSchema,
  handler: async ({ body, req }) =>
    toCouponDTO(await CouponService.create(body as CouponInput, auditContext(req))),
});

api.route({
  method: 'patch',
  path: '/admin/coupons/:id',
  summary: 'Change a coupon (affects future bookings only)',
  description:
    'Bumps the coupon version. Bookings already created keep their own immutable coupon snapshot. Audit-logged.',
  permission: 'admin:coupons:manage',
  params: idParams,
  body: z
    .strictObject({
      ...Object.fromEntries(
        Object.entries(terms).map(([k, v]) => [k, (v as z.ZodType).optional()]),
      ),
    } as unknown as Record<string, z.ZodType>)
    .refine((v) => Object.keys(v).length > 0, 'At least one field is required'),
  response: CouponSchema,
  handler: async ({ params, body, req }) =>
    toCouponDTO(
      await CouponService.update(params.id, body as Partial<CouponInput>, auditContext(req)),
    ),
});

for (const [action, active] of [
  ['activate', true],
  ['deactivate', false],
] as const) {
  api.route({
    method: 'post',
    path: `/admin/coupons/:id/${action}`,
    summary: `${action[0]!.toUpperCase()}${action.slice(1)} a coupon`,
    description: 'Idempotent. Audit-logged.',
    permission: 'admin:coupons:manage',
    params: idParams,
    response: CouponSchema.extend({ changed: z.boolean() }),
    handler: async ({ params, req }) => {
      const r = await CouponService.setActive(params.id, active, auditContext(req));
      return { ...toCouponDTO(r.coupon), changed: r.changed };
    },
  });
}

api.route({
  method: 'get',
  path: '/admin/coupons',
  summary: 'List coupons',
  permission: 'admin:coupons:manage',
  query: z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      active: z.enum(['true', 'false']).optional(),
    })
    .strict(),
  response: z.object({ items: z.array(CouponSchema), meta }),
  handler: async ({ query }) => {
    const { items, total } = await CouponService.list({
      page: query.page,
      limit: query.limit,
      active: query.active === undefined ? undefined : query.active === 'true',
    });
    return {
      items: items.map(toCouponDTO),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  },
});

api.route({
  method: 'get',
  path: '/admin/coupons/:id',
  summary: 'Inspect a coupon and its usage',
  permission: 'admin:coupons:manage',
  params: idParams,
  response: z.object({
    coupon: CouponSchema,
    usage: z.object({
      applied: z.number(),
      released: z.number(),
      totalDiscountMinor: z.number(),
    }),
  }),
  handler: async ({ params }) => {
    const r = await CouponService.inspect(params.id);
    return { coupon: toCouponDTO(r.coupon), usage: r.usage };
  },
});

export default api.router;
