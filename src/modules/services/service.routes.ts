import '../../common/openapi/extend';
import { z } from 'zod';
import { createApi } from '../../common/openapi/route';
import { NotFoundError } from '../../common/errors';
import { paginate, paginationQuery } from '../../common/pagination';
import { auditContext, AuditService } from '../audit';
import { NurseService } from '../nurses';
import { PRICE_KINDS, PricingService } from '../pricing';
import { BILLING_UNITS, SERVICE_CATEGORIES, Service } from './service.models';
import { NurseOffers, ServiceCatalog, toServiceDTO } from './service.service';
import { ServiceSchema } from './service.schemas';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'invalid id');
const idParams = z.strictObject({ id: objectId });
const fils = z.number().int().min(0).max(100_000_000).openapi({
  description: 'Integer amount in fils (minor units). 250 AED = 25000',
});

const serviceBody = z.strictObject({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and dashes')
    .max(140)
    .optional(),
  description: z.string().trim().max(2000).optional(),
  category: z.enum(SERVICE_CATEGORIES).optional(),
  billingUnit: z.enum(BILLING_UNITS),
  minDurationMinutes: z
    .number()
    .int()
    .min(15)
    .max(60 * 24 * 14),
  maxDurationMinutes: z
    .number()
    .int()
    .min(15)
    .max(60 * 24 * 14),
  expectedDurationMinutes: z
    .number()
    .int()
    .min(15)
    .max(60 * 24 * 14)
    .optional(),
  commissionBps: z.number().int().min(0).max(10_000).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  isActive: z.boolean().optional(),
});
const serviceUpdateBody = serviceBody
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');

const priceBody = z
  .strictObject({
    kind: z.enum(PRICE_KINDS),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_]{1,40}$/)
      .optional(),
    label: z.string().trim().max(100).optional(),
    amountMinor: fils.optional(),
    bps: z
      .number()
      .int()
      .min(0)
      .max(100_000)
      .optional()
      .openapi({ description: 'Basis points: 2000 = 20%' }),
    effectiveFrom: z.coerce.date().optional(),
  })
  .refine(
    (v) =>
      ['HOURLY', 'DAILY', 'FEE'].includes(v.kind)
        ? v.amountMinor !== undefined && v.bps === undefined
        : v.bps !== undefined && v.amountMinor === undefined,
    { message: 'HOURLY/DAILY/FEE require amountMinor; surcharges require bps', path: ['kind'] },
  );

const PriceSchema = z.object({
  id: z.string(),
  serviceId: z.string(),
  kind: z.enum(PRICE_KINDS),
  code: z.string(),
  label: z.string().nullable(),
  amountMinor: z.number().nullable(),
  bps: z.number().nullable(),
  currency: z.literal('AED'),
  effectiveFrom: z.date(),
  effectiveTo: z.date().nullable(),
  version: z.number(),
});
const toPriceDTO = (p: Awaited<ReturnType<typeof PricingService.listPrices>>[number]) => ({
  id: String(p._id),
  serviceId: String(p.serviceId),
  kind: p.kind,
  code: p.code,
  label: p.label ?? null,
  amountMinor: p.amountMinor ?? null,
  bps: p.bps ?? null,
  currency: 'AED' as const,
  effectiveFrom: p.effectiveFrom,
  effectiveTo: p.effectiveTo ?? null,
  version: p.version,
});

const pageMeta = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
});

const api = createApi('Services');

// ----- catalog (all authenticated roles) -----
api.route({
  method: 'get',
  path: '/services',
  summary: 'List active services with current base rates',
  description:
    'Prices are informational ("from"); the binding price is always the server-side quote.',
  permission: 'services:read',
  response: z.object({ items: z.array(ServiceSchema) }),
  handler: async () => ({ items: await ServiceCatalog.listActive() }),
});

api.route({
  method: 'get',
  path: '/services/:id',
  summary: 'Get an active service',
  permission: 'services:read',
  params: idParams,
  response: ServiceSchema,
  handler: async ({ params, auth }) => {
    const s = await ServiceCatalog.getById(params.id);
    if (!s.isActive && auth.role !== 'ADMIN')
      throw new NotFoundError('Service not found', 'SERVICE_NOT_FOUND');
    return toServiceDTO(s, await ServiceCatalog.baseRates(s));
  },
});

// ----- nurse: offered services -----
const OfferSchema = z.object({
  serviceId: z.string(),
  isEnabled: z.boolean(),
  hourlyRateMinor: z.number().nullable(),
  dailyRateMinor: z.number().nullable(),
});
const toOfferDTO = (o: {
  serviceId: unknown;
  isEnabled: boolean;
  hourlyRateMinor?: number | null;
  dailyRateMinor?: number | null;
}) => ({
  serviceId: String(o.serviceId),
  isEnabled: o.isEnabled,
  hourlyRateMinor: o.hourlyRateMinor ?? null,
  dailyRateMinor: o.dailyRateMinor ?? null,
});

api.route({
  method: 'get',
  path: '/nurses/me/services',
  summary: 'List the services I offer',
  permission: 'nurse-services:self',
  response: z.object({ items: z.array(OfferSchema) }),
  handler: async ({ auth }) => {
    const nurse = await NurseService.getByUserId(auth.userId);
    return { items: (await NurseOffers.list(String(nurse._id))).map(toOfferDTO) };
  },
});

api.route({
  method: 'put',
  path: '/nurses/me/services',
  summary: 'Replace the set of services I offer',
  description:
    'Services omitted from the request are disabled. Optional per-nurse rates override the service base rate for that billing unit; `null` clears an override.',
  permission: 'nurse-services:self',
  body: z.strictObject({
    services: z
      .array(
        z.strictObject({
          serviceId: objectId,
          isEnabled: z.boolean().optional(),
          hourlyRateMinor: fils.nullable().optional(),
          dailyRateMinor: fils.nullable().optional(),
        }),
      )
      .max(50),
  }),
  response: z.object({ items: z.array(OfferSchema) }),
  handler: async ({ auth, body }) => {
    const nurse = await NurseService.getByUserId(auth.userId);
    return { items: (await NurseOffers.replace(String(nurse._id), body.services)).map(toOfferDTO) };
  },
});

// ----- admin -----
api.route({
  method: 'get',
  path: '/admin/services',
  summary: 'List all services (including inactive)',
  permission: 'services:manage',
  query: paginationQuery
    .extend({
      isActive: z
        .enum(['true', 'false'])
        .transform((v) => v === 'true')
        .optional(),
      category: z.enum(SERVICE_CATEGORIES).optional(),
    })
    .strict(),
  response: z.object({ items: z.array(ServiceSchema.partial()), meta: pageMeta }),
  handler: ({ query }) =>
    paginate(
      Service,
      {
        ...(query.isActive !== undefined && { isActive: query.isActive }),
        ...(query.category && { category: query.category }),
      },
      { page: query.page, limit: query.limit, sort: { sortOrder: 1, name: 1 } },
    ),
});

api.route({
  method: 'post',
  path: '/admin/services',
  summary: 'Create a service',
  description: 'Prices are published separately via POST /admin/services/{id}/prices.',
  permission: 'services:manage',
  status: 201,
  body: serviceBody,
  response: ServiceSchema,
  handler: async ({ body, req }) =>
    toServiceDTO(await ServiceCatalog.create(body, auditContext(req))),
});

api.route({
  method: 'patch',
  path: '/admin/services/:id',
  summary: 'Update a service',
  permission: 'services:manage',
  params: idParams,
  body: serviceUpdateBody,
  response: ServiceSchema,
  handler: async ({ params, body, req }) =>
    toServiceDTO(await ServiceCatalog.update(params.id, body, auditContext(req))),
});

api.route({
  method: 'put',
  path: '/admin/services/:id/image',
  summary: 'Upload or replace the service picture (multipart/form-data)',
  description:
    'Field `file`: JPEG, PNG or WebP. The picture is public and served from `imageUrl` (`/api/v1/media/{id}`). The previous picture is deleted.',
  permission: 'services:manage',
  params: idParams,
  upload: { field: 'file', maxBytes: 10 * 1024 * 1024 },
  response: ServiceSchema,
  message: 'Image updated',
  handler: async ({ params, auth, req }) =>
    toServiceDTO(await ServiceCatalog.setImage(params.id, auth.userId, req.file, auditContext(req))),
});

api.route({
  method: 'patch',
  path: '/admin/services/:id/activate',
  summary: 'Activate a service',
  permission: 'services:manage',
  params: idParams,
  response: ServiceSchema,
  handler: async ({ params, req }) =>
    toServiceDTO(await ServiceCatalog.setActive(params.id, true, auditContext(req))),
});

api.route({
  method: 'patch',
  path: '/admin/services/:id/deactivate',
  summary: 'Deactivate a service',
  description: 'Inactive services cannot be quoted or booked. Existing bookings are unaffected.',
  permission: 'services:manage',
  params: idParams,
  response: ServiceSchema,
  handler: async ({ params, req }) =>
    toServiceDTO(await ServiceCatalog.setActive(params.id, false, auditContext(req))),
});

api.route({
  method: 'get',
  path: '/admin/services/:id/prices',
  summary: 'Rate history for a service',
  permission: 'pricing:manage',
  params: idParams,
  response: z.object({ items: z.array(PriceSchema) }),
  handler: async ({ params }) => {
    await ServiceCatalog.getById(params.id);
    return { items: (await PricingService.listPrices(params.id)).map(toPriceDTO) };
  },
});

api.route({
  method: 'post',
  path: '/admin/services/:id/prices',
  summary: 'Publish a new rate version',
  description:
    'Closes the currently effective row of the same kind/code and inserts a new version. Historical bookings keep their snapshot and are never repriced.',
  permission: 'pricing:manage',
  status: 201,
  params: idParams,
  body: priceBody,
  response: PriceSchema,
  handler: async ({ params, body, req, auth }) => {
    await ServiceCatalog.getById(params.id);
    const { before, after } = await PricingService.publishPrice(params.id, body, auth.userId);
    await AuditService.record(auditContext(req), {
      action: 'service.price_published',
      entity: 'Service',
      entityId: params.id,
      oldData: before && {
        kind: before.kind,
        amountMinor: before.amountMinor,
        bps: before.bps,
        version: before.version,
      },
      newData: {
        kind: after.kind,
        code: after.code,
        amountMinor: after.amountMinor,
        bps: after.bps,
        version: after.version,
      },
    });
    return toPriceDTO(after);
  },
});

export default api.router;
