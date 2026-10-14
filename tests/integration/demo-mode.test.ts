import type { Express } from 'express';
import request from 'supertest';
import { env } from '../../src/config/env';
import { executeJob } from '../../src/jobs';
import { InlineQueueBackend } from '../../src/jobs/inline.backend';
import { Booking } from '../../src/modules/bookings';
import { registerFinancialHooks } from '../../src/modules/finance';
import { Payment } from '../../src/modules/payments';
import { GridFsStorageProvider } from '../../src/providers/storage';
import { getQueueBackend, MemoryQueueBackend, QUEUES, setQueueBackend } from '../../src/queues';
import { createPayment, freshProvider } from '../helpers/finance';
import { resetState, startApp, stopApp } from '../helpers/harness';
import { at, baseWorld, bookIt } from '../helpers/world';

/**
 * Portfolio-demo deployment pieces (DEMO_MODE, inline jobs, GridFS storage, cron endpoint). env is parsed once at
 * import, so these tests flip the parsed values and restore them afterwards.
 */
const mutableEnv = env as unknown as Record<string, unknown>;
let app: Express;
beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(async () => {
  await resetState();
  freshProvider();
});
afterEach(() => {
  mutableEnv.DEMO_MODE = false;
  mutableEnv.CRON_SECRET = undefined;
  registerFinancialHooks();
  setQueueBackend(new MemoryQueueBackend());
});

describe('DEMO_MODE payments', () => {
  it('confirms a new payment through the signed webhook pipeline (booking moves on, ledger written)', async () => {
    mutableEnv.DEMO_MODE = true;
    registerFinancialHooks();
    const { serviceId, nurse, patient, D } = await baseWorld(app);
    const { booking } = await bookIt(app, patient, { serviceId, nurseId: nurse.profileId, start: at(D, '09:00'), end: at(D, '13:00') });
    expect(booking.status).toBe(201);

    const pay = await createPayment(app, patient, booking.body.data.id);
    expect(pay.status).toBe(201);
    expect(pay.body.data.status).toBe('PAID');
    const saved = await Payment.findById(pay.body.data.id).lean();
    expect(saved?.status).toBe('PAID');
    expect(saved?.settlement).toBe('APPLIED');
    const b = await Booking.findById(booking.body.data.id).lean();
    expect(b?.paidAt).toBeInstanceOf(Date);
    expect(b?.status).toBe('NURSE_PENDING');
  });

  it('without DEMO_MODE a payment stays pending until the provider webhook (unchanged behaviour)', async () => {
    registerFinancialHooks();
    const { serviceId, nurse, patient, D } = await baseWorld(app);
    const { booking } = await bookIt(app, patient, { serviceId, nurseId: nurse.profileId, start: at(D, '09:00'), end: at(D, '13:00') });
    const pay = await createPayment(app, patient, booking.body.data.id);
    expect(pay.body.data.status).toBe('PENDING');
    expect((await Booking.findById(booking.body.data.id).lean())?.paidAt).toBeUndefined();
  });
});

describe('cron sweep endpoint', () => {
  it('is disabled without CRON_SECRET and rejects a wrong secret', async () => {
    expect((await request(app).get('/internal/cron/sweep')).status).toBe(404);
    mutableEnv.CRON_SECRET = 'a-very-long-cron-secret-123';
    expect((await request(app).get('/internal/cron/sweep').set('Authorization', 'Bearer nope')).status).toBe(401);
    expect((await request(app).get('/internal/cron/sweep')).status).toBe(401);
  });

  it('runs every scheduled job with the right secret', async () => {
    mutableEnv.CRON_SECRET = 'a-very-long-cron-secret-123';
    const res = await request(app).get('/internal/cron/sweep').set('Authorization', 'Bearer a-very-long-cron-secret-123');
    expect(res.status).toBe(200);
    expect(res.body.data.ran.length).toBe(res.body.data.total);
    expect(res.body.data.ran.every((r: { ok: boolean }) => r.ok)).toBe(true);
  });
});

describe('InlineQueueBackend', () => {
  it('executes immediate jobs at once and leaves delayed ones to the sweep', async () => {
    const backend = new InlineQueueBackend();
    setQueueBackend(backend);
    expect(getQueueBackend()).toBe(backend);
    await expect(backend.add(QUEUES.booking, 'booking.expireDue', {})).resolves.toBe(true);
    await expect(backend.add(QUEUES.booking, 'booking.expireDue', {}, { delayMs: 60_000 })).resolves.toBe(false);
    // an invalid payload is logged, never thrown at the caller
    await expect(backend.add(QUEUES.booking, 'no.such.job', {})).resolves.toBe(true);
    await expect(executeJob('booking.expireDue', {})).resolves.toBeDefined();
  });
});

describe('GridFsStorageProvider', () => {
  it('stores, reads, refuses to overwrite and deletes', async () => {
    const s = new GridFsStorageProvider();
    const data = Buffer.from('picture-bytes');
    await expect(s.put('service_image/abc/1.png', data, { contentType: 'image/png', sha256: 'x' })).resolves.toEqual({ key: 'service_image/abc/1.png', size: data.length });
    await expect(s.exists('service_image/abc/1.png')).resolves.toBe(true);
    expect((await s.get('service_image/abc/1.png'))?.toString()).toBe('picture-bytes');
    await expect(s.put('service_image/abc/1.png', data, { contentType: 'image/png', sha256: 'x' })).rejects.toThrow('already exists');
    await expect(s.get('../etc/passwd')).rejects.toThrow('invalid storage key');
    await s.delete('service_image/abc/1.png');
    await expect(s.get('service_image/abc/1.png')).resolves.toBeNull();
  });
});
