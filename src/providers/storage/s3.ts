import { awsEncode, sha256Hex, signRequest, type SigV4Credentials } from '../../common/utils/sigv4';
import type { StorageProvider, StoredObjectInfo } from './types';

export interface S3Options {
  bucket: string;
  region: string;
  credentials: SigV4Credentials;
  /** Custom endpoint for S3-compatible services (Cloudflare R2, MinIO, DigitalOcean Spaces). Omit for AWS. */
  endpoint?: string;
  /** Path-style URLs (`endpoint/bucket/key`) — required by MinIO, optional elsewhere. */
  forcePathStyle?: boolean;
  /** `AES256` / `aws:kms` server-side encryption header (AWS). Omit for providers that encrypt by default (R2). */
  serverSideEncryption?: string;
  timeoutMs?: number;
}

export class S3StorageError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'S3StorageError';
  }
}

/**
 * Private object storage on any S3-compatible service. Objects are never public: the app streams them through
 * its own authorised routes (signed short-lived file URLs / public-media route for public images only).
 * Same guarantees as the local provider: application-generated keys only, no traversal, never overwrite.
 */
export class S3StorageProvider implements StorageProvider {
  readonly name = 's3';
  constructor(private readonly o: S3Options) {}

  private url(key: string): URL {
    if (!/^[A-Za-z0-9/_.-]+$/.test(key) || key.includes('..') || key.startsWith('/'))
      throw new Error('invalid storage key');
    const path = key.split('/').map(awsEncode).join('/');
    if (this.o.endpoint) {
      const base = this.o.endpoint.replace(/\/+$/, '');
      if (this.o.forcePathStyle) return new URL(`${base}/${this.o.bucket}/${path}`);
      const u = new URL(base);
      return new URL(`${u.protocol}//${this.o.bucket}.${u.host}/${path}`);
    }
    return new URL(`https://${this.o.bucket}.s3.${this.o.region}.amazonaws.com/${path}`);
  }

  private async send(
    method: 'GET' | 'PUT' | 'DELETE' | 'HEAD',
    key: string,
    body?: Buffer,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    const url = this.url(key);
    const headers = signRequest(
      { method, url, region: this.o.region, service: 's3', headers: extra, payloadHash: sha256Hex(body ?? '') },
      this.o.credentials,
    );
    delete headers.host; // fetch sets it
    return fetch(url, {
      method,
      headers,
      body: body ? new Uint8Array(body) : undefined,
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 20_000),
    });
  }

  async put(key: string, data: Buffer, meta: { contentType: string; sha256: string }): Promise<StoredObjectInfo> {
    const res = await this.send('PUT', key, data, {
      'content-type': meta.contentType,
      'content-length': String(data.length),
      'if-none-match': '*', // never overwrite an existing object
      'x-amz-meta-sha256': meta.sha256,
      ...(this.o.serverSideEncryption ? { 'x-amz-server-side-encryption': this.o.serverSideEncryption } : {}),
    });
    if (!res.ok) throw new S3StorageError(`S3 PUT failed (${res.status})`, res.status);
    return { key, size: data.length };
  }

  async get(key: string): Promise<Buffer | null> {
    const res = await this.send('GET', key);
    if (res.status === 404) return null;
    if (!res.ok) throw new S3StorageError(`S3 GET failed (${res.status})`, res.status);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const res = await this.send('DELETE', key);
    if (!res.ok && res.status !== 404) throw new S3StorageError(`S3 DELETE failed (${res.status})`, res.status);
  }

  async exists(key: string): Promise<boolean> {
    const res = await this.send('HEAD', key);
    if (res.status === 404) return false;
    if (!res.ok) throw new S3StorageError(`S3 HEAD failed (${res.status})`, res.status);
    return true;
  }
}
