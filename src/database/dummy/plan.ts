import mongoose from 'mongoose';
import {
  COUPONS,
  HOLIDAYS,
  NURSES,
  NURSE_VERIFICATION,
  PATIENTS,
  SEED_COUNT,
  SERVICES,
  bookingMarker,
  seedEmail,
} from './data';

export interface SeedPlan {
  collectionsPresent: string[];
  totalDocumentsByCollection: Record<string, number>;
  rows: {
    model: string;
    target: number;
    existing: number;
    plannedInserts: number;
    note?: string;
  }[];
}

/**
 * READ-ONLY plan. Uses the raw driver (never mongoose models), so opening this connection cannot create a
 * collection or an index, and it issues only: listCollections, estimatedDocumentCount and countDocuments.
 * The "existing" figures count only rows that carry the seed identifiers; unrelated data is only counted, never read.
 */
export async function planDummySeed(uri: string): Promise<SeedPlan> {
  const client = new mongoose.mongo.MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
    appName: 'careflow-seed-plan-readonly',
  });
  await client.connect();
  try {
    const db = client.db();
    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((c) => c.name)
      .sort();
    const totals: Record<string, number> = {};
    for (const n of names) totals[n] = await db.collection(n).estimatedDocumentCount();

    const count = async (collection: string, filter: Record<string, unknown>) =>
      names.includes(collection) ? db.collection(collection).countDocuments(filter) : 0;

    const patientEmails = PATIENTS.map((_, i) => seedEmail('patient', i + 1));
    const nurseEmails = NURSES.map((_, i) => seedEmail('nurse', i + 1));
    const slugs = SERVICES.map((s) =>
      s.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, ''),
    );

    const existingPatients = await count('users', { email: { $in: patientEmails } });
    const existingNurses = await count('users', { email: { $in: nurseEmails } });
    const existingServices = await count('services', { slug: { $in: slugs } });
    const existingCoupons = await count('coupons', { code: { $in: COUPONS.map((c) => c.code) } });
    const existingHolidays = await count('holidays', {
      date: { $in: HOLIDAYS.map((h) => h.date) },
    });
    const existingBookings = await count('bookings', {
      notes: { $in: Array.from({ length: SEED_COUNT }, (_, i) => bookingMarker(i + 1)) },
    });
    const verifiedTarget = Object.values(NURSE_VERIFICATION).filter((v) => v === 'VERIFIED').length;

    const row = (model: string, target: number, existing: number, note?: string) => ({
      model,
      target,
      existing,
      plannedInserts: Math.max(target - existing, 0),
      note,
    });
    return {
      collectionsPresent: names,
      totalDocumentsByCollection: totals,
      rows: [
        row('users (PATIENT)', PATIENTS.length, existingPatients),
        row('users (NURSE)', NURSES.length, existingNurses),
        row(
          'patientProfiles',
          PATIENTS.length,
          existingPatients,
          'created together with each new patient user',
        ),
        row(
          'nurseProfiles',
          NURSES.length,
          existingNurses,
          'created with each new nurse user; then completed/verified through NurseService',
        ),
        row('services', SERVICES.length, existingServices),
        row(
          'servicePrices',
          SERVICES.length,
          existingServices,
          'one versioned HOURLY price per new service',
        ),
        row(
          'nurseServiceOffers',
          NURSES.length * 3,
          existingNurses * 3,
          '3 offers per nurse (one document per nurse/service pair)',
        ),
        row(
          'nurseAvailability',
          verifiedTarget * 7,
          existingNurses ? Math.min(existingNurses, verifiedTarget) * 7 : 0,
          '7 weekly rules per verified nurse',
        ),
        row(
          'holidays',
          HOLIDAYS.length,
          existingHolidays,
          'skipped if a holiday already exists on that date',
        ),
        row('coupons', COUPONS.length, existingCoupons),
        row(
          'bookings (+ items, histories, reservations)',
          SEED_COUNT,
          existingBookings,
          'PAYMENT_PENDING only; created via BookingService with its time-range reservation',
        ),
      ],
    };
  } finally {
    await client.close();
  }
}
