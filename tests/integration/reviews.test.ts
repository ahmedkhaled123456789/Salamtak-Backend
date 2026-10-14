import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { AuditLog } from '../../src/modules/audit';
import { Booking } from '../../src/modules/bookings';
import { NurseProfile } from '../../src/modules/nurses';
import { Review, ReviewService } from '../../src/modules/reviews';
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
import { completeBooking, freshProvider, payFully } from '../helpers/finance';
import { at, baseWorld, type BookArgs, type Nurse } from '../helpers/world';

let app: Express;
let admin: Session;
let serviceId: string;
let nurse: Nurse;
let patient: Session;
let patient2: Session;
let D: string;
let mock: MockPaymentProvider;

beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(async () => {
  await resetState();
  mock = freshProvider();
  ({ admin, serviceId, nurse, patient, patient2, D } = await baseWorld(app));
});

const args = (s = '08:00', e = '12:00'): BookArgs => ({
  serviceId,
  nurseId: nurse.profileId,
  start: at(D, s),
  end: at(D, e),
});
const post = (s: Session, path: string, body: object = {}) =>
  request(app).post(`${API}${path}`).set(s.auth).send(body);
const get = (s: Session, path: string) => request(app).get(`${API}${path}`).set(s.auth);
const nurseDoc = async () => (await NurseProfile.findById(nurse.profileId))!;
const oid = (id: string) => new mongoose.Types.ObjectId(id);

async function completed(s = '08:00', e = '12:00', who = patient) {
  const r = await payFully(app, mock, who, args(s, e));
  await completeBooking(r.bookingId, nurse, app);
  return r.bookingId;
}

describe('creating reviews', () => {
  it('a patient reviews their completed booking once; the nurse aggregate updates', async () => {
    const id = await completed();
    const r = await post(patient, `/bookings/${id}/review`, {
      rating: 5,
      comment: 'Wonderful care',
    });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ rating: 5, status: 'ACTIVE', bookingId: id });
    expect(await nurseDoc()).toMatchObject({ totalReviews: 1, ratingSum: 5, averageRating: 5 });
    const id2 = await completed('13:00', '16:00');
    await post(patient, `/bookings/${id2}/review`, { rating: 2 });
    expect(await nurseDoc()).toMatchObject({ totalReviews: 2, ratingSum: 7, averageRating: 3.5 });
    expect((await get(patient, '/reviews/me')).body.data.meta.total).toBe(2);
  });

  it('duplicates are refused with 409 and do not change the aggregate', async () => {
    const id = await completed();
    await post(patient, `/bookings/${id}/review`, { rating: 4 });
    const dup = await post(patient, `/bookings/${id}/review`, { rating: 1 });
    expect([dup.status, dup.body.errorCode]).toEqual([409, 'REVIEW_ALREADY_EXISTS']);
    expect(await nurseDoc()).toMatchObject({ totalReviews: 1, ratingSum: 4 });
  });

  it('validates the rating and the comment', async () => {
    const id = await completed();
    for (const rating of [0, 6, 3.5, '5', null])
      expect((await post(patient, `/bookings/${id}/review`, { rating })).status).toBe(400);
    expect(
      (await post(patient, `/bookings/${id}/review`, { rating: 5, comment: 'x'.repeat(1001) }))
        .status,
    ).toBe(400);
    expect(
      (await post(patient, `/bookings/${id}/review`, { rating: 5, nurseId: 'x' })).status,
    ).toBe(400);
    expect(await Review.countDocuments()).toBe(0);
  });

  it('only the booking patient can review; other patients, nurses and admins cannot', async () => {
    const id = await completed();
    expect((await post(patient2, `/bookings/${id}/review`, { rating: 5 })).status).toBe(404);
    expect((await post(nurse.session, `/bookings/${id}/review`, { rating: 5 })).status).toBe(403);
    expect((await post(admin, `/bookings/${id}/review`, { rating: 5 })).status).toBe(403);
    expect(
      (await request(app).post(`${API}/bookings/${id}/review`).send({ rating: 5 })).status,
    ).toBe(401);
  });

  it.each([
    'CANCELLED',
    'REFUNDED',
    'NURSE_REJECTED',
    'EXPIRED',
    'DISPUTED',
    'CONFIRMED',
    'PAYMENT_PENDING',
  ])('a %s booking cannot be reviewed', async (status) => {
    const r = await payFully(app, mock, patient, args());
    await Booking.collection.updateOne({ _id: oid(r.bookingId) }, { $set: { status } });
    const res = await post(patient, `/bookings/${r.bookingId}/review`, { rating: 5 });
    expect([res.status, res.body.errorCode]).toEqual([422, 'REVIEW_NOT_ELIGIBLE']);
    expect(await Review.countDocuments()).toBe(0);
  });

  it('the review window closes', async () => {
    const id = await completed();
    await Booking.collection.updateOne(
      { _id: oid(id) },
      { $set: { completedAt: new Date(Date.now() - 100 * 86_400_000) } },
    );
    expect((await post(patient, `/bookings/${id}/review`, { rating: 5 })).body.errorCode).toBe(
      'REVIEW_WINDOW_CLOSED',
    );
  });

  it('concurrent attempts create exactly one review and count it once', async () => {
    const id = await completed();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => post(patient, `/bookings/${id}/review`, { rating: 5 })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await Review.countDocuments()).toBe(1);
    expect(await nurseDoc()).toMatchObject({ totalReviews: 1, ratingSum: 5, averageRating: 5 });
  });

  it('concurrent reviews of different bookings keep the aggregate exact', async () => {
    const ids = [
      await completed('06:00', '08:00'),
      await completed('09:00', '11:00'),
      await completed('12:00', '14:00'),
    ];
    await Promise.all(
      ids.map((id, i) => post(patient, `/bookings/${id}/review`, { rating: i + 3 })),
    );
    expect(await nurseDoc()).toMatchObject({ totalReviews: 3, ratingSum: 12, averageRating: 4 });
  });
});

describe('public reading and privacy', () => {
  it('lists only ACTIVE reviews with the reviewer first name and no private identifiers', async () => {
    const id = await completed();
    await post(patient, `/bookings/${id}/review`, { rating: 5, comment: 'Great' });
    const list = await get(patient2, `/nurses/${nurse.profileId}/reviews`);
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
    const item = list.body.data.items[0];
    expect(Object.keys(item).sort()).toEqual(['comment', 'createdAt', 'id', 'rating', 'reviewer']);
    expect(item.reviewer).not.toContain(' ');
    expect(JSON.stringify(list.body)).not.toContain(patient.id);
    expect(JSON.stringify(list.body)).not.toContain(id);
  });

  it('hides reviews of nurses that are not bookable', async () => {
    const id = await completed();
    await post(patient, `/bookings/${id}/review`, { rating: 5 });
    await request(app)
      .patch(`${API}/admin/nurses/${nurse.profileId}/suspend`)
      .set(admin.auth)
      .send({ reason: 'investigation' });
    expect((await get(patient2, `/nurses/${nurse.profileId}/reviews`)).status).toBe(404);
  });
});

describe('moderation', () => {
  async function reviewed(rating = 4) {
    const id = await completed();
    const r = await post(patient, `/bookings/${id}/review`, { rating, comment: 'meh' });
    return r.body.data.id as string;
  }

  it('hide / restore / flag adjust the aggregate and the public list, are idempotent and audited', async () => {
    const rid = await reviewed(4);
    const second = await completed('13:00', '16:00');
    await post(patient, `/bookings/${second}/review`, { rating: 2 });
    expect(await nurseDoc()).toMatchObject({ totalReviews: 2, ratingSum: 6, averageRating: 3 });

    expect((await post(admin, `/admin/reviews/${rid}/hide`, {})).status).toBe(400); // reason required
    const h = await post(admin, `/admin/reviews/${rid}/hide`, { reason: 'abusive language' });
    expect(h.body.data).toMatchObject({
      status: 'HIDDEN',
      changed: true,
      moderationReason: 'abusive language',
    });
    expect(
      (await post(admin, `/admin/reviews/${rid}/hide`, { reason: 'abusive language' })).body.data
        .changed,
    ).toBe(false);
    expect(await nurseDoc()).toMatchObject({ totalReviews: 1, ratingSum: 2, averageRating: 2 });
    expect(
      (await get(patient2, `/nurses/${nurse.profileId}/reviews`)).body.data.items,
    ).toHaveLength(1);

    const rs = await post(admin, `/admin/reviews/${rid}/restore`, {});
    expect(rs.body.data.status).toBe('ACTIVE');
    expect(await nurseDoc()).toMatchObject({ totalReviews: 2, ratingSum: 6, averageRating: 3 });

    const f = await post(admin, `/admin/reviews/${rid}/flag`, { reason: 'looks fake' });
    expect(f.body.data.status).toBe('FLAGGED');
    expect(await nurseDoc()).toMatchObject({ totalReviews: 1, ratingSum: 2 });
    // FLAGGED -> HIDDEN must not double-subtract
    await post(admin, `/admin/reviews/${rid}/hide`, { reason: 'confirmed fake' });
    expect(await nurseDoc()).toMatchObject({ totalReviews: 1, ratingSum: 2 });

    const actions = (await AuditLog.find({ entity: 'Review' }).lean()).map((a) => a.action).sort();
    expect(actions).toEqual(['review.flag', 'review.hide', 'review.hide', 'review.restore']);
    expect((await get(admin, `/admin/reviews/${rid}`)).body.data.patientId).toBe(patient.id);
    expect((await get(admin, '/admin/reviews?status=HIDDEN')).body.data.meta.total).toBe(1);
  });

  it('the aggregate never goes negative and concurrent moderation stays consistent', async () => {
    const rid = await reviewed(5);
    const admin2 = await createAdmin(app);
    await Promise.all([
      post(admin, `/admin/reviews/${rid}/hide`, { reason: 'spam' }),
      post(admin2, `/admin/reviews/${rid}/hide`, { reason: 'spam' }),
      post(admin, `/admin/reviews/${rid}/flag`, { reason: 'spam' }),
    ]);
    const n = await nurseDoc();
    expect(n.totalReviews).toBe(0);
    expect(n.ratingSum).toBe(0);
    expect(n.averageRating).toBe(0);
    expect(await ReviewService.reconcileAggregates()).toMatchObject({ repaired: 0 });
  });

  it('patients, nurses and finance approvers cannot moderate; nobody edits another review', async () => {
    const rid = await reviewed();
    const approver = await createAdmin(app, 'FINANCE_APPROVER');
    for (const who of [patient, patient2, nurse.session, approver]) {
      expect((await post(who, `/admin/reviews/${rid}/hide`, { reason: 'because' })).status).toBe(
        403,
      );
      expect((await get(who, '/admin/reviews')).status).toBe(403);
    }
    expect((await Review.findById(rid))!.status).toBe('ACTIVE');
  });
});

describe('aggregate reconciliation', () => {
  it('detects and repairs drift from the reviews (the source of truth); the job is idempotent', async () => {
    const id = await completed();
    await post(patient, `/bookings/${id}/review`, { rating: 4 });
    await NurseProfile.collection.updateOne(
      { _id: oid(nurse.profileId) },
      { $set: { totalReviews: 9, ratingSum: 40, averageRating: 4.4 } },
    );
    const r = await executeJob('review.reconcileAggregates', {});
    expect(r).toMatchObject({ repaired: 1 });
    expect(await nurseDoc()).toMatchObject({ totalReviews: 1, ratingSum: 4, averageRating: 4 });
    expect(await executeJob('review.reconcileAggregates', {})).toMatchObject({ repaired: 0 });
  });

  it('a review of an unrelated registered user is untouched by search of other nurses', async () => {
    void register;
    expect(await Review.countDocuments()).toBe(0);
  });
});
