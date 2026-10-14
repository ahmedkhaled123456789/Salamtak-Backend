import type { Quote } from '../pricing';
import '../../common/openapi/extend';
import { z } from 'zod';
import { fromGeoPoint } from '../../common/types/geo';
import type { BookingDoc } from './booking.models';
import { BOOKING_STATUSES, type BookingStatus } from './booking.states';

type Viewer = { role: string };

const NURSE_LOCATION_VISIBLE: BookingStatus[] = [
  'NURSE_ACCEPTED',
  'CONFIRMED',
  'CARE_STARTED',
  'CARE_IN_PROGRESS',
  'COMPLETED',
  'DISPUTED',
];

/**
 * Role-aware projection (data minimisation):
 *  - patient: pricing the patient pays, never commission / nurse earnings
 *  - nurse:   own earnings only; exact address only after accepting the request
 *  - admin:   everything including financial and commission snapshots
 */
const refundView = (b: BookingDoc) =>
  b.refund
    ? {
        status: b.refund.status,
        reason: b.refund.reason,
        percent: b.refund.percent,
        amountMinor: b.refund.amountMinor,
        requestedAt: b.refund.requestedAt,
        completedAt: b.refund.completedAt ?? null,
      }
    : null;

export function toBookingDTO(b: BookingDoc, viewer: Viewer) {
  const base = {
    id: String(b._id),
    bookingNumber: b.bookingNumber,
    status: b.status,
    statusUpdatedAt: b.statusUpdatedAt,
    statusReason: b.statusReason ?? null,
    service: {
      id: String(b.serviceId),
      name: b.serviceSnapshot!.name,
      slug: b.serviceSnapshot!.slug,
      billingUnit: b.serviceSnapshot!.billingUnit,
    },
    startDateTime: b.startDateTime,
    endDateTime: b.endDateTime,
    durationMinutes: b.durationMinutes,
    notes: b.notes ?? null,
    holdExpiresAt: b.holdExpiresAt ?? null,
    nurseResponseDeadline: b.nurseResponseDeadline ?? null,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
  const fullLocation = {
    latitude: fromGeoPoint(b.location!.point)?.latitude ?? null,
    longitude: fromGeoPoint(b.location!.point)?.longitude ?? null,
    address: b.location!.address,
    city: b.location!.city ?? null,
    country: b.location!.country ?? null,
  };
  const patientPricing = {
    currency: b.pricingSnapshot.currency,
    lines: b.pricingSnapshot.lines,
    baseMinor: b.pricingSnapshot.baseMinor,
    surchargeMinor: b.pricingSnapshot.surchargeMinor,
    feesMinor: b.pricingSnapshot.feesMinor,
    grossMinor: b.pricingSnapshot.grossMinor,
    discountMinor: b.pricingSnapshot.discountMinor,
    patientPayableMinor: b.pricingSnapshot.patientPayableMinor,
    pricingVersion: b.pricingSnapshot.pricingVersion,
    couponCode: b.couponSnapshot?.code ?? null,
  };

  if (viewer.role === 'NURSE') {
    const showAddress = NURSE_LOCATION_VISIBLE.includes(b.status as BookingStatus);
    return {
      ...base,
      patient: { displayName: b.patientSnapshot!.displayName },
      location: showAddress
        ? fullLocation
        : {
            latitude: null,
            longitude: null,
            address: null,
            city: b.location!.city ?? null,
            country: b.location!.country ?? null,
          },
      cancellation: b.cancellationOutcome
        ? { nurseCompensationMinor: b.cancellationOutcome.nurseCompensationMinor }
        : null,
      earnings: {
        currency: 'AED' as const,
        nurseEarningMinor: b.financialSnapshot.nurseEarningMinor,
      },
    };
  }
  const common = {
    ...base,
    nurse: { id: String(b.nurseId), displayName: b.nurseSnapshot!.displayName },
    genderPreference: b.genderPreference ?? null,
    location: fullLocation,
    pricing: patientPricing,
    refund: refundView(b),
    cancellationOutcome: b.cancellationOutcome
      ? {
          cancelledBy: b.cancellationOutcome.cancelledBy,
          hoursBeforeStart: b.cancellationOutcome.hoursBeforeStart,
          refundPercent: b.cancellationOutcome.refundPercent,
          refundMinor: b.cancellationOutcome.refundMinor,
        }
      : null,
    refundPolicy: b.refundPolicySnapshot?.tiers ?? [],
  };
  if (viewer.role === 'ADMIN') {
    return {
      ...common,
      patient: { id: String(b.patientId), displayName: b.patientSnapshot!.displayName },
      nurse: {
        id: String(b.nurseId),
        userId: String(b.nurseUserId),
        displayName: b.nurseSnapshot!.displayName,
      },
      financial: b.financialSnapshot,
      cancellationBreakdown: b.cancellationOutcome ?? null,
      commission: b.commissionSnapshot,
      paymentId: b.paymentId ? String(b.paymentId) : null,
      paidAt: b.paidAt ?? null,
    };
  }
  return common;
}

// ---------- OpenAPI schemas ----------
const fils = z.number().int().openapi({ description: 'Integer minor units (fils)' });
export const PriceLineSchema = z.object({
  code: z.enum(['BASE', 'WEEKEND_SURCHARGE', 'HOLIDAY_SURCHARGE', 'FEE', 'DISCOUNT']),
  label: z.string(),
  quantity: z.number(),
  unitAmountMinor: fils,
  amountMinor: fils,
});
export const PricingSchema = z.object({
  currency: z.literal('AED'),
  lines: z.array(PriceLineSchema),
  baseMinor: fils,
  surchargeMinor: fils,
  feesMinor: fils,
  grossMinor: fils,
  discountMinor: fils,
  patientPayableMinor: fils,
  pricingVersion: z.string(),
  couponCode: z.string().nullable().optional(),
});

export const QuoteSchema = z.object({
  quoteToken: z
    .string()
    .openapi({ description: 'Signed, expiring reference; send back when booking' }),
  expiresAt: z.string(),
  serviceId: z.string(),
  nurseId: z.string(),
  startDateTime: z.string(),
  endDateTime: z.string(),
  durationMinutes: z.number(),
  currency: z.literal('AED'),
  unit: z.enum(['HOURLY', 'DAILY']),
  rateMinor: fils,
  rateSource: z.enum(['SERVICE', 'NURSE_OVERRIDE']),
  lines: z.array(PriceLineSchema),
  baseMinor: fils,
  surchargeMinor: fils,
  feesMinor: fils,
  grossMinor: fils,
  discountMinor: fils,
  patientPayableMinor: fils,
  pricingVersion: z.string(),
  coupon: z.object({ code: z.string(), discountMinor: fils }).nullable().optional(),
});

export const BookingSchema = z.object({
  id: z.string(),
  bookingNumber: z.string(),
  status: z.enum(BOOKING_STATUSES),
  statusUpdatedAt: z.date(),
  statusReason: z.string().nullable(),
  service: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    billingUnit: z.string(),
  }),
  nurse: z.object({ id: z.string(), displayName: z.string() }).optional(),
  patient: z.object({ displayName: z.string() }).optional(),
  startDateTime: z.date(),
  endDateTime: z.date(),
  durationMinutes: z.number(),
  notes: z.string().nullable(),
  holdExpiresAt: z.date().nullable(),
  nurseResponseDeadline: z.date().nullable(),
  location: z.object({
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    address: z.string().nullable(),
    city: z.string().nullable(),
    country: z.string().nullable(),
  }),
  refund: z
    .object({
      status: z.enum(['NONE', 'PENDING', 'COMPLETED', 'FAILED']),
      reason: z.string(),
      percent: z.number(),
      amountMinor: fils,
      requestedAt: z.date(),
      completedAt: z.date().nullable(),
    })
    .nullable()
    .optional()
    .openapi({ description: 'Patient and admin views' }),
  cancellationOutcome: z
    .object({
      cancelledBy: z.enum(['PATIENT', 'ADMIN']),
      hoursBeforeStart: z.number(),
      refundPercent: z.number(),
      refundMinor: fils,
    })
    .nullable()
    .optional(),
  cancellation: z
    .object({ nurseCompensationMinor: fils })
    .nullable()
    .optional()
    .openapi({ description: 'Nurse view only' }),
  pricing: PricingSchema.optional().openapi({ description: 'Patient and admin views' }),
  earnings: z
    .object({ currency: z.literal('AED'), nurseEarningMinor: fils })
    .optional()
    .openapi({
      description: 'Nurse view only',
    }),
  financial: z
    .record(z.string(), z.unknown())
    .optional()
    .openapi({ description: 'Admin view only' }),
  commission: z
    .record(z.string(), z.unknown())
    .optional()
    .openapi({ description: 'Admin view only' }),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const BookingHistorySchema = z.object({
  previousState: z.enum(BOOKING_STATUSES).nullable(),
  newState: z.enum(BOOKING_STATUSES),
  actorRole: z.enum(['PATIENT', 'NURSE', 'ADMIN', 'SYSTEM']),
  reason: z.string().nullish(),
  createdAt: z.date(),
});

export const toQuoteDTO = (q: Quote) => {
  const p = q.pricing;
  return {
    quoteToken: q.quoteToken,
    expiresAt: q.expiresAt,
    serviceId: q.serviceId,
    nurseId: q.nurseId,
    startDateTime: q.startDateTime,
    endDateTime: q.endDateTime,
    durationMinutes: p.durationMinutes,
    currency: p.currency,
    unit: p.unit,
    rateMinor: p.lines[0]!.unitAmountMinor,
    rateSource: q.rateSource,
    lines: p.lines,
    baseMinor: p.baseMinor,
    surchargeMinor: p.surchargeMinor,
    feesMinor: p.feesMinor,
    grossMinor: p.grossMinor,
    discountMinor: p.discountMinor,
    patientPayableMinor: p.patientPayableMinor,
    pricingVersion: q.pricingVersion,
    coupon: q.coupon ?? null,
  };
};
