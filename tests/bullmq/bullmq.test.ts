import type { Express } from 'express';
import IORedis from 'ioredis';
import request from 'supertest';
import { AdminAlert } from '../../src/modules/alerts';
import { Booking, BookingService } from '../../src/modules/bookings';
import { Refund } from '../../src/modules/refunds';
import { WalletTransaction } from '../../src/modules/wallets';
import { startWorkers, syncSchedules, type WorkerRuntime } from '../../src/jobs';
import {
  BullQueueBackend,
  QUEUES,
  enqueue,
  setQueueBackend,
  type QueueName,
} from '../../src/queues';
import type { MockPaymentProvider } from '../../src/providers/payment';
import { API, resetState, startApp, stopApp, type Session } from '../helpers/harness';
import { completeBooking, freshProvider, payFully, walletOf } from '../helpers/finance';
import { at, baseWorld, bookIt, timeTravel, type BookArgs, type Nurse } from '../helpers/world';

/**
 * Runs against a REAL Redis (REDIS_TEST_URL, default redis://127.0.0.1:6379): BullMQ semantics
 * (job ids, retries/backoff, schedulers, graceful shutdown, reconnects) cannot be proven with a mock.
 * Domain effects are asserted in a REAL MongoDB replica set.
 */
const REDIS_URL = process.env.REDIS_URL as string;
let app: Express;
let backend: BullQueueBackend;
let serviceId: string;
let nurse: Nurse;
let patient: Session;
let D: string;
let mock: MockPaymentProvider;
const runtimes: WorkerRuntime[] = [];
let n = 0;

const waitFor = async (fn: () => Promise<boolean>, ms = 15_000, step = 100) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error('waitFor timed out');
};
const args = (): BookArgs => ({
  serviceId,
  nurseId: nurse.profileId,
  start: at(D, '08:00'),
  end: at(D, '12:00'),
});
const fresh = () =>
  new BullQueueBackend({
    redisUrl: REDIS_URL,
    prefix: `bt${process.pid}${Date.now().toString(36)}${n++}`,
    retry: { attempts: 3, backoffBaseMs: 100, removeOnCompleteCount: 100, removeOnFailCount: 100 },
  });
const start = async (queues?: QueueName[]) => {
  const r = await startWorkers(backend, { queues, schedule: false });
  runtimes.push(r);
  return r;
};

beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => {
  await stopApp();
});
beforeEach(async () => {
  await resetState();
  backend = fresh();
  setQueueBackend(backend);
  mock = freshProvider();
  ({ serviceId, nurse, patient, D } = await baseWorld(app));
});
afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.allSettled(runtimes.splice(0).map((r) => r.close()));
  await backend.obliterateAll().catch(() => undefined);
  await backend.close().catch(() => undefined);
  setQueueBackend(undefined);
});

describe('queues and jobs', () => {
  it('creates the queues and reports their statistics', async () => {
    await backend.add(QUEUES.booking, 'booking.expireDue', {});
    const s = await backend.stats(QUEUES.booking);
    expect(s).toMatchObject({ queue: 'booking-jobs', waiting: 1, active: 0, failed: 0 });
    expect(s.oldestWaitingSeconds).toBeGreaterThanOrEqual(0);
  });

  it('a deterministic jobId de-duplicates; re-adding does not create a second job', async () => {
    expect(
      await backend.add(QUEUES.refund, 'refund.attempt', { refundId: 'a' }, { jobId: 'refund-1' }),
    ).toBe(true);
    expect(
      await backend.add(QUEUES.refund, 'refund.attempt', { refundId: 'a' }, { jobId: 'refund-1' }),
    ).toBe(false);
    expect((await backend.stats(QUEUES.refund)).waiting).toBe(1);
  });

  it('schedulers are idempotent, readable and removable', async () => {
    await backend.upsertScheduler(QUEUES.booking, 'booking.expireDue', 60_000, 'booking.expireDue');
    await backend.upsertScheduler(QUEUES.booking, 'booking.expireDue', 60_000, 'booking.expireDue');
    const list = await backend.listSchedulers(QUEUES.booking);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ everyMs: 60_000, name: 'booking.expireDue' });
    await backend.removeScheduler(QUEUES.booking, 'booking.expireDue');
    expect(await backend.listSchedulers(QUEUES.booking)).toHaveLength(0);
  });

  it('syncSchedules registers every recurring job from platform settings', async () => {
    const s = await syncSchedules(backend);
    expect(s.upserted.length).toBeGreaterThanOrEqual(10);
    const all = (
      await Promise.all(Object.values(QUEUES).map((q) => backend.listSchedulers(q)))
    ).flat();
    expect(all).toHaveLength(s.upserted.length);
    expect(all.find((x) => x.name === 'booking.expireDue')!.everyMs).toBe(60_000);
  });
});

describe('worker processing against real services', () => {
  it('processes a job through the domain service (booking expiry) and records worker heartbeat', async () => {
    const { booking } = await bookIt(app, patient, args());
    const id = booking.body.data.id as string;
    await timeTravel(id, { holdExpiresAt: new Date(Date.now() - 60_000) });
    const rt = await start();
    expect((await backend.workers()).map((w) => w.id)).toContain(rt.id);
    await backend.add(QUEUES.booking, 'booking.expireDue', {});
    await waitFor(async () => (await Booking.findById(id))!.status === 'EXPIRED');
  });

  it('retries with exponential backoff and finally succeeds', async () => {
    const calls: number[] = [];
    jest.spyOn(BookingService, 'expireDue').mockImplementation(async () => {
      calls.push(Date.now());
      if (calls.length < 3) throw new Error('transient database error');
      return { expired: 0 };
    });
    await start([QUEUES.booking]);
    await backend.add(QUEUES.booking, 'booking.expireDue', {}, { jobId: 'retry-1' });
    await waitFor(
      async () => (await backend.queue(QUEUES.booking).getJob('retry-1'))?.finishedOn != null,
    );
    expect(calls).toHaveLength(3);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(90); // backoff 100ms
    expect(calls[2]! - calls[1]!).toBeGreaterThanOrEqual(190); // then 200ms (exponential)
    const job = (await backend.queue(QUEUES.booking).getJob('retry-1'))!;
    expect(await job.getState()).toBe('completed');
    expect(job.attemptsMade).toBe(3);
  });

  it('exhausted retries fail the job and raise ONE critical alert; invalid payloads are never retried', async () => {
    jest.spyOn(BookingService, 'expireDue').mockRejectedValue(new Error('database is down'));
    await start([QUEUES.booking, QUEUES.refund]);
    await backend.add(QUEUES.booking, 'booking.expireDue', {}, { jobId: 'fail-1' });
    await backend.add(QUEUES.booking, 'booking.expireDue', {}, { jobId: 'fail-2' });
    await waitFor(async () => (await AdminAlert.countDocuments({ type: 'JOB_EXHAUSTED' })) >= 1);
    await waitFor(async () => (await backend.stats(QUEUES.booking)).failed === 2);
    const alerts = await AdminAlert.find({ type: 'JOB_EXHAUSTED' }).lean();
    expect(alerts).toHaveLength(1); // per job type, never per job
    expect(alerts[0]).toMatchObject({ severity: 'CRITICAL' });
    expect(JSON.stringify(alerts[0])).not.toMatch(/password|secret|token/i);

    await backend.add(QUEUES.refund, 'refund.attempt', { refundId: 'garbage' }, { jobId: 'bad-1' });
    await waitFor(async () => (await backend.stats(QUEUES.refund)).failed === 1);
    const bad = (await backend.queue(QUEUES.refund).getJob('bad-1'))!;
    expect(bad.attemptsMade).toBe(1); // UnrecoverableError: no retries
  });
});

describe('duplicate delivery and several workers never duplicate financial effects', () => {
  it('the same refund delivered as many jobs to two worker instances calls the provider once', async () => {
    const r = await payFully(app, mock, patient, args());
    await request(app)
      .post(`${API}/bookings/${r.bookingId}/reject`)
      .set(nurse.session.auth)
      .send({});
    const refund = (await Refund.findOne({ bookingId: r.bookingId }))!;
    await start([QUEUES.refund]);
    const second = await start([QUEUES.refund]);
    expect(second.id).not.toBeUndefined();
    for (let i = 0; i < 8; i++)
      await backend.add(
        QUEUES.refund,
        'refund.attempt',
        { refundId: String(refund._id) },
        { jobId: `dup-${i}` },
      );
    await waitFor(async () => (await Booking.findById(r.bookingId))!.status === 'REFUNDED');
    await waitFor(async () => (await backend.stats(QUEUES.refund)).completed === 8);
    expect(mock.calls.refund).toBe(1);
    expect(await Refund.countDocuments({ bookingId: r.bookingId, status: 'SUCCEEDED' })).toBe(1);
  });

  it('duplicate wallet-release jobs on two workers release once', async () => {
    const r = await payFully(app, mock, patient, args());
    await completeBooking(r.bookingId, nurse, app, 100);
    await start([QUEUES.wallet]);
    await start([QUEUES.wallet]);
    for (let i = 0; i < 6; i++)
      await backend.add(QUEUES.wallet, 'wallet.releaseDue', {}, { jobId: `rel-${i}` });
    await waitFor(async () => (await backend.stats(QUEUES.wallet)).completed === 6);
    expect(
      await WalletTransaction.countDocuments({ referenceId: r.bookingId, type: 'RELEASE' }),
    ).toBe(2);
    expect(await walletOf(nurse)).toMatchObject({
      availableBalanceMinor: 13600,
      pendingBalanceMinor: 0,
    });
  });
});

describe('graceful shutdown', () => {
  it('waits for the active job to finish, then removes its heartbeat', async () => {
    let finished = false;
    jest.spyOn(BookingService, 'expireDue').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 800));
      finished = true;
      return { expired: 0 };
    });
    const rt = await start([QUEUES.booking]);
    await backend.add(QUEUES.booking, 'booking.expireDue', {}, { jobId: 'slow-1' });
    await waitFor(async () => (await backend.stats(QUEUES.booking)).active === 1);
    await rt.close();
    expect(finished).toBe(true); // not killed mid-flight
    expect((await backend.queue(QUEUES.booking).getJob('slow-1'))!.finishedOn).toBeTruthy();
    expect((await backend.workers()).map((w) => w.id)).not.toContain(rt.id);
    await rt.close(); // idempotent
  });
});

describe('Redis failure', () => {
  it('workers survive a dropped connection and keep processing afterwards', async () => {
    const { booking } = await bookIt(app, patient, args());
    const id = booking.body.data.id as string;
    await start([QUEUES.booking]);
    const admin = new IORedis(REDIS_URL);
    await admin.client('KILL', 'TYPE', 'normal', 'SKIPME', 'yes').catch(() => undefined);
    await admin.quit();
    await timeTravel(id, { holdExpiresAt: new Date(Date.now() - 60_000) });
    await waitFor(async () => {
      try {
        await backend.add(
          QUEUES.booking,
          'booking.expireDue',
          {},
          { jobId: `after-${Date.now()}` },
        );
        return true;
      } catch {
        return false;
      }
    });
    await waitFor(async () => (await Booking.findById(id))!.status === 'EXPIRED');
  });

  it('an unreachable Redis never blocks the API: enqueue returns false and financial flows still complete', async () => {
    const dead = new BullQueueBackend({ redisUrl: 'redis://127.0.0.1:1', prefix: 'dead' });
    dead.connection.on('error', () => undefined);
    setQueueBackend(dead);
    const t0 = Date.now();
    expect(await enqueue(QUEUES.refund, 'refund.attempt', { refundId: 'a' })).toBe(false);
    expect(Date.now() - t0).toBeLessThan(6000);
    const r = await payFully(app, mock, patient, args());
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(13600);
    await request(app)
      .post(`${API}/bookings/${r.bookingId}/reject`)
      .set(nurse.session.auth)
      .send({});
    const { RefundService } = await import('../../src/modules/refunds');
    await RefundService.processDue();
    expect((await Booking.findById(r.bookingId))!.status).toBe('REFUNDED');
    setQueueBackend(backend);
    dead.connection.disconnect();
  });
});
