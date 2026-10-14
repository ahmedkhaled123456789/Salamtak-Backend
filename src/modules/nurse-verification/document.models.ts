import { Schema, model } from 'mongoose';

export const DOCUMENT_TYPES = [
  'NURSING_LICENSE',
  'IDENTITY_DOCUMENT',
  'CERTIFICATE',
  'QUALIFICATION',
  'INSURANCE',
  'OTHER',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_STATUSES = [
  'PENDING',
  'UNDER_REVIEW',
  'VERIFIED',
  'REJECTED',
  'EXPIRED',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/**
 * A credential a nurse submitted. The bytes live in private storage (FileObject); this record only
 * references them. `documentNumber` is sensitive: shown masked to the owner, in full to authorised
 * admins, never in public APIs, never logged or audited.
 */
const documentSchema = new Schema(
  {
    nurseId: { type: Schema.Types.ObjectId, ref: 'NurseProfile', required: true },
    type: { type: String, enum: DOCUMENT_TYPES, required: true },
    fileId: { type: Schema.Types.ObjectId, ref: 'FileObject', required: true },
    documentNumber: { type: String, trim: true, maxlength: 60 },
    issuedAt: Date,
    expiresAt: Date,
    status: { type: String, enum: DOCUMENT_STATUSES, default: 'PENDING' },
    rejectionReason: { type: String, maxlength: 500 },
    verifiedAt: Date,
    verifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    expiredAt: Date,
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
// the same stored file can back only one document record (duplicate submissions are idempotent)
documentSchema.index({ fileId: 1 }, { unique: true });
documentSchema.index({ nurseId: 1, type: 1, status: 1 });
documentSchema.index({ status: 1, createdAt: 1 });
documentSchema.index({ status: 1, expiresAt: 1 }, { sparse: true });
export const NurseDocument = model('NurseDocument', documentSchema, 'nurseDocuments');
export type NurseDocumentDoc = InstanceType<typeof NurseDocument>;
