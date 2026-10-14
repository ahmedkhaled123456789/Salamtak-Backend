import { Schema, model } from 'mongoose';

/** Private purposes: owner/admin only, served through short-lived signed URLs. */
export const PRIVATE_FILE_PURPOSES = ['NURSE_DOCUMENT'] as const;
/** Public images (service pictures, profile photos): served at /media/:id, no auth, cacheable. */
export const PUBLIC_IMAGE_PURPOSES = ['SERVICE_IMAGE', 'PROFILE_IMAGE'] as const;
export const FILE_PURPOSES = [...PRIVATE_FILE_PURPOSES, ...PUBLIC_IMAGE_PURPOSES] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];
export type PublicImagePurpose = (typeof PUBLIC_IMAGE_PURPOSES)[number];
export const FILE_STATUSES = ['ACTIVE', 'DELETED'] as const;

/**
 * Metadata of a private object. The bytes live in the StorageProvider under a server-generated key;
 * the storage key is NEVER returned by any API.
 */
const fileSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    purpose: { type: String, enum: FILE_PURPOSES, required: true },
    /** sanitised display name only; never used to build a path */
    originalName: { type: String, required: true, maxlength: 100 },
    /** detected from the content (magic bytes), not trusted from the client */
    contentType: { type: String, required: true },
    size: { type: Number, required: true, min: 1 },
    storageKey: { type: String, required: true },
    storageProvider: { type: String, required: true },
    checksumSha256: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    status: { type: String, enum: FILE_STATUSES, default: 'ACTIVE' },
    /** true only for PUBLIC_IMAGE_PURPOSES; those (and only those) are readable without auth */
    isPublic: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
fileSchema.index({ storageKey: 1 }, { unique: true });
fileSchema.index({ ownerId: 1, purpose: 1, createdAt: -1 });
fileSchema.index({ ownerId: 1, checksumSha256: 1, purpose: 1 });
export const FileObject = model('FileObject', fileSchema, 'files');
export type FileObjectDoc = InstanceType<typeof FileObject>;
