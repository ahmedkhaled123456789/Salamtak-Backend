import dotenv from 'dotenv';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ms from 'ms';
import { z } from 'zod';

dotenv.config({ quiet: true });

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
/** `KEY=` in an .env file means "not set" (dotenv yields an empty string). */
const blank = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const duration = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .refine((v) => typeof ms(v as ms.StringValue) === 'number', 'invalid duration (e.g. 15m, 30d)')
    .transform((v) => Math.floor((ms(v as ms.StringValue) as number) / 1000));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MONGODB_URI: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_PRIVATE_KEY: z.string().optional(),
  JWT_PUBLIC_KEY: z.string().optional(),
  JWT_PRIVATE_KEY_FILE: z.string().optional(),
  JWT_PUBLIC_KEY_FILE: z.string().optional(),
  JWT_ISSUER: z.string().default('care-backend'),
  JWT_AUDIENCE: z.string().default('care-clients'),
  JWT_ACCESS_EXPIRES_IN: duration('15m'),
  JWT_REFRESH_EXPIRES_IN: duration('30d'),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: bool.default(false),
  SWAGGER_ENABLED: bool.optional(),
  PLATFORM_TIMEZONE: z.string().default('Asia/Dubai'),
  RATE_LIMIT_STORE: z.enum(['redis', 'memory']).default('redis'),
  PAYMENT_PROVIDER: z.enum(['mock', 'stripe']).default('mock'),
  PAYMENT_SECRET_KEY: z.string().optional(),
  PAYMENT_WEBHOOK_SECRET: z.string().optional(),
  /** Deprecated stop-gap timer; superseded by BullMQ workers (RUN_WORKERS / `npm run worker`). */
  INLINE_JOBS: bool.default(false),
  /** Run BullMQ workers + scheduler inside the API process (small deployments / dev). Otherwise run `npm run worker`. */
  RUN_WORKERS: bool.default(false),
  /** BullMQ key prefix; lets several environments share one Redis. */
  QUEUE_PREFIX: z.string().min(1).max(40).default('care'),
  /** Private file storage. `local` writes under STORAGE_LOCAL_DIR (dev); production plugs an object-storage provider into the same interface. */
  STORAGE_PROVIDER: z.enum(['memory', 'local', 's3', 'gridfs']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('.storage'),
  /** HMAC secret for short-lived private-file URLs. Required in production. */
  FILE_URL_SECRET: z.string().min(16).optional(),
  /** S3-compatible object storage (STORAGE_PROVIDER=s3). AWS: region only; R2/MinIO: also S3_ENDPOINT. */
  S3_BUCKET: z.string().min(3).optional(),
  S3_REGION: z.string().default('me-central-1'),
  S3_ENDPOINT: blank(z.string().url()),
  S3_FORCE_PATH_STYLE: bool.default(false),
  S3_SERVER_SIDE_ENCRYPTION: blank(z.enum(['AES256', 'aws:kms'])),
  /** AWS-style credentials shared by S3 and SES (prefer an instance/task role's short-lived keys). */
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_SESSION_TOKEN: z.string().optional(),
  /** `log` = development email provider that logs metadata only. `none` = skipped/unconfigured. `ses` = Amazon SES. */
  EMAIL_PROVIDER: z.enum(['none', 'log', 'ses']).default('none'),
  SES_REGION: z.string().optional(),
  /** Verified sender, e.g. `CareFlow <no-reply@careflow.ae>`. */
  EMAIL_FROM: z.string().optional(),
  /** SMS for phone verification codes. `log` = dev outbox only. */
  SMS_PROVIDER: z.enum(['none', 'log', 'twilio']).default('log'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  /** Sender: an E.164 number or a registered alphanumeric sender ID (UAE requires registration). */
  TWILIO_FROM: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
  /** Push notifications through the Expo Push API (the mobile app is an Expo app). */
  PUSH_PROVIDER: z.enum(['none', 'expo']).default('none'),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  /** Production refuses to start without real email + SMS providers unless this is explicitly true. */
  ALLOW_NO_MESSAGING: bool.default(false),
  /** Public website origin, used in emailed links (newsletter confirm/unsubscribe). */
  PUBLIC_WEB_URL: blank(z.string().url()),
  /**
   * Public PORTFOLIO DEMO (e.g. on Vercel): allows the mock payment provider (payments are confirmed instantly through
   * the normal signed-webhook pipeline), no email/SMS providers and REDIS_URL=memory in production. Refused unless
   * PAYMENT_PROVIDER=mock, so it can never run next to real payments.
   */
  DEMO_MODE: bool.default(false),
  /** Bearer secret for POST /internal/cron/sweep (Vercel Cron / external scheduler). Unset = endpoint disabled. */
  CRON_SECRET: blank(z.string().min(16)),
  /** Optional error reporting (Sentry DSN). Empty = disabled. */
  SENTRY_DSN: blank(z.string().url()),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  throw new Error(`Invalid environment configuration: ${details}`);
}
const raw = parsed.data;

function decodePem(value: string): string {
  return value.includes('BEGIN') ? value : Buffer.from(value, 'base64').toString('utf8');
}

function loadKey(inline?: string, file?: string): string | undefined {
  if (file) return readFileSync(file, 'utf8');
  if (inline) return decodePem(inline);
  return undefined;
}

let privateKey = loadKey(raw.JWT_PRIVATE_KEY, raw.JWT_PRIVATE_KEY_FILE);
let publicKey = loadKey(raw.JWT_PUBLIC_KEY, raw.JWT_PUBLIC_KEY_FILE);
let ephemeralKeys = false;

if (!privateKey || !publicKey) {
  if (raw.NODE_ENV === 'production') {
    throw new Error('JWT_PRIVATE_KEY and JWT_PUBLIC_KEY (or *_FILE) are required in production');
  }
  // Non-production convenience only: ephemeral pair generated at boot (tokens die on restart).
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
  ephemeralKeys = true;
}

if (raw.DEMO_MODE && raw.PAYMENT_PROVIDER !== 'mock') {
  throw new Error('DEMO_MODE requires PAYMENT_PROVIDER=mock (a demo must never take real payments)');
}
if (raw.NODE_ENV === 'production' && raw.PAYMENT_PROVIDER === 'mock' && !raw.DEMO_MODE) {
  throw new Error('PAYMENT_PROVIDER=mock is not allowed in production (except DEMO_MODE=true)');
}
if (raw.NODE_ENV === 'production' && raw.REDIS_URL === 'memory' && !raw.DEMO_MODE) {
  throw new Error('REDIS_URL=memory is not allowed in production (except DEMO_MODE=true)');
}

if (raw.NODE_ENV === 'production') {
  if (!raw.FILE_URL_SECRET) throw new Error('FILE_URL_SECRET is required in production');
  if (raw.STORAGE_PROVIDER === 'memory')
    throw new Error('STORAGE_PROVIDER=memory is not allowed in production');
  // Without these, phone codes and password-reset emails are silently dropped.
  if (!raw.ALLOW_NO_MESSAGING && !raw.DEMO_MODE && (raw.EMAIL_PROVIDER !== 'ses' || raw.SMS_PROVIDER !== 'twilio'))
    throw new Error(
      'Production needs EMAIL_PROVIDER=ses and SMS_PROVIDER=twilio (or ALLOW_NO_MESSAGING=true to run without them)',
    );
}

const missing = (keys: (keyof typeof raw)[]) => keys.filter((k) => !raw[k]);
const requireAll = (when: boolean, label: string, keys: (keyof typeof raw)[]) => {
  const m = when ? missing(keys) : [];
  if (m.length) throw new Error(`${label} requires ${m.join(', ')}`);
};
requireAll(raw.STORAGE_PROVIDER === 's3', 'STORAGE_PROVIDER=s3', ['S3_BUCKET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
requireAll(raw.EMAIL_PROVIDER === 'ses', 'EMAIL_PROVIDER=ses', ['SES_REGION', 'EMAIL_FROM', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
requireAll(raw.SMS_PROVIDER === 'twilio', 'SMS_PROVIDER=twilio', ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN']);
if (raw.SMS_PROVIDER === 'twilio' && !raw.TWILIO_FROM && !raw.TWILIO_MESSAGING_SERVICE_SID)
  throw new Error('SMS_PROVIDER=twilio requires TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID');
/** Non-production fallback is per-process random: signed file URLs simply stop working after a restart. */
const fileUrlSecret = raw.FILE_URL_SECRET ?? randomBytes(32).toString('hex');

export const env = {
  ...raw,
  fileUrlSecret,
  isProd: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  swaggerEnabled: raw.SWAGGER_ENABLED ?? raw.NODE_ENV !== 'production',
  corsOrigins: raw.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  jwt: {
    privateKey,
    publicKey,
    ephemeralKeys,
    issuer: raw.JWT_ISSUER,
    audience: raw.JWT_AUDIENCE,
    accessTtlSeconds: raw.JWT_ACCESS_EXPIRES_IN,
    refreshTtlSeconds: raw.JWT_REFRESH_EXPIRES_IN,
  },
} as const;

export type Env = typeof env;
