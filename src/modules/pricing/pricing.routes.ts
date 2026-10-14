import { z } from 'zod';
import { createApi } from '../../common/openapi/route';
import { ConflictError, NotFoundError, BadRequestError } from '../../common/errors';
import { isValidLocalDate } from '../../common/utils/time';
import { AuditService, auditContext } from '../audit';
import { SettingsService } from '../settings';
import { CommissionService } from './pricing.service';
import { Holiday } from './pricing.models';

const api = createApi('Pricing');
const idParams = z.strictObject({ id: z.string().regex(/^[a-f\d]{24}$/i, 'invalid id') });
const HolidaySchema = z.object({ id: z.string(), date: z.string(), name: z.string() });
const toDTO = (h: { _id: unknown; date: string; name: string }) => ({
  id: String(h._id),
  date: h.date,
  name: h.name,
});

api.route({
  method: 'get',
  path: '/admin/holidays',
  summary: 'List public holidays used for HOLIDAY surcharges',
  permission: 'holidays:manage',
  response: z.object({ items: z.array(HolidaySchema) }),
  handler: async () => ({ items: (await Holiday.find().sort({ date: 1 }).lean()).map(toDTO) }),
});

api.route({
  method: 'post',
  path: '/admin/holidays',
  summary: 'Add a public holiday',
  description: 'Date is a local calendar date in the platform timezone.',
  permission: 'holidays:manage',
  status: 201,
  body: z.strictObject({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
    name: z.string().trim().min(2).max(100),
  }),
  response: HolidaySchema,
  handler: async ({ body, req, auth }) => {
    const tz = await SettingsService.get('platform.timezone');
    if (!isValidLocalDate(body.date, tz))
      throw new BadRequestError('Invalid calendar date', 'INVALID_DATE');
    if (await Holiday.exists({ date: body.date }))
      throw new ConflictError('Holiday already defined for that date', 'HOLIDAY_EXISTS');
    const h = await Holiday.create({ ...body, createdBy: auth.userId });
    await AuditService.record(auditContext(req), {
      action: 'holiday.created',
      entity: 'Holiday',
      entityId: String(h._id),
      newData: body,
    });
    return toDTO(h);
  },
});

api.route({
  method: 'delete',
  path: '/admin/holidays/:id',
  summary: 'Remove a public holiday',
  permission: 'holidays:manage',
  params: idParams,
  handler: async ({ params, req }) => {
    const h = await Holiday.findByIdAndDelete(params.id);
    if (!h) throw new NotFoundError('Holiday not found', 'HOLIDAY_NOT_FOUND');
    await AuditService.record(auditContext(req), {
      action: 'holiday.deleted',
      entity: 'Holiday',
      entityId: params.id,
      oldData: { date: h.date, name: h.name },
    });
  },
});

const CommissionSchema = z.object({
  id: z.string(),
  scope: z.enum(['GLOBAL', 'SERVICE', 'NURSE']),
  serviceId: z.string().nullable(),
  nurseId: z.string().nullable(),
  type: z.enum(['PERCENTAGE', 'FIXED']),
  bps: z.number().nullable().openapi({ description: 'Basis points: 1500 = 15%' }),
  fixedMinor: z
    .number()
    .nullable()
    .openapi({ description: 'Fixed commission in fils per booking' }),
  effectiveFrom: z.date(),
  effectiveTo: z.date().nullable(),
  version: z.number(),
});
const toCommissionDTO = (c: Awaited<ReturnType<typeof CommissionService.list>>[number]) => ({
  id: String(c._id),
  scope: c.scope,
  serviceId: c.serviceId ? String(c.serviceId) : null,
  nurseId: c.nurseId ? String(c.nurseId) : null,
  type: c.type,
  bps: c.bps ?? null,
  fixedMinor: c.fixedMinor ?? null,
  effectiveFrom: c.effectiveFrom,
  effectiveTo: c.effectiveTo ?? null,
  version: c.version,
});
const objectIdStr = z.string().regex(/^[a-f\d]{24}$/i, 'invalid id');

api.route({
  method: 'get',
  path: '/admin/commissions',
  summary: 'Commission rule history',
  description:
    'Resolution order for a booking: NURSE rule, SERVICE rule, GLOBAL rule, the service commissionBps, then the commission.defaultBps setting. The applied terms are snapshotted on each booking.',
  permission: 'pricing:manage',
  response: z.object({ items: z.array(CommissionSchema) }),
  handler: async () => ({ items: (await CommissionService.list()).map(toCommissionDTO) }),
});

api.route({
  method: 'post',
  path: '/admin/commissions',
  summary: 'Publish a commission rule version',
  description:
    'Percentage rules use integer basis points; fixed rules use fils. Closes the previous version of the same scope. Historical bookings are unaffected. Audit-logged.',
  permission: 'pricing:manage',
  status: 201,
  body: z
    .strictObject({
      scope: z.enum(['GLOBAL', 'SERVICE', 'NURSE']),
      serviceId: objectIdStr.optional(),
      nurseId: objectIdStr.optional(),
      type: z.enum(['PERCENTAGE', 'FIXED']),
      bps: z.number().int().min(0).max(10_000).optional(),
      fixedMinor: z.number().int().min(0).max(100_000_000).optional(),
      effectiveFrom: z.coerce.date().optional(),
    })
    .refine(
      (v) =>
        v.type === 'PERCENTAGE'
          ? v.bps !== undefined && v.fixedMinor === undefined
          : v.fixedMinor !== undefined && v.bps === undefined,
      {
        message: 'PERCENTAGE requires bps; FIXED requires fixedMinor',
        path: ['type'],
      },
    )
    .refine(
      (v) =>
        v.scope === 'SERVICE'
          ? !!v.serviceId && !v.nurseId
          : v.scope === 'NURSE'
            ? !!v.nurseId && !v.serviceId
            : !v.serviceId && !v.nurseId,
      {
        message: 'SERVICE requires serviceId, NURSE requires nurseId, GLOBAL neither',
        path: ['scope'],
      },
    ),
  response: CommissionSchema,
  handler: async ({ body, req, auth }) => {
    const { before, after } = await CommissionService.publish(body, auth.userId);
    await AuditService.record(auditContext(req), {
      action: 'commission.published',
      entity: 'Commission',
      entityId: String(after._id),
      oldData: before && {
        type: before.type,
        bps: before.bps,
        fixedMinor: before.fixedMinor,
        version: before.version,
      },
      newData: {
        scope: after.scope,
        type: after.type,
        bps: after.bps,
        fixedMinor: after.fixedMinor,
        version: after.version,
      },
    });
    return toCommissionDTO(after);
  },
});

export default api.router;
