// Runs before each test file (before any app module is imported).
import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const base = process.env.TEST_MONGO_BASE_URI ?? 'mongodb://127.0.0.1:27017';
const query = process.env.TEST_MONGO_QUERY ? `?${process.env.TEST_MONGO_QUERY}` : '';
const dbName = `care_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  MONGODB_URI: `${base}/${dbName}${query}`,
  REDIS_URL: 'redis://127.0.0.1:6379',
  RATE_LIMIT_STORE: 'memory',
  STORAGE_PROVIDER: 'memory',
  PAYMENT_PROVIDER: 'mock',
  PAYMENT_WEBHOOK_SECRET:
    'whsec_test_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
  BCRYPT_COST: '4',
  JWT_PRIVATE_KEY: Buffer.from(privateKey).toString('base64'),
  JWT_PUBLIC_KEY: Buffer.from(publicKey).toString('base64'),
  CORS_ORIGINS: 'http://localhost:3000',
});
