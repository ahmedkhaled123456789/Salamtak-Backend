import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import request from 'supertest';
import { Booking } from '../../src/modules/bookings';
import { NurseProfile } from '../../src/modules/nurses';
import { API, register, type Session } from './harness';

export const TZ = 'Asia/Dubai';

/** Instant for a Dubai-local date + HH:mm. */
export const at = (date: string, hm: string): Date =>
  DateTime.fromISO(`${date}T${hm}`, { zone: TZ }).toJSDate();

/** Dubai-local date `n` days from now (YYYY-MM-DD). */
export const day = (n: number): string =>
  DateTime.now().setZone(TZ).plus({ days: n }).toFormat('yyyy-LL-dd');

/** The next date at least `from` days away that falls on the given ISO weekday (1=Mon..7=Sun). */
export const nextWeekday = (isoWeekday: number, from = 3): string => {
  for (let n = from; n < from + 14; n++) {
    if (DateTime.fromISO(day(n), { zone: TZ }).weekday === isoWeekday) return day(n);
  }
  throw new Error('unreachable');
};

export const LOCATION = {
  latitude: 25.2048,
  longitude: 55.2708,
  address: 'Marina Walk, Tower 1',
  city: 'Dubai',
};

let n = 0;

export async function mkService(
  app: Express,
  admin: Session,
  o: {
    billingUnit?: 'HOURLY' | 'DAILY';
    rate?: number;
    min?: number;
    max?: number;
    name?: string;
    prices?: boolean;
  } = {},
): Promise<string> {
  n += 1;
  const unit = o.billingUnit ?? 'HOURLY';
  const res = await request(app)
    .post(`${API}/admin/services`)
    .set(admin.auth)
    .send({
      name: o.name ?? `Service ${n}`,
      billingUnit: unit,
      minDurationMinutes: o.min ?? (unit === 'HOURLY' ? 60 : 24 * 60),
      maxDurationMinutes: o.max ?? (unit === 'HOURLY' ? 24 * 60 : 14 * 24 * 60),
      category: 'NURSING',
    });
  if (res.status !== 201) throw new Error(`mkService: ${res.status} ${JSON.stringify(res.body)}`);
  const id = res.body.data.id as string;
  if (o.prices !== false) {
    const p = await request(app)
      .post(`${API}/admin/services/${id}/prices`)
      .set(admin.auth)
      .send({ kind: unit, amountMinor: o.rate ?? (unit === 'HOURLY' ? 4000 : 25000) });
    if (p.status !== 201) throw new Error(`mkService price: ${p.status} ${JSON.stringify(p.body)}`);
  }
  return id;
}

export interface Nurse {
  session: Session;
  profileId: string;
}

export async function mkNurse(
  app: Express,
  admin: Session,
  o: {
    serviceIds: string[];
    gender?: 'MALE' | 'FEMALE';
    years?: number;
    latitude?: number;
    longitude?: number;
    radiusKm?: number;
    specializations?: string[];
    languages?: string[];
    hourlyRateMinor?: number;
    verify?: boolean;
    hours?: [string, string] | null; // null = no availability rules
    registerOverrides?: Record<string, unknown>;
  },
): Promise<Nurse> {
  const session = await register(app, 'NURSE', o.registerOverrides);
  const patch = await request(app)
    .patch(`${API}/nurses/me`)
    .set(session.auth)
    .send({
      gender: o.gender ?? 'FEMALE',
      yearsOfExperience: o.years ?? 5,
      location: { latitude: o.latitude ?? 25.2, longitude: o.longitude ?? 55.27 },
      serviceRadiusKm: o.radiusKm ?? 30,
      specializations: o.specializations ?? ['elderly care'],
      languages: o.languages ?? ['english', 'arabic'],
      city: 'Dubai',
    });
  if (patch.status !== 200)
    throw new Error(`mkNurse patch: ${patch.status} ${JSON.stringify(patch.body)}`);
  const profile = await NurseProfile.findOne({ userId: session.id });
  const profileId = String(profile!._id);

  if (o.verify !== false) {
    const v = await request(app)
      .patch(`${API}/admin/nurses/${profileId}/verify`)
      .set(admin.auth)
      .send({ decision: 'VERIFIED' });
    if (v.status !== 200) throw new Error(`mkNurse verify: ${v.status}`);
  }
  const offers = await request(app)
    .put(`${API}/nurses/me/services`)
    .set(session.auth)
    .send({
      services: o.serviceIds.map((serviceId) => ({
        serviceId,
        ...(o.hourlyRateMinor !== undefined && { hourlyRateMinor: o.hourlyRateMinor }),
      })),
    });
  if (offers.status !== 200)
    throw new Error(`mkNurse offers: ${offers.status} ${JSON.stringify(offers.body)}`);

  if (o.hours !== null) {
    const [startTime, endTime] = o.hours ?? ['00:00', '24:00'];
    for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek++) {
      const a = await request(app)
        .post(`${API}/nurses/me/availability`)
        .set(session.auth)
        .send({ kind: 'WEEKLY', dayOfWeek, startTime, endTime });
      if (a.status !== 201)
        throw new Error(`mkNurse availability: ${a.status} ${JSON.stringify(a.body)}`);
    }
  }
  return { session, profileId };
}

export interface BookArgs {
  serviceId: string;
  nurseId: string;
  start: Date;
  end: Date;
  location?: typeof LOCATION;
  notes?: string;
}

export const quoteReq = (app: Express, patient: Session, a: BookArgs) =>
  request(app)
    .post(`${API}/bookings/quote`)
    .set(patient.auth)
    .send({
      serviceId: a.serviceId,
      nurseId: a.nurseId,
      startDateTime: a.start.toISOString(),
      endDateTime: a.end.toISOString(),
      location: {
        latitude: (a.location ?? LOCATION).latitude,
        longitude: (a.location ?? LOCATION).longitude,
      },
    });

export const bookReq = (
  app: Express,
  patient: Session,
  a: BookArgs,
  quoteToken: string,
  key: string | null = randomUUID(), // null => omit the header
) =>
  request(app)
    .post(`${API}/bookings`)
    .set(patient.auth)
    .set(key === null ? {} : { 'Idempotency-Key': key })
    .send({
      serviceId: a.serviceId,
      nurseId: a.nurseId,
      startDateTime: a.start.toISOString(),
      endDateTime: a.end.toISOString(),
      location: a.location ?? LOCATION,
      notes: a.notes,
      quoteToken,
    });

/** quote + book. Returns both responses. */
export async function bookIt(app: Express, patient: Session, a: BookArgs) {
  const quote = await quoteReq(app, patient, a);
  if (quote.status !== 200) return { quote, booking: quote };
  const booking = await bookReq(app, patient, a, quote.body.data.quoteToken);
  return { quote, booking };
}

/** Test-only clock shift: native collection bypasses the immutability hooks on purpose. */
export async function timeTravel(
  bookingId: string,
  fields: Partial<{
    startDateTime: Date;
    endDateTime: Date;
    holdExpiresAt: Date;
    nurseResponseDeadline: Date;
  }>,
): Promise<void> {
  await Booking.collection.updateOne(
    { _id: new Booking.base.Types.ObjectId(bookingId) },
    { $set: fields },
  );
}

/** Standard scenario: admin, two patients, one HOURLY service (40 AED/h), one verified nurse available 24/7. */
export async function baseWorld(app: Express) {
  const { createAdmin } = await import('./harness');
  const admin = await createAdmin(app);
  const serviceId = await mkService(app, admin);
  const nurse = await mkNurse(app, admin, { serviceIds: [serviceId] });
  const patient = await register(app, 'PATIENT');
  const patient2 = await register(app, 'PATIENT');
  return { admin, serviceId, nurse, patient, patient2, D: day(5) };
}
