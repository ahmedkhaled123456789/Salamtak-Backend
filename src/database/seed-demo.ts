/**
 * PORTFOLIO DEMO DATA — a realistic, fully consistent dataset for showing CareFlow (website, dashboard, app).
 *
 *   npm run seed:demo                                          # DRY RUN: target, plan and confirmation token
 *   SEED_DEMO_PASSWORD=… npm run seed:demo -- --apply          # local database
 *   SEED_DEMO_PASSWORD=… SEED_DUMMY_CONFIRM_TARGET=<token> [SEED_DUMMY_ALLOW_PROTECTED_DB=health] \
 *     npm run seed:demo -- --apply --allow-remote              # remote (e.g. the demo database on Atlas)
 *
 * Everything goes through the real domain services — validation, quotes, the booking state machine, the signed
 * payment-webhook pipeline (mock provider), refunds, wallets, reviews — so every number in the dashboard is one the
 * platform itself produced. Past activity is created with a simulated clock (only `Date` is moved; timers stay
 * real): a booking "made" 40 days ago is quoted, paid, accepted, started and completed at those simulated times.
 * Nothing is written with raw database updates.
 *
 * Creates (idempotent — a second run adds nothing):
 *   accounts  admin@, finance@, patient@ (+7 patients) and the 6 website nurses <slug>@careflow-demo.test,
 *             all with SEED_DEMO_PASSWORD (public by design: it is a demo)
 *   catalogue the website's 12 services (daily rates + photos) and 6 nurses (photos, offers, 24/7 availability)
 *   activity  ~25 bookings across every state, payments, refunds, reviews, wallet earnings, contact messages and
 *             newsletter subscribers
 * Also deactivates (does not delete) earlier `seed-*` test services so only the polished catalogue is public.
 * Pictures go to the configured storage (STORAGE_PROVIDER; GridFS by default so they live in the same database).
 * Same safety gates as seed:dummy: --apply, never NODE_ENV=production, protected databases, and for a remote target
 * --allow-remote plus a confirmation token for that exact host + database.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import type { DateTime as LuxonDateTime } from 'luxon';
import {
  assertDedicatedConfig,
  assertRequiredDatabase,
  assertWriteAllowed,
  confirmationToken,
  parseMongoTarget,
  redactedHosts,
  SeedRefusedError,
} from './dummy/target';

dotenv.config({ quiet: true });

const WEBSITE = resolve(__dirname, '../../../website');
const DOMAIN = 'careflow-demo.test';
const MAX_DAYS = 14;
const CATEGORY = { elderly: 'ELDERLY_CARE', recovery: 'POST_SURGERY', nursing: 'NURSING', 'daily-living': 'DAILY_ASSISTANCE' } as const;

interface Loc {
  en: string;
  ar: string;
}
interface SiteService {
  id: string;
  slug: string;
  category: keyof typeof CATEGORY;
  title: Loc;
  description: Loc;
  image: string;
  dailyRateSample: number | null;
  minDays: number;
  maxDays: number;
  popularity: number;
}
interface SiteNurse {
  id: string;
  slug: string;
  name: Loc;
  role: Loc;
  gender: 'female' | 'male';
  portrait: string;
  bio: Loc;
  city: Loc;
  serviceIds: string[];
  languages: Loc[];
  experienceYears?: number;
  dailyRateSample?: number;
}
interface Emirate {
  id: string;
  name: Loc;
  latitude: number;
  longitude: number;
}

const PATIENTS: [string, string, 'MALE' | 'FEMALE', string][] = [
  ['Mariam', 'Al Mansoori', 'FEMALE', 'dubai'],
  ['Omar', 'Haddad', 'MALE', 'abu-dhabi'],
  ['Fatima', 'Rahman', 'FEMALE', 'sharjah'],
  ['Khalid', 'Al Suwaidi', 'MALE', 'dubai'],
  ['Layla', 'Nasser', 'FEMALE', 'abu-dhabi'],
  ['Yousef', 'Karim', 'MALE', 'dubai'],
  ['Noura', 'Al Hashimi', 'FEMALE', 'sharjah'],
  ['Hassan', 'Farouk', 'MALE', 'abu-dhabi'],
];
const STREETS = ['Al Wasl Road, Villa 14', 'Corniche Road, Tower B, Apt 1203', 'Al Khan Street, Building 7', 'Jumeirah 1, Street 18, Villa 3'];
const REVIEWS: [number, string][] = [
  [5, 'Very professional and kind with my mother. She looked forward to every visit.'],
  [5, 'Punctual, calm and explained everything clearly after the surgery.'],
  [4, 'Great care. Communication about the schedule could have been a little faster.'],
  [5, 'ممرضة رائعة، اهتمت بوالدي بكل احترام وصبر.'],
  [5, 'Made the first week home from hospital so much easier for the whole family.'],
  [4, 'Kind and skilled. Would book again.'],
  [3, 'Good care overall, but arrived late on the second day.'],
  [5, 'خدمة ممتازة ومتابعة دقيقة للأدوية.'],
  [5, 'Excellent wound care and very hygienic.'],
  [4, 'Friendly companion for my grandmother, she enjoyed the walks.'],
];
const CONTACTS = [
  { name: 'Sara Ahmed', email: 'sara.ahmed@example.com', topic: 'CARE', message: 'Do you offer overnight care for a parent with dementia in Dubai Marina? We need help for about two weeks.' },
  { name: 'Dr. Rami Saleh', email: 'rami.saleh@example.com', topic: 'PARTNER', message: 'I am a registered nurse with 9 years in ICU and would like to join CareFlow as a professional. How does verification work?' },
  { name: 'Huda Khalil', email: 'huda.khalil@example.com', topic: 'BOOKING', message: 'I need to change the start date of my booking by one day. Is that possible without cancelling?' },
] as const;

const loadModule = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(resolve(WEBSITE, rel)).href)) as T;
function imageFile(publicPath: string) {
  const buffer = readFileSync(resolve(WEBSITE, 'public', publicPath.replace(/^\//, '')));
  return { originalname: publicPath.split('/').pop()!, mimetype: 'image/jpeg', buffer, size: buffer.length };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const allowRemote = process.argv.includes('--allow-remote');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  const target = parseMongoTarget(uri);
  assertRequiredDatabase(target, process.env);
  let dotenvValues: Record<string, string> = {};
  try {
    dotenvValues = dotenv.parse(readFileSync('.env'));
  } catch {
    /* no .env */
  }
  assertDedicatedConfig(process.env, dotenvValues);
  console.log('TARGET (credentials never shown)');
  console.log(`  hosts    : ${redactedHosts(target)}`);
  console.log(`  database : ${target.database} (${target.local ? 'local' : 'REMOTE'})`);
  console.log(`  confirm  : ${confirmationToken(target)}   <- SEED_DUMMY_CONFIRM_TARGET for a remote write`);
  console.log('PLAN: accounts (admin, finance, 8 patients, 6 nurses), 12 services + photos, ~23 bookings with payments,');
  console.log('      refunds, reviews and earnings, contact messages, newsletter subscribers; hide seed-* services and nurses.');
  if (!apply) {
    console.log('DRY RUN - nothing was written. Add --apply (and --allow-remote for a remote target).');
    return;
  }
  assertWriteAllowed(target, { apply, allowRemote }, process.env);
  const password = process.env.SEED_DEMO_PASSWORD ?? '';
  if (password.length < 10) throw new SeedRefusedError('SEED_DEMO_PASSWORD (10+ characters) is required: it is the demo accounts\' password');
  if ((process.env.PAYMENT_PROVIDER ?? 'mock') !== 'mock') throw new SeedRefusedError('demo data is paid with the mock provider only');
  // configuration for THIS process (must be set before the app modules read it)
  process.env.PAYMENT_PROVIDER = 'mock';
  process.env.REDIS_URL = 'memory';
  process.env.RATE_LIMIT_STORE = 'memory';
  process.env.STORAGE_PROVIDER ||= 'gridfs';
  process.env.EMAIL_PROVIDER = 'none';
  process.env.SMS_PROVIDER = 'none';

  const FakeTimers = await import('@sinonjs/fake-timers');
  const { DateTime } = await import('luxon');
  const bcrypt = (await import('bcryptjs')).default;
  const { assertReplicaSet, disconnectDatabase, initModels, withTransaction } = await import('../config/database');
  const mongoose = (await import('mongoose')).default;
  const { env } = await import('../config/env');
  const { setQueueBackend, MemoryQueueBackend } = await import('../queues');
  const { Service, ServiceCatalog, NurseOffers } = await import('../modules/services');
  const { PricingService } = await import('../modules/pricing');
  const { FileService } = await import('../modules/files');
  const { User } = await import('../modules/users');
  const { NurseService, NurseProfile } = await import('../modules/nurses');
  const { PatientService } = await import('../modules/patients');
  const { AvailabilityService } = await import('../modules/availability');
  const { SettingsService } = await import('../modules/settings');
  const { Booking, BookingService } = await import('../modules/bookings');
  const { PaymentService } = await import('../modules/payments');
  const { PaymentWebhookService, registerFinancialHooks, runFinanceSweeps } = await import('../modules/finance');
  const { registerNotificationHooks } = await import('../modules/notifications');
  const { registerCouponHooks } = await import('../modules/coupons');
  const { ReviewService } = await import('../modules/reviews');
  const { InboxService } = await import('../modules/inbox');
  const { AdminService } = await import('../modules/admin');
  const { MockPaymentProvider, getPaymentProvider } = await import('../providers/payment');

  const services = (await loadModule<{ services: SiteService[] }>('src/data/services.ts')).services;
  const siteNurses = (await loadModule<{ nurses: SiteNurse[] }>('src/data/nurses.ts')).nurses;
  const emirates = (await loadModule<{ emirates: Emirate[] }>('src/data/emirates.ts')).emirates;
  const emirate = (idOrName: string) => emirates.find((e) => e.id === idOrName || e.name.en === idOrName) ?? emirates[0]!;

  setQueueBackend(new MemoryQueueBackend()); // follow-up work is done by the explicit sweeps at the end
  registerFinancialHooks();
  registerNotificationHooks();
  registerCouponHooks();
  const provider = getPaymentProvider();
  if (!(provider instanceof MockPaymentProvider)) throw new Error('mock payment provider expected');

  // Mongoose judges liveness from the driver's last heartbeat time; under the simulated clock one side reads the fake
  // Date and the other the real one. A heartbeat interval longer than the run keeps every comparison on real time.
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000, heartbeatFrequencyMS: 2_000_000_000 });
  await assertReplicaSet();
  const passwordHash = await bcrypt.hash(password, env.BCRYPT_COST);
  const made: Record<string, number> = {};
  const count = (k: string) => (made[k] = (made[k] ?? 0) + 1);
  try {
    await initModels();

    /* ----------------------------------------- accounts ----------------------------------------- */
    async function account(email: string, role: 'ADMIN' | 'FINANCE_APPROVER' | 'PATIENT' | 'NURSE', first: string, last: string, phone: string, gender?: 'MALE' | 'FEMALE') {
      const found = await User.findOne({ email });
      if (found) return found;
      const user = await withTransaction(async (session) => {
        const [u] = await User.create(
          [{ firstName: first, lastName: last, email, phone, role, gender, passwordHash, isVerified: true, emailVerifiedAt: new Date(), phoneVerifiedAt: new Date() }],
          { session },
        );
        if (role === 'PATIENT') await PatientService.createEmpty(String(u!._id), session);
        if (role === 'NURSE') await NurseService.createEmpty(String(u!._id), session);
        return u!;
      });
      count(`accounts.${role.toLowerCase()}`);
      return user;
    }
    const admin = await account(`admin@${DOMAIN}`, 'ADMIN', 'Demo', 'Admin', '+971500990001');
    await account(`finance@${DOMAIN}`, 'FINANCE_APPROVER', 'Demo', 'Finance', '+971500990002');
    const adminId = String(admin._id);
    await SettingsService.set('booking.maxDurationHours', MAX_DAYS * 24, adminId);

    const patients: { userId: string; emirate: Emirate; address: string }[] = [];
    for (const [i, [first, last, gender, em]] of PATIENTS.entries()) {
      const email = i === 0 ? `patient@${DOMAIN}` : `patient${i + 1}@${DOMAIN}`;
      const u = await account(email, 'PATIENT', first, last, `+97150010${String(i + 1).padStart(4, '0')}`, gender);
      const place = emirate(em);
      const address = `${STREETS[i % STREETS.length]}, ${place.name.en}`;
      await PatientService.update(String(u._id), {
        address,
        city: place.name.en,
        country: 'AE',
        location: { latitude: place.latitude, longitude: place.longitude },
      } as never);
      patients.push({ userId: String(u._id), emirate: place, address });
    }

    /* ----------------------------------------- catalogue ----------------------------------------- */
    const serviceIdBySiteId = new Map<string, string>();
    const ranked = [...services].sort((a, b) => b.popularity - a.popularity);
    for (const [i, s] of ranked.entries()) {
      let doc = await Service.findOne({ slug: s.slug });
      const fields = {
        name: s.title.en,
        slug: s.slug,
        description: s.description.en.slice(0, 2000),
        category: CATEGORY[s.category],
        billingUnit: 'DAILY' as const,
        minDurationMinutes: s.minDays * 1440,
        maxDurationMinutes: Math.min(s.maxDays, MAX_DAYS) * 1440,
        sortOrder: i,
      };
      if (!doc) {
        doc = await ServiceCatalog.create(fields, { actorId: adminId, actorRole: 'ADMIN' });
        count('services');
      }
      const id = String(doc._id);
      if (!doc.isActive) await ServiceCatalog.setActive(id, true, { actorId: adminId, actorRole: 'ADMIN' });
      if (s.dailyRateSample != null) {
        const active = await PricingService.activeRates(id, new Date());
        if (active.DAILY?.amountMinor !== s.dailyRateSample * 100)
          await PricingService.publishPrice(id, { kind: 'DAILY', amountMinor: s.dailyRateSample * 100 }, adminId);
      }
      if (!doc.imageId) {
        await ServiceCatalog.setImage(id, adminId, imageFile(s.image), { actorId: adminId, actorRole: 'ADMIN' });
        count('service photos');
      }
      serviceIdBySiteId.set(s.id, id);
    }
    // earlier test services (`seed-*`) stay in the database but leave the public catalogue
    for (const old of await Service.find({ slug: /^seed-/, isActive: true })) {
      await ServiceCatalog.setActive(String(old._id), false, { actorId: adminId, actorRole: 'ADMIN' });
      count('test services deactivated');
    }
    // ...and their test nurses (no photos) leave the public nurse list: the admin "suspend" action, audited,
    // undone with "reactivate" in the dashboard
    const testNurseUsers = await User.find({ role: 'NURSE', email: /^seed\.nurse\./ }).select('_id').lean();
    for (const p of await NurseProfile.find({ userId: { $in: testNurseUsers.map((u) => u._id) }, status: { $ne: 'SUSPENDED' } })) {
      await AdminService.suspendNurse(String(p._id), 'Earlier test account - hidden from the portfolio demo', { actorId: adminId, actorRole: 'ADMIN' });
      count('test nurses suspended');
    }

    const nurses: { userId: string; profileId: string; serviceIds: string[]; emirate: Emirate }[] = [];
    for (const [i, n] of siteNurses.entries()) {
      const [first, ...rest] = n.name.en.split(' ');
      const user = await account(`${n.slug}@${DOMAIN}`, 'NURSE', first!, rest.join(' ') || first!, `+97155510${String(i + 1).padStart(4, '0')}`, n.gender === 'male' ? 'MALE' : 'FEMALE');
      const userId = String(user._id);
      const place = emirate(n.city.en);
      await NurseService.update(userId, {
        bio: n.bio.en,
        yearsOfExperience: n.experienceYears ?? 5,
        specializations: [n.role.en.toLowerCase()],
        languages: n.languages.map((l) => l.en.toLowerCase()),
        gender: n.gender === 'male' ? 'MALE' : 'FEMALE',
        ...(n.dailyRateSample != null && { dailyRateMinor: n.dailyRateSample * 100 }),
        serviceRadiusKm: 150, // covers Dubai, Sharjah and Abu Dhabi for the demo
        location: { latitude: place.latitude, longitude: place.longitude },
        address: `${place.name.en} base`,
        city: place.name.en,
        country: 'AE',
      } as never);
      const profile = (await NurseProfile.findOne({ userId: user._id }))!;
      const profileId = String(profile._id);
      if (profile.verificationStatus !== 'VERIFIED') await NurseService.setVerification(profileId, 'VERIFIED', undefined);
      const offered = n.serviceIds.map((sid) => serviceIdBySiteId.get(sid)).filter((x): x is string => !!x);
      await NurseOffers.replace(profileId, offered.map((serviceId) => ({ serviceId, ...(n.dailyRateSample != null && { dailyRateMinor: n.dailyRateSample * 100 }) })));
      if ((await AvailabilityService.list(profileId)).length === 0)
        for (let d = 1; d <= 7; d++) await AvailabilityService.create(profileId, { kind: 'WEEKLY', dayOfWeek: d, startTime: '00:00', endTime: '24:00' } as never);
      if (!user.profileImage) {
        const img = await FileService.replacePublicImage(userId, 'PROFILE_IMAGE', imageFile(n.portrait), user.profileImage);
        await User.updateOne({ _id: user._id }, { $set: { profileImage: img._id } });
        count('nurse photos');
      }
      nurses.push({ userId, profileId, serviceIds: offered, emirate: place });
    }

    /* ----------------------------------------- activity ----------------------------------------- */
    const demoPatientIds = patients.map((p) => p.userId);
    if ((await Booking.countDocuments({ patientId: { $in: demoPatientIds } })) > 0) {
      console.log('activity: already present (skipped)');
    } else {
      const REAL_NOW = Date.now();
      const clock = FakeTimers.withGlobal(globalThis).install({ now: REAL_NOW, toFake: ['Date'] });
      const at = (d: LuxonDateTime) => clock.setSystemTime(d.toJSDate());
      const today = DateTime.fromMillis(REAL_NOW).setZone(env.PLATFORM_TIMEZONE).startOf('day');
      try {
        let k = 0;
        /** One booking through the real flow. `startOffset` in days from today (negative = past). */
        const run = async (opts: {
          startOffset: number;
          days: number;
          outcome: 'completed' | 'cancelled-early' | 'cancelled-late' | 'rejected' | 'in-progress' | 'confirmed' | 'awaiting-nurse';
          review?: boolean;
        }) => {
          const p = patients[k % patients.length]!;
          const n = nurses[k % nurses.length]!;
          const serviceId = n.serviceIds[k % n.serviceIds.length]!;
          k += 1;
          // respect the service's own duration limits (the API enforces them)
          const svc = (await Service.findById(serviceId).lean())!;
          const days = Math.min(Math.max(opts.days, Math.ceil(svc.minDurationMinutes / 1440)), Math.floor(svc.maxDurationMinutes / 1440));
          const start = today.plus({ days: opts.startOffset }).set({ hour: 9 });
          const end = start.plus({ days });
          at(start.minus({ days: 5, hours: 3 })); // booked a few days ahead
          const req = { serviceId, nurseId: n.profileId, startDateTime: start.toJSDate(), endDateTime: end.toJSDate() };
          const quote = await BookingService.quote(p.userId, { ...req, location: { latitude: p.emirate.latitude, longitude: p.emirate.longitude } });
          const booking = await BookingService.create(p.userId, {
            ...req,
            location: { latitude: p.emirate.latitude, longitude: p.emirate.longitude, address: p.address, city: p.emirate.name.en, country: 'AE' },
            notes: k % 3 === 0 ? 'Please call when you arrive; the building has a visitor parking.' : undefined,
            quoteToken: quote.quoteToken,
          } as never);
          const id = String(booking._id);
          count('bookings');
          // pay: the mock provider's signed webhook through the real pipeline
          at(start.minus({ days: 5, hours: 2, minutes: 50 }));
          const created = await PaymentService.create(p.userId, id);
          const signed = provider.signEvent('payment.succeeded', {
            providerTransactionId: created.payment.providerTransactionId!,
            amountMinor: created.payment.amountMinor,
            currency: created.payment.currency,
          });
          provider.markPaid(created.payment.providerTransactionId!);
          await PaymentWebhookService.handle(signed.rawBody, signed.headers);
          count('payments');
          if (opts.outcome === 'awaiting-nurse') return;
          at(start.minus({ days: 5, hours: 1 }));
          if (opts.outcome === 'rejected') {
            await BookingService.reject(id, n.userId, 'Not available on these dates');
            return;
          }
          await BookingService.accept(id, n.userId);
          if (opts.outcome === 'confirmed') return;
          if (opts.outcome === 'cancelled-early' || opts.outcome === 'cancelled-late') {
            at(opts.outcome === 'cancelled-early' ? start.minus({ days: 3 }) : start.minus({ hours: 30 }));
            await BookingService.cancelByPatient(id, p.userId, 'Plans changed');
            count('cancellations');
            return;
          }
          at(start.plus({ minutes: 20 }));
          await BookingService.start(id, n.userId);
          if (opts.outcome === 'in-progress') return;
          at(end.plus({ hours: 1 }));
          await BookingService.complete(id, n.userId);
          if (opts.review) {
            const [rating, comment] = REVIEWS[k % REVIEWS.length]!;
            at(end.plus({ days: 1, hours: 2 }));
            await ReviewService.create(p.userId, id, { rating, comment });
            count('reviews');
          }
        };

        // ~2 months of history, then what is happening now and next (non-overlapping per nurse: each nurse is used
        // every 6th booking, and each run is spaced 4 days from the previous one of the same nurse)
        const history = [
          -62, -58, -55, -51, -48, -44, -41, -37, -34, -30, -27, -23, -20, -16,
        ];
        for (const [i, off] of history.entries()) await run({ startOffset: off, days: 1 + (i % 3), outcome: 'completed', review: i % 7 !== 3 });
        await run({ startOffset: -12, days: 2, outcome: 'cancelled-early' });
        await run({ startOffset: -9, days: 1, outcome: 'cancelled-late' });
        await run({ startOffset: -8, days: 2, outcome: 'rejected' });
        await run({ startOffset: -1, days: 3, outcome: 'in-progress' });
        await run({ startOffset: 3, days: 2, outcome: 'confirmed' });
        await run({ startOffset: 6, days: 1, outcome: 'confirmed' });
        await run({ startOffset: 9, days: 3, outcome: 'confirmed' });
        await run({ startOffset: 12, days: 2, outcome: 'awaiting-nurse' });
        await run({ startOffset: 16, days: 1, outcome: 'awaiting-nurse' });

        // contact form and newsletter (a few weeks back)
        at(today.minus({ days: 6 }).set({ hour: 11 }));
        for (const c of CONTACTS) {
          await InboxService.submitContact({ ...c, locale: 'en' });
          count('contact messages');
        }
        for (const [i, email] of ['amina.k@example.com', 'r.daoud@example.com', 'salma.n@example.com', 'jassim.t@example.com', 'lina.m@example.com'].entries()) {
          await InboxService.importConfirmed(email, i % 2 ? 'ar' : 'en', today.minus({ days: 20 - i * 3 }).toJSDate());
          count('newsletter subscribers');
        }
      } finally {
        clock.uninstall();
      }
    }

    // the platform's own time-driven work at the real current time: refunds, earnings release, expiries
    const sweeps = await runFinanceSweeps(new Date());
    console.log('sweeps:', JSON.stringify(sweeps));
    console.log('created:', JSON.stringify(made));
    console.log(`Done. Demo logins: admin@${DOMAIN}, finance@${DOMAIN}, patient@${DOMAIN}, <nurse-slug>@${DOMAIN} (password: SEED_DEMO_PASSWORD).`);
  } finally {
    await disconnectDatabase();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof SeedRefusedError ? `REFUSED: ${err.message}` : err);
  process.exit(1);
});
