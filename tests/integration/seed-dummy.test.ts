import mongoose from 'mongoose';
import { COUPONS, HOLIDAYS, SERVICES, bookingMarker } from '../../src/database/dummy/data';
import { runDummySeed } from '../../src/database/dummy/seed';
import { parseMongoTarget } from '../../src/database/dummy/target';
import { NurseAvailability } from '../../src/modules/availability';
import { AuthService } from '../../src/modules/auth';
import { Booking, BookingItem, BookingReservation } from '../../src/modules/bookings';
import { Coupon } from '../../src/modules/coupons';
import { NurseProfile } from '../../src/modules/nurses';
import { PatientProfile } from '../../src/modules/patients';
import { Holiday, ServicePrice } from '../../src/modules/pricing';
import { NurseServiceOffer, Service } from '../../src/modules/services';
import { User } from '../../src/modules/users';
import { connectDatabase, initModels } from '../../src/config/database';
import { resetState, stopApp } from '../helpers/harness';

/** Models that hold money, provider traffic, messaging or credentials: the seeder must never create a row in any. */
const MUST_STAY_EMPTY = [
  'Payment',
  'PaymentWebhook',
  'Refund',
  'Payout',
  'PayoutMethod',
  'Wallet',
  'WalletTransaction',
  'WalletAdjustment',
  'Notification',
  'DeviceToken',
  'Conversation',
  'Message',
  'EmergencyRequest',
  'EmergencyOffer',
  'Review',
  'FileObject',
  'NurseDocument',
  'RefreshToken',
  'OneTimeToken',
  'CouponRedemption',
  'CouponUserUsage',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = mongoose.Model<any>;
const snapshot = async (...models: AnyModel[]) =>
  JSON.stringify(await Promise.all(models.map(async (m) => m.find({}).sort({ _id: 1 }).lean())));

beforeAll(async () => {
  // Exactly what src/database/seed-dummy.ts does: connect + init models. No createApp(), so no notification /
  // financial hooks are registered and no e-mail/SMS/push work can be queued as a side effect.
  await connectDatabase();
  await initModels();
});
afterAll(async () => {
  await stopApp();
});
beforeEach(async () => {
  await resetState();
});

describe('dummy seeder (disposable local database only)', () => {
  it('is running against the disposable test database, never a remote one', () => {
    const t = parseMongoTarget(process.env.MONGODB_URI as string);
    expect(t.local).toBe(true);
    expect(t.database).toMatch(/^care_test_/);
  });

  it('creates valid, consistent data; a second run creates and changes nothing; unrelated rows are untouched', async () => {
    // Pre-existing NON-seed records that must come out byte-identical.
    const control = await User.create({
      firstName: 'Control',
      lastName: 'Person',
      email: 'control.person@example.test',
      phone: '+971500009999',
      passwordHash: 'x',
      role: 'PATIENT',
    });
    const controlCoupon = (await Coupon.create({
      code: 'CONTROLCODE',
      type: 'FIXED',
      valueMinor: 100,
      startAt: new Date(),
      endAt: new Date(Date.now() + 86_400_000),
      active: true,
    } as never)) as unknown as { _id: unknown };
    const controlService = (await Service.create({
      name: 'Control Service',
      slug: 'control-service',
      category: 'OTHER',
      billingUnit: 'HOURLY',
      minDurationMinutes: 60,
      maxDurationMinutes: 120,
    } as never)) as unknown as { _id: unknown };
    const controlHoliday = await Holiday.create({ date: '2027-06-06', name: 'Control holiday' });
    const controlBefore = JSON.stringify(
      await Promise.all([
        User.findById(control._id).lean(),
        Coupon.findById(controlCoupon._id).lean(),
        Service.findById(controlService._id).lean(),
        Holiday.findById(controlHoliday._id).lean(),
      ]),
    );

    const first = await runDummySeed();
    expect(first.skipped).toEqual([]);

    /* ---------------------------------- planned counts ---------------------------------- */
    const seedUsers = { email: /^seed\.(patient|nurse)\.\d\d@example\.test$/ };
    expect(await User.countDocuments({ ...seedUsers, role: 'PATIENT' })).toBe(10);
    expect(await User.countDocuments({ ...seedUsers, role: 'NURSE' })).toBe(10);
    expect(await PatientProfile.countDocuments()).toBe(10);
    expect(await NurseProfile.countDocuments()).toBe(10);
    expect(await Service.countDocuments({ slug: /^seed-/ })).toBe(SERVICES.length);
    expect(await ServicePrice.countDocuments()).toBe(SERVICES.length);
    expect(await NurseServiceOffer.countDocuments()).toBe(30);
    expect(await NurseAvailability.countDocuments()).toBe(8 * 7); // verified nurses only
    expect(await Holiday.countDocuments({ name: /^Seed: / })).toBe(HOLIDAYS.length);
    expect(await Coupon.countDocuments({ code: /^SEED/ })).toBe(COUPONS.length);
    expect(await Booking.countDocuments()).toBe(10);

    /* ----------------------------- identity / privacy of the data ----------------------------- */
    const users = await User.find(seedUsers).lean();
    expect(
      users.every((u) => u.email.endsWith('@example.test') && u.phone.startsWith('+97155500')),
    ).toBe(true);
    expect(users.every((u) => u.isVerified && u.isActive)).toBe(true);
    // no health information in any profile: patient `notes` is never set
    expect((await PatientProfile.find().lean()).every((p) => p.notes === undefined)).toBe(true);

    /* -------------------------------- nurse states are valid -------------------------------- */
    const nurses = await NurseProfile.find().lean();
    expect(nurses.filter((n) => n.verificationStatus === 'VERIFIED').length).toBe(8);
    expect(nurses.filter((n) => n.verificationStatus === 'UNDER_REVIEW').length).toBe(1);
    expect(nurses.filter((n) => n.verificationStatus === 'PENDING').length).toBe(1);
    // bookable <=> verified AND active (the model's own rule), never true for the others
    for (const n of nurses)
      expect(n.isBookable).toBe(n.verificationStatus === 'VERIFIED' && n.status === 'ACTIVE');

    /* ------------------------------------ references ------------------------------------ */
    const patientIds = new Set((await User.find({ role: 'PATIENT' }).distinct('_id')).map(String));
    const nurseById = new Map(nurses.map((n) => [String(n._id), n]));
    const serviceIds = new Set((await Service.find().distinct('_id')).map(String));
    for (const o of await NurseServiceOffer.find().lean()) {
      expect(nurseById.has(String(o.nurseId))).toBe(true);
      expect(serviceIds.has(String(o.serviceId))).toBe(true);
    }
    for (const p of await ServicePrice.find().lean())
      expect(serviceIds.has(String(p.serviceId))).toBe(true);
    for (const a of await NurseAvailability.find().lean())
      expect(nurseById.get(String(a.nurseId))?.verificationStatus).toBe('VERIFIED');

    /* ------------------- bookings: valid, reserved, unpaid, financially sane ------------------- */
    const bookings = await Booking.find().lean();
    const offers = await NurseServiceOffer.find().lean();
    for (const b of bookings) {
      expect(b.status).toBe('PAYMENT_PENDING'); // nothing is ever marked paid
      expect(patientIds.has(String(b.patientId))).toBe(true);
      expect(nurseById.get(String(b.nurseId))?.verificationStatus).toBe('VERIFIED');
      expect(
        offers.some(
          (o) =>
            String(o.nurseId) === String(b.nurseId) && String(o.serviceId) === String(b.serviceId),
        ),
      ).toBe(true);
      expect(b.startDateTime.getTime()).toBeGreaterThan(Date.now());
      expect(b.endDateTime.getTime()).toBeGreaterThan(b.startDateTime.getTime());
      expect(b.notes).toMatch(/^\[seed:dummy-v1\] Fictional booking \d\d$/);
      expect(b.holdExpiresAt).toBeTruthy();
      // every money figure is an integer number of fils and the payable amount equals gross minus discount
      const doc = b as unknown as {
        pricingSnapshot: { grossMinor: number; discountMinor: number; patientPayableMinor: number };
        financialSnapshot: {
          grossMinor: number;
          commissionMinor: number;
          nurseEarningMinor: number;
          patientPaidMinor: number;
        };
      };
      const p = doc.pricingSnapshot;
      const f = doc.financialSnapshot;
      for (const v of [
        p.grossMinor,
        p.discountMinor,
        p.patientPayableMinor,
        f.commissionMinor,
        f.nurseEarningMinor,
      ])
        expect(Number.isInteger(v)).toBe(true);
      expect(p.patientPayableMinor).toBe(p.grossMinor - p.discountMinor);
      // the server's own split: with no discount, commission + nurse earning accounts for the whole gross amount
      expect(f.commissionMinor + f.nurseEarningMinor).toBe(f.grossMinor);
      expect(f.grossMinor).toBe(p.grossMinor);
    }
    expect(new Set(bookings.map((b) => b.bookingNumber)).size).toBe(10);
    // each booking holds its nurse's time slots (a 2 h booking at 15-min slots = 8); no slot is double-held
    const reservations = await BookingReservation.find().lean();
    expect(reservations.length).toBe(10 * 8);
    expect(reservations.every((r) => r.state === 'HELD')).toBe(true);
    expect(new Set(reservations.map((r) => `${r.nurseId}:${r.slotStart.toISOString()}`)).size).toBe(
      reservations.length,
    );
    for (const b of bookings)
      expect(reservations.filter((r) => String(r.bookingId) === String(b._id)).length).toBe(8);
    expect(await BookingItem.countDocuments()).toBeGreaterThanOrEqual(10);

    /* ------------------------- nothing touches money, providers or credentials ------------------------- */
    for (const name of MUST_STAY_EMPTY) {
      const m = mongoose.models[name];
      if (m)
        expect({ model: name, rows: await m.countDocuments() }).toEqual({ model: name, rows: 0 });
    }
    // dummy accounts cannot sign in unless an operator opted in with SEED_DUMMY_PASSWORD
    await expect(
      AuthService.login('seed.patient.01@example.test', 'Passw0rd-guess-1', {}),
    ).rejects.toBeTruthy();

    /* ---------------------------------- uniqueness is enforced ---------------------------------- */
    await expect(
      User.create({
        firstName: 'Dup',
        lastName: 'Dup',
        email: 'seed.patient.01@example.test',
        phone: '+971500008888',
        passwordHash: 'x',
        role: 'PATIENT',
      }),
    ).rejects.toThrow(/duplicate|E11000/i);
    await expect(Holiday.create({ date: HOLIDAYS[0]!.date, name: 'dup' })).rejects.toThrow(
      /duplicate|E11000/i,
    );
    await expect(
      Coupon.create({
        code: COUPONS[0]!.code,
        type: 'FIXED',
        valueMinor: 1,
        startAt: new Date(),
        endAt: new Date(Date.now() + 1000),
      } as never),
    ).rejects.toThrow(/duplicate|E11000/i);

    /* ------------------------ second run: no duplicates, no change at all ------------------------ */
    const models = [
      User,
      PatientProfile,
      NurseProfile,
      Service,
      ServicePrice,
      NurseServiceOffer,
      NurseAvailability,
      Holiday,
      Coupon,
      Booking,
      BookingItem,
      BookingReservation,
    ] as AnyModel[];
    const afterFirst = await snapshot(...models);
    const second = await runDummySeed();
    expect(second.created).toEqual({}); // nothing created
    expect(second.existing.bookings).toBe(10);
    expect(await snapshot(...models)).toBe(afterFirst); // every document byte-identical (incl. updatedAt)
    for (let i = 1; i <= 10; i++)
      expect(await Booking.countDocuments({ notes: bookingMarker(i) })).toBe(1);

    /* --------------------------------- unrelated data untouched --------------------------------- */
    const controlAfter = JSON.stringify(
      await Promise.all([
        User.findById(control._id).lean(),
        Coupon.findById(controlCoupon._id).lean(),
        Service.findById(controlService._id).lean(),
        Holiday.findById(controlHoliday._id).lean(),
      ]),
    );
    expect(controlAfter).toBe(controlBefore);
  });

  it('resumes safely after a partial run (users exist, nothing else)', async () => {
    await User.create({
      firstName: 'Layla',
      lastName: 'Haddad',
      email: 'seed.patient.01@example.test',
      phone: '+97155500101',
      passwordHash: 'x',
      role: 'PATIENT',
    });
    const report = await runDummySeed();
    expect(report.existing['users.patient']).toBe(1);
    expect(report.created['users.patient']).toBe(9);
    expect(await User.countDocuments({ email: 'seed.patient.01@example.test' })).toBe(1);
  });

  it('skips a holiday date that already exists instead of overwriting it', async () => {
    await Holiday.create({ date: HOLIDAYS[0]!.date, name: 'Official holiday (not seed)' });
    const report = await runDummySeed();
    expect(report.created.holidays).toBe(HOLIDAYS.length - 1);
    expect((await Holiday.findOne({ date: HOLIDAYS[0]!.date }).lean())?.name).toBe(
      'Official holiday (not seed)',
    );
  });
});
