/**
 * Loads the website's catalogue (services + nurses + their photos) into the backend so the site can be served
 * by the API instead of its static files.
 *
 *   npm run seed:website                 # DRY RUN: prints what would be created, writes nothing
 *   npm run seed:website -- --apply      # LOCAL (loopback) database only; never a remote cluster
 *
 * Reads ../website/src/data/{services,nurses}.ts and the images in ../website/public, goes through the real
 * services (validation, versioned prices, verification rules) and uploads every picture through the same
 * public-image pipeline the admin endpoints use. Idempotent: services are matched by slug and nurses by e-mail
 * `<slug>@careflow-demo.test`; a re-run changes nothing unless a picture on disk changed.
 * Nurse accounts get an unguessable password (they cannot sign in) unless SEED_DUMMY_PASSWORD is set.
 * Requires an ADMIN account (npm run seed:admin) because service pictures are owned by an admin.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import {
  assertDedicatedConfig,
  assertRequiredDatabase,
  assertWriteAllowed,
  parseMongoTarget,
  redactedHosts,
  SeedRefusedError,
} from './dummy/target';

dotenv.config({ quiet: true });

const WEBSITE = resolve(__dirname, '../../../website');
const EMAIL_DOMAIN = 'careflow-demo.test';
const CATEGORY = {
  elderly: 'ELDERLY_CARE',
  recovery: 'POST_SURGERY',
  nursing: 'NURSING',
  'daily-living': 'DAILY_ASSISTANCE',
} as const;
/** The website's cities and where they are (the API checks the booking address against the nurse's service area). */
const CITIES: Record<string, { latitude: number; longitude: number }> = {
  Riyadh: { latitude: 24.7136, longitude: 46.6753 },
  Jeddah: { latitude: 21.4858, longitude: 39.1925 },
  Dammam: { latitude: 26.4207, longitude: 50.0888 },
};
const MAX_DAYS = 14; // schema cap on a service duration

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

const loadModule = async <T>(rel: string): Promise<T> =>
  (await import(pathToFileURL(resolve(WEBSITE, rel)).href)) as T;

function imageFile(publicPath: string) {
  const buffer = readFileSync(resolve(WEBSITE, 'public', publicPath.replace(/^\//, '')));
  return { originalname: publicPath.split('/').pop()!, mimetype: 'image/jpeg', buffer, size: buffer.length };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
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
  console.log(`Target: ${redactedHosts(target)} / ${target.database} (${target.local ? 'local' : 'REMOTE'})`);

  const mod = await loadModule<{ services: SiteService[] }>('src/data/services.ts');
  const nmod = await loadModule<{ nurses: SiteNurse[] }>('src/data/nurses.ts');
  const { services, } = mod;
  const { nurses } = nmod;

  if (!apply) {
    console.log(`DRY RUN: would upsert ${services.length} services (+ rate + picture) and ${nurses.length} nurses (+ photo, offers, availability).`);
    return;
  }
  assertWriteAllowed(target, { apply: true, allowRemote: false }, process.env);
  if (!target.local) throw new SeedRefusedError('seed:website writes to a local database only');

  const bcrypt = (await import('bcryptjs')).default;
  const { connectDatabase, disconnectDatabase, initModels } = await import('../config/database');
  const { env } = await import('../config/env');
  const { Service, ServiceCatalog, NurseOffers } = await import('../modules/services');
  const { PricingService } = await import('../modules/pricing');
  const { FileService } = await import('../modules/files');
  const { User } = await import('../modules/users');
  const { NurseService, NurseProfile } = await import('../modules/nurses');
  const { AvailabilityService } = await import('../modules/availability');
  const { SettingsService } = await import('../modules/settings');
  const { withTransaction } = await import('../config/database');

  await connectDatabase();
  try {
    await initModels();
    const admin = await User.findOne({ role: 'ADMIN', isActive: true });
    if (!admin) throw new Error('No ADMIN user found: run `npm run seed:admin` first');
    const adminId = String(admin._id);

    // daily bookings span up to MAX_DAYS; the platform default (72h) would reject anything longer
    await SettingsService.set('booking.maxDurationHours', MAX_DAYS * 24, adminId);

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
      if (!doc) doc = await ServiceCatalog.create(fields, { actorRole: 'SYSTEM' } as never);
      else await ServiceCatalog.update(String(doc._id), fields, { actorRole: 'SYSTEM' } as never);
      const id = String(doc._id);
      if (s.dailyRateSample != null) {
        const active = await PricingService.activeRates(id, new Date());
        const wanted = s.dailyRateSample * 100;
        if (active.DAILY?.amountMinor !== wanted)
          await PricingService.publishPrice(id, { kind: 'DAILY', amountMinor: wanted }, adminId);
      }
      await ServiceCatalog.setImage(id, adminId, imageFile(s.image), { actorRole: 'SYSTEM' } as never);
      serviceIdBySiteId.set(s.id, id);
      console.log(`service  ${s.slug}`);
    }

    const password = process.env.SEED_DUMMY_PASSWORD || randomBytes(24).toString('base64url');
    const passwordHash = await bcrypt.hash(password, env.BCRYPT_COST);
    for (const [i, n] of nurses.entries()) {
      const email = `${n.slug}@${EMAIL_DOMAIN}`;
      const [first, ...rest] = n.name.en.split(' ');
      let user = await User.findOne({ email });
      if (!user) {
        user = await withTransaction(async (session) => {
          const [u] = await User.create(
            [
              {
                firstName: first!,
                lastName: rest.join(' ') || first!,
                email,
                phone: `+96655510${String(i).padStart(4, '0')}`,
                role: 'NURSE',
                gender: n.gender === 'male' ? 'MALE' : 'FEMALE',
                passwordHash,
                isVerified: true,
                emailVerifiedAt: new Date(),
                phoneVerifiedAt: new Date(),
              },
            ],
            { session },
          );
          await NurseService.createEmpty(String(u!._id), session);
          return u!;
        });
      }
      const userId = String(user._id);
      const city = CITIES[n.city.en] ?? CITIES.Riyadh!;
      await NurseService.update(userId, {
        bio: n.bio.en,
        yearsOfExperience: n.experienceYears ?? 5,
        specializations: [n.role.en.toLowerCase()],
        languages: n.languages.map((l) => l.en.toLowerCase()),
        gender: n.gender === 'male' ? 'MALE' : 'FEMALE',
        ...(n.dailyRateSample != null && { dailyRateMinor: n.dailyRateSample * 100 }),
        serviceRadiusKm: 50,
        location: city,
        address: `${n.city.en} base`,
        city: n.city.en,
        country: 'SA',
      });
      const profile = (await NurseProfile.findOne({ userId: user._id }))!;
      const profileId = String(profile._id);
      await NurseService.setVerification(profileId, 'VERIFIED', undefined);
      await NurseOffers.replace(
        profileId,
        n.serviceIds
          .map((sid) => serviceIdBySiteId.get(sid))
          .filter((x): x is string => !!x)
          .map((serviceId) => ({
            serviceId,
            ...(n.dailyRateSample != null && { dailyRateMinor: n.dailyRateSample * 100 }),
          })),
      );
      if ((await AvailabilityService.list(profileId)).length === 0)
        for (let d = 1; d <= 7; d++)
          await AvailabilityService.create(profileId, {
            kind: 'WEEKLY',
            dayOfWeek: d,
            startTime: '00:00',
            endTime: '24:00',
          } as never);
      await FileService.replacePublicImage(
        userId,
        'PROFILE_IMAGE',
        imageFile(n.portrait),
        user.profileImage,
      ).then((img) => User.updateOne({ _id: user!._id }, { $set: { profileImage: img._id } }));
      console.log(`nurse    ${n.slug}`);
    }
    console.log('Done.');
  } finally {
    await disconnectDatabase();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof SeedRefusedError ? `REFUSED: ${err.message}` : err);
  process.exit(1);
});
