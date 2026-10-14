import type { ClientSession } from 'mongoose';
import { withTransaction } from '../../config/database';
import { BadRequestError, ConflictError, NotFoundError } from '../../common/errors';
import { AlertService } from '../alerts';
import { AuditService, type AuditContext } from '../audit';
import { FileObject } from '../files';
import { NotificationService, notifyNurse } from '../notifications';
import { NurseProfile, NurseService, toNurseDTO } from '../nurses';
import { SettingsService } from '../settings';
import { User } from '../users';
import {
  NurseDocument,
  type DocumentStatus,
  type DocumentType,
  type NurseDocumentDoc,
} from './document.models';

const mask = (n?: string | null) => (n ? `****${n.slice(-4)}` : null);

/** `forAdmin` exposes the full number and the rejection reason; owners get the number masked. */
export function toDocumentDTO(d: NurseDocumentDoc, forAdmin = false) {
  return {
    id: String(d._id),
    nurseId: String(d.nurseId),
    type: d.type,
    fileId: String(d.fileId),
    documentNumber: forAdmin ? (d.documentNumber ?? null) : mask(d.documentNumber),
    issuedAt: d.issuedAt ?? null,
    expiresAt: d.expiresAt ?? null,
    status: d.status,
    rejectionReason: d.rejectionReason ?? null,
    verifiedAt: d.verifiedAt ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

const live = (d: { status: string; expiresAt?: Date | null }, now: Date) =>
  ['PENDING', 'UNDER_REVIEW', 'VERIFIED'].includes(d.status) && (!d.expiresAt || d.expiresAt > now);

async function notifyAdmins(
  n: {
    type: string;
    title: string;
    body: string;
    referenceKey: string;
    data?: Record<string, string>;
  },
  session?: ClientSession,
) {
  const admins = await User.find({ role: 'ADMIN', isActive: true })
    .select('_id')
    .session(session ?? null)
    .lean();
  for (const a of admins)
    await NotificationService.notify({ ...n, recipientId: String(a._id), channels: [] }, session);
}

export const VerificationService = {
  // ------------------------------------------------------------------ nurse
  async addDocument(
    userId: string,
    input: {
      type: DocumentType;
      fileId: string;
      documentNumber?: string;
      issuedAt?: Date;
      expiresAt?: Date;
    },
  ): Promise<{ doc: NurseDocumentDoc; created: boolean }> {
    const nurse = await NurseService.getByUserId(userId);
    const file = await FileObject.findOne({
      _id: input.fileId,
      ownerId: userId,
      purpose: 'NURSE_DOCUMENT',
      status: 'ACTIVE',
    });
    if (!file) throw new NotFoundError('File not found', 'FILE_NOT_FOUND'); // also hides other users files
    const now = new Date();
    if (input.expiresAt && input.expiresAt <= now)
      throw new BadRequestError('The document has already expired', 'DOCUMENT_ALREADY_EXPIRED');
    if (input.issuedAt && input.issuedAt > now)
      throw new BadRequestError('issuedAt cannot be in the future', 'INVALID_ISSUE_DATE');
    if (input.issuedAt && input.expiresAt && input.issuedAt >= input.expiresAt)
      throw new BadRequestError('expiresAt must be after issuedAt', 'INVALID_EXPIRY_DATE');

    const existing = await NurseDocument.findOne({ fileId: input.fileId });
    if (existing) return { doc: existing, created: false }; // duplicate submission: idempotent
    try {
      const doc = await NurseDocument.create({
        nurseId: nurse._id,
        type: input.type,
        fileId: input.fileId,
        documentNumber: input.documentNumber,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        status: nurse.verificationStatus === 'UNDER_REVIEW' ? 'UNDER_REVIEW' : 'PENDING',
      });
      return { doc, created: true };
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        const again = await NurseDocument.findOne({ fileId: input.fileId });
        if (again) return { doc: again, created: false };
      }
      throw err;
    }
  },

  listMine: async (userId: string) => {
    const nurse = await NurseService.getByUserId(userId);
    return NurseDocument.find({ nurseId: nurse._id }).sort({ createdAt: -1 });
  },

  /** Nurse submits the profile + documents for review: PENDING / REJECTED / EXPIRED -> UNDER_REVIEW. */
  async submit(userId: string, ctx: AuditContext) {
    const settings = await SettingsService.getAll();
    const nurse = await NurseService.getByUserId(userId);
    const now = new Date();
    const docs = await NurseDocument.find({ nurseId: nurse._id });
    const missing = settings['verification.requiredDocuments'].filter(
      (t) => !docs.some((d) => d.type === t && live(d, now)),
    );
    if (missing.length && nurse.verificationStatus !== 'UNDER_REVIEW')
      throw new ConflictError(
        `Missing required documents: ${missing.join(', ')}`,
        'REQUIRED_DOCUMENTS_MISSING',
      );
    return withTransaction(async (session) => {
      const r = await NurseService.setVerification(
        String(nurse._id),
        'UNDER_REVIEW',
        undefined,
        session,
      );
      if (r.changed) {
        await NurseDocument.updateMany(
          { nurseId: nurse._id, status: 'PENDING' },
          { $set: { status: 'UNDER_REVIEW' } },
          { session },
        );
        await AuditService.record(
          ctx,
          {
            action: 'nurse.verification_submitted',
            entity: 'NurseProfile',
            entityId: String(nurse._id),
            oldData: { verificationStatus: r.before.verificationStatus },
            newData: { verificationStatus: 'UNDER_REVIEW' },
          },
          session,
        );
        await notifyAdmins(
          {
            type: 'NURSE_VERIFICATION_SUBMITTED',
            title: 'Nurse awaiting verification',
            body: 'A nurse submitted documents for review.',
            referenceKey: `${String(nurse._id)}:${r.after.updatedAt.getTime()}`,
            data: { nurseId: String(nurse._id) },
          },
          session,
        );
      }
      return { nurse: r.after, changed: r.changed };
    });
  },

  // ------------------------------------------------------------------ admin
  async approveDocument(docId: string, ctx: AuditContext) {
    return withTransaction(async (session) => {
      const doc = await NurseDocument.findById(docId).session(session);
      if (!doc) throw new NotFoundError('Document not found', 'DOCUMENT_NOT_FOUND');
      if (doc.status === 'VERIFIED') return { doc, changed: false };
      if (doc.expiresAt && doc.expiresAt <= new Date())
        throw new ConflictError('The document has expired', 'DOCUMENT_ALREADY_EXPIRED');
      const updated = await NurseDocument.findOneAndUpdate(
        { _id: docId, status: { $in: ['PENDING', 'UNDER_REVIEW'] } },
        {
          $set: { status: 'VERIFIED', verifiedAt: new Date(), verifiedBy: ctx.actorId },
          $unset: { rejectionReason: 1 },
        },
        { new: true, session },
      );
      if (!updated)
        throw new ConflictError(
          `Document is ${doc.status} and cannot be approved`,
          'DOCUMENT_STATE',
        );
      await AuditService.record(
        ctx,
        {
          action: 'nurse_document.approved',
          entity: 'NurseDocument',
          entityId: docId,
          oldData: { status: doc.status },
          newData: { status: 'VERIFIED', type: doc.type, nurseId: String(doc.nurseId) },
        },
        session,
      );
      return { doc: updated, changed: true };
    });
  },

  async rejectDocument(docId: string, reason: string, ctx: AuditContext) {
    const settings = await SettingsService.getAll();
    return withTransaction(async (session) => {
      const doc = await NurseDocument.findById(docId).session(session);
      if (!doc) throw new NotFoundError('Document not found', 'DOCUMENT_NOT_FOUND');
      if (doc.status === 'REJECTED') return { doc, changed: false };
      const updated = await NurseDocument.findOneAndUpdate(
        { _id: docId, status: { $in: ['PENDING', 'UNDER_REVIEW', 'VERIFIED'] } },
        {
          $set: { status: 'REJECTED', rejectionReason: reason },
          $unset: { verifiedAt: 1, verifiedBy: 1 },
        },
        { new: true, session },
      );
      if (!updated)
        throw new ConflictError(
          `Document is ${doc.status} and cannot be rejected`,
          'DOCUMENT_STATE',
        );
      let downgraded = false;
      // a credential that backed a VERIFIED nurse was invalidated: the nurse goes back to review
      if (
        doc.status === 'VERIFIED' &&
        settings['verification.requiredDocuments'].includes(doc.type)
      ) {
        const r = await NurseService.setVerification(
          String(doc.nurseId),
          'UNDER_REVIEW',
          undefined,
          session,
        );
        downgraded = r.changed;
      }
      await AuditService.record(
        ctx,
        {
          action: 'nurse_document.rejected',
          entity: 'NurseDocument',
          entityId: docId,
          oldData: { status: doc.status },
          newData: {
            status: 'REJECTED',
            type: doc.type,
            nurseId: String(doc.nurseId),
            reason,
            nurseDowngraded: downgraded,
          },
        },
        session,
      );
      await notifyNurse(
        String(doc.nurseId),
        {
          type: 'DOCUMENT_REJECTED',
          title: 'Document rejected',
          body: 'One of your documents was rejected. Open the app to see the reason and upload a new one.',
          data: { documentId: docId },
          referenceKey: docId,
          channels: ['PUSH'],
        },
        session,
      );
      return { doc: updated, changed: true };
    });
  },

  async approveNurse(nurseId: string, ctx: AuditContext) {
    const settings = await SettingsService.getAll();
    return withTransaction(async (session) => {
      const nurse = await NurseService.getById(nurseId, session);
      if (nurse.verificationStatus === 'VERIFIED') return { nurse, changed: false };
      if (nurse.verificationStatus !== 'UNDER_REVIEW')
        throw new ConflictError(
          `Nurse is ${nurse.verificationStatus}; only a nurse UNDER_REVIEW can be approved`,
          'INVALID_VERIFICATION_TRANSITION',
        );
      const now = new Date();
      const docs = await NurseDocument.find({ nurseId, status: 'VERIFIED' }).session(session);
      const missing = settings['verification.requiredDocuments'].filter(
        (t) => !docs.some((d) => d.type === t && (!d.expiresAt || d.expiresAt > now)),
      );
      if (missing.length)
        throw new ConflictError(
          `Required documents not verified: ${missing.join(', ')}`,
          'REQUIRED_DOCUMENTS_NOT_VERIFIED',
        );
      const r = await NurseService.setVerification(nurseId, 'VERIFIED', undefined, session);
      await AuditService.record(
        ctx,
        {
          action: 'nurse.approved',
          entity: 'NurseProfile',
          entityId: nurseId,
          oldData: { verificationStatus: r.before.verificationStatus, status: r.before.status },
          newData: { verificationStatus: r.after.verificationStatus, status: r.after.status },
        },
        session,
      );
      await notifyNurse(
        nurseId,
        {
          type: 'NURSE_APPROVED',
          title: 'Verification approved',
          body: 'Your profile was approved. You can now receive bookings.',
          referenceKey: `${nurseId}:approved:${r.after.updatedAt.getTime()}`,
          channels: ['EMAIL', 'PUSH'],
        },
        session,
      );
      return { nurse: r.after, changed: true };
    });
  },

  async rejectNurse(nurseId: string, reason: string, ctx: AuditContext) {
    return withTransaction(async (session) => {
      const nurse = await NurseService.getById(nurseId, session);
      if (nurse.verificationStatus === 'REJECTED') return { nurse, changed: false };
      if (!['UNDER_REVIEW', 'VERIFIED', 'PENDING'].includes(nurse.verificationStatus))
        throw new ConflictError(
          `Nurse is ${nurse.verificationStatus} and cannot be rejected`,
          'INVALID_VERIFICATION_TRANSITION',
        );
      const r = await NurseService.setVerification(nurseId, 'REJECTED', reason, session);
      await AuditService.record(
        ctx,
        {
          action: 'nurse.rejected',
          entity: 'NurseProfile',
          entityId: nurseId,
          oldData: { verificationStatus: r.before.verificationStatus },
          newData: { verificationStatus: 'REJECTED', reason },
        },
        session,
      );
      await notifyNurse(
        nurseId,
        {
          type: 'NURSE_REJECTED_VERIFICATION',
          title: 'Verification rejected',
          body: 'Your verification was rejected. Open the app to see the reason.',
          referenceKey: `${nurseId}:rejected:${r.after.updatedAt.getTime()}`,
          channels: ['EMAIL', 'PUSH'],
        },
        session,
      );
      return { nurse: r.after, changed: true };
    });
  },

  async inspect(nurseId: string) {
    const nurse = await NurseService.getById(nurseId);
    const docs = await NurseDocument.find({ nurseId }).sort({ createdAt: -1 });
    return { nurse: toNurseDTO(nurse), documents: docs.map((d) => toDocumentDTO(d, true)) };
  },

  async listDocuments(q: {
    page: number;
    limit: number;
    status?: DocumentStatus;
    type?: DocumentType;
    nurseId?: string;
  }) {
    const filter = {
      ...(q.status && { status: q.status }),
      ...(q.type && { type: q.type }),
      ...(q.nurseId && { nurseId: q.nurseId }),
    };
    const [items, total] = await Promise.all([
      NurseDocument.find(filter)
        .sort({ createdAt: 1, _id: 1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit),
      NurseDocument.countDocuments(filter),
    ]);
    return { items, total };
  },

  // ------------------------------------------------------------------ system (scheduled)
  /**
   * Marks lapsed documents EXPIRED (never deletes them). A lapsed VERIFIED required credential makes
   * the nurse's verification EXPIRED, i.e. not bookable, until renewal goes through review again.
   * Idempotent and safe to run concurrently (conditional updates; alerts are keyed per document).
   */
  async expireDue(now = new Date(), limit = 200) {
    const settings = await SettingsService.getAll();
    const due = await NurseDocument.find({
      status: { $in: ['PENDING', 'UNDER_REVIEW', 'VERIFIED'] },
      expiresAt: { $lte: now },
    })
      .sort({ expiresAt: 1 })
      .limit(limit)
      .select('_id')
      .lean();
    let documents = 0;
    let nurses = 0;
    for (const d of due) {
      const r = await withTransaction(async (session) => {
        const doc = await NurseDocument.findOneAndUpdate(
          {
            _id: d._id,
            status: { $in: ['PENDING', 'UNDER_REVIEW', 'VERIFIED'] },
            expiresAt: { $lte: now },
          },
          { $set: { status: 'EXPIRED', expiredAt: now } },
          { session },
        ); // returns the document BEFORE the update
        if (!doc) return null;
        let nurseExpired = false;
        if (
          doc.status === 'VERIFIED' &&
          settings['verification.requiredDocuments'].includes(doc.type)
        ) {
          const nurse = await NurseProfile.findById(doc.nurseId).session(session);
          if (nurse?.verificationStatus === 'VERIFIED') {
            await NurseService.setVerification(String(doc.nurseId), 'EXPIRED', undefined, session);
            nurseExpired = true;
          }
        }
        await AuditService.record(
          { actorRole: 'SYSTEM' },
          {
            action: 'nurse_document.expired',
            entity: 'NurseDocument',
            entityId: String(doc._id),
            oldData: { status: doc.status },
            newData: {
              status: 'EXPIRED',
              type: doc.type,
              nurseId: String(doc.nurseId),
              nurseExpired,
            },
          },
          session,
        );
        await AlertService.raise(
          {
            key: `document-expired:${String(doc._id)}`,
            type: nurseExpired ? 'NURSE_CREDENTIAL_EXPIRED' : 'DOCUMENT_EXPIRED',
            severity: 'WARNING',
            entity: 'NurseDocument',
            entityId: String(doc._id),
            message: nurseExpired
              ? 'A required credential expired; the nurse is no longer bookable'
              : 'A nurse document expired',
            data: { type: doc.type, nurseId: String(doc.nurseId) },
          },
          session,
        );
        await notifyNurse(
          String(doc.nurseId),
          {
            type: 'DOCUMENT_EXPIRED',
            title: 'Document expired',
            body: nurseExpired
              ? 'A required document expired. Upload a renewal to become bookable again.'
              : 'One of your documents expired.',
            data: { documentId: String(doc._id) },
            referenceKey: String(doc._id),
            channels: ['EMAIL', 'PUSH'],
          },
          session,
        );
        return { nurseExpired };
      });
      if (r) {
        documents += 1;
        if (r.nurseExpired) nurses += 1;
      }
    }
    return { documents, nurses };
  },
};
