/** Generates an RS256 keypair into ./keys (gitignored) and prints base64 env values. */
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
mkdirSync('keys', { recursive: true });
writeFileSync('keys/jwt-private.pem', privateKey, { mode: 0o600 });
writeFileSync('keys/jwt-public.pem', publicKey);
console.log('Wrote keys/jwt-private.pem and keys/jwt-public.pem');
console.log('Use JWT_PRIVATE_KEY_FILE / JWT_PUBLIC_KEY_FILE, or the base64 values below:\n');
console.log(`JWT_PRIVATE_KEY=${Buffer.from(privateKey).toString('base64')}`);
console.log(`JWT_PUBLIC_KEY=${Buffer.from(publicKey).toString('base64')}`);
