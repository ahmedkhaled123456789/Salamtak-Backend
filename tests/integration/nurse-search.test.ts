import type { Express } from 'express';
import request from 'supertest';
import { resetRateLimiters } from '../../src/common/middleware/rateLimit';
import { NurseProfile } from '../../src/modules/nurses';
import {
  API,
  createAdmin,
  register,
  resetState,
  startApp,
  stopApp,
  type Session,
} from '../helpers/harness';
import { at, bookIt, mkNurse, mkService, nextWeekday, type Nurse } from '../helpers/world';

let app: Express;
let admin: Session;
let patient: Session;
let S: string; // main service
let T: string; // second service
let n1: Nurse; // Marina, female, 10y, 4.8, override 50 AED/h
let n2: Nurse; // Downtown, male, 3y, 4.2
let n3: Nurse; // Sharjah, female, 6y, 3.9, works 09-17, radius 5
let n4: Nurse; // Abu Dhabi, female, 8y, 5.0 (1 review)
let n5: Nurse; // unverified
let n6: Nurse; // only service T
let D: string;

beforeAll(async () => {
  app = await startApp();
  await resetState();
  admin = await createAdmin(app);
  patient = await register(app, 'PATIENT');
  S = await mkService(app, admin, { name: 'Home Nursing' });
  T = await mkService(app, admin, { name: 'Companion Care' });
  n1 = await mkNurse(app, admin, {
    serviceIds: [S],
    gender: 'FEMALE',
    years: 10,
    latitude: 25.08,
    longitude: 55.14,
    radiusKm: 25,
    specializations: ['elderly care'],
    languages: ['english', 'arabic'],
    hourlyRateMinor: 5000,
  });
  n2 = await mkNurse(app, admin, {
    serviceIds: [S],
    gender: 'MALE',
    years: 3,
    latitude: 25.19,
    longitude: 55.27,
    radiusKm: 20,
    specializations: ['post surgery'],
    languages: ['english', 'hindi'],
  });
  n3 = await mkNurse(app, admin, {
    serviceIds: [S, T],
    specializations: ['general'],
    languages: ['english'],
    gender: 'FEMALE',
    years: 6,
    latitude: 25.34,
    longitude: 55.41,
    radiusKm: 5,
    hours: ['09:00', '17:00'],
  });
  n4 = await mkNurse(app, admin, {
    serviceIds: [S],
    specializations: ['general'],
    languages: ['english'],
    gender: 'FEMALE',
    years: 8,
    latitude: 24.45,
    longitude: 54.38,
    radiusKm: 30,
  });
  n5 = await mkNurse(app, admin, { serviceIds: [S], verify: false });
  n6 = await mkNurse(app, admin, {
    serviceIds: [T],
    specializations: ['general'],
    languages: ['english'],
    gender: 'MALE',
    years: 1,
    latitude: 25.2,
    longitude: 55.3,
  });
  for (const [n, rating, reviews] of [
    [n1, 4.8, 50],
    [n2, 4.2, 10],
    [n3, 3.9, 4],
    [n4, 5.0, 1],
  ] as const) {
    await NurseProfile.updateOne(
      { _id: n.profileId },
      { averageRating: rating, totalReviews: reviews },
    );
  }
  D = nextWeekday(2);
});
afterAll(stopApp);
beforeEach(() => resetRateLimiters());

const search = (qs = '', who: Session = patient) =>
  request(app)
    .get(`${API}/nurses${qs ? `?${qs}` : ''}`)
    .set(who.auth);
const ids = (res: request.Response) =>
  res.body.data.items.map((i: { id: string }) => i.id) as string[];
const sorted = (a: string[]) => [...a].sort();
const near = 'lat=25.2&lng=55.27';

describe('eligibility', () => {
  it('only ACTIVE + VERIFIED nurses are ever returned', async () => {
    const res = await search();
    expect(res.status).toBe(200);
    const got = ids(res);
    expect(got).not.toContain(n5.profileId);
    expect(sorted(got)).toEqual(sorted([n1, n2, n3, n4, n6].map((n) => n.profileId)));
  });

  it('requires authentication and the search permission (nurses cannot search)', async () => {
    expect((await request(app).get(`${API}/nurses`)).status).toBe(401);
    expect((await search('', n1.session)).status).toBe(403);
    expect((await search('', admin)).status).toBe(200);
  });
});

describe('filters', () => {
  it('service: only nurses offering it', async () => {
    expect(sorted(ids(await search(`serviceId=${S}`)))).toEqual(
      sorted([n1, n2, n3, n4].map((n) => n.profileId)),
    );
    expect(sorted(ids(await search(`serviceId=${T}`)))).toEqual(
      sorted([n3, n6].map((n) => n.profileId)),
    );
  });

  it('unknown / inactive service', async () => {
    expect((await search('serviceId=64b7f0f0f0f0f0f0f0f0f0f0')).status).toBe(404);
    expect((await search('serviceId=not-an-id')).status).toBe(400);
  });

  it('gender', async () => {
    expect(sorted(ids(await search('gender=MALE')))).toEqual(
      sorted([n2, n6].map((n) => n.profileId)),
    );
    expect(ids(await search(`serviceId=${S}&gender=MALE`))).toEqual([n2.profileId]);
    expect((await search('gender=ROBOT')).status).toBe(400);
  });

  it('experience, rating, language, specialization', async () => {
    expect(sorted(ids(await search('minExperience=7')))).toEqual(
      sorted([n1, n4].map((n) => n.profileId)),
    );
    expect(sorted(ids(await search('minRating=4.5')))).toEqual(
      sorted([n1, n4].map((n) => n.profileId)),
    );
    expect(ids(await search('language=hindi'))).toEqual([n2.profileId]);
    expect(sorted(ids(await search('language=hindi,arabic')))).toEqual(
      sorted([n1, n2].map((n) => n.profileId)),
    );
    expect(ids(await search('specialization=post%20surgery'))).toEqual([n2.profileId]);
    expect(ids(await search('specialization=elderly%20care'))).toEqual([n1.profileId]);
  });

  it('price (per billing unit, honours nurse overrides) and its guards', async () => {
    expect(ids(await search(`serviceId=${S}&minPrice=4500`))).toEqual([n1.profileId]);
    expect(sorted(ids(await search(`serviceId=${S}&maxPrice=4500`)))).toEqual(
      sorted([n2, n3, n4].map((n) => n.profileId)),
    );
    expect((await search('minPrice=100')).body.errorCode).toBe('FILTER_REQUIRES_SERVICE');
    expect((await search(`serviceId=${S}&minPrice=5000&maxPrice=100`)).body.errorCode).toBe(
      'INVALID_PRICE_RANGE',
    );
    const card = (await search(`serviceId=${S}`)).body.data.items.find(
      (i: { id: string }) => i.id === n1.profileId,
    );
    expect(card.price).toEqual({ unit: 'HOURLY', unitAmountMinor: 5000, currency: 'AED' });
  });
});

describe('geospatial search (2dsphere $geoNear)', () => {
  it('defaults to nurses whose own service radius covers the patient', async () => {
    const got = ids(await search(`serviceId=${S}&${near}`));
    // Downtown patient: n2 (~1km), n1 (~17km, radius 25). n3 (Sharjah ~21km, radius 5) and n4 (Abu Dhabi ~130km) cannot reach.
    expect(sorted(got)).toEqual(sorted([n1, n2].map((n) => n.profileId)));
  });

  it('maxDistanceKm narrows further; withinNurseRadius=false widens', async () => {
    expect(ids(await search(`serviceId=${S}&${near}&maxDistanceKm=10`))).toEqual([n2.profileId]);
    const wide = await search(`serviceId=${S}&${near}&withinNurseRadius=false`);
    expect(sorted(ids(wide))).toEqual(sorted([n1, n2, n3, n4].map((n) => n.profileId)));
    const far = await search(`serviceId=${S}&${near}&withinNurseRadius=false&maxDistanceKm=40`);
    expect(sorted(ids(far))).toEqual(sorted([n1, n2, n3].map((n) => n.profileId)));
  });

  it('returns distance (km, rounded) and never exact coordinates or contact data', async () => {
    const res = await search(`serviceId=${S}&${near}&sort=distance`);
    const first = res.body.data.items[0];
    expect(first.id).toBe(n2.profileId);
    expect(first.distanceKm).toBeGreaterThan(0);
    expect(first.distanceKm).toBeLessThan(3);
    expect(JSON.stringify(res.body)).not.toMatch(
      /coordinates|latitude|longitude|email|phone|passwordHash/i,
    );
  });

  it('sort=distance orders nearest first; lat/lng must come together', async () => {
    const res = await search(`${near}&withinNurseRadius=false&sort=distance`);
    const d = res.body.data.items.map((i: { distanceKm: number }) => i.distanceKm);
    expect([...d].sort((a, b) => a - b)).toEqual(d);
    expect((await search('sort=distance')).body.errorCode).toBe('SORT_REQUIRES_LOCATION');
    expect((await search('lat=25.2')).status).toBe(400);
    expect((await search('lat=95&lng=55')).status).toBe(400);
  });
});

describe('availability filter', () => {
  const win = (from: string, to: string) =>
    `startDateTime=${encodeURIComponent(at(D, from).toISOString())}&endDateTime=${encodeURIComponent(at(D, to).toISOString())}`;

  it('excludes nurses outside working hours (n3 works 09-17)', async () => {
    const evening = ids(await search(`serviceId=${S}&${win('18:00', '20:00')}`));
    expect(evening).not.toContain(n3.profileId);
    expect(sorted(evening)).toEqual(sorted([n1, n2, n4].map((n) => n.profileId)));
    const day = ids(await search(`serviceId=${S}&${win('10:00', '12:00')}`));
    expect(sorted(day)).toEqual(sorted([n1, n2, n3, n4].map((n) => n.profileId)));
    expect(ids(await search(`serviceId=${S}&${win('16:00', '18:00')}`))).not.toContain(
      n3.profileId,
    ); // straddles closing
  });

  it('requires both ends and a sane range', async () => {
    expect(
      (await search(`startDateTime=${encodeURIComponent(at(D, '10:00').toISOString())}`)).status,
    ).toBe(400);
    expect((await search(`${win('12:00', '10:00')}`)).body.errorCode).toBe('INVALID_TIME_RANGE');
  });

  it('marks results as available', async () => {
    const res = await search(`serviceId=${S}&${win('10:00', '12:00')}`);
    expect(res.body.data.items.every((i: { available: boolean }) => i.available === true)).toBe(
      true,
    );
  });
});

describe('sorting and pagination', () => {
  it('sort=rating (desc)', async () => {
    const res = await search('sort=rating');
    const r = res.body.data.items.map((i: { averageRating: number }) => i.averageRating);
    expect([...r].sort((a, b) => b - a)).toEqual(r);
    expect(res.body.data.items[0].id).toBe(n4.profileId);
  });

  it('sort=experience (desc)', async () => {
    const y = (await search('sort=experience')).body.data.items.map(
      (i: { yearsOfExperience: number }) => i.yearsOfExperience,
    );
    expect([...y].sort((a, b) => b - a)).toEqual(y);
    expect(y[0]).toBe(10);
  });

  it('sort=price (asc) needs a service; nurse with the override is priciest', async () => {
    expect((await search('sort=price')).body.errorCode).toBe('SORT_REQUIRES_SERVICE');
    const res = await search(`serviceId=${S}&sort=price`);
    const p = res.body.data.items.map(
      (i: { price: { unitAmountMinor: number } }) => i.price.unitAmountMinor,
    );
    expect([...p].sort((a, b) => a - b)).toEqual(p);
    expect(res.body.data.items.at(-1).id).toBe(n1.profileId);
  });

  it('paginates with consistent meta and no overlap between pages', async () => {
    const p1 = await search('sort=rating&page=1&limit=2');
    const p2 = await search('sort=rating&page=2&limit=2');
    const p3 = await search('sort=rating&page=3&limit=2');
    expect(p1.body.data.meta).toEqual({ page: 1, limit: 2, total: 5, totalPages: 3 });
    expect(p1.body.data.items).toHaveLength(2);
    expect(p2.body.data.items).toHaveLength(2);
    expect(p3.body.data.items).toHaveLength(1);
    expect(new Set([...ids(p1), ...ids(p2), ...ids(p3)]).size).toBe(5);
    expect((await search('page=0')).status).toBe(400);
    expect((await search('limit=101')).status).toBe(400);
    expect((await search('page=9&limit=2')).body.data.items).toHaveLength(0);
  });

  it('rejects unknown query parameters and sorts', async () => {
    expect((await search('sort=magic')).status).toBe(400);
    expect((await search('verified=false')).status).toBe(400);
  });
});

describe('relevance ranking (rule-based matching)', () => {
  it('returns 0-100 integer scores in descending order', async () => {
    const res = await search(`serviceId=${S}&${near}&withinNurseRadius=false&sort=relevance`);
    const scores = res.body.data.items.map((i: { matchScore: number }) => i.matchScore);
    expect(scores.every((s: number) => Number.isInteger(s) && s >= 0 && s <= 100)).toBe(true);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(res.body.data.truncated).toBe(false);
  });

  it('is the default sort, and non-relevance sorts do not return a score', async () => {
    expect((await search(`serviceId=${S}`)).body.data.items[0].matchScore).not.toBeNull();
    expect((await search(`serviceId=${S}&sort=rating`)).body.data.items[0].matchScore).toBeNull();
  });

  it('a nearer, well-reviewed, experienced nurse outranks a distant, unproven one', async () => {
    const res = await search(`serviceId=${S}&${near}&withinNurseRadius=false`);
    const order = ids(res);
    expect(order.indexOf(n1.profileId)).toBeLessThan(order.indexOf(n4.profileId)); // 4.8*50 reviews vs 5.0*1 review, far away
    expect(order.indexOf(n2.profileId)).toBeLessThan(order.indexOf(n4.profileId));
  });

  it('specialization match lifts the matching nurse', async () => {
    const res = await search(
      `serviceId=${S}&${near}&withinNurseRadius=false&specialization=post%20surgery,elderly%20care`,
    );
    // the filter is "any match": only n1 and n2 have those specializations
    expect(sorted(ids(res))).toEqual(sorted([n1, n2].map((n) => n.profileId)));
  });
});

describe('nurse public profile', () => {
  it('shows offered services with effective prices and no private data', async () => {
    const res = await request(app).get(`${API}/nurses/${n1.profileId}`).set(patient.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: n1.profileId,
      yearsOfExperience: 10,
      averageRating: 4.8,
      isBookable: true,
    });
    expect(res.body.data.services).toEqual([
      expect.objectContaining({
        serviceId: S,
        billingUnit: 'HOURLY',
        unitAmountMinor: 5000,
        currency: 'AED',
      }),
    ]);
    expect(res.body.data.displayName).toMatch(/^Test N\.$/);
    expect(JSON.stringify(res.body)).not.toMatch(/email|phone|coordinates|userId|passwordHash/i);
  });

  it('non-bookable nurses are invisible to patients, visible to admins', async () => {
    expect((await request(app).get(`${API}/nurses/${n5.profileId}`).set(patient.auth)).status).toBe(
      404,
    );
    expect((await request(app).get(`${API}/nurses/${n5.profileId}`).set(admin.auth)).status).toBe(
      200,
    );
    expect(
      (await request(app).get(`${API}/nurses/64b7f0f0f0f0f0f0f0f0f0f0`).set(patient.auth)).status,
    ).toBe(404);
    expect((await request(app).get(`${API}/nurses/xyz`).set(patient.auth)).status).toBe(400);
  });

  it('/nurses/me is not shadowed by /nurses/:id', async () => {
    expect((await request(app).get(`${API}/nurses/me`).set(n1.session.auth)).body.data.userId).toBe(
      n1.session.id,
    );
  });
});

// Mutations last: they change who is searchable.
describe('dynamic eligibility', () => {
  it('a booked time range removes the nurse from availability searches; other times stay', async () => {
    const win = (from: string, to: string) =>
      `startDateTime=${encodeURIComponent(at(D, from).toISOString())}&endDateTime=${encodeURIComponent(at(D, to).toISOString())}`;
    const b = await bookIt(app, patient, {
      serviceId: S,
      nurseId: n2.profileId,
      start: at(D, '10:00'),
      end: at(D, '12:00'),
    });
    expect(b.booking.status).toBe(201);
    expect(ids(await search(`serviceId=${S}&${win('11:00', '13:00')}`))).not.toContain(
      n2.profileId,
    );
    expect(ids(await search(`serviceId=${S}&${win('12:00', '14:00')}`))).toContain(n2.profileId); // back-to-back is free
    expect(ids(await search(`serviceId=${S}&${win('08:00', '10:00')}`))).toContain(n2.profileId);
  });

  it('pausing or suspending removes a nurse from search immediately', async () => {
    await request(app)
      .patch(`${API}/nurses/me/status`)
      .set(n1.session.auth)
      .send({ status: 'INACTIVE' });
    expect(ids(await search(`serviceId=${S}`))).not.toContain(n1.profileId);
    await request(app)
      .patch(`${API}/nurses/me/status`)
      .set(n1.session.auth)
      .send({ status: 'ACTIVE' });
    expect(ids(await search(`serviceId=${S}`))).toContain(n1.profileId);
    await request(app)
      .patch(`${API}/admin/nurses/${n4.profileId}/suspend`)
      .set(admin.auth)
      .send({ reason: 'investigation' });
    expect(ids(await search(`serviceId=${S}`))).not.toContain(n4.profileId);
  });

  it('a deactivated service cannot be searched', async () => {
    await request(app).patch(`${API}/admin/services/${T}/deactivate`).set(admin.auth);
    const res = await search(`serviceId=${T}`);
    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('SERVICE_INACTIVE');
  });
});
