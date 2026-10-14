import { z } from 'zod';
import { createApi } from '../../common/openapi/route';
import { paginationQuery } from '../../common/pagination';
import { ROLES } from '../../common/constants/rbac';
import { auditContext } from '../audit';
import { NURSE_STATUSES, VERIFICATION_STATUSES, NurseProfileSchema } from '../nurses';
import { UserSchema } from '../users';
import { AuditService } from '../audit';
import { ReservationService } from '../bookings';
import { SETTING_KEYS, SettingsService } from '../settings';
import { AdminService } from './admin.service';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'invalid id');
const idParams = z.strictObject({ id: objectId });
const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');
const dateRange = {
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
};
const pageMeta = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
});
const paged = (item: z.ZodType) => z.object({ items: z.array(item), meta: pageMeta });

const api = createApi('Admin');

api.route({
  method: 'get',
  path: '/admin/dashboard',
  summary: 'Platform statistics',
  description:
    'Supports ?from&to (ISO dates) on createdAt. Booking/revenue figures arrive in later phases.',
  permission: 'admin:dashboard',
  query: z.strictObject(dateRange),
  response: z.object({
    totalUsers: z.number(),
    totalPatients: z.number(),
    totalNurses: z.number(),
    verifiedNurses: z.number(),
    pendingNurses: z.number(),
    suspendedNurses: z.number(),
  }),
  handler: ({ query }) => AdminService.dashboard(query),
});

api.route({
  method: 'get',
  path: '/admin/users',
  summary: 'List users',
  permission: 'admin:users:read',
  query: paginationQuery
    .extend({
      role: z.enum(ROLES as [string, ...string[]]).optional(),
      isActive: boolQuery.optional(),
      search: z.string().trim().min(1).max(100).optional(),
      ...dateRange,
    })
    .strict(),
  response: paged(UserSchema),
  handler: ({ query }) => AdminService.listUsers(query),
});

api.route({
  method: 'get',
  path: '/admin/nurses',
  summary: 'List nurse profiles',
  permission: 'admin:nurses:read',
  query: paginationQuery
    .extend({
      status: z.enum(NURSE_STATUSES).optional(),
      verificationStatus: z.enum(VERIFICATION_STATUSES).optional(),
      isBookable: boolQuery.optional(),
    })
    .strict(),
  response: paged(NurseProfileSchema.partial()),
  handler: ({ query }) => AdminService.listNurses(query),
});

api.route({
  method: 'patch',
  path: '/admin/nurses/:id/verify',
  summary: 'Set a nurse verification decision',
  description:
    'VERIFIED activates a PENDING nurse. REJECTED requires a reason. The id is the nurse profile id.',
  permission: 'admin:nurses:verify',
  params: idParams,
  body: z.strictObject({
    decision: z.enum(['UNDER_REVIEW', 'VERIFIED', 'REJECTED']),
    reason: z.string().trim().min(3).max(500).optional(),
  }),
  response: NurseProfileSchema,
  message: 'Nurse verification updated',
  handler: ({ params, body, req }) =>
    AdminService.verifyNurse(params.id, body.decision, body.reason, auditContext(req)),
});

api.route({
  method: 'patch',
  path: '/admin/nurses/:id/suspend',
  summary: 'Suspend a nurse',
  permission: 'admin:nurses:suspend',
  params: idParams,
  body: z.strictObject({ reason: z.string().trim().min(3).max(500) }),
  response: NurseProfileSchema,
  message: 'Nurse suspended',
  handler: ({ params, body, req }) =>
    AdminService.suspendNurse(params.id, body.reason, auditContext(req)),
});

api.route({
  method: 'patch',
  path: '/admin/nurses/:id/reactivate',
  summary: 'Lift a nurse suspension',
  permission: 'admin:nurses:suspend',
  params: idParams,
  response: NurseProfileSchema,
  message: 'Nurse reactivated',
  handler: ({ params, req }) => AdminService.reactivateNurse(params.id, auditContext(req)),
});

api.route({
  method: 'patch',
  path: '/admin/users/:id/block',
  summary: 'Block or unblock a user',
  description: 'Blocking revokes all refresh tokens; the access token is rejected on its next use.',
  permission: 'admin:users:block',
  params: idParams,
  body: z.strictObject({
    blocked: z.boolean(),
    reason: z.string().trim().min(3).max(500).optional(),
  }),
  response: UserSchema,
  message: 'User updated',
  handler: ({ params, body, req }) =>
    AdminService.setUserBlocked(params.id, body.blocked, body.reason, auditContext(req)),
});

api.route({
  method: 'get',
  path: '/admin/audit-logs',
  summary: 'List audit logs',
  permission: 'admin:audit:read',
  query: paginationQuery
    .extend({
      entity: z.string().max(60).optional(),
      entityId: objectId.optional(),
      action: z.string().max(80).optional(),
    })
    .strict(),
  response: paged(z.record(z.string(), z.unknown())),
  handler: ({ query }) => AdminService.listAuditLogs(query),
});

api.route({
  method: 'get',
  path: '/admin/settings',
  summary: 'Effective platform settings',
  description:
    'Defaults merged with stored overrides (timezone, booking hold, refund policy, commission, ...).',
  permission: 'settings:manage',
  response: z.record(z.string(), z.unknown()),
  handler: () => SettingsService.getAll(),
});

api.route({
  method: 'put',
  path: '/admin/settings/:key',
  summary: 'Change a platform setting',
  description:
    'Validated against the typed registry. `booking.slotMinutes` can only change while no reservations exist. Audit-logged.',
  permission: 'settings:manage',
  params: z.strictObject({ key: z.enum(SETTING_KEYS as [string, ...string[]]) }),
  body: z.strictObject({ value: z.unknown() }),
  response: z.object({ key: z.string(), before: z.unknown(), after: z.unknown() }),
  handler: async ({ params, body, req, auth }) => {
    const res = await SettingsService.set(params.key, body.value, auth.userId, {
      hasReservations: ReservationService.hasAnyReservation,
    });
    await AuditService.record(auditContext(req), {
      action: 'settings.changed',
      entity: 'PlatformSetting',
      oldData: { [params.key]: res.before },
      newData: { [params.key]: res.after },
    });
    return res;
  },
});

export default api.router;
