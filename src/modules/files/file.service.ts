import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError, NotFoundError } from '../../common/errors';
import { env } from '../../config/env';
import { getStorageProvider } from '../../providers/storage';
import { SettingsService } from '../settings';
import {
  FileObject,
  PUBLIC_IMAGE_PURPOSES,
  type FileObjectDoc,
  type FilePurpose,
} from './file.models';
import { checkFilename, sniff } from './file.sniff';

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

const bad = (code: string, msg: string, status = 422) => new AppError(status, code, msg);

export const toFileDTO = (f: FileObjectDoc) => ({
  id: String(f._id),
  purpose: f.purpose,
  originalName: f.originalName,
  contentType: f.contentType,
  size: f.size,
  checksumSha256: f.checksumSha256,
  createdAt: f.createdAt,
}); // storageKey / storageProvider are deliberately absent

const sign = (id: string, exp: number, userId: string) =>
  createHmac('sha256', env.fileUrlSecret).update(`${id}|${exp}|${userId}`).digest('hex');

const isPublicPurpose = (p: FilePurpose) =>
  (PUBLIC_IMAGE_PURPOSES as readonly string[]).includes(p);


export const FileService = {
  /**
   * Validates and stores an upload. Nothing from the client decides the storage location:
   * the key is `<purpose>/<owner>/<uuid>.<ext>` generated here.
   */
  async upload(
    ownerId: string,
    purpose: FilePurpose,
    file: UploadedFile | undefined,
  ): Promise<{ file: FileObjectDoc; duplicate: boolean }> {
    if (!file || !file.buffer?.length) throw bad('FILE_REQUIRED', 'A file is required', 400);
    const settings = await SettingsService.getAll();
    if (file.size > settings['files.maxUploadBytes'])
      throw bad('FILE_TOO_LARGE', `File exceeds ${settings['files.maxUploadBytes']} bytes`, 413);

    const name = checkFilename(file.originalname);
    if (!name) throw bad('FILE_TYPE_NOT_ALLOWED', 'This file name or extension is not allowed');
    const detected = sniff(file.buffer);
    if (!detected)
      throw bad('FILE_TYPE_NOT_ALLOWED', 'Only PDF, JPEG, PNG and WebP files are allowed');
    const isPublic = isPublicPurpose(purpose);
    if (isPublic && detected.contentType === 'application/pdf')
      throw bad('FILE_TYPE_NOT_ALLOWED', 'Only JPEG, PNG and WebP images are allowed');
    // the content, the extension and the declared content type must all agree
    if (!detected.extensions.includes(name.ext))
      throw bad('FILE_TYPE_MISMATCH', 'File extension does not match its content');
    if (file.mimetype !== detected.contentType)
      throw bad('FILE_TYPE_MISMATCH', 'Declared content type does not match the file content');

    const checksum = createHash('sha256').update(file.buffer).digest('hex');
    const dup = await FileObject.findOne({
      ownerId,
      purpose,
      checksumSha256: checksum,
      status: 'ACTIVE',
    });
    if (dup) return { file: dup, duplicate: true };

    const storage = getStorageProvider();
    const ext = name.ext === 'jpeg' ? 'jpg' : name.ext;
    const key = `${purpose.toLowerCase()}/${ownerId}/${randomUUID()}.${ext}`;
    await storage.put(key, file.buffer, { contentType: detected.contentType, sha256: checksum });
    try {
      const doc = await FileObject.create({
        ownerId,
        purpose,
        originalName: name.safe,
        contentType: detected.contentType,
        size: file.buffer.length,
        storageKey: key,
        storageProvider: storage.name,
        checksumSha256: checksum,
        isPublic,
      });
      return { file: doc, duplicate: false };
    } catch (err) {
      await storage.delete(key).catch(() => undefined); // never leave an orphan object behind
      throw err;
    }
  },

  /**
   * Stores a public image and retires the one it replaces (record + bytes), so changing a photo
   * never leaves orphans. Returns the new file id.
   */
  async replacePublicImage(
    ownerId: string,
    purpose: (typeof PUBLIC_IMAGE_PURPOSES)[number],
    file: UploadedFile | undefined,
    previousId?: unknown,
  ): Promise<FileObjectDoc> {
    const { file: doc } = await this.upload(ownerId, purpose, file);
    if (previousId && String(previousId) !== String(doc._id)) {
      const old = await FileObject.findOneAndUpdate(
        { _id: previousId, isPublic: true, status: 'ACTIVE' },
        { $set: { status: 'DELETED' } },
      );
      if (old) await getStorageProvider().delete(old.storageKey).catch(() => undefined);
    }
    return doc;
  },

  /** Public images only; anything private is a 404 here, whatever its id. */
  async openPublic(fileId: string): Promise<{ file: FileObjectDoc; data: Buffer }> {
    const f = await FileObject.findOne({ _id: fileId, status: 'ACTIVE', isPublic: true });
    const data = f ? await getStorageProvider().get(f.storageKey) : null;
    if (!f || !data) throw new NotFoundError('Image not found', 'IMAGE_NOT_FOUND');
    return { file: f, data };
  },

  /** Owner (or a caller explicitly allowed to read any file) only; others see 404. */
  async getAccessible(
    fileId: string,
    viewer: { userId: string; canReadAny: boolean },
  ): Promise<FileObjectDoc> {
    const f = await FileObject.findOne({ _id: fileId, status: 'ACTIVE' });
    if (!f || (!viewer.canReadAny && String(f.ownerId) !== viewer.userId))
      throw new NotFoundError('File not found', 'FILE_NOT_FOUND');
    return f;
  },

  /** Short-lived URL bound to the requester; the bytes are only served by `openSigned`. */
  async accessUrl(
    fileId: string,
    viewer: { userId: string; canReadAny: boolean },
  ): Promise<{ url: string; expiresAt: Date }> {
    const f = await this.getAccessible(fileId, viewer);
    const ttl = await SettingsService.get('files.signedUrlTtlSeconds');
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const sig = sign(String(f._id), exp, viewer.userId);
    return {
      url: `/api/v1/files/${String(f._id)}/content?exp=${exp}&u=${viewer.userId}&sig=${sig}`,
      expiresAt: new Date(exp * 1000),
    };
  },

  async openSigned(
    fileId: string,
    q: { exp: number; u: string; sig: string },
  ): Promise<{ file: FileObjectDoc; data: Buffer }> {
    const invalid = () =>
      new AppError(403, 'INVALID_FILE_LINK', 'This link is invalid or has expired');
    if (!Number.isInteger(q.exp) || q.exp < Math.floor(Date.now() / 1000)) throw invalid();
    const expected = Buffer.from(sign(fileId, q.exp, q.u), 'hex');
    const given = Buffer.from(q.sig, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();
    const f = await FileObject.findOne({ _id: fileId, status: 'ACTIVE' });
    if (!f) throw invalid();
    const data = await getStorageProvider().get(f.storageKey);
    if (!data) throw new NotFoundError('File not found', 'FILE_NOT_FOUND');
    return { file: f, data };
  },
};
