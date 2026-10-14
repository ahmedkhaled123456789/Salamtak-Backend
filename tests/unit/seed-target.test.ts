import {
  assertDedicatedConfig,
  assertRequiredDatabase,
  assessUserScope,
  assertWriteAllowed,
  PROTECTED_DATABASES,
  confirmationToken,
  parseMongoTarget,
  redactedHosts,
  SeedRefusedError,
} from '../../src/database/dummy/target';

describe('seed target parsing and write gate', () => {
  it('parses an Atlas-style SRV URI without ever exposing credentials', () => {
    const t = parseMongoTarget(
      'mongodb+srv://someuser:S3cretPass@cluster0.abcde.mongodb.net/health?retryWrites=true&w=majority',
    );
    expect(t).toEqual({
      srv: true,
      hosts: ['cluster0.abcde.mongodb.net'],
      database: 'health',
      local: false,
    });
    const shown = JSON.stringify([t, redactedHosts(t), confirmationToken(t)]);
    expect(shown).not.toMatch(/someuser|S3cretPass/);
    expect(redactedHosts(t)).toMatch(/^cluster0\.ab\*+\.mongodb\.net$/);
  });

  it('handles passwords containing @ and multi-host URIs', () => {
    const t = parseMongoTarget('mongodb://u:p@ss@host1:27017,host2:27017/care?replicaSet=rs0');
    expect(t.hosts).toEqual(['host1', 'host2']);
    expect(t.database).toBe('care');
    expect(t.local).toBe(false);
  });

  it('only loopback, non-SRV URIs are local', () => {
    expect(parseMongoTarget('mongodb://127.0.0.1:27018/care?replicaSet=rs0').local).toBe(true);
    expect(parseMongoTarget('mongodb://localhost/care').local).toBe(true);
    expect(parseMongoTarget('mongodb://[::1]:27017/care').local).toBe(true);
    expect(parseMongoTarget('mongodb://10.0.0.5/care').local).toBe(false);
    expect(parseMongoTarget('mongodb+srv://localhost/care').local).toBe(false);
    expect(parseMongoTarget('mongodb://127.0.0.1,evil.example.com/care').local).toBe(false);
  });

  it('rejects things that are not mongo URIs', () => {
    expect(() => parseMongoTarget('postgres://x/y')).toThrow();
  });

  const local = parseMongoTarget('mongodb://127.0.0.1:27018/care_seed');
  const remote = parseMongoTarget('mongodb+srv://u:p@cluster0.abcde.mongodb.net/care_demo');

  it('never writes without --apply', () => {
    expect(() => assertWriteAllowed(local, { apply: false, allowRemote: false }, {})).toThrow(
      SeedRefusedError,
    );
  });

  it('allows a local database with --apply only', () => {
    expect(() => assertWriteAllowed(local, { apply: true, allowRemote: false }, {})).not.toThrow();
  });

  it('refuses production NODE_ENV even for local', () => {
    expect(() =>
      assertWriteAllowed(local, { apply: true, allowRemote: false }, { NODE_ENV: 'production' }),
    ).toThrow(/production/);
  });

  it('refuses a remote target without --allow-remote', () => {
    expect(() => assertWriteAllowed(remote, { apply: true, allowRemote: false }, {})).toThrow(
      /allow-remote/,
    );
  });

  it('refuses a remote target without, or with a wrong, confirmation token', () => {
    expect(() => assertWriteAllowed(remote, { apply: true, allowRemote: true }, {})).toThrow(
      /CONFIRM_TARGET/,
    );
    expect(() =>
      assertWriteAllowed(
        remote,
        { apply: true, allowRemote: true },
        { SEED_DUMMY_CONFIRM_TARGET: 'care_demo@0000000000' },
      ),
    ).toThrow(/CONFIRM_TARGET/);
  });

  it('a confirmation token is bound to exactly one host + database', () => {
    const token = confirmationToken(remote);
    expect(() =>
      assertWriteAllowed(
        remote,
        { apply: true, allowRemote: true },
        { SEED_DUMMY_CONFIRM_TARGET: token },
      ),
    ).not.toThrow();
    const otherDb = parseMongoTarget('mongodb+srv://u:p@cluster0.abcde.mongodb.net/other');
    const otherHost = parseMongoTarget('mongodb+srv://u:p@cluster9.zzzzz.mongodb.net/care_demo');
    expect(() =>
      assertWriteAllowed(
        otherDb,
        { apply: true, allowRemote: true },
        { SEED_DUMMY_CONFIRM_TARGET: token },
      ),
    ).toThrow();
    expect(() =>
      assertWriteAllowed(
        otherHost,
        { apply: true, allowRemote: true },
        { SEED_DUMMY_CONFIRM_TARGET: token },
      ),
    ).toThrow();
  });

  it('refuses when no database is named', () => {
    expect(() =>
      assertWriteAllowed(
        parseMongoTarget('mongodb://127.0.0.1:27017'),
        { apply: true, allowRemote: false },
        {},
      ),
    ).toThrow(/database/);
  });

  it('can never seed a protected database, even with every flag and a valid token', () => {
    for (const name of PROTECTED_DATABASES) {
      const t = parseMongoTarget(`mongodb+srv://u:p@cluster0.abcde.mongodb.net/${name}`);
      expect(() =>
        assertWriteAllowed(
          t,
          { apply: true, allowRemote: true },
          { SEED_DUMMY_CONFIRM_TARGET: confirmationToken(t) },
        ),
      ).toThrow(/protected database/);
    }
    for (const name of ['health', 'SKY_CARE', 'school-management-system'])
      expect(PROTECTED_DATABASES).toContain(name);
  });

  it('allows health_test with the right token', () => {
    const t = parseMongoTarget(
      'mongodb+srv://u:p@cluster0.abcde.mongodb.net/health_test?retryWrites=true',
    );
    expect(() =>
      assertWriteAllowed(
        t,
        { apply: true, allowRemote: true },
        { SEED_DUMMY_CONFIRM_TARGET: confirmationToken(t), SEED_DUMMY_REQUIRE_DB: 'health_test' },
      ),
    ).not.toThrow();
  });

  it('SEED_DUMMY_REQUIRE_DB refuses a different database before connecting (dry run too)', () => {
    const health = parseMongoTarget('mongodb+srv://u:p@cluster0.abcde.mongodb.net/health');
    expect(() => assertRequiredDatabase(health, { SEED_DUMMY_REQUIRE_DB: 'health_test' })).toThrow(
      /refusing to connect/,
    );
    expect(() => assertRequiredDatabase(health, {})).not.toThrow();
    const ok = parseMongoTarget('mongodb+srv://u:p@cluster0.abcde.mongodb.net/health_test');
    expect(() =>
      assertRequiredDatabase(ok, { SEED_DUMMY_REQUIRE_DB: 'health_test' }),
    ).not.toThrow();
  });

  it('accepts a user confined to the target database', () => {
    expect(assessUserScope([{ role: 'readWrite', db: 'health_test' }], 'health_test')).toEqual({
      ok: true,
      problems: [],
    });
  });

  it('rejects over-privileged users (the current Atlas user shape) and any role beyond the database', () => {
    expect(assessUserScope([{ role: 'readWriteAnyDatabase', db: 'admin' }], 'health_test').ok).toBe(
      false,
    );
    expect(assessUserScope([{ role: 'atlasAdmin', db: 'admin' }], 'health_test').ok).toBe(false);
    expect(
      assessUserScope(
        [
          { role: 'readWrite', db: 'health_test' },
          { role: 'read', db: 'SKY_CARE' },
        ],
        'health_test',
      ).ok,
    ).toBe(false);
    expect(
      assessUserScope([{ role: 'read', db: 'health_test' }], 'health_test').problems.join(),
    ).toMatch(/no readWrite/);
    expect(assessUserScope([], 'health_test').ok).toBe(false);
  });

  describe('dedicated config (never fall back to .env)', () => {
    const ok = {
      SEED_DUMMY_REQUIRE_DB: 'health_test',
      MONGODB_URI: 'mongodb+srv://a:b@h.mongodb.net/health_test',
      REDIS_URL: 'redis://127.0.0.1:6379',
    };
    it('is inert when the dedicated mode is not used', () => {
      expect(() => assertDedicatedConfig({}, { MONGODB_URI: 'x' })).not.toThrow();
    });
    it('accepts its own URI and a loopback Redis', () => {
      expect(() =>
        assertDedicatedConfig(ok, { MONGODB_URI: 'mongodb+srv://other@h.mongodb.net/health' }),
      ).not.toThrow();
      expect(() =>
        assertDedicatedConfig({ ...ok, REDIS_URL: 'redis://localhost:6379' }, {}),
      ).not.toThrow();
    });
    it('refuses a missing URI', () => {
      expect(() => assertDedicatedConfig({ ...ok, MONGODB_URI: undefined }, {})).toThrow(/missing/);
    });
    it('refuses a URI identical to the one in .env', () => {
      expect(() => assertDedicatedConfig(ok, { MONGODB_URI: ok.MONGODB_URI })).toThrow(
        /same as in \.env/,
      );
    });
    it('refuses a missing or non-loopback Redis', () => {
      expect(() => assertDedicatedConfig({ ...ok, REDIS_URL: undefined }, {})).toThrow(
        /loopback Redis/,
      );
      expect(() =>
        assertDedicatedConfig({ ...ok, REDIS_URL: 'redis://cache.example.com:6379' }, {}),
      ).toThrow(/loopback Redis/);
    });
  });

  describe('explicit override for the application database only', () => {
    const health = parseMongoTarget('mongodb+srv://u:p@cluster0.abcde.mongodb.net/health');
    const token = confirmationToken(health);
    const flags = { apply: true, allowRemote: true };
    it('still refuses health without the exact override', () => {
      expect(() => assertWriteAllowed(health, flags, { SEED_DUMMY_CONFIRM_TARGET: token })).toThrow(
        /protected database/,
      );
      expect(() =>
        assertWriteAllowed(health, flags, {
          SEED_DUMMY_CONFIRM_TARGET: token,
          SEED_DUMMY_ALLOW_PROTECTED_DB: 'SKY_CARE',
        }),
      ).toThrow(/protected database/);
    });
    it('allows health only with override AND the target token AND --allow-remote', () => {
      const env = { SEED_DUMMY_CONFIRM_TARGET: token, SEED_DUMMY_ALLOW_PROTECTED_DB: 'health' };
      expect(() => assertWriteAllowed(health, flags, env)).not.toThrow();
      expect(() => assertWriteAllowed(health, { apply: true, allowRemote: false }, env)).toThrow(
        /allow-remote/,
      );
      expect(() =>
        assertWriteAllowed(health, flags, {
          ...env,
          SEED_DUMMY_CONFIRM_TARGET: 'health@0000000000',
        }),
      ).toThrow(/CONFIRM_TARGET/);
    });
    it('can never unlock any other protected database, whatever is set', () => {
      for (const name of [
        'SKY_CARE',
        'school-management-system',
        'Udemy-ecommerce-db',
        'sample_mflix',
        'admin',
        'local',
        'config',
      ]) {
        const t = parseMongoTarget(`mongodb+srv://u:p@cluster0.abcde.mongodb.net/${name}`);
        expect(() =>
          assertWriteAllowed(t, flags, {
            SEED_DUMMY_CONFIRM_TARGET: confirmationToken(t),
            SEED_DUMMY_ALLOW_PROTECTED_DB: name,
          }),
        ).toThrow(/protected database/);
      }
    });
  });
});
