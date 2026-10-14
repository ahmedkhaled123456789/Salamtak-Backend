import '../../common/openapi/extend';
import { z } from 'zod';
import { createApi } from '../../common/openapi/route';
import { auditContext } from '../audit';
import { IDEMPOTENCY_KEY_PATTERN, IdempotencyService, hashPayload } from '../idempotency';
import { enqueue, QUEUES } from '../../queues';
import { EMERGENCY_STATUSES } from './emergency.models';
import { EmergencyService, toRequestDTO } from './emergency.service';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'invalid id');
const idParams = z.strictObject({ id: objectId });
const idem = z.object({
  'idempotency-key': z
    .string()
    .regex(IDEMPOTENCY_KEY_PATTERN, '8-128 chars: letters, digits, _ - : .')
    .openapi({ description: 'REQUIRED. Retrying with the same key returns the original request.' }),
});
const RequestSchema = z.object({
  id: z.string(),
  status: z.enum(EMERGENCY_STATUSES),
  statusReason: z.string().nullable(),
  serviceId: z.string(),
  requestedStart: z.date(),
  durationMinutes: z.number().int(),
  genderPreference: z.enum(['MALE', 'FEMALE', 'OTHER']).nullable(),
  expiresAt: z.date(),
  offersMade: z.number().int(),
  bookingId: z
    .string()
    .nullable()
    .openapi({ description: 'Set once a nurse accepted: pay it like any booking' }),
  createdAt: z.date(),
});
const AdminRequestSchema = RequestSchema.extend({
  patientId: z.string(),
  acceptedNurseId: z.string().nullable(),
  location: z.object({
    latitude: z.number(),
    longitude: z.number(),
    address: z.string(),
    city: z.string().nullable(),
  }),
  notes: z.string().nullable(),
});
const OfferSchema = z.object({
  offerId: z.string(),
  requestId: z.string(),
  service: z.string(),
  city: z.string().nullable(),
  requestedStart: z.date(),
  durationMinutes: z.number().int(),
  expiresAt: z.date(),
});
const meta = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
});

const api = createApi('Emergency');

api.route({
  method: 'post',
  path: '/emergency-requests',
  summary: 'Request a nurse urgently (patient)',
  description:
    'Starts asynchronous matching: verified, ACTIVE, available nurses are offered the request one at a time using the existing matching service. Not a guarantee. A patient can have ONE live request. When a nurse accepts, a booking is created through the ordinary flow and must be paid. `notes` must be short and non-clinical.',
  permission: 'emergency:create',
  rateLimit: { name: 'emergency-create', config: { points: 10, durationSeconds: 3600 } },
  status: 201,
  headers: idem,
  body: z.strictObject({
    serviceId: objectId,
    location: z.strictObject({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      address: z.string().trim().min(3).max(300),
      city: z.string().trim().max(100).optional(),
    }),
    durationMinutes: z
      .number()
      .int()
      .min(60)
      .max(24 * 60),
    genderPreference: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
    notes: z.string().trim().max(200).optional(),
  }),
  response: RequestSchema,
  handler: async ({ auth, body, req }) => {
    const key = (req.valid.headers as { 'idempotency-key': string })['idempotency-key'];
    const out = await IdempotencyService.execute<ReturnType<typeof toRequestDTO>>(
      { scope: 'emergency.create', userId: auth.userId, key, requestHash: hashPayload(body) },
      async () => {
        const r = await EmergencyService.create(auth.userId, body, key);
        return { status: 201, body: toRequestDTO(r) };
      },
    );
    // immediacy only: the scheduled sweep matches anyway when Redis is unavailable
    void enqueue(
      QUEUES.marketplace,
      'emergency.match',
      { requestId: out.body.id },
      { jobId: `emergency-match-${out.body.id}` },
    );
    return out.body;
  },
});

api.route({
  method: 'get',
  path: '/emergency-requests',
  summary: 'My emergency requests',
  permission: 'emergency:create',
  response: z.array(RequestSchema),
  handler: async ({ auth }) =>
    (await EmergencyService.listForPatient(auth.userId)).map((r) => toRequestDTO(r)),
});

api.route({
  method: 'get',
  path: '/emergency-requests/:id',
  summary: 'My emergency request',
  permission: 'emergency:create',
  params: idParams,
  response: RequestSchema,
  handler: async ({ auth, params }) =>
    toRequestDTO(await EmergencyService.getForPatient(auth.userId, params.id)),
});

api.route({
  method: 'post',
  path: '/emergency-requests/:id/cancel',
  summary: 'Cancel my emergency request (before a booking exists)',
  description:
    'Idempotent. After a nurse accepted and a booking exists, cancel the booking instead.',
  permission: 'emergency:create',
  params: idParams,
  response: RequestSchema,
  handler: async ({ auth, params }) =>
    toRequestDTO(
      (await EmergencyService.cancel(auth.userId, params.id, 'Cancelled by patient')).request,
    ),
});

api.route({
  method: 'get',
  path: '/emergency-offers',
  summary: 'Emergency offers addressed to me (nurse)',
  description:
    'Only live offers assigned to the calling nurse. No patient identity or exact address is shown before acceptance.',
  permission: 'emergency:respond',
  response: z.array(OfferSchema),
  handler: async ({ auth }) => EmergencyService.listOffers(auth.userId),
});

for (const [action, accept] of [
  ['accept', true],
  ['decline', false],
] as const) {
  api.route({
    method: 'post',
    path: `/emergency-offers/:id/${action}`,
    summary: `${action[0]!.toUpperCase()}${action.slice(1)} an emergency offer (nurse)`,
    description: accept
      ? 'Only one nurse can ever accept a request. Accepting creates the patient booking through the ordinary booking flow (payment still required).'
      : 'The request is offered to the next candidate.',
    permission: 'emergency:respond',
    params: idParams,
    response: z.object({ offerId: z.string(), status: z.string() }),
    handler: async ({ auth, params }) => {
      const o = await EmergencyService.respond(auth.userId, params.id, accept);
      return { offerId: String(o._id), status: o.status };
    },
  });
}

api.route({
  method: 'get',
  path: '/admin/emergency-requests',
  summary: 'List emergency requests (admin)',
  permission: 'admin:emergency:manage',
  query: z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      status: z.enum(EMERGENCY_STATUSES).optional(),
      patientId: objectId.optional(),
    })
    .strict(),
  response: z.object({ items: z.array(AdminRequestSchema), meta }),
  handler: async ({ query }) => {
    const { items, total } = await EmergencyService.listAdmin(query);
    return {
      items: items.map((r) => toRequestDTO(r, true) as never),
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
  path: '/admin/emergency-requests/:id',
  summary: 'Inspect an emergency request and its offers',
  permission: 'admin:emergency:manage',
  params: idParams,
  response: z.object({
    request: AdminRequestSchema,
    patientName: z.string().nullable(),
    offers: z.array(
      z.object({
        id: z.string(),
        nurseId: z.string(),
        status: z.string(),
        round: z.number(),
        score: z.number().nullable(),
        expiresAt: z.date(),
        respondedAt: z.date().nullable(),
      }),
    ),
  }),
  handler: async ({ params }) => {
    const r = await EmergencyService.inspect(params.id);
    return {
      request: toRequestDTO(r.request, true) as never,
      patientName: r.patientName,
      offers: r.offers.map((o) => ({
        id: String(o._id),
        nurseId: String(o.nurseId),
        status: o.status,
        round: o.round,
        score: o.score ?? null,
        expiresAt: o.expiresAt,
        respondedAt: o.respondedAt ?? null,
      })),
    };
  },
});

api.route({
  method: 'post',
  path: '/admin/emergency-requests/:id/cancel',
  summary: 'Admin: cancel an emergency request',
  description:
    'Idempotent and audit-logged. A request that already has a booking must be handled through the booking.',
  permission: 'admin:emergency:manage',
  rateLimit: { name: 'emergency-admin', config: { points: 60, durationSeconds: 60 } },
  params: idParams,
  body: z.strictObject({ reason: z.string().trim().min(3).max(300) }),
  response: RequestSchema.extend({ changed: z.boolean() }),
  handler: async ({ params, body, req }) => {
    const r = await EmergencyService.cancel(undefined, params.id, body.reason, auditContext(req));
    return { ...toRequestDTO(r.request), changed: r.changed };
  },
});

api.route({
  method: 'post',
  path: '/admin/emergency-requests/:id/reopen',
  summary: 'Admin: reopen a FAILED or EXPIRED request for another matching round',
  description: 'Idempotent and audit-logged.',
  permission: 'admin:emergency:manage',
  rateLimit: { name: 'emergency-admin', config: { points: 60, durationSeconds: 60 } },
  params: idParams,
  response: RequestSchema.extend({ changed: z.boolean() }),
  handler: async ({ params, req }) => {
    const r = await EmergencyService.reopen(params.id, auditContext(req));
    return { ...toRequestDTO(r.request), changed: r.changed };
  },
});

export default api.router;
