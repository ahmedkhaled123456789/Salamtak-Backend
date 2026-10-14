import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { AuditLog } from '../../src/modules/audit';
import { Booking } from '../../src/modules/bookings';
import { EmergencyOffer, EmergencyRequest, EmergencyService } from '../../src/modules/emergency';
import { Notification } from '../../src/modules/notifications';
import { executeJob } from '../../src/jobs';
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
import { createPayment, freshProvider, succeed } from '../helpers/finance';
import { memoryQueue } from '../helpers/jobs';
import { baseWorld, mkNurse, type Nurse } from '../helpers/world';

let app: Express;
let admin: Session;
let serviceId: string;
let nurse: Nurse;
let patient: Session;
let patient2: Session;
let mock: MockPaymentProvider;

beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(async () => {
  await resetState();
  memoryQueue().jobs.length = 0;
  mock = freshProvider();
  ({ admin, serviceId, nurse, patient, patient2 } = await baseWorld(app));
});

const post = (s: Session, path: string, body: object = {}) =>
  request(app).post(`${API}${path}`).set(s.auth).send(body);
const get = (s: Session, path: string) => request(app).get(`${API}${path}`).set(s.auth);
const body = (o: Record<string, unknown> = {}) => ({
  serviceId,
  location: {
    latitude: 25.2048,
    longitude: 55.2708,
    address: 'Marina Walk, Tower 1',
    city: 'Dubai',
  },
  durationMinutes: 120,
  notes: 'asthma attack, urgent',
  ...o,
});
const create = (
  who = patient,
  o: Record<string, unknown> = {},
  key: string | null = randomUUID(),
) => {
  const r = request(app).post(`${API}/emergency-requests`).set(who.auth);
  return (key ? r.set('Idempotency-Key', key) : r).send(body(o));
};
const later = (s: number) => new Date(Date.now() + s * 1000);

async function offered(who = patient) {
  const r = await create(who);
  expect(r.status).toBe(201);
  const id = r.body.data.id as string;
  expect(await EmergencyService.matchNext(id)).toBe('OFFERED');
  const offer = (await EmergencyOffer.findOne({ requestId: id, status: 'OFFERED' }))!;
  return { id, offer };
}

describe('creating requests', () => {
  it('creates a PENDING request that respects the booking minimum lead; idempotent; one live request per patient', async () => {
    const key = randomUUID();
    const a = await create(patient, {}, key);
    const b = await create(patient, {}, key);
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ status: 'PENDING', durationMinutes: 120, bookingId: null });
    expect(b.body.data.id).toBe(a.body.data.id);
    const start = new Date(a.body.data.requestedStart).getTime();
    expect(start - Date.now()).toBeGreaterThanOrEqual(60 * 60_000); // booking.minLeadMinutes
    const second = await create(patient);
    expect([second.status, second.body.errorCode]).toEqual([409, 'EMERGENCY_ALREADY_ACTIVE']);
    expect(await EmergencyRequest.countDocuments()).toBe(1);
    // another patient is unaffected
    expect((await create(patient2)).status).toBe(201);
  });

  it('validates input, requires the Idempotency-Key and the PATIENT role', async () => {
    expect((await create(patient, {}, null)).status).toBe(400);
    expect((await create(patient, { durationMinutes: 30 })).status).toBe(400);
    expect((await create(patient, { notes: 'x'.repeat(201) })).status).toBe(400);
    expect((await create(patient, { priority: 'HIGH' })).status).toBe(400);
    expect((await create(patient, { serviceId: 'nope' })).status).toBe(400);
    expect((await create(nurse.session)).status).toBe(403);
    expect((await create(admin)).status).toBe(403);
    expect((await request(app).post(`${API}/emergency-requests`).send(body())).status).toBe(401);
  });

  it('queues only an id for immediate matching (no personal or health data in the job payload)', async () => {
    const r = await create();
    const jobs = memoryQueue().jobs.filter((j) => j.name === 'emergency.match');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toEqual({ requestId: r.body.data.id });
  });
});

describe('matching and offers', () => {
  it('offers the request to a verified, available nurse; the nurse sees a minimal offer', async () => {
    const { id, offer } = await offered();
    expect(offer.nurseUserId.toString()).toBe(nurse.session.id);
    expect(await EmergencyRequest.findById(id)).toMatchObject({
      status: 'NURSE_OFFERED',
      offersMade: 1,
    });
    const mine = await get(nurse.session, '/emergency-offers');
    expect(mine.body.data).toHaveLength(1);
    const o = mine.body.data[0];
    expect(Object.keys(o).sort()).toEqual([
      'city',
      'durationMinutes',
      'expiresAt',
      'offerId',
      'requestId',
      'requestedStart',
      'service',
    ]);
    const blob = JSON.stringify(mine.body);
    expect(blob).not.toMatch(/Marina Walk|asthma|latitude|patientId/);
    expect(
      await Notification.countDocuments({ type: 'EMERGENCY_OFFER', recipientId: nurse.session.id }),
    ).toBe(1);
    const all = JSON.stringify(await Notification.find().lean());
    expect(all).not.toMatch(/asthma|Marina Walk/);
    expect((await get(patient, '/emergency-offers')).status).toBe(403);
  });

  it('never offers to nurses that are unverified or suspended', async () => {
    await request(app)
      .patch(`${API}/admin/nurses/${nurse.profileId}/suspend`)
      .set(admin.auth)
      .send({ reason: 'investigation' });
    await mkNurse(app, admin, { serviceIds: [serviceId], verify: false });
    const r = await create();
    expect(await EmergencyService.matchNext(r.body.data.id)).toBe('NO_CANDIDATE');
    expect(await EmergencyRequest.findById(r.body.data.id)).toMatchObject({
      status: 'FAILED',
      statusReason: 'NO_NURSE_AVAILABLE',
    });
    expect(await EmergencyOffer.countDocuments()).toBe(0);
    expect(
      await Notification.countDocuments({ type: 'EMERGENCY_NO_NURSE', recipientId: patient.id }),
    ).toBe(1);
  });

  it('honours the gender preference', async () => {
    const r = await create(patient, { genderPreference: 'MALE' }); // the only nurse is FEMALE
    expect(await EmergencyService.matchNext(r.body.data.id)).toBe('NO_CANDIDATE');
  });

  it('concurrent matching creates exactly one live offer', async () => {
    const r = await create();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => EmergencyService.matchNext(r.body.data.id)),
    );
    expect(results.filter((x) => x === 'OFFERED')).toHaveLength(1);
    expect(await EmergencyOffer.countDocuments({ requestId: r.body.data.id })).toBe(1);
    expect((await EmergencyRequest.findById(r.body.data.id))!.offersMade).toBe(1);
  });

  it('declining passes the request to the next nurse; with nobody left it fails', async () => {
    const second = await mkNurse(app, admin, { serviceIds: [serviceId] });
    const { id, offer } = await offered();
    const firstUser = String(offer.nurseUserId);
    const firstSession = firstUser === nurse.session.id ? nurse.session : second.session;
    const otherSession = firstSession === nurse.session ? second.session : nurse.session;
    expect(
      (await post(otherSession, `/emergency-offers/${String(offer._id)}/decline`)).status,
    ).toBe(404); // not mine
    expect(
      (await post(firstSession, `/emergency-offers/${String(offer._id)}/decline`)).status,
    ).toBe(200);
    expect(await EmergencyRequest.findById(id)).toMatchObject({ status: 'MATCHING' });
    expect(await EmergencyService.matchNext(id)).toBe('OFFERED');
    const next = (await EmergencyOffer.findOne({ requestId: id, status: 'OFFERED' }))!;
    expect(String(next.nurseUserId)).toBe(otherSession.id);
    await post(otherSession, `/emergency-offers/${String(next._id)}/decline`);
    expect(await EmergencyService.matchNext(id)).toBe('NO_CANDIDATE');
    expect((await EmergencyRequest.findById(id))!.status).toBe('FAILED');
  });

  it('an unanswered offer expires and the request moves on (sweep job)', async () => {
    const { id, offer } = await offered();
    const out = await executeJob('emergency.sweep', {}, { now: later(300) });
    expect(out.offersExpired).toBe(1);
    expect((await EmergencyOffer.findById(offer._id))!.status).toBe('EXPIRED');
    // the only nurse was already tried: the request fails instead of looping
    expect((await EmergencyRequest.findById(id))!.status).toBe('FAILED');
    expect(
      (await post(nurse.session, `/emergency-offers/${String(offer._id)}/accept`)).status,
    ).toBe(409);
  });

  it('the whole request expires after its time limit', async () => {
    const r = await create();
    await EmergencyRequest.collection.updateOne(
      { _id: new EmergencyRequest.base.Types.ObjectId(r.body.data.id) },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const out = await executeJob('emergency.sweep', {});
    expect(out.requestsExpired).toBe(1);
    expect((await EmergencyRequest.findById(r.body.data.id))!.status).toBe('EXPIRED');
    expect((await executeJob('emergency.sweep', {})).requestsExpired).toBe(0);
  });
});

describe('acceptance creates an ordinary booking', () => {
  it('only one acceptance, one booking; payment and nurse confirmation still follow the normal flow', async () => {
    const { id, offer } = await offered();
    const results = await Promise.all(
      [1, 2, 3].map(() => post(nurse.session, `/emergency-offers/${String(offer._id)}/accept`)),
    );
    expect(results.every((r) => r.status === 200 && r.body.data.status === 'ACCEPTED')).toBe(true);
    const req = (await EmergencyRequest.findById(id))!;
    expect(req.status).toBe('ACCEPTED');
    expect(req.bookingId).toBeTruthy();
    expect(await Booking.countDocuments()).toBe(1);
    const b = (await Booking.findById(req.bookingId).lean())!;
    expect(b).toMatchObject({ status: 'PAYMENT_PENDING' });
    expect(String(b.patientId)).toBe(patient.id);
    expect(await EmergencyOffer.countDocuments({ requestId: id, status: 'ACCEPTED' })).toBe(1);
    expect(
      await Notification.countDocuments({ type: 'EMERGENCY_NURSE_FOUND', recipientId: patient.id }),
    ).toBe(1);
    // payment is still required (no bypass)
    const pay = await createPayment(app, patient, String(req.bookingId));
    expect(pay.status).toBe(201);
    await succeed(app, mock, pay.body.data.id);
    expect((await Booking.findById(req.bookingId))!.status).toBe('NURSE_PENDING');
    // the patient sees the booking id
    expect((await get(patient, `/emergency-requests/${id}`)).body.data.bookingId).toBe(
      String(req.bookingId),
    );
    expect(await executeJob('emergency.sweep', {})).toMatchObject({ finalized: 0 });
  });

  it('a crash between acceptance and booking is repaired by the sweep, still with one booking', async () => {
    const { id, offer } = await offered();
    jest.spyOn(EmergencyService, 'finalizeBooking').mockResolvedValueOnce(null);
    await post(nurse.session, `/emergency-offers/${String(offer._id)}/accept`);
    jest.restoreAllMocks();
    expect((await EmergencyRequest.findById(id))!.bookingId).toBeUndefined();
    const out = await executeJob('emergency.sweep', {});
    expect(out.finalized).toBe(1);
    await executeJob('emergency.sweep', {});
    expect(await Booking.countDocuments()).toBe(1);
  });

  it('if the accepted nurse can no longer be booked, the request goes back to matching', async () => {
    const { id, offer } = await offered();
    await request(app)
      .patch(`${API}/admin/nurses/${nurse.profileId}/suspend`)
      .set(admin.auth)
      .send({ reason: 'investigation' });
    await post(nurse.session, `/emergency-offers/${String(offer._id)}/accept`);
    const r = (await EmergencyRequest.findById(id))!;
    expect(r.status).toBe('MATCHING');
    expect(r.bookingId).toBeUndefined();
    expect((await EmergencyOffer.findById(offer._id))!.status).toBe('FAILED');
    expect(await Booking.countDocuments()).toBe(0);
  });

  it('concurrent accept and decline of the same offer end in one consistent state', async () => {
    const { id, offer } = await offered();
    const [a, d] = await Promise.all([
      post(nurse.session, `/emergency-offers/${String(offer._id)}/accept`),
      post(nurse.session, `/emergency-offers/${String(offer._id)}/decline`),
    ]);
    expect([200, 409]).toContain(a.status);
    expect([200, 409]).toContain(d.status);
    expect([a.status, d.status].filter((s) => s === 200)).toHaveLength(1);
    const req = (await EmergencyRequest.findById(id))!;
    expect(['ACCEPTED', 'MATCHING']).toContain(req.status);
    expect(await EmergencyOffer.countDocuments({ requestId: id, status: 'ACCEPTED' })).toBe(
      req.status === 'ACCEPTED' ? 1 : 0,
    );
  });
});

describe('cancellation and authorization', () => {
  it('a patient cancels before a booking exists (idempotent); after that, the booking must be cancelled', async () => {
    const { id, offer } = await offered();
    const c = await post(patient, `/emergency-requests/${id}/cancel`);
    expect(c.body.data.status).toBe('CANCELLED');
    expect((await post(patient, `/emergency-requests/${id}/cancel`)).status).toBe(200);
    expect((await EmergencyOffer.findById(offer._id))!.status).toBe('CANCELLED');
    expect(
      (await post(nurse.session, `/emergency-offers/${String(offer._id)}/accept`)).status,
    ).toBe(409);
    const other = await offered(patient2);
    await post(nurse.session, `/emergency-offers/${String(other.offer._id)}/accept`);
    const late = await post(patient2, `/emergency-requests/${other.id}/cancel`);
    expect([late.status, late.body.errorCode]).toEqual([409, 'EMERGENCY_HAS_BOOKING']);
  });

  it('patients only see and cancel their own requests', async () => {
    const r = await create();
    const id = r.body.data.id as string;
    expect((await get(patient2, `/emergency-requests/${id}`)).status).toBe(404);
    expect((await post(patient2, `/emergency-requests/${id}/cancel`)).status).toBe(404);
    expect((await get(patient2, '/emergency-requests')).body.data).toHaveLength(0);
    expect((await get(nurse.session, `/emergency-requests/${id}`)).status).toBe(403);
  });

  it('admin inspects, cancels and reopens with RBAC and audit; finance approvers cannot', async () => {
    const approver = await createAdmin(app, 'FINANCE_APPROVER');
    const r = await create();
    const id = r.body.data.id as string;
    for (const who of [patient, nurse.session, approver]) {
      expect((await get(who, '/admin/emergency-requests')).status).toBe(403);
      expect(
        (await post(who, `/admin/emergency-requests/${id}/cancel`, { reason: 'because' })).status,
      ).toBe(403);
    }
    const list = await get(admin, '/admin/emergency-requests?status=PENDING');
    expect(list.body.data.meta.total).toBe(1);
    expect(list.body.data.items[0].location.address).toBe('Marina Walk, Tower 1');
    const c1 = await post(admin, `/admin/emergency-requests/${id}/cancel`, {
      reason: 'duplicate call',
    });
    const c2 = await post(admin, `/admin/emergency-requests/${id}/cancel`, {
      reason: 'duplicate call',
    });
    expect([c1.body.data.changed, c2.body.data.changed]).toEqual([true, false]);
    expect((await post(admin, `/admin/emergency-requests/${id}/reopen`)).status).toBe(409); // CANCELLED cannot be reopened
    // a failed request can be reopened for a new round
    const f = await create(patient2);
    await EmergencyService.matchNext(f.body.data.id); // offered
    await EmergencyService.fail(f.body.data.id, 'NO_NURSE_AVAILABLE');
    const re = await post(admin, `/admin/emergency-requests/${f.body.data.id}/reopen`);
    expect(re.body.data).toMatchObject({ status: 'PENDING', changed: true });
    expect(
      (await post(admin, `/admin/emergency-requests/${f.body.data.id}/reopen`)).body.data.changed,
    ).toBe(false);
    expect(await EmergencyService.matchNext(f.body.data.id)).toBe('OFFERED'); // earlier offers do not block the new round
    const detail = await get(admin, `/admin/emergency-requests/${f.body.data.id}`);
    expect(detail.body.data.offers.map((o: { round: number }) => o.round)).toEqual([1, 2]);
    const actions = (await AuditLog.find({ entity: 'EmergencyRequest' }).lean())
      .map((a) => a.action)
      .sort();
    expect(actions).toEqual(['emergency.cancelled_by_admin', 'emergency.reopened_by_admin']);
    void register;
  });
});
