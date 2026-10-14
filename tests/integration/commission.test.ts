import type { Express } from 'express';
import request from 'supertest';
import { AuditLog } from '../../src/modules/audit';
import { Booking } from '../../src/modules/bookings';
import { Commission } from '../../src/modules/pricing';
import { API, resetState, startApp, stopApp, type Session } from '../helpers/harness';
import {
  at,
  baseWorld,
  bookIt,
  bookReq,
  mkNurse,
  mkService,
  quoteReq,
  type BookArgs,
  type Nurse,
} from '../helpers/world';

let app: Express;
let admin: Session;
let serviceId: string;
let nurse: Nurse;
let patient: Session;
let D: string;

beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(async () => {
  await resetState();
  ({ admin, serviceId, nurse, patient, D } = await baseWorld(app));
});

const args = (s = '08:00', e = '12:00', over: Partial<BookArgs> = {}): BookArgs => ({
  serviceId,
  nurseId: nurse.profileId,
  start: at(D, s),
  end: at(D, e),
  ...over,
});
const rule = (body: object) =>
  request(app).post(`${API}/admin/commissions`).set(admin.auth).send(body);
async function book(a = args()) {
  const { booking } = await bookIt(app, patient, a);
  expect(booking.status).toBe(201);
  return (await Booking.findById(booking.body.data.id).lean())!;
}

describe('commission calculation (integer basis points, server-side, snapshotted)', () => {
  it('default 15%: 160 AED => platform 24 AED, nurse 136 AED; commission + nurse == gross', async () => {
    const b = await book();
    expect(b.financialSnapshot).toMatchObject({
      grossMinor: 16000,
      commissionBps: 1500,
      commissionMinor: 2400,
      nurseEarningMinor: 13600,
      platformNetRevenueMinor: 2400,
      paymentProcessingFeeMinor: 0,
    });
    expect(b.commissionSnapshot).toMatchObject({
      type: 'PERCENTAGE',
      bps: 1500,
      platformMinor: 2400,
      nurseMinor: 13600,
    });
    expect(b.financialSnapshot.commissionMinor + b.financialSnapshot.nurseEarningMinor).toBe(
      b.financialSnapshot.grossMinor,
    );
  });

  it('the spec example: 1500 AED at 15% => platform 225 AED, nurse 1275 AED (daily service)', async () => {
    const daily = await mkService(app, admin, { billingUnit: 'DAILY', rate: 150000 });
    const n = await mkNurse(app, admin, { serviceIds: [daily] });
    const b = await book({
      serviceId: daily,
      nurseId: n.profileId,
      start: at(D, '08:00'),
      end: new Date(at(D, '08:00').getTime() + 24 * 3_600_000),
    });
    expect(b.financialSnapshot).toMatchObject({
      grossMinor: 150000,
      commissionMinor: 22500,
      nurseEarningMinor: 127500,
    });
  });

  it('rounds half-up in whole fils and never loses or creates a fil', async () => {
    await rule({ scope: 'GLOBAL', type: 'PERCENTAGE', bps: 333 });
    const b = await book(args('08:00', '09:15')); // 75 min at 4000/h = 5000
    const f = b.financialSnapshot;
    expect(f.grossMinor).toBe(5000);
    expect(f.commissionMinor).toBe(167); // 5000 * 3.33% = 166.5 -> 167
    expect(f.commissionMinor + f.nurseEarningMinor).toBe(5000);
    expect(Number.isInteger(f.commissionMinor)).toBe(true);
  });

  it('platform-funded coupon logic: discount lowers the patient price, never the nurse earning (calculator level)', async () => {
    const { calculatePrice } = await import('../../src/modules/pricing');
    const r = calculatePrice({
      unit: 'DAILY',
      rateMinor: 100000,
      weekendBps: 0,
      holidayBps: 0,
      fees: [],
      weekendDays: [],
      holidayDates: new Set(),
      startMs: Date.parse('2026-12-01T04:00:00Z'),
      endMs: Date.parse('2026-12-02T04:00:00Z'),
      tz: 'Asia/Dubai',
      commissionBps: 1500,
      discountMinor: 20000,
    });
    expect(r.financial).toMatchObject({
      grossMinor: 100000,
      discountMinor: 20000,
      patientPaidMinor: 80000,
      platformFundedDiscountMinor: 20000,
      commissionMinor: 15000,
      nurseEarningMinor: 85000,
      platformNetRevenueMinor: -5000,
    });
  });
});

describe('commission rules (global / service / nurse, percentage / fixed)', () => {
  it('precedence: NURSE > SERVICE > GLOBAL > service default > platform default', async () => {
    expect((await book()).financialSnapshot.commissionBps).toBe(1500); // platform default
    await request(app)
      .patch(`${API}/admin/services/${serviceId}`)
      .set(admin.auth)
      .send({ commissionBps: 1800 });
    expect((await book(args('13:00', '14:00'))).financialSnapshot.commissionBps).toBe(1800); // service default
    await rule({ scope: 'GLOBAL', type: 'PERCENTAGE', bps: 2000 });
    expect((await book(args('15:00', '16:00'))).financialSnapshot.commissionBps).toBe(2000); // global rule beats service default
    await rule({ scope: 'SERVICE', serviceId, type: 'PERCENTAGE', bps: 1000 });
    expect((await book(args('17:00', '18:00'))).financialSnapshot.commissionBps).toBe(1000);
    await rule({ scope: 'NURSE', nurseId: nurse.profileId, type: 'PERCENTAGE', bps: 500 });
    const b = await book(args('19:00', '20:00'));
    expect(b.financialSnapshot).toMatchObject({
      commissionBps: 500,
      commissionMinor: 200,
      nurseEarningMinor: 3800,
    });
  });

  it('a FIXED commission is a flat fee per booking, capped at the gross', async () => {
    await rule({ scope: 'GLOBAL', type: 'FIXED', fixedMinor: 2000 });
    const b = await book();
    expect(b.financialSnapshot).toMatchObject({
      commissionMinor: 2000,
      nurseEarningMinor: 14000,
      commissionBps: 0,
    });
    expect(b.commissionSnapshot).toMatchObject({
      type: 'FIXED',
      fixedMinor: 2000,
      platformMinor: 2000,
      nurseMinor: 14000,
    });
    await rule({ scope: 'GLOBAL', type: 'FIXED', fixedMinor: 99999 });
    const capped = await book(args('13:00', '14:00'));
    expect(capped.financialSnapshot).toMatchObject({
      grossMinor: 4000,
      commissionMinor: 4000,
      nurseEarningMinor: 0,
    });
  });

  it('changing commission NEVER touches existing bookings; it applies to new ones', async () => {
    const old = await book();
    await rule({ scope: 'GLOBAL', type: 'PERCENTAGE', bps: 3000 });
    const fresh = await book(args('14:00', '18:00'));
    expect((await Booking.findById(old._id).lean())!.financialSnapshot).toEqual(
      old.financialSnapshot,
    );
    expect(fresh.financialSnapshot).toMatchObject({
      commissionBps: 3000,
      commissionMinor: 4800,
      nurseEarningMinor: 11200,
    });
  });

  it('a commission change after the quote invalidates it (the quote fingerprint covers the commission)', async () => {
    const a = args();
    const q = await quoteReq(app, patient, a);
    await rule({ scope: 'GLOBAL', type: 'PERCENTAGE', bps: 2500 });
    const r = await bookReq(app, patient, a, q.body.data.quoteToken);
    expect([r.status, r.body.errorCode]).toEqual([409, 'QUOTE_MISMATCH']);
  });

  it('the patient never sees commission or nurse earnings in the quote or booking', async () => {
    const q = await quoteReq(app, patient, args());
    expect(JSON.stringify(q.body)).not.toMatch(/commission|nurseEarning/i);
  });
});

describe('rule administration', () => {
  it('publishing versions the rule, closes the previous one and is audit-logged', async () => {
    const a = await rule({ scope: 'GLOBAL', type: 'PERCENTAGE', bps: 1200 });
    expect(a.status).toBe(201);
    const later = new Date(Date.now() + 1000).toISOString();
    const b = await rule({ scope: 'GLOBAL', type: 'PERCENTAGE', bps: 1300, effectiveFrom: later });
    expect(b.body.data).toMatchObject({ version: 2, bps: 1300 });
    expect(await Commission.countDocuments({ isCurrent: true })).toBe(1);
    const list = await request(app).get(`${API}/admin/commissions`).set(admin.auth);
    expect(list.body.data.items).toHaveLength(2);
    expect(list.body.data.items.find((i: { version: number }) => i.version === 1).effectiveTo).toBe(
      later,
    );
    expect(await AuditLog.countDocuments({ action: 'commission.published' })).toBe(2);
    const stale = await rule({
      scope: 'GLOBAL',
      type: 'PERCENTAGE',
      bps: 1,
      effectiveFrom: new Date(Date.now() - 86_400_000).toISOString(),
    });
    expect([stale.status, stale.body.errorCode]).toEqual([409, 'COMMISSION_DATE_CONFLICT']);
  });

  it('validates integer basis points, the scope targets and the rule shape; admin only', async () => {
    expect((await rule({ scope: 'GLOBAL', type: 'PERCENTAGE', bps: 15.5 })).status).toBe(400);
    expect((await rule({ scope: 'GLOBAL', type: 'PERCENTAGE', bps: 10001 })).status).toBe(400);
    expect((await rule({ scope: 'GLOBAL', type: 'PERCENTAGE', fixedMinor: 100 })).status).toBe(400);
    expect((await rule({ scope: 'GLOBAL', type: 'FIXED', bps: 100 })).status).toBe(400);
    expect((await rule({ scope: 'SERVICE', type: 'PERCENTAGE', bps: 100 })).status).toBe(400); // needs serviceId
    expect((await rule({ scope: 'GLOBAL', serviceId, type: 'PERCENTAGE', bps: 100 })).status).toBe(
      400,
    );
    for (const who of [patient, nurse.session]) {
      expect(
        (
          await request(app)
            .post(`${API}/admin/commissions`)
            .set(who.auth)
            .send({ scope: 'GLOBAL', type: 'PERCENTAGE', bps: 100 })
        ).status,
      ).toBe(403);
    }
    expect(await Commission.countDocuments()).toBe(0);
  });

  it('a future-dated rule is not applied yet', async () => {
    await rule({
      scope: 'GLOBAL',
      type: 'PERCENTAGE',
      bps: 4000,
      effectiveFrom: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect((await book()).financialSnapshot.commissionBps).toBe(1500);
  });
});
