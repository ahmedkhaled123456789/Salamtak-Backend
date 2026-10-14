/**
 * Content-based type detection. The client's MIME type and file extension are NEVER trusted on
 * their own: the bytes decide, and the declared type and extension must agree with them.
 */
export interface Sniffed {
  contentType: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';
  extensions: string[];
}

export function sniff(buf: Buffer): Sniffed | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-')
    return { contentType: 'application/pdf', extensions: ['pdf'] };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return { contentType: 'image/jpeg', extensions: ['jpg', 'jpeg'] };
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return { contentType: 'image/png', extensions: ['png'] };
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return { contentType: 'image/webp', extensions: ['webp'] };
  return null;
}

/** Never accepted, whatever the content/extension combination claims. */
const DANGEROUS_EXT = new Set([
  'exe',
  'dll',
  'bat',
  'cmd',
  'com',
  'msi',
  'sh',
  'bash',
  'ps1',
  'vbs',
  'js',
  'mjs',
  'jar',
  'apk',
  'app',
  'php',
  'phtml',
  'py',
  'rb',
  'pl',
  'html',
  'htm',
  'svg',
  'xml',
  'scr',
  'lnk',
  'hta',
  'wsf',
]);

/** Splits `name.ext` safely. Every extension in a multi-dot name is checked (e.g. `a.php.pdf`). */
export function checkFilename(name: string): { safe: string; ext: string } | null {
  const base = name.split(/[\\/]/).pop() ?? '';
  if (!base || base.includes('\0')) return null;
  const parts = base.toLowerCase().split('.');
  if (parts.length < 2) return null;
  if (parts.slice(1).some((p) => DANGEROUS_EXT.has(p))) return null;
  const ext = parts[parts.length - 1]!;
  const safe = base
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(-80);
  return { safe: safe || `file.${ext}`, ext };
}
