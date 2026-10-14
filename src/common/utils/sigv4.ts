import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 for plain `fetch` calls (S3-compatible storage, SES). Kept dependency-free on purpose:
 * the same ~60 lines serve AWS, Cloudflare R2 and MinIO. Verified against AWS's published S3 example request
 * (tests/unit/sigv4.test.ts).
 */
export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SigV4Request {
  method: string;
  url: URL;
  region: string;
  service: string;
  headers?: Record<string, string>;
  /** Hex SHA-256 of the body, or 'UNSIGNED-PAYLOAD'. */
  payloadHash: string;
  /** Override the signing time (tests). */
  now?: Date;
}

export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as AWS expects (encodeURIComponent leaves !'()* unescaped). */
export const awsEncode = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([k, v]) => [awsEncode(k), awsEncode(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** Returns the headers to send: the input headers plus host, x-amz-date, x-amz-content-sha256 and Authorization. */
export function signRequest(req: SigV4Request, creds: SigV4Credentials): Record<string, string> {
  const now = req.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20130524T000000Z
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...req.headers,
    host: req.url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': req.payloadHash,
    ...(creds.sessionToken ? { 'x-amz-security-token': creds.sessionToken } : {}),
  };
  const lower = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const signedHeaders = lower.map(([k]) => k).join(';');
  // path segments are already encoded by URL; S3 must not double-encode them
  const canonicalRequest = [
    req.method.toUpperCase(),
    req.url.pathname || '/',
    canonicalQuery(req.url),
    lower.map(([k, v]) => `${k}:${v}\n`).join(''),
    signedHeaders,
    req.payloadHash,
  ].join('\n');
  const scope = `${day}/${req.region}/${req.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${creds.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, req.region), req.service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
