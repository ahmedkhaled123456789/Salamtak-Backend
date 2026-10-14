/**
 * Dummy-data seeder for dashboards and demos.
 *
 *   npm run seed:dummy                      # DRY RUN (default): read-only plan against $MONGODB_URI, writes nothing
 *   npm run seed:dummy -- --apply           # write to a LOCAL database only (loopback host)
 *   # non-local target: needs BOTH --apply --allow-remote AND SEED_DUMMY_CONFIRM_TARGET=<token printed by the dry run>
 *
 * Optional: SEED_DUMMY_PASSWORD (>=10 chars) makes the dummy accounts able to sign in; without it they get an
 * unguessable random password. See src/database/dummy/seed.ts for exactly what is and is not created.
 */
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import {
  assertDedicatedConfig,
  assertRequiredDatabase,
  assertWriteAllowed,
  assessUserScope,
  confirmationToken,
  parseMongoTarget,
  redactedHosts,
  SeedRefusedError,
} from './dummy/target';

// Same convention as the app: .env is read, but variables already set in the shell win (e.g. a local MONGODB_URI).
dotenv.config({ quiet: true });

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const flags = { apply: args.has('--apply'), allowRemote: args.has('--allow-remote') };
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');

  const target = parseMongoTarget(uri);
  assertRequiredDatabase(target, process.env); // before anything is printed or connected
  let dotenvValues: Record<string, string> = {};
  try {
    dotenvValues = dotenv.parse(readFileSync('.env'));
  } catch {
    /* no .env: nothing to fall back to */
  }
  assertDedicatedConfig(process.env, dotenvValues);
  console.log('Target (credentials never shown):');
  console.log(`  hosts     : ${redactedHosts(target)}${target.srv ? '  (SRV / Atlas-style)' : ''}`);
  console.log(`  database  : ${target.database || '(none named!)'}`);
  console.log(`  local     : ${target.local ? 'yes (loopback)' : 'NO - remote'}`);
  console.log(
    `  confirm   : ${confirmationToken(target)}   <- required as SEED_DUMMY_CONFIRM_TARGET for any remote write`,
  );

  if (!flags.apply) {
    const { planDummySeed } = await import('./dummy/plan');
    const plan = await planDummySeed(uri);
    console.log('\nDRY RUN - nothing was written. Planned inserts for seed identifiers:');
    console.table(plan.rows);
    console.log(
      `Collections present: ${plan.collectionsPresent.length}; documents of unrelated data are only counted, never read or changed.`,
    );
    return;
  }

  assertWriteAllowed(target, flags, process.env);
  if (!target.local) {
    // Remote: also prove (read-only) that the connecting user is confined to this one database.
    const { default: mongoose } = await import('mongoose');
    const probe = new mongoose.mongo.MongoClient(uri, {
      serverSelectionTimeoutMS: 20_000,
      appName: 'careflow-seed-scope-check',
    });
    await probe.connect();
    try {
      const status = (await probe.db('admin').command({ connectionStatus: 1 })) as {
        authInfo?: { authenticatedUserRoles?: { role: string; db: string }[] };
      };
      const scope = assessUserScope(status.authInfo?.authenticatedUserRoles ?? [], target.database);
      if (!scope.ok && process.env.SEED_DUMMY_ACCEPT_BROAD_USER === '1') {
        console.log(
          `NOTE: proceeding with a broad database user by explicit operator acceptance (${scope.problems.length} scope problem(s)).`,
        );
      } else if (!scope.ok)
        throw new SeedRefusedError(
          `database user is not confined to "${target.database}": ${scope.problems.join('; ')}`,
        );
    } finally {
      await probe.close();
    }
  }
  const { connectDatabase, disconnectDatabase, initModels } = await import('../config/database');
  const { disconnectRedis } = await import('../config/redis');
  const { runDummySeed } = await import('./dummy/seed');
  await connectDatabase();
  try {
    await initModels();
    const { default: mongoose } = await import('mongoose');
    const { SEED_COLLECTIONS } = await import('./dummy/data');
    const count = async (name: string) => mongoose.connection.collection(name).countDocuments({});
    const before: Record<string, number> = {};
    for (const c of SEED_COLLECTIONS) before[c] = await count(c);

    const report = await runDummySeed((l) => console.log(`  ${l}`));

    const e = report.existing;
    const skipped: Record<string, number> = {
      users: (e['users.patient'] ?? 0) + (e['users.nurse'] ?? 0),
      services: e.services ?? 0,
      servicePrices: e.servicePrices ?? 0,
      nurseServices: e.nurseServiceOffers ?? 0,
      nurseAvailabilities: e.nurseAvailability ?? 0,
      holidays: e.holidays ?? 0,
      coupons: e.coupons ?? 0,
      bookings: e.bookings ?? 0,
    };
    const rows = [];
    for (const c of SEED_COLLECTIONS) {
      const after = await count(c);
      rows.push({
        collection: c,
        before: before[c],
        inserted: after - before[c]!,
        after,
        'skipped (already present)': skipped[c] ?? '-',
      });
    }
    console.log('\nSUMMARY (actual document counts, measured before and after)');
    console.table(rows);
    console.log(`Total inserted: ${rows.reduce((n, r) => n + r.inserted, 0)}`);
    if (report.skipped.length) console.log('Skipped steps:', report.skipped);
  } finally {
    // booking creation takes per-nurse Redis locks; close that connection too or the process never exits
    await disconnectRedis();
    await disconnectDatabase();
  }
}

main().catch((err: unknown) => {
  console.error(
    err instanceof SeedRefusedError
      ? `REFUSED: ${err.message}`
      : err instanceof Error
        ? err.message
        : err,
  );
  process.exit(1);
});
