import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { DateTime } from 'luxon';
import { withTransaction } from '../../config/database';
import { env } from '../../config/env';
import { AvailabilityService } from '../../modules/availability';
import { Booking, BookingService } from '../../modules/bookings';
import { Coupon, CouponService } from '../../modules/coupons';
import { NurseProfile, NurseService } from '../../modules/nurses';
import { PatientProfile, PatientService } from '../../modules/patients';
import { Holiday, PricingService } from '../../modules/pricing';
import { NurseOffers, Service, ServiceCatalog } from '../../modules/services';
import { User } from '../../modules/users';
import {
  COUPONS,
  HOLIDAYS,
  LANGUAGES,
  LOCATIONS,
  NURSES,
  NURSE_VERIFICATION,
  PATIENTS,
  SEED_COUNT,
  SERVICES,
  SPECIALIZATIONS,
  bookingMarker,
  seedEmail,
  seedPhone,
} from './data';

export interface SeedReport {
  created: Record<string, number>;
  existing: Record<string, number>;
  skipped: string[];
}

const SYSTEM = { actorRole: 'SYSTEM' } as const;

/**
 * Idempotent dummy-data seeder (APPLY mode). Rules it follows:
 *  - find-or-create on a stable key; a second run creates nothing and changes no row;
 *  - it only ever updates rows it can prove are seed rows (e-mail `seed.*@example.test`, slug `seed-*`, `SEED*` code);
 *  - it goes through the real services (validation, state machine, reservations, versioned prices), never raw inserts
 *    for anything that has business rules;
 *  - it never touches payments, refunds, payouts, wallets or the ledger, never marks anything paid, never sends
 *    e-mail/SMS/push and never opens a provider connection.
 * Dummy accounts get an unguessable random password unless SEED_DUMMY_PASSWORD is set, so by default they cannot sign in.
 */
export async function runDummySeed(
  log: (line: string) => void = () => undefined,
): Promise<SeedReport> {
  const report: SeedReport = { created: {}, existing: {}, skipped: [] };
  const made = (k: string) => (report.created[k] = (report.created[k] ?? 0) + 1);
  const had = (k: string) => (report.existing[k] = (report.existing[k] ?? 0) + 1);

  const password = process.env.SEED_DUMMY_PASSWORD || randomBytes(24).toString('base64url');
  const passwordHash = await bcrypt.hash(password, env.BCRYPT_COST);

  /* ------------------------------- users + profiles ------------------------------- */
  async function ensureUser(
    role: 'PATIENT' | 'NURSE',
    n: number,
    first: string,
    last: string,
    gender: 'MALE' | 'FEMALE',
  ) {
    const email = seedEmail(role === 'PATIENT' ? 'patient' : 'nurse', n);
    const found = await User.findOne({ email });
    if (found) {
      had(`users.${role.toLowerCase()}`);
      return found;
    }
    const user = await withTransaction(async (session) => {
      const [u] = await User.create(
        [
          {
            firstName: first,
            lastName: last,
            email,
            phone: seedPhone(role === 'PATIENT' ? 'patient' : 'nurse', n),
            role,
            gender,
            passwordHash,
            isVerified: true,
            emailVerifiedAt: new Date(),
            phoneVerifiedAt: new Date(),
          },
        ],
        { session },
      );
      if (role === 'PATIENT') await PatientService.createEmpty(String(u!._id), session);
      else await NurseService.createEmpty(String(u!._id), session);
      return u!;
    });
    made(`users.${role.toLowerCase()}`);
    return user;
  }

  const patients: { userId: string }[] = [];
  for (let i = 0; i < SEED_COUNT; i++) {
    const [first, last] = PATIENTS[i]!;
    const u = await ensureUser('PATIENT', i + 1, first, last, i % 2 ? 'MALE' : 'FEMALE');
    const profile = await PatientProfile.findOne({ userId: u._id });
    if (profile && !profile.city) {
      const loc = LOCATIONS[i % LOCATIONS.length]!;
      await PatientService.update(String(u._id), {
        address: loc.address,
        city: loc.city,
        country: 'AE',
        location: { latitude: loc.latitude, longitude: loc.longitude },
        emergencyContact: {
          name: `${first} Contact (fictional)`,
          phone: `+97155509${String(i).padStart(3, '0')}`,
          relation: 'family',
        },
      });
      made('patientProfiles.completed');
    }
    patients.push({ userId: String(u._id) });
  }

  const nurses: { userId: string; profileId: string; verified: boolean }[] = [];
  for (let i = 0; i < SEED_COUNT; i++) {
    const [first, last] = NURSES[i]!;
    const u = await ensureUser('NURSE', i + 1, first, last, i === 6 || i === 9 ? 'MALE' : 'FEMALE');
    const profile = (await NurseProfile.findOne({ userId: u._id }))!;
    if (!profile.city) {
      await NurseService.update(String(u._id), {
        bio: 'Fictional seed nurse profile for dashboard testing.',
        yearsOfExperience: 2 + (i % 9),
        specializations: [
          SPECIALIZATIONS[i % SPECIALIZATIONS.length]!,
          SPECIALIZATIONS[(i + 2) % SPECIALIZATIONS.length]!,
        ],
        languages: LANGUAGES[i % LANGUAGES.length]!,
        gender: i === 6 || i === 9 ? 'MALE' : 'FEMALE',
        hourlyRateMinor: 5000 + (i % 4) * 500,
        serviceRadiusKm: 30,
        location: { latitude: 25.2 + (i % 5) * 0.01, longitude: 55.27 + (i % 3) * 0.01 },
        address: `Seed Base ${i + 1}`,
        city: 'Dubai',
        country: 'AE',
      });
      made('nurseProfiles.completed');
    }
    const target = NURSE_VERIFICATION[i];
    if (target) {
      const r = await NurseService.setVerification(String(profile._id), target, undefined);
      if (r.changed) made(`nurseProfiles.${target.toLowerCase()}`);
    }
    const fresh = (await NurseProfile.findById(profile._id))!;
    nurses.push({
      userId: String(u._id),
      profileId: String(profile._id),
      verified: fresh.verificationStatus === 'VERIFIED',
    });
  }

  /* ------------------------------ services + prices ------------------------------ */
  const serviceIds: string[] = [];
  for (const s of SERVICES) {
    const slug = s.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    let doc = await Service.findOne({ slug });
    if (doc) had('services');
    else {
      doc = await ServiceCatalog.create(
        {
          name: s.name,
          slug,
          category: s.category,
          billingUnit: 'HOURLY',
          minDurationMinutes: s.min,
          maxDurationMinutes: s.max,
          description: 'Fictional seed service.',
        },
        SYSTEM,
      );
      made('services');
    }
    if ((await PricingService.listPrices(String(doc._id))).length === 0) {
      await PricingService.publishPrice(String(doc._id), {
        kind: 'HOURLY',
        amountMinor: s.rateMinor,
      });
      made('servicePrices');
    } else had('servicePrices');
    serviceIds.push(String(doc._id));
  }

  /* ------------------------ nurse offers + weekly availability ------------------------ */
  for (let i = 0; i < nurses.length; i++) {
    const n = nurses[i]!;
    if ((await NurseOffers.list(n.profileId)).length === 0) {
      const picks = [
        serviceIds[i % serviceIds.length]!,
        serviceIds[(i + 1) % serviceIds.length]!,
        serviceIds[(i + 3) % serviceIds.length]!,
      ];
      await NurseOffers.replace(
        n.profileId,
        picks.map((serviceId) => ({ serviceId })),
      );
      made('nurseServiceOffers');
    } else had('nurseServiceOffers');
    if (n.verified) {
      if ((await AvailabilityService.list(n.profileId)).length === 0) {
        for (let d = 1; d <= 7; d++)
          await AvailabilityService.create(n.profileId, {
            kind: 'WEEKLY',
            dayOfWeek: d,
            startTime: '07:00',
            endTime: '21:00',
          } as never);
        made('nurseAvailability');
      } else had('nurseAvailability');
    }
  }

  /* ----------------------------------- holidays ----------------------------------- */
  for (const h of HOLIDAYS) {
    if (await Holiday.exists({ date: h.date })) {
      had('holidays');
      continue;
    }
    await Holiday.create(h);
    made('holidays');
  }

  /* ----------------------------------- coupons ----------------------------------- */
  const startAt = DateTime.now().startOf('day').toJSDate();
  const endAt = DateTime.now().plus({ days: 90 }).endOf('day').toJSDate();
  for (const c of COUPONS) {
    if (await Coupon.exists({ code: c.code })) {
      had('coupons');
      continue;
    }
    await CouponService.create({ ...c, startAt, endAt } as never, SYSTEM);
    made('coupons');
  }

  /* ---------------- bookings (PAYMENT_PENDING only; nothing is ever marked paid) ---------------- */
  const verified = nurses.filter((n) => n.verified);
  if (!verified.length) report.skipped.push('bookings: no verified nurse available');
  else {
    for (let i = 0; i < SEED_COUNT; i++) {
      const marker = bookingMarker(i + 1);
      if (await Booking.exists({ notes: marker })) {
        had('bookings');
        continue;
      }
      const patient = patients[i]!;
      const nurse = verified[i % verified.length]!;
      const nurseIdx = nurses.indexOf(nurse);
      const serviceId = serviceIds[(nurseIdx + (i % 2 === 0 ? 0 : 1)) % serviceIds.length]!; // one the nurse offers
      // 10:00–12:00 Dubai time on a distinct day 4..13 days ahead (clear of the minimum lead time, inside the advance window)
      const start = DateTime.now()
        .setZone(env.PLATFORM_TIMEZONE)
        .plus({ days: 4 + i })
        .set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
      const loc = LOCATIONS[i % LOCATIONS.length]!;
      const req = {
        serviceId,
        nurseId: nurse.profileId,
        startDateTime: start.toJSDate(),
        endDateTime: start.plus({ hours: 2 }).toJSDate(),
      };
      const quote = await BookingService.quote(patient.userId, {
        ...req,
        location: { latitude: loc.latitude, longitude: loc.longitude },
      });
      await BookingService.create(patient.userId, {
        ...req,
        location: {
          latitude: loc.latitude,
          longitude: loc.longitude,
          address: loc.address,
          city: loc.city,
          country: 'AE',
        },
        notes: marker,
        quoteToken: quote.quoteToken,
      });
      made('bookings');
      log(`booking ${i + 1} created`);
    }
  }
  return report;
}
