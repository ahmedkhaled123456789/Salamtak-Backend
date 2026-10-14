import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const randomOtp = (digits = 6): string => {
  const n = randomBytes(4).readUInt32BE() % 10 ** digits;
  return n.toString().padStart(digits, '0');
};
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
