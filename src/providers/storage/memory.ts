import type { StorageProvider, StoredObjectInfo } from './types';

/** Test provider: keeps objects in process memory. */
export class MemoryStorageProvider implements StorageProvider {
  readonly name = 'memory';
  readonly objects = new Map<string, { data: Buffer; contentType: string; sha256: string }>();
  failNextPut = false;

  async put(
    key: string,
    data: Buffer,
    meta: { contentType: string; sha256: string },
  ): Promise<StoredObjectInfo> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error('simulated storage outage');
    }
    this.objects.set(key, { data: Buffer.from(data), ...meta });
    return { key, size: data.length };
  }
  async get(key: string): Promise<Buffer | null> {
    return this.objects.get(key)?.data ?? null;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
}
