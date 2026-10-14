import { env } from '../../config/env';
import { LocalDiskStorageProvider } from './local';
import { MemoryStorageProvider } from './memory';
import { S3StorageProvider } from './s3';
import { GridFsStorageProvider } from './gridfs';
import type { StorageProvider } from './types';

export * from './types';
export { MemoryStorageProvider } from './memory';
export { LocalDiskStorageProvider } from './local';
export { S3StorageProvider } from './s3';
export { GridFsStorageProvider } from './gridfs';

let instance: StorageProvider | undefined;
export function getStorageProvider(): StorageProvider {
  if (!instance)
    instance =
      env.STORAGE_PROVIDER === 'memory'
        ? new MemoryStorageProvider()
        : env.STORAGE_PROVIDER === 's3'
          ? new S3StorageProvider({
              bucket: env.S3_BUCKET!,
              region: env.S3_REGION,
              endpoint: env.S3_ENDPOINT,
              forcePathStyle: env.S3_FORCE_PATH_STYLE,
              serverSideEncryption: env.S3_SERVER_SIDE_ENCRYPTION,
              credentials: {
                accessKeyId: env.AWS_ACCESS_KEY_ID ?? '',
                secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '',
                sessionToken: env.AWS_SESSION_TOKEN,
              },
            })
          : env.STORAGE_PROVIDER === 'gridfs'
            ? new GridFsStorageProvider()
            : new LocalDiskStorageProvider(env.STORAGE_LOCAL_DIR);
  return instance;
}
export const setStorageProvider = (p: StorageProvider | undefined): void => {
  instance = p;
};
