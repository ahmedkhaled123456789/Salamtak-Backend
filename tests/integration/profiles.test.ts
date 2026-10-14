import type { Express } from 'express';
import request from 'supertest';
import { NurseProfile } from '../../src/modules/nurses';
import { API, register, resetState, startApp, stopApp } from '../helpers/harness';

let app: Express;
beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(resetState);

describe('users/me', () => {
  it('reads and updates the account but not email/phone/role', async () => {
    const s = await register(app, 'PATIENT');
    const get = await request(app).get(`${API}/users/me`).set(s.auth);
    expect(get.body.data).toMatchObject({ id: s.id, role: 'PATIENT' });
    expect(get.body.data.passwordHash).toBeUndefined();

    const patch = await request(app)
      .patch(`${API}/users/me`)
      .set(s.auth)
      .send({ firstName: 'Fatima', gender: 'FEMALE', dateOfBirth: '1990-05-01' });
    expect(patch.status).toBe(200);
    expect(patch.body.data).toMatchObject({ firstName: 'Fatima', gender: 'FEMALE' });

    for (const forbidden of [
      { role: 'ADMIN' },
      { email: 'x@y.co' },
      { phone: '+971500000001' },
      { isVerified: true },
    ]) {
      expect((await request(app).patch(`${API}/users/me`).set(s.auth).send(forbidden)).status).toBe(
        400,
      );
    }
    expect((await request(app).patch(`${API}/users/me`).set(s.auth).send({})).status).toBe(400);
  });
});

describe('patients/me', () => {
  it('updates basic info and stores location as GeoJSON', async () => {
    const s = await register(app, 'PATIENT');
    const res = await request(app)
      .patch(`${API}/patients/me`)
      .set(s.auth)
      .send({
        address: 'Marina Walk, Tower 3',
        city: 'Dubai',
        country: 'AE',
        notes: 'Ring twice',
        emergencyContact: { name: 'Omar', phone: '+971501112222', relation: 'Son' },
        location: { latitude: 25.0805, longitude: 55.1403 },
      });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      city: 'Dubai',
      location: { latitude: 25.0805, longitude: 55.1403 },
      emergencyContact: { name: 'Omar', relation: 'Son' },
    });
    const partial = await request(app)
      .patch(`${API}/patients/me`)
      .set(s.auth)
      .send({ emergencyContact: { relation: 'Brother' } });
    expect(partial.body.data.emergencyContact).toMatchObject({ name: 'Omar', relation: 'Brother' });
    const cleared = await request(app)
      .patch(`${API}/patients/me`)
      .set(s.auth)
      .send({ location: null });
    expect(cleared.body.data.location).toBeNull();
  });

  it('rejects invalid coordinates, medical-style extra fields, and userId override', async () => {
    const s = await register(app, 'PATIENT');
    const patch = (b: object) => request(app).patch(`${API}/patients/me`).set(s.auth).send(b);
    expect((await patch({ location: { latitude: 120, longitude: 0 } })).status).toBe(400);
    expect((await patch({ diagnosis: 'diabetes' })).status).toBe(400);
    expect((await patch({ userId: '64b7f0f0f0f0f0f0f0f0f0f0' })).status).toBe(400);
    expect((await patch({ emergencyContact: { phone: '12345' } })).status).toBe(400);
  });

  it('a patient only sees their own profile', async () => {
    const a = await register(app, 'PATIENT');
    const b = await register(app, 'PATIENT');
    await request(app).patch(`${API}/patients/me`).set(a.auth).send({ city: 'Abu Dhabi' });
    await request(app).patch(`${API}/patients/me`).set(b.auth).send({ city: 'Sharjah' });
    expect((await request(app).get(`${API}/patients/me`).set(a.auth)).body.data.city).toBe(
      'Abu Dhabi',
    );
    expect((await request(app).get(`${API}/patients/me`).set(b.auth)).body.data.city).toBe(
      'Sharjah',
    );
  });
});

describe('nurses/me', () => {
  it('updates professional info; rates are integer minor units', async () => {
    const s = await register(app, 'NURSE');
    const res = await request(app)
      .patch(`${API}/nurses/me`)
      .set(s.auth)
      .send({
        bio: 'RN with ICU background',
        yearsOfExperience: 8,
        specializations: ['Elderly Care', 'Post Surgery'],
        languages: ['English', 'Arabic'],
        gender: 'FEMALE',
        dailyRateMinor: 25000,
        hourlyRateMinor: 4000,
        serviceRadiusKm: 25,
        location: { latitude: 25.2048, longitude: 55.2708 },
        city: 'Dubai',
      });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      yearsOfExperience: 8,
      specializations: ['elderly care', 'post surgery'],
      dailyRateMinor: 25000,
      currency: 'AED',
      status: 'PENDING',
      isBookable: false,
    });
  });

  it('rejects float money, negative money and attempts to set admin-controlled fields', async () => {
    const s = await register(app, 'NURSE');
    const patch = (b: object) => request(app).patch(`${API}/nurses/me`).set(s.auth).send(b);
    expect((await patch({ dailyRateMinor: 250.5 })).status).toBe(400);
    expect((await patch({ dailyRateMinor: -1 })).status).toBe(400);
    for (const field of [
      { status: 'ACTIVE' },
      { verificationStatus: 'VERIFIED' },
      { isBookable: true },
      { averageRating: 5 },
      { totalReviews: 999 },
      { userId: '64b7f0f0f0f0f0f0f0f0f0f0' },
    ]) {
      expect((await patch(field)).status).toBe(400);
    }
    expect(await NurseProfile.countDocuments({ verificationStatus: 'VERIFIED' })).toBe(0);
  });

  it('cannot toggle own status while PENDING (admin-controlled)', async () => {
    const s = await register(app, 'NURSE');
    const res = await request(app)
      .patch(`${API}/nurses/me/status`)
      .set(s.auth)
      .send({ status: 'ACTIVE' });
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('NURSE_STATUS_LOCKED');
  });
});
