import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import mongoose from 'mongoose';
import { SEED_COLLECTIONS } from '../../src/database/dummy/data';
import { confirmationToken, parseMongoTarget } from '../../src/database/dummy/target';
import { connectDatabase, initModels } from '../../src/config/database';
import { stopApp } from '../helpers/harness';

/**
 * End-to-end tests of the real `npm run seed:dummy` entry point, run as a child process. This is the only way to
 * prove that it exits on its own (connections closed), that a second run adds nothing, and that unsafe targets are
 * refused. The child needs a local Redis (booking creation takes per-nurse locks), so these tests skip without one.
 */
const CLI = resolve(__dirname, '../../src/database/seed-dummy.ts');
const TSX = resolve(__dirname, '../../node_modules/tsx/dist/cli.mjs');
const EXPECTED_TOTAL = 306;

// Synchronous probe so the dependent test is reported as SKIPPED (not silently passed) when Redis is absent.
const haveRedis =
  spawnSync(process.execPath, [
    '-e',
    "require('net').connect({host:'127.0.0.1',port:6379,timeout:1500}).on('connect',()=>process.exit(0)).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))",
  ]).status === 0;
const itRedis = haveRedis ? it : it.skip;

function runCli(args: string[], env: Record<string, string | undefined>) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], {
    env: {
      ...process.env,
      LOG_LEVEL: 'silent',
      REDIS_URL: 'redis://127.0.0.1:6379',
      SEED_DUMMY_REQUIRE_DB: undefined,
      ...env,
    } as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 150_000,
  });
  return {
    status: r.status,
    timedOut: r.error?.message.includes('ETIMEDOUT') ?? false,
    out: `${r.stdout}${r.stderr}`,
    ms: Date.now() - t0,
  };
}

beforeAll(async () => {
  await connectDatabase();
  await initModels();
  await Promise.all(SEED_COLLECTIONS.map((c) => mongoose.connection.collection(c).deleteMany({}))); // this test's own throw-away DB only
});
afterAll(async () => {
  await stopApp();
});

const counts = async (): Promise<Record<string, number>> =>
  Object.fromEntries(
    await Promise.all(
      SEED_COLLECTIONS.map(async (c) => [
        c,
        await mongoose.connection.collection(c).countDocuments({}),
      ]),
    ),
  );

describe('seed:dummy CLI (child process, disposable local database)', () => {
  it('refuses to write without --apply (dry run) and writes nothing', async () => {
    const r = runCli([], {});
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/DRY RUN - nothing was written/);
    expect(Object.values(await counts()).reduce((a, b) => a + b, 0)).toBe(0);
  });

  itRedis(
    'applies once, exits by itself (connections closed), and a second run inserts nothing',
    async () => {
      const first = runCli(['--apply'], {});
      expect({ status: first.status, timedOut: first.timedOut }).toEqual({
        status: 0,
        timedOut: false,
      });
      expect(first.out).toMatch(new RegExp(`Total inserted: ${EXPECTED_TOTAL}`));
      const after1 = await counts();
      expect(after1).toMatchObject({
        users: 20,
        patientProfiles: 10,
        nurseProfiles: 10,
        services: 10,
        servicePrices: 10,
        nurseServices: 30,
        nurseAvailabilities: 56,
        holidays: 10,
        coupons: 10,
        bookings: 10,
        bookingItems: 10,
        bookingHistories: 20,
        bookingReservations: 80,
      });

      const second = runCli(['--apply'], {});
      expect({ status: second.status, timedOut: second.timedOut }).toEqual({
        status: 0,
        timedOut: false,
      });
      expect(second.out).toMatch(/Total inserted: 0/);
      expect(await counts()).toEqual(after1); // no duplicates, nothing changed
      // no connection string, password or token ever reaches the output
      expect(first.out + second.out).not.toMatch(/mongodb(\+srv)?:\/\/[^\s]*@|password|secret/i);
    },
  );

  it('refuses protected databases even with --allow-remote and a valid token (before any connection)', () => {
    for (const db of ['health', 'SKY_CARE', 'school-management-system']) {
      const uri = `mongodb+srv://u:p@cluster0.abcde.mongodb.net/${db}`;
      const token = confirmationToken(parseMongoTarget(uri));
      const r = runCli(['--apply', '--allow-remote'], {
        MONGODB_URI: uri,
        SEED_DUMMY_CONFIRM_TARGET: token,
      });
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/REFUSED: ".*" is a protected database/);
      expect(r.out).not.toMatch(/u:p@/);
    }
  });

  it('refuses a database that differs from SEED_DUMMY_REQUIRE_DB, for dry runs too', () => {
    const r = runCli([], {
      MONGODB_URI: 'mongodb+srv://u:p@cluster0.abcde.mongodb.net/health',
      SEED_DUMMY_REQUIRE_DB: 'health_test',
    });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/REFUSED: SEED_DUMMY_REQUIRE_DB is "health_test"/);
  });

  it('refuses a dedicated-config run that supplies no MONGODB_URI (the .env rule itself is unit-tested)', () => {
    const r = runCli([], { MONGODB_URI: '', SEED_DUMMY_REQUIRE_DB: 'health_test' });
    expect(r.status).toBe(1);
  });
});
