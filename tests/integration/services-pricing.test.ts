import type { Express } from 'express';
import request from 'supertest';
import { Holiday, ServicePrice } from '../../src/modules/pricing';
import { AuditLog } from '../../src/modules/audit';
import {
  API,
  createAdmin,
  register,
  resetState,
  startApp,
  stopApp,
  type Session,
} from '../helpers/harness';
import { at, mkNurse, mkService, nextWeekday, quoteReq } from '../helpers/world';

let app: Express;
let admin: Session;
let patient: Session;
beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(async () => {
  await resetState();
  admin = await createAdmin(app);
  patient = await register(app, 'PATIENT');
});

const adm = (m: 'post' | 'patch' | 'get' | 'put' | 'delete', path: string, body?: object) =>
  request(app)[m](`${API}${path}`).set(admin.auth).send(body);

describe('service management (admin)', () => {
  it('creates, updates, deactivates and reactivates a service; every action is audit-logged', async () => {
    const created = await adm('post', '/admin/services', {
      name: 'Post-Surgery Care',
      description: 'Wound care and mobility assistance',
      category: 'POST_SURGERY',
      billingUnit: 'HOURLY',
      minDurationMinutes: 60,
      maxDurationMinutes: 720,
      expectedDurationMinutes: 240,
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      slug: 'post-surgery-care',
      isActive: true,
      category: 'POST_SURGERY',
      billingUnit: 'HOURLY',
    });
    const id = created.body.data.id;

    const upd = await adm('patch', `/admin/services/${id}`, {
      description: 'Updated',
      maxDurationMinutes: 1440,
    });
    expect(upd.body.data).toMatchObject({ description: 'Updated', maxDurationMinutes: 1440 });

    const off = await adm('patch', `/admin/services/${id}/deactivate`);
    expect(off.body.data.isActive).toBe(false);
    const on = await adm('patch', `/admin/services/${id}/activate`);
    expect(on.body.data.isActive).toBe(true);

    const actions = (await AuditLog.find({ entity: 'Service' }).sort({ at: 1 }).lean()).map(
      (a) => a.action,
    );
    expect(actions).toEqual([
      'service.created',
      'service.updated',
      'service.deactivated',
      'service.activated',
    ]);
  });

  it('rejects duplicate names/slugs and invalid durations', async () => {
    const body = {
      name: 'Elderly Care',
      billingUnit: 'DAILY',
      minDurationMinutes: 1440,
      maxDurationMinutes: 10080,
    };
    expect((await adm('post', '/admin/services', body)).status).toBe(201);
    const dup = await adm('post', '/admin/services', body);
    expect(dup.status).toBe(409);
    expect(dup.body.errorCode).toBe('SERVICE_EXISTS');
    expect(
      (
        await adm('post', '/admin/services', {
          ...body,
          name: 'Other',
          minDurationMinutes: 600,
          maxDurationMinutes: 60,
        })
      ).body.errorCode,
    ).toBe('INVALID_DURATION_RANGE');
    expect((await adm('post', '/admin/services', { ...body, name: 'X', price: 100 })).status).toBe(
      400,
    ); // unknown field
  });

  it('only admins manage services; everyone authenticated can read active ones', async () => {
    const id = await mkService(app, admin, { name: 'Companion Care' });
    const body = {
      name: 'Hack',
      billingUnit: 'HOURLY',
      minDurationMinutes: 60,
      maxDurationMinutes: 120,
    };
    expect(
      (await request(app).post(`${API}/admin/services`).set(patient.auth).send(body)).status,
    ).toBe(403);
    expect(
      (await request(app).patch(`${API}/admin/services/${id}/deactivate`).set(patient.auth)).status,
    ).toBe(403);
    expect((await request(app).get(`${API}/services`)).status).toBe(401);
    const list = await request(app).get(`${API}/services`).set(patient.auth);
    expect(list.body.data.items.map((s: { name: string }) => s.name)).toEqual(['Companion Care']);
  });

  it('inactive services are hidden from clients but visible to admins', async () => {
    const id = await mkService(app, admin, { name: 'Vital Signs Monitoring' });
    await adm('patch', `/admin/services/${id}/deactivate`);
    expect(
      (await request(app).get(`${API}/services`).set(patient.auth)).body.data.items,
    ).toHaveLength(0);
    expect((await request(app).get(`${API}/services/${id}`).set(patient.auth)).status).toBe(404);
    expect((await adm('get', `/services/${id}`)).status).toBe(200);
    expect((await adm('get', '/admin/services?isActive=false')).body.data.meta.total).toBe(1);
  });

  it('exposes current base rates with the service (so apps never hardcode prices)', async () => {
    const id = await mkService(app, admin, { billingUnit: 'DAILY', rate: 25000 });
    const s = (await request(app).get(`${API}/services/${id}`).set(patient.auth)).body.data;
    expect(s.baseRatesMinor).toMatchObject({ daily: 25000, hourly: null });
    expect(s.currency).toBe('AED');
  });
});

describe('rate card (database-driven pricing)', () => {
  it('publishing a rate closes the previous version and keeps history', async () => {
    const id = await mkService(app, admin, { rate: 4000 });
    const later = new Date(Date.now() + 1000);
    const v2 = await adm('post', `/admin/services/${id}/prices`, {
      kind: 'HOURLY',
      amountMinor: 5000,
      effectiveFrom: later.toISOString(),
    });
    expect(v2.body.data).toMatchObject({ version: 2, amountMinor: 5000, effectiveTo: null });
    const hist = (await adm('get', `/admin/services/${id}/prices`)).body.data.items;
    expect(hist).toHaveLength(2);
    const old = hist.find((p: { version: number }) => p.version === 1);
    expect(old.effectiveTo).toBe(later.toISOString());
    expect(
      await ServicePrice.countDocuments({ serviceId: id, kind: 'HOURLY', isCurrent: true }),
    ).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'service.price_published' })).toBe(2);
  });

  it('validates the shape per kind and rejects non-integer money', async () => {
    const id = await mkService(app, admin, { prices: false });
    expect(
      (await adm('post', `/admin/services/${id}/prices`, { kind: 'HOURLY', amountMinor: 40.5 }))
        .status,
    ).toBe(400);
    expect(
      (await adm('post', `/admin/services/${id}/prices`, { kind: 'HOURLY', bps: 100 })).status,
    ).toBe(400);
    expect(
      (
        await adm('post', `/admin/services/${id}/prices`, {
          kind: 'WEEKEND_SURCHARGE',
          amountMinor: 100,
        })
      ).status,
    ).toBe(400);
    expect(
      (await adm('post', `/admin/services/${id}/prices`, { kind: 'HOURLY', amountMinor: -5 }))
        .status,
    ).toBe(400);
    expect(
      (await adm('post', `/admin/services/${id}/prices`, { kind: 'HOURLY', amountMinor: 4000 }))
        .status,
    ).toBe(201);
  });

  it('refuses a new version dated before the current one', async () => {
    const id = await mkService(app, admin);
    const r = await adm('post', `/admin/services/${id}/prices`, {
      kind: 'HOURLY',
      amountMinor: 1,
      effectiveFrom: new Date(Date.now() - 86_400_000).toISOString(),
    });
    expect(r.status).toBe(409);
    expect(r.body.errorCode).toBe('PRICE_EFFECTIVE_DATE_CONFLICT');
  });

  it('only admins can change prices', async () => {
    const id = await mkService(app, admin);
    expect(
      (
        await request(app)
          .post(`${API}/admin/services/${id}/prices`)
          .set(patient.auth)
          .send({ kind: 'HOURLY', amountMinor: 1 })
      ).status,
    ).toBe(403);
  });
});

describe('quote calculation end to end', () => {
  it('hourly: 3h at 40 AED = 120 AED (12000 fils)', async () => {
    const serviceId = await mkService(app, admin);
    const nurse = await mkNurse(app, admin, { serviceIds: [serviceId] });
    const d = nextWeekday(2); // a Tuesday: no weekend surcharge
    const q = await quoteReq(app, patient, {
      serviceId,
      nurseId: nurse.profileId,
      start: at(d, '09:00'),
      end: at(d, '12:00'),
    });
    expect(q.body.data).toMatchObject({
      baseMinor: 12000,
      patientPayableMinor: 12000,
      currency: 'AED',
    });
  });

  it('daily: 250 AED/day x 3 days = 750 AED (75000 fils)', async () => {
    const serviceId = await mkService(app, admin, { billingUnit: 'DAILY', rate: 25000 });
    const nurse = await mkNurse(app, admin, { serviceIds: [serviceId] });
    const d = nextWeekday(2);
    const start = at(d, '08:00');
    const q = await quoteReq(app, patient, {
      serviceId,
      nurseId: nurse.profileId,
      start,
      end: new Date(start.getTime() + 72 * 3_600_000),
    });
    expect(q.status).toBe(200);
    expect(q.body.data).toMatchObject({
      unit: 'DAILY',
      baseMinor: 75000,
      patientPayableMinor: 75000,
    });
    expect(q.body.data.lines[0]).toMatchObject({
      code: 'BASE',
      quantity: 3,
      unitAmountMinor: 25000,
    });
  });

  it('daily services reject sub-day durations', async () => {
    const serviceId = await mkService(app, admin, { billingUnit: 'DAILY' });
    const nurse = await mkNurse(app, admin, { serviceIds: [serviceId] });
    const d = nextWeekday(2);
    const q = await quoteReq(app, patient, {
      serviceId,
      nurseId: nurse.profileId,
      start: at(d, '08:00'),
      end: at(d, '16:00'),
    });
    expect(q.body.errorCode).toBe('INVALID_DURATION');
  });

  it('weekend surcharge from the rate card applies on Saturdays (configurable weekend days)', async () => {
    const serviceId = await mkService(app, admin);
    await adm('post', `/admin/services/${serviceId}/prices`, {
      kind: 'WEEKEND_SURCHARGE',
      bps: 2000,
    });
    const nurse = await mkNurse(app, admin, { serviceIds: [serviceId] });
    const sat = nextWeekday(6);
    const q = await quoteReq(app, patient, {
      serviceId,
      nurseId: nurse.profileId,
      start: at(sat, '09:00'),
      end: at(sat, '13:00'),
    });
    expect(q.body.data).toMatchObject({
      baseMinor: 16000,
      surchargeMinor: 3200,
      patientPayableMinor: 19200,
    });
    expect(q.body.data.lines.map((l: { code: string }) => l.code)).toEqual([
      'BASE',
      'WEEKEND_SURCHARGE',
    ]);
    const tue = nextWeekday(2);
    const q2 = await quoteReq(app, patient, {
      serviceId,
      nurseId: nurse.profileId,
      start: at(tue, '09:00'),
      end: at(tue, '13:00'),
    });
    expect(q2.body.data.surchargeMinor).toBe(0);

    // change the platform weekend to Fri/Sat: Saturday still surcharged, Sunday not
    await adm('put', '/admin/settings/pricing.weekendDays', { value: [5, 6] });
    const sun = nextWeekday(7);
    const q3 = await quoteReq(app, patient, {
      serviceId,
      nurseId: nurse.profileId,
      start: at(sun, '09:00'),
      end: at(sun, '13:00'),
    });
    expect(q3.body.data.surchargeMinor).toBe(0);
  });

  it('holiday surcharge and fixed fees are itemised', async () => {
    const serviceId = await mkService(app, admin);
    await adm('post', `/admin/services/${serviceId}/prices`, {
      kind: 'HOLIDAY_SURCHARGE',
      bps: 5000,
    });
    await adm('post', `/admin/services/${serviceId}/prices`, {
      kind: 'FEE',
      code: 'TRAVEL',
      label: 'Travel fee',
      amountMinor: 1500,
    });
    const nurse = await mkNurse(app, admin, { serviceIds: [serviceId] });
    const tue = nextWeekday(2, 4);
    expect((await adm('post', '/admin/holidays', { date: tue, name: 'National Day' })).status).toBe(
      201,
    );
    expect((await adm('post', '/admin/holidays', { date: tue, name: 'dup' })).status).toBe(409);
    const q = await quoteReq(app, patient, {
      serviceId,
      nurseId: nurse.profileId,
      start: at(tue, '09:00'),
      end: at(tue, '13:00'),
    });
    expect(q.body.data).toMatchObject({
      baseMinor: 16000,
      surchargeMinor: 8000,
      feesMinor: 1500,
      grossMinor: 25500,
      patientPayableMinor: 25500,
    });
    expect(q.body.data.lines.map((l: { code: string }) => l.code)).toEqual([
      'BASE',
      'HOLIDAY_SURCHARGE',
      'FEE',
    ]);
    const holiday = await Holiday.findOne({ date: tue });
    expect((await adm('delete', `/admin/holidays/${holiday!._id}`)).status).toBe(200);
    const q2 = await quoteReq(app, patient, {
      serviceId,
      nurseId: nurse.profileId,
      start: at(tue, '09:00'),
      end: at(tue, '13:00'),
    });
    expect(q2.body.data.surchargeMinor).toBe(0);
  });

  it('a service with no configured price cannot be quoted', async () => {
    const serviceId = await mkService(app, admin, { prices: false });
    const nurse = await mkNurse(app, admin, { serviceIds: [serviceId] });
    const d = nextWeekday(2);
    const q = await quoteReq(app, patient, {
      serviceId,
      nurseId: nurse.profileId,
      start: at(d, '09:00'),
      end: at(d, '12:00'),
    });
    expect(q.status).toBe(422);
    expect(q.body.errorCode).toBe('PRICING_NOT_CONFIGURED');
  });

  it('commission follows the service override, then the platform default (snapshot only; not shown to patients)', async () => {
    const serviceId = await mkService(app, admin);
    await adm('patch', `/admin/services/${serviceId}`, { commissionBps: 2000 });
    const nurse = await mkNurse(app, admin, { serviceIds: [serviceId] });
    const d = nextWeekday(2);
    const q = await quoteReq(app, patient, {
      serviceId,
      nurseId: nurse.profileId,
      start: at(d, '09:00'),
      end: at(d, '13:00'),
    });
    expect(q.status).toBe(200);
    expect(JSON.stringify(q.body)).not.toMatch(/commission/i);
  });
});

describe('platform settings', () => {
  it('validates keys and values, and is admin-only + audited', async () => {
    expect(
      (await adm('put', '/admin/settings/platform.timezone', { value: 'Not/AZone' })).status,
    ).toBe(400);
    expect((await adm('put', '/admin/settings/booking.holdMinutes', { value: 0 })).status).toBe(
      400,
    );
    expect((await adm('put', '/admin/settings/unknown.key', { value: 1 })).status).toBe(400);
    expect((await adm('put', '/admin/settings/booking.holdMinutes', { value: 20 })).status).toBe(
      200,
    );
    const all = (await adm('get', '/admin/settings')).body.data;
    expect(all['booking.holdMinutes']).toBe(20);
    expect(all['platform.timezone']).toBe('Asia/Dubai');
    expect(await AuditLog.countDocuments({ action: 'settings.changed' })).toBe(1);
    expect(
      (
        await request(app)
          .put(`${API}/admin/settings/booking.holdMinutes`)
          .set(patient.auth)
          .send({ value: 1 })
      ).status,
    ).toBe(403);
  });
});
