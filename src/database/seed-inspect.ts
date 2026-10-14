/**
 * READ-ONLY inspection of the database configured in MONGODB_URI, to help a human decide whether it is a
 * dedicated test database BEFORE any seed is applied.
 *
 *   npm run seed:dummy:inspect
 *
 * It issues only read commands (ping, hello, buildInfo, connectionStatus, listCollections, estimatedDocumentCount,
 * countDocuments, and one $group aggregate). It never writes, never builds an index, never reads document contents,
 * and never prints the connection string, user name, password or e-mail addresses. Hostnames are masked.
 */
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import {
  assertDedicatedConfig,
  assertRequiredDatabase,
  assessUserScope,
  confirmationToken,
  parseMongoTarget,
  PROTECTED_DATABASES,
  redactedHosts,
} from './dummy/target';

// Same convention as the app: .env is read, but variables already set in the shell win (e.g. a local MONGODB_URI).
dotenv.config({ quiet: true });

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  const target = parseMongoTarget(uri);
  assertRequiredDatabase(target, process.env); // before anything is printed or connected
  let dotenvValues: Record<string, string> = {};
  try {
    dotenvValues = dotenv.parse(readFileSync('.env'));
  } catch {
    /* no .env */
  }
  assertDedicatedConfig(process.env, dotenvValues);
  console.log('TARGET (credentials never shown)');
  console.log(`  configured hosts : ${redactedHosts(target)}${target.srv ? ' (SRV)' : ''}`);
  console.log(`  database         : ${target.database || '(none named)'}`);
  console.log(`  local            : ${target.local ? 'yes' : 'NO - remote'}`);
  console.log(`  confirm token    : ${confirmationToken(target)}`);

  const client = new mongoose.mongo.MongoClient(uri, {
    serverSelectionTimeoutMS: 15_000,
    appName: 'careflow-inspect-readonly',
  });
  await client.connect();
  try {
    const db = client.db();
    const admin = client.db('admin');

    const hello = (await admin.command({ hello: 1 })) as Record<string, unknown>;
    const build = (await admin.command({ buildInfo: 1 })) as { version?: string };
    const members = ((hello.hosts as string[] | undefined) ?? []).map((h) =>
      redactedHosts({ ...target, hosts: [h.replace(/:\d+$/, '')], local: false }),
    );
    console.log('\nSERVER');
    console.log(`  version          : ${build.version}`);
    console.log(
      `  replica set      : ${hello.setName ? 'yes (transactions available)' : 'NO'}${members.length ? `, ${members.length} members: ${members.join(', ')}` : ''}`,
    );

    const status = (await admin.command({ connectionStatus: 1, showPrivileges: false })) as {
      authInfo?: { authenticatedUserRoles?: { role: string; db: string }[] };
    };
    const roles = status.authInfo?.authenticatedUserRoles ?? [];
    console.log('\nCONNECTING USER (name never shown) — granted roles:');
    console.log(
      `  ${roles.length ? roles.map((r) => `${r.role}@${r.db}`).join(', ') : '(none reported)'}`,
    );

    const scope = assessUserScope(roles, target.database);
    const protectedDb = (PROTECTED_DATABASES as readonly string[]).includes(target.database);
    console.log(
      `  scope check      : ${scope.ok ? 'OK - user is confined to this database' : `NOT OK - ${scope.problems.join('; ')}`}`,
    );
    console.log(
      `  protected db     : ${protectedDb ? 'YES - seeding is refused for this name' : 'no'}`,
    );

    let dbNames: string[] = [];
    try {
      const l = (await admin.command({ listDatabases: 1, nameOnly: true })) as {
        databases: { name: string }[];
      };
      dbNames = l.databases.map((d) => d.name);
    } catch {
      /* a scoped user may not be allowed to list databases */
    }
    console.log('\nDATABASES VISIBLE TO THIS USER');
    console.log(
      `  ${dbNames.length ? dbNames.join(', ') : '(listing not permitted for this user)'}`,
    );

    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((c) => c.name)
      .sort();
    const counts: Record<string, number> = {};
    for (const n of names) counts[n] = await db.collection(n).estimatedDocumentCount();
    console.log(
      `\nCOLLECTIONS IN "${target.database}" (${names.length}) — estimated document counts`,
    );
    console.table(counts);

    const has = (n: string) => names.includes(n);
    const n = async (c: string, f: Record<string, unknown>) =>
      has(c) ? db.collection(c).countDocuments(f) : 0;
    console.log('SIGNALS (counts only; no contents read)');
    if (has('users')) {
      const total = counts.users ?? 0;
      const reserved = await n('users', { email: { $regex: '@example\\.test$', $options: 'i' } });
      const seedLike = await n('users', { email: { $regex: '^seed\\.', $options: 'i' } });
      const byRole = await db
        .collection('users')
        .aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }])
        .toArray();
      const span = await db
        .collection('users')
        .aggregate([
          { $group: { _id: null, first: { $min: '$createdAt' }, last: { $max: '$createdAt' } } },
        ])
        .toArray();
      console.log(
        `  users            : ${total} total; ${reserved} on reserved example.test; ${total - reserved} on other domains; ${seedLike} look like seed accounts`,
      );
      console.log(
        `  users by role    : ${byRole.map((r) => `${String(r._id)}=${r.count}`).join(', ') || '-'}`,
      );
      const s = span[0] as { first?: Date; last?: Date } | undefined;
      if (s?.first)
        console.log(
          `  users created    : ${s.first.toISOString().slice(0, 10)} … ${s.last?.toISOString().slice(0, 10)}`,
        );
    } else console.log('  users            : collection does not exist');
    for (const c of [
      'bookings',
      'payments',
      'refunds',
      'payouts',
      'wallets',
      'walletTransactions',
      'reviews',
      'notifications',
      'auditLogs',
    ]) {
      if (has(c)) console.log(`  ${c.padEnd(16)} : ${counts[c]}`);
    }
    if (has('payments')) {
      console.log(
        `  payments by provider status : paid=${await n('payments', { status: 'PAID' })}, any non-mock provider=${await n('payments', { provider: { $ne: 'mock' } })}`,
      );
    }
    console.log(
      `\nSeed identifiers already present: users=${await n('users', { email: { $regex: '^seed\\.(patient|nurse)\\.\\d\\d@example\\.test$', $options: 'i' } })}, services=${await n('services', { slug: { $regex: '^seed-' } })}, coupons=${await n('coupons', { code: { $regex: '^SEED' } })}, bookings=${await n('bookings', { notes: { $regex: '^\\[seed:dummy-v1\\]' } })}`,
    );
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  // Never echo driver errors verbatim: they can embed the connection string.
  const msg =
    err instanceof Error
      ? err.message.replace(/mongodb(\+srv)?:\/\/[^\s'"]+/gi, 'mongodb://<redacted>')
      : String(err);
  console.error(`inspection failed: ${msg}`);
  process.exit(1);
});
