import mongoose from 'mongoose';
import type { StorageProvider, StoredObjectInfo } from './types';

/**
 * Stores files in MongoDB GridFS (bucket `storage`). Meant for small deployments and the portfolio demo on
 * serverless hosts (no writable disk, no extra storage account): pictures and documents live in the same Atlas
 * database as everything else. Same guarantees as the other providers: application-generated keys only, never
 * overwrite. For large volumes use the S3 provider.
 */
export class GridFsStorageProvider implements StorageProvider {
  readonly name = 'gridfs';

  private bucket(): mongoose.mongo.GridFSBucket {
    const db = mongoose.connection.db;
    if (!db) throw new Error('MongoDB connection not ready');
    return new mongoose.mongo.GridFSBucket(db, { bucketName: 'storage' });
  }

  private check(key: string): void {
    if (!/^[A-Za-z0-9/_.-]+$/.test(key) || key.includes('..') || key.startsWith('/'))
      throw new Error('invalid storage key');
  }

  async put(key: string, data: Buffer, meta: { contentType: string; sha256: string }): Promise<StoredObjectInfo> {
    this.check(key);
    if (await this.exists(key)) throw new Error('storage key already exists'); // never overwrite
    await new Promise<void>((resolve, reject) => {
      const stream = this.bucket().openUploadStream(key, { metadata: { contentType: meta.contentType, sha256: meta.sha256 } });
      stream.once('finish', () => resolve());
      stream.once('error', reject);
      stream.end(data);
    });
    return { key, size: data.length };
  }

  async get(key: string): Promise<Buffer | null> {
    this.check(key);
    const [file] = await this.bucket().find({ filename: key }).limit(1).toArray();
    if (!file) return null;
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      this.bucket()
        .openDownloadStream(file._id)
        .on('data', (c: Buffer) => chunks.push(c))
        .once('end', () => resolve())
        .once('error', reject);
    });
    return Buffer.concat(chunks);
  }

  async delete(key: string): Promise<void> {
    this.check(key);
    for (const file of await this.bucket().find({ filename: key }).toArray()) await this.bucket().delete(file._id);
  }

  async exists(key: string): Promise<boolean> {
    this.check(key);
    return (await this.bucket().find({ filename: key }).limit(1).toArray()).length > 0;
  }
}
