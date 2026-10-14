import { z } from 'zod';
import { createApi } from '../../common/openapi/route';
import { paginationQuery } from '../../common/pagination';
import { auditContext } from '../audit';
import { IDEMPOTENCY_KEY_PATTERN, IdempotencyService, hashPayload } from '../idempotency';
import { BookingService } from './booking.service';
import {
  BookingHistorySchema,
  BookingSchema,
  QuoteSchema,
  toBookingDTO,
  toQuoteDTO,
} from './booking.dto';
import { BOOKING_STATUSES } from './booking.states';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'invalid id');
const idParams = z.strictObject({ id: objectId });
const isoDate = z.coerce.date().refine((d) => !Number.isNaN(d.getTime()), 'invalid date');

const latLng = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

const quoteBody = z.strictObject({
  serviceId: objectId,
  nurseId: objectId.openapi({ description: 'Nurse profile id' }),
  startDateTime: isoDate.openapi({
    example: '2026-12-01T08:00:00+04:00',
    description: 'ISO-8601; stored as UTC',
  }),
  endDateTime: isoDate.openapi({ example: '2026-12-01T12:00:00+04:00' }),
  location: latLng.optional().openapi({ description: 'Enables the service-radius check' }),
  genderPreference: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  couponCode: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .optional()
    .openapi({ description: 'Optional coupon. The server calculates the discount.' }),
});

const createBody = z.strictObject({
  serviceId: objectId,
  nurseId: objectId.openapi({ description: 'Nurse profile id' }),
  startDateTime: isoDate,
  endDateTime: isoDate,
  location: latLng.extend({
    address: z.string().trim().min(3).max(300),
    city: z.string().trim().max(100).optional(),
    country: z.string().trim().max(100).optional(),
  }),
  genderPreference: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  notes: z.string().trim().max(1000).optional(),
  couponCode: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .optional()
    .openapi({ description: 'Must be the coupon the quote was priced with.' }),
  quoteToken: z.string().min(20).max(4000).openapi({
    description:
      'From POST /bookings/quote. The server re-prices and rejects stale or mismatched quotes.',
  }),
});

const pageMeta = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
});
const reasonBody = z.strictObject({ reason: z.string().trim().max(500).optional() }).optional();

const api = createApi('Bookings');

api.route({
  method: 'post',
  path: '/bookings/quote',
  summary: 'Get a server-calculated price quote',
  description:
    'Validates the service, nurse eligibility, availability and time window, then returns an itemised integer-fils price and a signed `quoteToken` (valid for `booking.quoteTtlSeconds`). Nothing is reserved or charged.',
  permission: 'bookings:create',
  body: quoteBody,
  response: QuoteSchema,
  handler: async ({ auth, body }) => {
    const q = await BookingService.quote(auth.userId, body);
    return toQuoteDTO(q);
  },
});

api.route({
  method: 'post',
  path: '/bookings',
  summary: 'Create a booking (time-range hold)',
  description:
    "Re-validates everything server-side, re-prices, then atomically reserves the nurse's time range in a MongoDB transaction. The booking starts in `PAYMENT_PENDING` and holds the slot for `booking.holdMinutes`. Overlapping requests for the same nurse yield `409 BOOKING_CONFLICT`; non-overlapping bookings on the same day are fine.",
  permission: 'bookings:create',
  status: 201,
  headers: z.object({
    'idempotency-key': z
      .string()
      .regex(IDEMPOTENCY_KEY_PATTERN, '8-128 chars: letters, digits, _ - : .')
      .openapi({
        description:
          'REQUIRED. Unique per logical booking attempt (e.g. a UUID). Retrying with the same key and payload returns the original result without creating another booking; the same key with a different payload returns 422 IDEMPOTENCY_KEY_REUSED; a concurrent duplicate waits for the original.',
        example: '7b0d6c52-2d63-4f0c-9d0d-3f6f0c0a9c11',
      }),
  }),
  body: createBody,
  response: BookingSchema,
  handler: async ({ auth, body, req, res }) => {
    const key = (req.valid.headers as { 'idempotency-key': string })['idempotency-key'];
    const out = await IdempotencyService.execute<ReturnType<typeof toBookingDTO>>(
      { scope: 'bookings.create', userId: auth.userId, key, requestHash: hashPayload(body) },
      async (ctx) => {
        const booking = await BookingService.create(auth.userId, body, {
          // record completion in the SAME transaction that creates the booking
          inTxn: (session, b) =>
            ctx.complete(session, { status: 201, body: toBookingDTO(b, auth) }),
        });
        return { status: 201, body: toBookingDTO(booking, auth) };
      },
    );
    if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return out.body;
  },
});

api.route({
  method: 'get',
  path: '/bookings',
  summary: 'List my bookings',
  description:
    'Patients see their bookings; nurses see paid requests assigned to them. Sorted by start time, newest first.',
  permission: 'bookings:read',
  query: paginationQuery
    .extend({
      status: z.enum(BOOKING_STATUSES).optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    })
    .strict(),
  response: z.object({ items: z.array(BookingSchema.partial()), meta: pageMeta }),
  handler: async ({ auth, query }) => {
    const page = await BookingService.list(auth, query);
    return { items: page.items.map((b) => toBookingDTO(b, auth)), meta: page.meta };
  },
});

api.route({
  method: 'get',
  path: '/bookings/:id',
  summary: 'Get a booking',
  description: "Only the booking's patient, its (paid) nurse, or an admin; anyone else gets 404.",
  permission: 'bookings:read',
  params: idParams,
  response: BookingSchema,
  handler: async ({ auth, params }) =>
    toBookingDTO(await BookingService.getForViewer(params.id, auth), auth),
});

api.route({
  method: 'get',
  path: '/bookings/:id/history',
  summary: 'Booking state history (read-only, append-only)',
  permission: 'bookings:read',
  params: idParams,
  response: z.object({ items: z.array(BookingHistorySchema) }),
  handler: async ({ auth, params }) => ({
    items: (await BookingService.history(params.id, auth)).map((h) => ({
      previousState: h.previousState ?? null,
      newState: h.newState,
      actorRole: h.actorRole,
      reason: h.reason ?? null,
      createdAt: h.createdAt,
    })),
  }),
});

api.route({
  method: 'post',
  path: '/bookings/:id/cancel',
  summary: 'Cancel my booking',
  description:
    "Unpaid bookings are cancelled and the held time range released. Paid, unstarted bookings (`NURSE_PENDING`/`NURSE_ACCEPTED`/`CONFIRMED`) become `CANCELLED` then `REFUND_PENDING` with the refund taken from the booking's snapshotted policy (48h+: 100%, 24-48h: 50%, <24h: 0%, which stays `CANCELLED`). Later states return `409 CANCELLATION_NOT_ALLOWED`. The provider refund is not part of this phase.",
  permission: 'bookings:cancel',
  params: idParams,
  body: reasonBody,
  response: BookingSchema,
  message: 'Booking cancelled',
  handler: async ({ auth, params, body }) =>
    toBookingDTO(await BookingService.cancelByPatient(params.id, auth.userId, body?.reason), auth),
});

api.route({
  method: 'post',
  path: '/bookings/:id/accept',
  summary: 'Nurse accepts a booking request',
  description: '`NURSE_PENDING` → `NURSE_ACCEPTED` → `CONFIRMED`.',
  permission: 'bookings:respond',
  params: idParams,
  response: BookingSchema,
  message: 'Booking confirmed',
  handler: async ({ auth, params }) =>
    toBookingDTO(await BookingService.accept(params.id, auth.userId), auth),
});

api.route({
  method: 'post',
  path: '/bookings/:id/reject',
  summary: 'Nurse rejects a booking request',
  description:
    '`NURSE_PENDING` → `NURSE_REJECTED` → `REFUND_PENDING` (100% refund); the time range is released.',
  permission: 'bookings:respond',
  params: idParams,
  body: reasonBody,
  response: BookingSchema,
  message: 'Booking rejected',
  handler: async ({ auth, params, body }) =>
    toBookingDTO(await BookingService.reject(params.id, auth.userId, body?.reason), auth),
});

api.route({
  method: 'post',
  path: '/bookings/:id/start',
  summary: 'Nurse starts care',
  description:
    '`CONFIRMED` → `CARE_STARTED` (→ `CARE_IN_PROGRESS` once the scheduled start has passed). Only within the allowed window around the start time.',
  permission: 'bookings:respond',
  params: idParams,
  response: BookingSchema,
  message: 'Care started',
  handler: async ({ auth, params }) =>
    toBookingDTO(await BookingService.start(params.id, auth.userId), auth),
});

api.route({
  method: 'post',
  path: '/bookings/:id/complete',
  summary: 'Nurse completes care',
  description: '`CARE_IN_PROGRESS` → `COMPLETED`.',
  permission: 'bookings:respond',
  params: idParams,
  response: BookingSchema,
  message: 'Care completed',
  handler: async ({ auth, params }) =>
    toBookingDTO(await BookingService.complete(params.id, auth.userId), auth),
});

api.route({
  method: 'post',
  path: '/admin/bookings/:id/cancel',
  summary: 'Admin: cancel a booking (privileged)',
  description:
    "Allowed before care starts. Paid bookings enter REFUND_PENDING using the booking's snapshotted policy, or `refundPercent` (0-100) if the admin overrides it. Audit-logged. No provider refund is made in this phase.",
  permission: 'admin:bookings:manage',
  params: idParams,
  body: z.strictObject({
    reason: z.string().trim().min(3).max(500),
    refundPercent: z.number().int().min(0).max(100).optional(),
  }),
  response: BookingSchema,
  message: 'Booking cancelled',
  handler: async ({ auth, params, body, req }) =>
    toBookingDTO(await BookingService.adminCancel(params.id, auditContext(req), body), auth),
});

api.route({
  method: 'post',
  path: '/admin/bookings/:id/resolve',
  summary: 'Admin: resolve a DISPUTED booking (e.g. a no-show)',
  description:
    'Only DISPUTED bookings. `REFUND` (1-100%, default 100) moves to REFUND_PENDING; `COMPLETE` completes the booking without a refund. No settlement ever happens automatically for disputes. Audit-logged.',
  permission: 'admin:bookings:manage',
  params: idParams,
  body: z.strictObject({
    resolution: z.enum(['REFUND', 'COMPLETE']),
    refundPercent: z.number().int().min(1).max(100).optional(),
    reason: z.string().trim().min(3).max(500),
  }),
  response: BookingSchema,
  message: 'Dispute resolved',
  handler: async ({ auth, params, body, req }) =>
    toBookingDTO(await BookingService.adminResolve(params.id, auditContext(req), body), auth),
});

// ---- admin ----
api.route({
  method: 'get',
  path: '/admin/bookings',
  summary: 'List all bookings',
  permission: 'admin:bookings:read',
  query: paginationQuery
    .extend({
      status: z.enum(BOOKING_STATUSES).optional(),
      patientId: objectId.optional(),
      nurseId: objectId.optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    })
    .strict(),
  response: z.object({ items: z.array(BookingSchema.partial()), meta: pageMeta }),
  handler: async ({ auth, query }) => {
    const page = await BookingService.list(auth, query);
    return { items: page.items.map((b) => toBookingDTO(b, auth)), meta: page.meta };
  },
});

export default api.router;
