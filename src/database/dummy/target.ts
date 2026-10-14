import { createHash } from 'node:crypto';

/**
 * Credential-safe description of a MongoDB connection string. Nothing in here ever contains the user name,
 * password or query options — only the host(s) and database name, which is what a human needs to recognise the
 * target. Pure functions: no I/O, so they can be tested and used before any connection is opened.
 */
export interface MongoTarget {
  srv: boolean;
  hosts: string[];
  database: string;
  /** True only for a non-SRV URI whose hosts are all loopback. */
  local: boolean;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function parseMongoTarget(uri: string): MongoTarget {
  const m = /^mongodb(\+srv)?:\/\/(.+)$/i.exec(uri.trim());
  if (!m) throw new Error('MONGODB_URI is not a mongodb:// or mongodb+srv:// connection string');
  const srv = Boolean(m[1]);
  let rest = m[2]!;
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash + 1);
  rest = authority;
  const at = rest.lastIndexOf('@'); // credentials (if any) end at the LAST '@' of the authority
  const hostList = at === -1 ? rest : rest.slice(at + 1);
  const hosts = hostList
    .split(',')
    .map((h) => h.trim().replace(/:\d+$/, '').toLowerCase())
    .filter(Boolean);
  if (!hosts.length) throw new Error('MONGODB_URI has no host');
  const database = decodeURIComponent(path.split('?')[0] ?? '');
  const local = !srv && hosts.every((h) => LOOPBACK.has(h));
  return { srv, hosts, database, local };
}

/** Host identity with the middle of each hostname masked, e.g. `cluster0.ab****.mongodb.net`. */
export function redactedHosts(t: MongoTarget): string {
  if (t.local) return t.hosts.join(', '); // loopback addresses are not sensitive
  return t.hosts
    .map((h) => {
      const parts = h.split('.');
      if (parts.length < 3) return h;
      return parts
        .map((p, i) => (i === 1 ? `${p.slice(0, 2)}${'*'.repeat(Math.max(p.length - 2, 2))}` : p))
        .join('.');
    })
    .join(', ');
}

/**
 * The exact string an operator must supply (SEED_DUMMY_CONFIRM_TARGET) to allow writing to a non-local database.
 * It binds the approval to ONE host + database, so approving "the test database" can never be reused for another.
 */
export function confirmationToken(t: MongoTarget): string {
  const digest = createHash('sha256')
    .update(`${t.hosts.join(',')}/${t.database}`)
    .digest('hex')
    .slice(0, 10);
  return `${t.database}@${digest}`;
}

/**
 * Databases that must never receive seed data, whatever flags or tokens are supplied. This is a last line of
 * defence on top of the confirmation token: the names are the existing databases found on the shared Atlas
 * cluster, plus MongoDB's own system databases and the application's real database.
 */
export const PROTECTED_DATABASES = [
  'health',
  'SKY_CARE',
  'school-management-system',
  'Udemy-ecommerce-db',
  'sample_mflix',
  'admin',
  'local',
  'config',
] as const;

/**
 * Narrow, explicit exception for the application's own database. Only `health` can ever be unlocked, and only by
 * naming it exactly in SEED_DUMMY_ALLOW_PROTECTED_DB. Every other protected name (other projects' databases and
 * MongoDB system databases) stays refused no matter what is set.
 */
export const OVERRIDABLE_PROTECTED = ['health'] as const;
export function isProtectedOverrideAllowed(database: string, env: NodeJS.ProcessEnv): boolean {
  return (
    (OVERRIDABLE_PROTECTED as readonly string[]).includes(database) &&
    env.SEED_DUMMY_ALLOW_PROTECTED_DB === database
  );
}

export interface GrantedRole {
  role: string;
  db: string;
}

/**
 * Judges whether the connecting database user is confined to the target database. A user that can reach any
 * other database (e.g. `readWriteAnyDatabase@admin`, `atlasAdmin`, a role granted on another db) is rejected, so
 * a seed can never be run with an over-privileged account even by mistake.
 */
export function assessUserScope(
  roles: GrantedRole[],
  database: string,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!roles.length) problems.push('the server reported no roles for this user');
  for (const r of roles) {
    if (r.db !== database) problems.push(`${r.role}@${r.db} reaches beyond "${database}"`);
    else if (/AnyDatabase$|^atlasAdmin$|^root$|^backup$|^restore$/.test(r.role))
      problems.push(`${r.role}@${r.db} is a cluster-wide role`);
  }
  if (roles.length && !roles.some((r) => r.db === database && r.role === 'readWrite'))
    problems.push(`no readWrite@${database} role`);
  return { ok: problems.length === 0, problems };
}

/**
 * If SEED_DUMMY_REQUIRE_DB is set, the configured database MUST be that one. Checked before any connection is
 * opened — including for dry runs and inspection — so a wrong or missing URI can never fall through to another
 * database (e.g. the one in .env).
 */
export function assertRequiredDatabase(t: MongoTarget, env: NodeJS.ProcessEnv): void {
  const required = env.SEED_DUMMY_REQUIRE_DB;
  if (required && t.database !== required) {
    throw new SeedRefusedError(
      `SEED_DUMMY_REQUIRE_DB is "${required}" but MONGODB_URI names "${t.database}" - refusing to connect`,
    );
  }
}

/**
 * Dedicated-config mode (SEED_DUMMY_REQUIRE_DB set): the connection must come from the dedicated env file, never
 * from the application's `.env`. Refuses if the active URI is identical to the one in `.env` (the string is only
 * compared in memory, never printed), and requires a loopback Redis (the seed only uses it for local locks).
 */
export function assertDedicatedConfig(
  env: NodeJS.ProcessEnv,
  dotenvValues: Record<string, string | undefined>,
): void {
  if (!env.SEED_DUMMY_REQUIRE_DB) return;
  if (!env.MONGODB_URI)
    throw new SeedRefusedError('MONGODB_URI is missing from the dedicated env file');
  if (dotenvValues.MONGODB_URI && dotenvValues.MONGODB_URI === env.MONGODB_URI) {
    throw new SeedRefusedError(
      'MONGODB_URI is the same as in .env - the dedicated env file must supply its own connection',
    );
  }
  const redis = env.REDIS_URL
    ? /^rediss?:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/]+)/i.exec(env.REDIS_URL)?.[1]?.toLowerCase()
    : undefined;
  if (!redis || !LOOPBACK.has(redis))
    throw new SeedRefusedError(
      'REDIS_URL must be set to a loopback Redis in the dedicated env file',
    );
}

export interface SeedFlags {
  apply: boolean;
  allowRemote: boolean;
}

export class SeedRefusedError extends Error {}

/**
 * Gate for any WRITE. Dry-run never reaches this. Rules:
 *  - production NODE_ENV is always refused;
 *  - a local (loopback, non-SRV) database needs only `--apply`;
 *  - anything else additionally needs `--allow-remote` AND SEED_DUMMY_CONFIRM_TARGET equal to the token printed
 *    for exactly this host + database.
 */
export function assertWriteAllowed(t: MongoTarget, flags: SeedFlags, env: NodeJS.ProcessEnv): void {
  if (!flags.apply)
    throw new SeedRefusedError('Writes require --apply (default is a read-only dry run)');
  if (env.NODE_ENV === 'production')
    throw new SeedRefusedError('Refusing to seed dummy data with NODE_ENV=production');
  if (!t.database) throw new SeedRefusedError('MONGODB_URI must name a database explicitly');
  if (
    (PROTECTED_DATABASES as readonly string[]).includes(t.database) &&
    !isProtectedOverrideAllowed(t.database, env)
  ) {
    throw new SeedRefusedError(`"${t.database}" is a protected database and can never be seeded`);
  }
  const required = env.SEED_DUMMY_REQUIRE_DB;
  if (required && t.database !== required) {
    throw new SeedRefusedError(
      `SEED_DUMMY_REQUIRE_DB is "${required}" but the target database is "${t.database}"`,
    );
  }
  if (t.local) return;
  if (!flags.allowRemote)
    throw new SeedRefusedError('Target is not a local database: --allow-remote is required');
  if (env.SEED_DUMMY_CONFIRM_TARGET !== confirmationToken(t)) {
    throw new SeedRefusedError(
      'SEED_DUMMY_CONFIRM_TARGET does not match this exact host + database',
    );
  }
}
