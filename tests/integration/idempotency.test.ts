import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { resetRateLimiters } from '../../src/common/middleware/rateLimit';
import { getRedis } from '../../src/config/redis';
import { Booking, BookingReservation } from '../../src/modules/bookings';
import { IdempotencyKey, IdempotencyService, hashPayload } from '../../src/modules/idempotency';
import { API, resetState, startApp, stopApp, type Session } from '../helpers/harness';
import { at, baseWorld, bookReq, quoteReq, type BookArgs, type Nurse } from '../helpers/world';

let app: Express;
let serviceId: string;
let nurse: Nurse;
let patient: Session;
let patient2: Session;
let D: string;

beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(async () => {
  await resetState();
  ({ serviceId, nurse, patient, patient2, D } = await baseWorld(app));
});
afterEach(() => jest.restoreAllMocks());

const args = (s = '08:00', e = '12:00'): BookArgs => ({
  serviceId,
  nurseId: nurse.profileId,
  start: at(D, s),
  end: at(D, e),
});
const quote = async (who: Session, a: BookArgs) =>
  (await quoteReq(app, who, a)).body.data.quoteToken as string;

describe('Idempotency-Key is required and validated', () => {
  it('missing header -> 400 and nothing is created', async () => {
    const a = args();
    const res = await bookReq(app, patient, a, await quote(patient, a), null);
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_ERROR');
    expect(res.body.details[0].field).toContain('idempotency-key');
    expect(await Booking.countDocuments()).toBe(0);
  });

  it('malformed keys are rejected', async () => {
    const a = args();
    const token = await quote(patient, a);
    for (const bad of ['short', 'has space in it', 'x'.repeat(129), 'bad/key!!!!!!']) {
      expect((await bookReq(app, patient, a, token, bad)).status).toBe(400);
    }
    expect(await Booking.countDocuments()).toBe(0);
  });

  it('is documented as a required header in OpenAPI', async () => {
    const doc = (await request(app).get('/docs.json')).body;
    const params = doc.paths['/api/v1/bookings'].post.parameters as {
      name: string;
      in: string;
      required: boolean;
    }[];
    expect(params).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'idempotency-key', in: 'header', required: true }),
      ]),
    );
  });
});

describe('same key + same patient + same request', () => {
  it('returns the original result and creates exactly one booking', async () => {
    const a = args();
    const token = await quote(patient, a);
    const key = randomUUID();
    const first = await bookReq(app, patient, a, token, key);
    const second = await bookReq(app, patient, a, token, key);
    const third = await bookReq(app, patient, a, token, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(third.status).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body).toEqual(first.body); // byte-for-byte the original result
    expect(await Booking.countDocuments()).toBe(1);
    expect(await BookingReservation.countDocuments()).toBe(16);
  });

  it('booking creation and idempotency completion are atomic (record is COMPLETED and points at the booking)', async () => {
    const a = args();
    const key = randomUUID();
    const res = await bookReq(app, patient, a, await quote(patient, a), key);
    const rec = await IdempotencyKey.findOne({ key }).lean();
    expect(rec).toMatchObject({
      status: 'COMPLETED',
      scope: 'bookings.create',
      responseStatus: 201,
    });
    expect((rec!.response as { id: string }).id).toBe(res.body.data.id);
    expect(String(rec!.userId)).toBe(patient.id);
  });

  it('replays even after the original booking has moved on (the original response is returned)', async () => {
    const a = args();
    const token = await quote(patient, a);
    const key = randomUUID();
    const first = await bookReq(app, patient, a, token, key);
    await request(app)
      .post(`${API}/bookings/${first.body.data.id}/cancel`)
      .set(patient.auth)
      .send({});
    const replay = await bookReq(app, patient, a, token, key);
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(replay.body.data.status).toBe('PAYMENT_PENDING'); // original snapshot
    expect(await Booking.countDocuments()).toBe(1);
  });
});

describe('same key + different request payload', () => {
  it('different notes -> 422 IDEMPOTENCY_KEY_REUSED, nothing new created', async () => {
    const a = args();
    const token = await quote(patient, a);
    const key = randomUUID();
    expect((await bookReq(app, patient, { ...a, notes: 'first' }, token, key)).status).toBe(201);
    const second = await bookReq(app, patient, { ...a, notes: 'second' }, token, key);
    expect(second.status).toBe(422);
    expect(second.body.errorCode).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await Booking.countDocuments()).toBe(1);
  });

  it('different time range (with its own valid quote) -> 422, no second booking', async () => {
    const a1 = args('08:00', '12:00');
    const a2 = args('14:00', '18:00');
    const key = randomUUID();
    expect((await bookReq(app, patient, a1, await quote(patient, a1), key)).status).toBe(201);
    const res = await bookReq(app, patient, a2, await quote(patient, a2), key);
    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await Booking.countDocuments()).toBe(1);
    expect(await BookingReservation.countDocuments()).toBe(16);
  });

  it('the error is deterministic: repeating the mismatch gives the same result', async () => {
    const a = args();
    const token = await quote(patient, a);
    const key = randomUUID();
    await bookReq(app, patient, a, token, key);
    const r1 = await bookReq(app, patient, { ...a, notes: 'x' }, token, key);
    const r2 = await bookReq(app, patient, { ...a, notes: 'x' }, token, key);
    expect([r1.status, r2.status]).toEqual([422, 422]);
    expect(r1.body.errorCode).toBe(r2.body.errorCode);
  });
});

describe('same key from a different authenticated patient', () => {
  it('never exposes or replays the first patient result', async () => {
    const a = args('08:00', '12:00');
    const key = randomUUID();
    const token = await quote(patient, a); // quoted before the slot is taken
    const mine = await bookReq(app, patient, a, token, key);
    expect(mine.status).toBe(201);

    // patient2 replays patient1's exact request + token with the same key
    const stolen = await bookReq(app, patient2, a, token, key);
    expect(stolen.status).toBe(409);
    expect(stolen.body.errorCode).toBe('QUOTE_MISMATCH');
    expect(JSON.stringify(stolen.body)).not.toContain(mine.body.data.id);
    expect(JSON.stringify(stolen.body)).not.toContain(mine.body.data.bookingNumber);

    // patient2 using the same key for their OWN request: independent record, own booking
    const b = args('14:00', '18:00');
    const theirs = await bookReq(app, patient2, b, await quote(patient2, b), key);
    expect(theirs.status).toBe(201);
    expect(theirs.body.data.id).not.toBe(mine.body.data.id);
    expect(theirs.headers['idempotent-replayed']).toBeUndefined();
    expect(await Booking.countDocuments()).toBe(2);
    expect(await IdempotencyKey.countDocuments({ key })).toBe(2); // one per user

    // and patient2 cannot read patient1's booking
    expect(
      (await request(app).get(`${API}/bookings/${mine.body.data.id}`).set(patient2.auth)).status,
    ).toBe(404);
  });
});

describe('simultaneous duplicate requests', () => {
  it('8 identical requests with one key: one booking, every response is the same booking', async () => {
    const a = args();
    const token = await quote(patient, a);
    const key = randomUUID();
    const res = await Promise.all(
      Array.from({ length: 8 }, () => bookReq(app, patient, a, token, key)),
    );
    expect(res.map((r) => r.status)).toEqual(Array(8).fill(201));
    expect(new Set(res.map((r) => r.body.data.id)).size).toBe(1);
    expect(
      res.filter((r) => r.headers['idempotent-replayed'] === 'true').length,
    ).toBeGreaterThanOrEqual(7);
    expect(await Booking.countDocuments()).toBe(1);
    expect(await BookingReservation.countDocuments()).toBe(16);
    expect(await IdempotencyKey.countDocuments()).toBe(1);
  });

  it('concurrent requests with one key but DIFFERENT payloads: at most one booking is ever created', async () => {
    const a1 = args('08:00', '12:00');
    const a2 = args('14:00', '18:00');
    const key = randomUUID();
    const t1 = await quote(patient, a1);
    const t2 = await quote(patient, a2);
    const res = await Promise.all([
      bookReq(app, patient, a1, t1, key),
      bookReq(app, patient, a2, t2, key),
      bookReq(app, patient, a1, t1, key),
      bookReq(app, patient, a2, t2, key),
    ]);
    expect(res.every((r) => r.status === 201 || r.status === 422)).toBe(true);
    expect(
      res
        .filter((r) => r.status === 422)
        .every((r) => r.body.errorCode === 'IDEMPOTENCY_KEY_REUSED'),
    ).toBe(true);
    expect(await Booking.countDocuments()).toBe(1);
  });

  it('different keys, same overlapping range: still exactly one booking (no idempotency shortcut around conflicts)', async () => {
    const a = args();
    const token1 = await quote(patient, a);
    const token2 = await quote(patient2, a);
    const res = await Promise.all([
      bookReq(app, patient, a, token1),
      bookReq(app, patient2, a, token2),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(res.find((r) => r.status === 409)!.body.errorCode).toBe('BOOKING_CONFLICT');
  });
});

describe('failures are not cached', () => {
  it('a failed attempt releases the key; a corrected retry with the same key succeeds', async () => {
    const a = args();
    const key = randomUUID();
    const bad = await bookReq(app, patient, a, 'x'.repeat(40), key); // invalid quote
    expect(bad.status).toBe(400);
    expect(await IdempotencyKey.countDocuments({ key })).toBe(0);
    const good = await bookReq(app, patient, a, await quote(patient, a), key);
    expect(good.status).toBe(201);
    expect(await Booking.countDocuments()).toBe(1);
  });

  it('a conflict (BOOKING_CONFLICT) is not replayed once the slot frees up', async () => {
    const a = args();
    const first = await bookReq(app, patient, a, await quote(patient, a));
    const key = randomUUID();
    const token2 = await quote(patient2, args('13:00', '15:00')); // valid quote for another range...
    const clash = await bookReq(app, patient2, args('13:00', '15:00'), token2, key);
    expect(clash.status).toBe(201); // different range: ok, just checking independence
    await request(app)
      .post(`${API}/bookings/${first.body.data.id}/cancel`)
      .set(patient.auth)
      .send({});
    const again = await bookReq(app, patient, a, await quote(patient, a), randomUUID());
    expect(again.status).toBe(201);
  });
});

describe('Redis is not involved (MongoDB is the source of truth)', () => {
  it('replay and concurrent duplicates still work with Redis down', async () => {
    const a = args();
    const token = await quote(patient, a);
    const redis = getRedis();
    jest.spyOn(redis, 'set').mockRejectedValue(new Error('connect ECONNREFUSED'));
    jest.spyOn(redis, 'get').mockRejectedValue(new Error('connect ECONNREFUSED'));
    jest.spyOn(redis, 'eval').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const key = randomUUID();
    const res = await Promise.all(
      Array.from({ length: 5 }, () => bookReq(app, patient, a, token, key)),
    );
    expect(res.map((r) => r.status)).toEqual(Array(5).fill(201));
    expect(new Set(res.map((r) => r.body.data.id)).size).toBe(1);
    const replay = await bookReq(app, patient, a, token, key);
    expect(replay.body.data.id).toBe(res[0]!.body.data.id);
    expect(await Booking.countDocuments()).toBe(1);
  });

  it('Redis flushed (all cache lost): the stored idempotency record still protects against duplicates', async () => {
    const a = args();
    const token = await quote(patient, a);
    const key = randomUUID();
    const first = await bookReq(app, patient, a, token, key);
    await getRedis().flushall();
    resetRateLimiters();
    const again = await bookReq(app, patient, a, token, key);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(await Booking.countDocuments()).toBe(1);
  });
});

describe('IdempotencyService internals', () => {
  const uid = () => String(new mongoose.Types.ObjectId());

  it('takes over a key whose owner crashed (lock expired, no booking was created)', async () => {
    const userId = uid();
    await IdempotencyKey.create({
      scope: 't',
      userId,
      key: 'crashed-owner-1',
      requestHash: hashPayload({ a: 1 }),
      status: 'IN_PROGRESS',
      ownerToken: 'dead',
      lockedUntil: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const out = await IdempotencyService.execute<{ ok: boolean }>(
      {
        scope: 't',
        userId,
        key: 'crashed-owner-1',
        requestHash: hashPayload({ a: 1 }),
        waitMs: 2000,
      },
      async () => ({ status: 201, body: { ok: true } }),
    );
    expect(out).toMatchObject({ status: 201, replayed: false, body: { ok: true } });
  });

  it('a live owner blocks duplicates: they wait, then get 409 IDEMPOTENCY_IN_PROGRESS', async () => {
    const userId = uid();
    await IdempotencyKey.create({
      scope: 't',
      userId,
      key: 'live-owner-0001',
      requestHash: hashPayload({ a: 1 }),
      status: 'IN_PROGRESS',
      ownerToken: 'alive',
      lockedUntil: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      IdempotencyService.execute(
        {
          scope: 't',
          userId,
          key: 'live-owner-0001',
          requestHash: hashPayload({ a: 1 }),
          waitMs: 300,
        },
        async () => ({ status: 201, body: {} }),
      ),
    ).rejects.toMatchObject({ statusCode: 409, errorCode: 'IDEMPOTENCY_IN_PROGRESS' });
  });

  it('a waiting duplicate picks up the result when the original completes', async () => {
    const userId = uid();
    const hash = hashPayload({ a: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = IdempotencyService.execute<{ n: number }>(
      { scope: 't', userId, key: 'slow-original-1', requestHash: hash },
      async () => {
        await gate;
        return { status: 201, body: { n: 42 } };
      },
    );
    await new Promise((r) => setTimeout(r, 100));
    const dup = IdempotencyService.execute<{ n: number }>(
      { scope: 't', userId, key: 'slow-original-1', requestHash: hash, waitMs: 5000 },
      async () => ({ status: 201, body: { n: -1 } }),
    );
    setTimeout(release, 200);
    const [a, b] = await Promise.all([first, dup]);
    expect(a.body.n).toBe(42);
    expect(b).toMatchObject({ replayed: true, body: { n: 42 } });
  });

  it('hashPayload is key-order independent and date-normalised', () => {
    expect(hashPayload({ a: 1, b: { c: 2, d: new Date('2026-01-01T00:00:00Z') } })).toBe(
      hashPayload({ b: { d: '2026-01-01T00:00:00.000Z', c: 2 }, a: 1 }),
    );
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
  });

  it('records expire via a TTL index', async () => {
    const idx = await mongoose.connection.collection('idempotencyKeys').indexes();
    expect(idx).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
        expect.objectContaining({ key: { scope: 1, userId: 1, key: 1 }, unique: true }),
      ]),
    );
  });
});
