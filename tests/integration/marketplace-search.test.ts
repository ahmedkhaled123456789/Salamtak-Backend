import type { Express } from 'express';
import request from 'supertest';
import { Coupon } from '../../src/modules/coupons';
import { NurseProfile } from '../../src/modules/nurses';
import { NurseDocument } from '../../src/modules/nurse-verification';
import { Review } from '../../src/modules/reviews';
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
import { completeBooking, freshProvider, payFully } from '../helpers/finance';
import { at, baseWorld, mkNurse, type BookArgs, type Nurse } from '../helpers/world';

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

const get = (s: Session, path: string) => request(app).get(`${API}${path}`).set(s.auth);
const post = (s: Session, path: string, body: object = {}) =>
  request(app).post(`${API}${path}`).set(s.auth).send(body);
const ids = (r: { body: { data: { items: { id: string }[] } } }) =>
  r.body.data.items.map((i) => i.id);
const args = (n: Nurse, s = '08:00', e = '12:00'): BookArgs => ({
  serviceId,
  nurseId: n.profileId,
  start: at(D, s),
  end: at(D, e),
});

async function rated(n: Nurse, rating: number, slot: [string, string]) {
  const r = await payFully(app, mock, patient, args(n, ...slot));
  await completeBooking(r.bookingId, n, app);
  const res = await post(patient, `/bookings/${r.bookingId}/review`, { rating });
  expect(res.status).toBe(201);
}

describe('search only returns bookable nurses and never leaks private data', () => {
  it('excludes unverified, rejected, expired and suspended nurses', async () => {
    const pending = await mkNurse(app, admin, { serviceIds: [serviceId], verify: false });
    const suspended = await mkNurse(app, admin, { serviceIds: [serviceId] });
    await request(app)
      .patch(`${API}/admin/nurses/${suspended.profileId}/suspend`)
      .set(admin.auth)
      .send({ reason: 'check' });
    const expired = await mkNurse(app, admin, { serviceIds: [serviceId] });
    await NurseProfile.collection.updateOne(
      { _id: new NurseProfile.base.Types.ObjectId(expired.profileId) },
      { $set: { verificationStatus: 'EXPIRED', isBookable: false } },
    );
    const found = ids(await get(patient, `/nurses?serviceId=${serviceId}`));
    expect(found).toEqual([nurse.profileId]);
    for (const n of [pending, suspended, expired]) {
      expect((await get(patient, `/nurses/${n.profileId}`)).status).toBe(404);
      expect((await get(patient, `/nurses/${n.profileId}/reviews`)).status).toBe(404);
    }
  });

  it('exposes no verification notes, documents, contact or internal admin data in search or profile', async () => {
    await NurseProfile.updateOne(
      { _id: nurse.profileId },
      { $set: { statusReason: 'INTERNAL-NOTE-XYZ' } },
    );
    const search = await get(patient, `/nurses?serviceId=${serviceId}&lat=25.2&lng=55.27`);
    const profile = await get(patient, `/nurses/${nurse.profileId}`);
    for (const body of [search.body, profile.body]) {
      const blob = JSON.stringify(body);
      expect(blob).not.toMatch(
        /INTERNAL-NOTE|statusReason|verificationStatus|documentNumber|storageKey|fileId|email|phone|passwordHash|userId|bookingSeq|ratingSum/,
      );
    }
    const card = search.body.data.items[0];
    expect(Object.keys(card).sort()).toEqual(
      [
        'available',
        'averageRating',
        'bio',
        'city',
        'dailyRateMinor', // the nurse's published daily rate (public catalogue)
        'displayName',
        'distanceKm',
        'gender',
        'id',
        'imageUrl', // public photo URL only; never a storage key or file id
        'languages',
        'matchScore',
        'price',
        'serviceIds',
        'serviceRadiusKm',
        'specializations',
        'totalCompletedBookings',
        'totalReviews',
        'yearsOfExperience',
      ].sort(),
    );
    expect(card.displayName).toMatch(/^\S+ \S\.$/); // first name + initial only
  });

  it('a nurse whose required credential lapses disappears from search immediately', async () => {
    const lic = await NurseDocument.create({
      nurseId: nurse.profileId,
      type: 'NURSING_LICENSE',
      fileId: new NurseProfile.base.Types.ObjectId(),
      status: 'VERIFIED',
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(ids(await get(patient, `/nurses?serviceId=${serviceId}`))).toContain(nurse.profileId);
    const { VerificationService } = await import('../../src/modules/nurse-verification');
    await VerificationService.expireDue();
    expect(lic.status).toBe('VERIFIED');
    expect(ids(await get(patient, `/nurses?serviceId=${serviceId}`))).not.toContain(
      nurse.profileId,
    );
  });
});

describe('filters, sorting and ratings driven by real reviews', () => {
  it('minRating / sort=rating use the review-maintained aggregate; moderation changes the result', async () => {
    const other = await mkNurse(app, admin, { serviceIds: [serviceId], years: 12 });
    await rated(nurse, 5, ['06:00', '08:00']);
    await rated(other, 2, ['09:00', '11:00']);
    const q = `/nurses?serviceId=${serviceId}`;
    expect(ids(await get(patient, `${q}&minRating=4`))).toEqual([nurse.profileId]);
    expect(ids(await get(patient, `${q}&sort=rating`))).toEqual([nurse.profileId, other.profileId]);
    expect(ids(await get(patient, `${q}&minExperience=10`))).toEqual([other.profileId]);
    // hiding the 5-star review drops that nurse out of the rating filter
    const review = (await Review.findOne({ nurseId: nurse.profileId }))!;
    await post(admin, `/admin/reviews/${String(review._id)}/hide`, { reason: 'abusive' });
    expect(ids(await get(patient, `${q}&minRating=4`))).toEqual([]);
    const profile = await get(patient, `/nurses/${nurse.profileId}`);
    expect(profile.body.data).toMatchObject({ averageRating: 0, totalReviews: 0 });
  });

  it('language, specialization, gender, pagination and distance work together', async () => {
    const male = await mkNurse(app, admin, {
      serviceIds: [serviceId],
      gender: 'MALE',
      languages: ['hindi'],
      specializations: ['wound care'],
      latitude: 25.6,
      longitude: 55.6,
      radiusKm: 100,
    });
    const base = `/nurses?serviceId=${serviceId}`;
    expect(ids(await get(patient, `${base}&gender=MALE`))).toEqual([male.profileId]);
    expect(ids(await get(patient, `${base}&language=hindi`))).toEqual([male.profileId]);
    expect(ids(await get(patient, `${base}&specialization=wound%20care`))).toEqual([
      male.profileId,
    ]);
    const near = ids(
      await get(patient, `${base}&lat=25.2&lng=55.27&maxDistanceKm=10&sort=distance`),
    );
    expect(near).toEqual([nurse.profileId]);
    const p1 = await get(patient, `${base}&limit=1&page=1`);
    const p2 = await get(patient, `${base}&limit=1&page=2`);
    expect(p1.body.data.meta).toMatchObject({ total: 2, totalPages: 2 });
    expect(new Set([...ids(p1), ...ids(p2)]).size).toBe(2);
  });

  it('availability filter excludes nurses that are booked for the window', async () => {
    await payFully(app, mock, patient, args(nurse));
    const free = await mkNurse(app, admin, { serviceIds: [serviceId] });
    const q = `/nurses?serviceId=${serviceId}&startDateTime=${encodeURIComponent(at(D, '08:00').toISOString())}&endDateTime=${encodeURIComponent(at(D, '12:00').toISOString())}`;
    expect(ids(await get(patient, q))).toEqual([free.profileId]);
  });
});

describe('index usage', () => {
  it('the main search paths are served by indexes (explain plan)', async () => {
    const hasIxscan = (plan: unknown): boolean => JSON.stringify(plan).includes('IXSCAN');
    const exp = await NurseProfile.find({ isBookable: true, averageRating: { $gte: 4 } })
      .sort({ averageRating: -1 })
      .explain('queryPlanner');
    expect(hasIxscan(exp)).toBe(true);
    expect(JSON.stringify(exp)).not.toContain('COLLSCAN');
    const geo = await NurseProfile.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [55.27, 25.2] },
          distanceField: 'd',
          spherical: true,
          query: { isBookable: true },
        },
      },
    ]).explain('queryPlanner');
    expect(JSON.stringify(geo)).toContain('2dsphere');
    const coupon = await Coupon.find({ code: 'X' }).explain('queryPlanner');
    expect(hasIxscan(coupon)).toBe(true);
  });
});

describe('marketplace report', () => {
  it('returns aggregate counts for admins only (no personal data)', async () => {
    await rated(nurse, 4, ['06:00', '08:00']);
    const rep = await get(admin, '/admin/reports/marketplace');
    expect(rep.status).toBe(200);
    expect(rep.body.data).toMatchObject({
      nursesByVerification: { VERIFIED: 1 },
      reviewsByStatus: { ACTIVE: 1 },
      averageRatingActive: 4,
    });
    expect(JSON.stringify(rep.body)).not.toContain(patient.id);
    const approver = await createAdmin(app, 'FINANCE_APPROVER');
    for (const who of [patient, nurse.session, approver])
      expect((await get(who, '/admin/reports/marketplace')).status).toBe(403);
    void register;
  });
});
