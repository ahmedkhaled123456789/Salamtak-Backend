import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { AuditLog } from '../../src/modules/audit';
import { Booking, BookingService } from '../../src/modules/bookings';
import {
  Coupon,
  CouponRedemption,
  CouponUserUsage,
  computeDiscount,
} from '../../src/modules/coupons';
import { ReconciliationService } from '../../src/modules/finance';
import { Payment } from '../../src/modules/payments';
import { Refund, RefundService } from '../../src/modules/refunds';
import { WalletService } from '../../src/modules/wallets';
import type { MockPaymentProvider } from '../../src/providers/payment';
import {
  API,
  createAdmin,
  register,
  resetState,
  startApp,
  stopApp,
  type Session,
} from '../helpers/harness';
import { H, createPayment, freshProvider, succeed, walletOf } from '../helpers/finance';
import { at, baseWorld, mkService, timeTravel, type Nurse } from '../helpers/world';

let app: Express;
let admin: Session;
let serviceId: string;
let nurse: Nurse;
let patient: Session;
let D: string;
let mock: MockPaymentProvider;

beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(async () => {
  await resetState();
  mock = freshProvider();
  ({ admin, serviceId, nurse, patient, D } = await baseWorld(app));
});
afterEach(() => jest.restoreAllMocks());

const post = (s: Session, path: string, body: object = {}) =>
  request(app).post(`${API}${path}`).set(s.auth).send(body);
const patch = (s: Session, path: string, body: object = {}) =>
  request(app).patch(`${API}${path}`).set(s.auth).send(body);
const get = (s: Session, path: string) => request(app).get(`${API}${path}`).set(s.auth);
const oid = (id: string) => new mongoose.Types.ObjectId(id);
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

const slot = (s = '08:00', e = '12:00') => ({
  serviceId,
  nurseId: nurse.profileId,
  startDateTime: at(D, s).toISOString(),
  endDateTime: at(D, e).toISOString(),
});
const mkCoupon = async (over: Record<string, unknown> = {}) => {
  const r = await post(admin, '/admin/coupons', {
    code: `SAVE${Math.floor(Math.random() * 1e6)}`,
    type: 'FIXED',
    valueMinor: 2000,
    startAt: day(-1),
    endAt: day(30),
    ...over,
  });
  expect(r.status).toBe(201);
  return r.body.data as { id: string; code: string };
};
const quote = (who: Session, couponCode?: string, s = slot()) =>
  post(who, '/bookings/quote', { ...s, ...(couponCode && { couponCode }) });
const book = async (who: Session, couponCode?: string, s = slot(), key = randomUUID()) => {
  const q = await quote(who, couponCode, s);
  if (q.status !== 200) return q;
  return request(app)
    .post(`${API}/bookings`)
    .set(who.auth)
    .set('Idempotency-Key', key)
    .send({
      ...s,
      location: { latitude: 25.2, longitude: 55.27, address: 'Marina Walk 1' },
      quoteToken: q.body.data.quoteToken,
      ...(couponCode && { couponCode }),
    });
};

describe('discount calculation (pure, integer only)', () => {
  it('FIXED / PERCENTAGE with caps and half-up basis-point rounding', () => {
    expect(computeDiscount({ type: 'FIXED', valueMinor: 2000 }, 16000)).toBe(2000);
    expect(computeDiscount({ type: 'FIXED', valueMinor: 99999 }, 16000)).toBe(16000); // never below zero
    expect(computeDiscount({ type: 'PERCENTAGE', valueBps: 1000 }, 16000)).toBe(1600);
    expect(computeDiscount({ type: 'PERCENTAGE', valueBps: 1500 }, 333)).toBe(50); // 49.95 -> 50
    expect(computeDiscount({ type: 'PERCENTAGE', valueBps: 1 }, 5000)).toBe(1); // 0.5 -> rounds up (half-up)
    expect(computeDiscount({ type: 'PERCENTAGE', valueBps: 1 }, 4999)).toBe(0); // 0.4999 -> down
    expect(computeDiscount({ type: 'PERCENTAGE', valueBps: 10_000 }, 16000)).toBe(16000);
    expect(
      computeDiscount({ type: 'PERCENTAGE', valueBps: 5000, maxDiscountMinor: 3000 }, 16000),
    ).toBe(3000);
    expect(computeDiscount({ type: 'FIXED', valueMinor: 500 }, 0)).toBe(0);
    expect(() => computeDiscount({ type: 'FIXED', valueMinor: 5 }, 1.5)).toThrow();
    expect(() => computeDiscount({ type: 'FIXED', valueMinor: 5 }, -1)).toThrow();
  });
});

describe('quote and validation', () => {
  it('FIXED discount: server calculates it, payable drops, the nurse earning stays GROSS based', async () => {
    const c = await mkCoupon({ valueMinor: 2000 });
    const q = await post(patient, '/coupons/validate', {
      couponCode: c.code.toLowerCase(),
      ...slot(),
    });
    expect(q.status).toBe(200);
    expect(q.body.data.coupon).toEqual({ code: c.code, discountMinor: 2000 });
    expect(q.body.data.quote).toMatchObject({
      grossMinor: 16000,
      discountMinor: 2000,
      patientPayableMinor: 14000,
    });
    const res = await book(patient, c.code);
    expect(res.status).toBe(201);
    const b = (await Booking.findById(res.body.data.id).lean())!;
    expect(b.financialSnapshot).toMatchObject({
      grossMinor: 16000,
      discountMinor: 2000,
      patientPaidMinor: 14000,
      platformFundedDiscountMinor: 2000,
      commissionMinor: 2400,
      nurseEarningMinor: 13600,
    });
    expect(res.body.data.pricing.couponCode).toBe(c.code);
    const pay = await createPayment(app, patient, res.body.data.id);
    expect(pay.body.data.amountMinor).toBe(14000);
    await succeed(app, mock, pay.body.data.id);
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(13600);
    expect((await ReconciliationService.run()).ok).toBe(true);
  });

  it('PERCENTAGE in basis points, with a maximum discount', async () => {
    const pct = await mkCoupon({ type: 'PERCENTAGE', valueBps: 1000, valueMinor: undefined });
    expect((await quote(patient, pct.code)).body.data.discountMinor).toBe(1600);
    const capped = await mkCoupon({
      type: 'PERCENTAGE',
      valueBps: 5000,
      valueMinor: undefined,
      maxDiscountMinor: 3000,
    });
    const q = await quote(patient, capped.code);
    expect(q.body.data).toMatchObject({ discountMinor: 3000, patientPayableMinor: 13000 });
  });

  it.each([
    ['unknown code', async () => 'NOPE-NOT-REAL', 'COUPON_NOT_FOUND'],
    [
      'expired',
      async () => (await mkCoupon({ startAt: day(-10), endAt: day(-1) })).code,
      'COUPON_EXPIRED',
    ],
    [
      'not started',
      async () => (await mkCoupon({ startAt: day(2), endAt: day(9) })).code,
      'COUPON_NOT_STARTED',
    ],
    [
      'inactive',
      async () => {
        const c = await mkCoupon();
        await post(admin, `/admin/coupons/${c.id}/deactivate`);
        return c.code;
      },
      'COUPON_INACTIVE',
    ],
    [
      'below the minimum amount',
      async () => (await mkCoupon({ minBookingAmountMinor: 20000 })).code,
      'COUPON_MIN_AMOUNT',
    ],
    [
      'other service',
      async () =>
        (await mkCoupon({ applicableServiceIds: [String(new mongoose.Types.ObjectId())] })).code,
      'COUPON_SERVICE_NOT_ELIGIBLE',
    ],
    [
      'other nurse',
      async () =>
        (await mkCoupon({ applicableNurseIds: [String(new mongoose.Types.ObjectId())] })).code,
      'COUPON_NURSE_NOT_ELIGIBLE',
    ],
  ])('refuses a coupon that is %s', async (_n, code, errorCode) => {
    const r = await quote(patient, await code());
    expect([r.status, r.body.errorCode]).toEqual([422, errorCode]);
  });

  it('the minimum amount is compared with the exact boundary (gross)', async () => {
    const ok = await mkCoupon({ minBookingAmountMinor: 16000 });
    expect((await quote(patient, ok.code)).status).toBe(200);
    const no = await mkCoupon({ minBookingAmountMinor: 16001 });
    expect((await quote(patient, no.code)).body.errorCode).toBe('COUPON_MIN_AMOUNT');
  });

  it('applicable services / nurses restrict to the listed ones', async () => {
    const other = await mkService(app, admin, { name: 'Other service' });
    const c = await mkCoupon({
      applicableServiceIds: [serviceId],
      applicableNurseIds: [nurse.profileId],
    });
    expect((await quote(patient, c.code)).status).toBe(200);
    void other;
  });

  it('never accepts a client-supplied discount; only patients validate', async () => {
    const c = await mkCoupon();
    expect(
      (
        await post(patient, '/bookings/quote', {
          ...slot(),
          couponCode: c.code,
          discountMinor: 99999,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(patient, '/coupons/validate', {
          ...slot(),
          couponCode: c.code,
          discountMinor: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (await post(nurse.session, '/coupons/validate', { ...slot(), couponCode: c.code })).status,
    ).toBe(403);
    expect((await post(admin, '/coupons/validate', { ...slot(), couponCode: c.code })).status).toBe(
      403,
    );
  });

  it('a quote is bound to its coupon: it cannot be added, removed or swapped at booking time', async () => {
    const a = await mkCoupon({ valueMinor: 2000 });
    const b = await mkCoupon({ valueMinor: 3000 });
    const s = slot();
    const withA = (await quote(patient, a.code, s)).body.data.quoteToken as string;
    const plain = (await quote(patient, undefined, s)).body.data.quoteToken as string;
    const send = (quoteToken: string, couponCode?: string) =>
      request(app)
        .post(`${API}/bookings`)
        .set(patient.auth)
        .set('Idempotency-Key', randomUUID())
        .send({
          ...s,
          location: { latitude: 25.2, longitude: 55.27, address: 'Marina 1' },
          quoteToken,
          ...(couponCode && { couponCode }),
        });
    expect((await send(plain, a.code)).body.errorCode).toBe('QUOTE_MISMATCH');
    expect((await send(withA)).body.errorCode).toBe('QUOTE_MISMATCH');
    expect((await send(withA, b.code)).body.errorCode).toBe('QUOTE_MISMATCH');
    expect(await Booking.countDocuments()).toBe(0);
    expect((await send(withA, a.code)).status).toBe(201);
  });
});

describe('booking snapshot', () => {
  it('stores the exact terms; later coupon edits never change an existing booking', async () => {
    const c = await mkCoupon({
      type: 'PERCENTAGE',
      valueBps: 1000,
      valueMinor: undefined,
      maxDiscountMinor: 5000,
    });
    const res = await book(patient, c.code);
    const before = (await Booking.findById(res.body.data.id).lean())!;
    expect(before.couponSnapshot).toMatchObject({
      code: c.code,
      type: 'PERCENTAGE',
      valueBps: 1000,
      maxDiscountMinor: 5000,
      discountMinor: 1600,
      couponVersion: 1,
    });
    const up = await patch(admin, `/admin/coupons/${c.id}`, { valueBps: 5000 });
    expect(up.body.data.version).toBe(2);
    const after = (await Booking.findById(res.body.data.id).lean())!;
    expect(after.couponSnapshot).toEqual(before.couponSnapshot);
    expect(after.pricingSnapshot!.discountMinor).toBe(1600);
    // the snapshot is immutable at the model level too
    await expect(
      Booking.updateOne({ _id: before._id }, { $set: { couponSnapshot: null } }),
    ).rejects.toThrow();
    expect(await AuditLog.countDocuments({ action: 'coupon.updated' })).toBe(1);
  });
});

describe('usage limits (MongoDB conditional updates, concurrency-safe)', () => {
  const slots: [string, string][] = [
    ['00:00', '01:00'],
    ['02:00', '03:00'],
    ['04:00', '05:00'],
    ['06:00', '07:00'],
    ['08:00', '09:00'],
    ['10:00', '11:00'],
  ];

  it('usageLimit 1 with 6 simultaneous bookings: exactly one succeeds', async () => {
    const c = await mkCoupon({ usageLimit: 1 });
    const patients = await Promise.all(slots.map(() => register(app, 'PATIENT')));
    // everybody gets a valid quote first (the limit is not yet consumed)
    const quotes = await Promise.all(patients.map((p, i) => quote(p, c.code, slot(...slots[i]!))));
    expect(quotes.every((q) => q.status === 200)).toBe(true);
    const results = await Promise.all(
      patients.map((p, i) =>
        request(app)
          .post(`${API}/bookings`)
          .set(p.auth)
          .set('Idempotency-Key', randomUUID())
          .send({
            ...slot(...slots[i]!),
            location: { latitude: 25.2, longitude: 55.27, address: 'Marina 1' },
            quoteToken: quotes[i]!.body.data.quoteToken,
            couponCode: c.code,
          }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const failed = results.filter((r) => r.status !== 201);
    expect(failed).toHaveLength(5);
    expect(failed.every((r) => r.body.errorCode === 'COUPON_USAGE_LIMIT')).toBe(true);
    expect((await Coupon.findById(c.id))!.usedCount).toBe(1);
    expect(await CouponRedemption.countDocuments({ couponId: c.id, status: 'APPLIED' })).toBe(1);
    expect(await Booking.countDocuments({ couponSnapshot: { $exists: true } })).toBe(1);
    expect(await Booking.countDocuments()).toBe(1); // the losers left no booking or reservation behind
  });

  it('perUserLimit 1: two simultaneous bookings by the same patient, one wins', async () => {
    const c = await mkCoupon({ perUserLimit: 1 });
    const qs = await Promise.all([
      quote(patient, c.code, slot(...slots[0]!)),
      quote(patient, c.code, slot(...slots[1]!)),
    ]);
    const send = (i: number) =>
      request(app)
        .post(`${API}/bookings`)
        .set(patient.auth)
        .set('Idempotency-Key', randomUUID())
        .send({
          ...slot(...slots[i]!),
          location: { latitude: 25.2, longitude: 55.27, address: 'Marina 1' },
          quoteToken: qs[i]!.body.data.quoteToken,
          couponCode: c.code,
        });
    const results = await Promise.all([send(0), send(1)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(results.find((r) => r.status === 422)!.body.errorCode).toBe('COUPON_USER_LIMIT');
    expect((await CouponUserUsage.findOne({ couponId: c.id }))!.used).toBe(1);
    expect((await Coupon.findById(c.id))!.usedCount).toBe(1);
    // a different patient can still use it
    const other = await register(app, 'PATIENT');
    expect((await book(other, c.code, slot(...slots[2]!))).status).toBe(201);
  });

  it('a limited coupon is validated against the limits at quote time too', async () => {
    const c = await mkCoupon({ usageLimit: 1 });
    expect((await book(patient, c.code, slot(...slots[0]!))).status).toBe(201);
    const other = await register(app, 'PATIENT');
    expect((await quote(other, c.code, slot(...slots[1]!))).body.errorCode).toBe(
      'COUPON_USAGE_LIMIT',
    );
  });

  it('an unpaid booking that expires or is cancelled gives the use back; a paid one keeps it', async () => {
    const c = await mkCoupon({ usageLimit: 1, perUserLimit: 1 });
    const first = await book(patient, c.code, slot(...slots[0]!));
    expect((await Coupon.findById(c.id))!.usedCount).toBe(1);
    await timeTravel(first.body.data.id, { holdExpiresAt: new Date(Date.now() - 60_000) });
    await BookingService.expireDue(new Date());
    expect((await Coupon.findById(c.id))!.usedCount).toBe(0);
    expect((await CouponRedemption.findOne({ bookingId: first.body.data.id }))!.status).toBe(
      'RELEASED',
    );
    await BookingService.expireDue(new Date()); // idempotent
    expect((await Coupon.findById(c.id))!.usedCount).toBe(0);

    const second = await book(patient, c.code, slot(...slots[1]!));
    expect(second.status).toBe(201);
    const cancel = await post(patient, `/bookings/${second.body.data.id}/cancel`);
    expect(cancel.status).toBe(200);
    expect((await Coupon.findById(c.id))!.usedCount).toBe(0);
    expect((await CouponUserUsage.findOne({ couponId: c.id }))!.used).toBe(0);

    const third = await book(patient, c.code, slot(...slots[2]!));
    const pay = await createPayment(app, patient, third.body.data.id);
    await succeed(app, mock, pay.body.data.id);
    expect((await Coupon.findById(c.id))!.usedCount).toBe(1); // paid: the use is kept
  });

  it('retrying a booking with the same Idempotency-Key consumes one use', async () => {
    const c = await mkCoupon({ usageLimit: 5 });
    const key = randomUUID();
    const s = slot(...slots[0]!);
    const q = await quote(patient, c.code, s);
    const send = () =>
      request(app)
        .post(`${API}/bookings`)
        .set(patient.auth)
        .set('Idempotency-Key', key)
        .send({
          ...s,
          location: { latitude: 25.2, longitude: 55.27, address: 'Marina 1' },
          quoteToken: q.body.data.quoteToken,
          couponCode: c.code,
        });
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.data.id).toBe(b.body.data.id);
    expect((await Coupon.findById(c.id))!.usedCount).toBe(1);
  });
});

describe('admin management', () => {
  it('validates terms, rejects duplicate codes, restricts to admins and audits every change', async () => {
    const bad = [
      { type: 'FIXED', valueBps: 100 }, // wrong value kind
      { type: 'PERCENTAGE', valueMinor: 100 },
      { type: 'PERCENTAGE', valueBps: 10_001 },
      { type: 'FIXED', valueMinor: 1.5 },
      { type: 'FIXED', valueMinor: 100, startAt: day(5), endAt: day(1) },
    ];
    for (const b of bad)
      expect(
        (
          await post(admin, '/admin/coupons', {
            code: 'BADONE',
            startAt: day(-1),
            endAt: day(9),
            ...b,
          })
        ).status,
      ).toBe(400);
    const c = await mkCoupon({ code: 'Welcome-10' });
    expect(c.code).toBe('WELCOME-10');
    const dup = await post(admin, '/admin/coupons', {
      code: 'welcome-10',
      type: 'FIXED',
      valueMinor: 1,
      startAt: day(-1),
      endAt: day(2),
    });
    expect([dup.status, dup.body.errorCode]).toEqual([409, 'COUPON_CODE_EXISTS']);
    const approver = await createAdmin(app, 'FINANCE_APPROVER');
    for (const who of [patient, nurse.session, approver]) {
      expect(
        (
          await post(who, '/admin/coupons', {
            code: 'HACK',
            type: 'FIXED',
            valueMinor: 1,
            startAt: day(-1),
            endAt: day(2),
          })
        ).status,
      ).toBe(403);
      expect((await get(who, '/admin/coupons')).status).toBe(403);
    }
    expect((await post(admin, `/admin/coupons/${c.id}/deactivate`)).body.data.changed).toBe(true);
    expect((await post(admin, `/admin/coupons/${c.id}/deactivate`)).body.data.changed).toBe(false);
    expect((await post(admin, `/admin/coupons/${c.id}/activate`)).body.data.active).toBe(true);
    const log = (await AuditLog.find({ entity: 'Coupon' }).lean()).map((a) => a.action).sort();
    expect(log).toEqual(['coupon.activated', 'coupon.created', 'coupon.deactivated']);
    expect((await get(admin, '/admin/coupons?active=true')).body.data.meta.total).toBe(1);
  });

  it('inspect shows usage and total platform-funded discount', async () => {
    const c = await mkCoupon({ valueMinor: 2000 });
    await book(patient, c.code, slot('00:00', '04:00'));
    const o = await register(app, 'PATIENT');
    await book(o, c.code, slot('05:00', '09:00'));
    const r = await get(admin, `/admin/coupons/${c.id}`);
    expect(r.body.data.usage).toEqual({ applied: 2, released: 0, totalDiscountMinor: 4000 });
    expect(r.body.data.coupon.usedCount).toBe(2);
  });
});

describe('zero-amount bookings (explicit server-side flow)', () => {
  async function freeBooking() {
    const c = await mkCoupon({ valueMinor: 999_999 });
    const res = await book(patient, c.code);
    expect(res.status).toBe(201);
    return { c, id: res.body.data.id as string };
  }

  it('creates an internal PAID payment of 0 with no provider payment, credits the nurse from GROSS and reconciles', async () => {
    const { id } = await freeBooking();
    const b = (await Booking.findById(id).lean())!;
    expect(b.status).toBe('NURSE_PENDING');
    expect(b.pricingSnapshot).toMatchObject({
      grossMinor: 16000,
      discountMinor: 16000,
      patientPayableMinor: 0,
    });
    const pays = await Payment.find({ bookingId: id }).lean();
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({
      provider: 'internal',
      amountMinor: 0,
      status: 'PAID',
      settlement: 'APPLIED',
    });
    expect(pays[0]!.providerTransactionId).toBeUndefined();
    expect(mock.calls.create).toBe(0); // the provider was never asked to create a payment
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(13600);
    expect(await AuditLog.countDocuments({ action: 'payment.zero_settled' })).toBe(1);
    expect((await ReconciliationService.run()).ok).toBe(true);
    // a client can not start a provider payment for it
    const pay = await createPayment(app, patient, id);
    expect(pay.status).toBeGreaterThanOrEqual(400);
    expect(await Payment.countDocuments({ bookingId: id })).toBe(1);
  });

  it('is idempotent: retrying the booking creates one payment and one earning', async () => {
    const c = await mkCoupon({ valueMinor: 999_999 });
    const key = randomUUID();
    const s = slot();
    const q = await quote(patient, c.code, s);
    const send = () =>
      request(app)
        .post(`${API}/bookings`)
        .set(patient.auth)
        .set('Idempotency-Key', key)
        .send({
          ...s,
          location: { latitude: 25.2, longitude: 55.27, address: 'Marina 1' },
          quoteToken: q.body.data.quoteToken,
          couponCode: c.code,
        });
    const rs = await Promise.all([send(), send(), send()]);
    expect(new Set(rs.map((r) => r.body.data.id)).size).toBe(1);
    expect(await Payment.countDocuments()).toBe(1);
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(13600);
  });

  it('nurse rejection reverses the earning, ends REFUNDED, needs no provider refund, and reconciles', async () => {
    const { id } = await freeBooking();
    const r = await post(nurse.session, `/bookings/${id}/reject`);
    expect(r.status).toBe(200);
    expect((await Booking.findById(id))!.status).toBe('REFUNDED');
    expect(await Refund.countDocuments()).toBe(0);
    expect(mock.calls.refund).toBe(0);
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(0);
    expect((await ReconciliationService.run()).checks.filter((c) => !c.ok)).toEqual([]);
  });

  it.each([
    // hours before start, nurse keeps, final status
    [100, 0, 'REFUNDED'],
    [30, 6800, 'REFUNDED'],
    [5, 13600, 'CANCELLED'],
  ])(
    'patient cancels %ih before start: nurse keeps %i fils, platform absorbs it, reconciliation stays green',
    async (hours, nurseKeeps, status) => {
      const { id } = await freeBooking();
      const start = Date.now() + hours * H;
      await timeTravel(id, {
        startDateTime: new Date(start),
        endDateTime: new Date(start + 4 * H),
      });
      const c = await post(patient, `/bookings/${id}/cancel`);
      expect(c.status).toBe(200);
      const b = (await Booking.findById(id).lean())!;
      expect(b.status).toBe(status);
      expect(b.cancellationOutcome).toMatchObject({
        refundMinor: 0,
        nurseCompensationMinor: nurseKeeps,
        platformKeptMinor: 0 - nurseKeeps,
      });
      expect((await walletOf(nurse)).pendingBalanceMinor).toBe(nurseKeeps);
      expect(await Refund.countDocuments()).toBe(0);
      await RefundService.processDue();
      expect((await ReconciliationService.run()).checks.filter((x) => !x.ok)).toEqual([]);
    },
  );

  it('the earning can be released after completion like any other', async () => {
    const { id } = await freeBooking();
    const { completeBooking } = await import('../helpers/finance');
    await completeBooking(id, nurse, app);
    await WalletService.releaseDue(new Date(Date.now() + 49 * H));
    expect(await walletOf(nurse)).toMatchObject({
      availableBalanceMinor: 13600,
      pendingBalanceMinor: 0,
    });
    expect((await ReconciliationService.run()).ok).toBe(true);
    void oid;
  });
});
