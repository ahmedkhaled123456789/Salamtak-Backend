import type { Express } from 'express';
import request from 'supertest';
import { API, type Session } from './harness';

export const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-body'),
]);
export const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpg')]);
export const EXE = Buffer.from('MZ\x90\x00\x03\x00\x00\x00 fake executable');

/** A PDF that differs per call (so checksums differ). */
export const uniquePdf = (n: number | string) => Buffer.from(`%PDF-1.4\n% unique ${n}\n%%EOF\n`);

export function upload(
  app: Express,
  who: Session,
  file: Buffer,
  o: { filename?: string; contentType?: string; purpose?: string } = {},
) {
  return request(app)
    .post(`${API}/files`)
    .set(who.auth)
    .field('purpose', o.purpose ?? 'NURSE_DOCUMENT')
    .attach('file', file, {
      filename: o.filename ?? 'license.pdf',
      contentType: o.contentType ?? 'application/pdf',
    });
}
