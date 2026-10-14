/* global console, Buffer */
// Prints fresh secrets for the backend's Vercel environment variables (paste each into Vercel → Settings → Environment Variables).
// Run once per deployment target; nothing is written to disk. Never commit the output.
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const b64 = (s) => Buffer.from(s).toString('base64');
const secret = () => randomBytes(32).toString('hex');

console.log(`JWT_PRIVATE_KEY=${b64(privateKey)}`);
console.log(`JWT_PUBLIC_KEY=${b64(publicKey)}`);
console.log(`FILE_URL_SECRET=${secret()}`);
console.log(`PAYMENT_WEBHOOK_SECRET=${secret()}`);
console.log(`CRON_SECRET=${secret()}`);
