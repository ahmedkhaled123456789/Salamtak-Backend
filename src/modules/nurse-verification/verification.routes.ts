import '../../common/openapi/extend';
import { z } from 'zod';
import { createApi } from '../../common/openapi/route';
import { auditContext } from '../audit';
import { NurseProfileSchema, toNurseDTO } from '../nurses';
import { DOCUMENT_STATUSES, DOCUMENT_TYPES } from './document.models';
import { VerificationService, toDocumentDTO } from './verification.service';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'invalid id');
const idParams = z.strictObject({ id: objectId });
const DocumentSchema = z.object({
  id: z.string(),
  nurseId: z.string(),
  type: z.enum(DOCUMENT_TYPES),
  fileId: z.string(),
  documentNumber: z.string().nullable().openapi({ description: 'Masked for the owner' }),
  issuedAt: z.date().nullable(),
  expiresAt: z.date().nullable(),
  status: z.enum(DOCUMENT_STATUSES),
  rejectionReason: z.string().nullable(),
  verifiedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
const pageMeta = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
});
const reason = z.string().trim().min(5).max(500);

const api = createApi('Nurse verification');

// ---------------------------------------------------------------- nurse
api.route({
  method: 'post',
  path: '/nurses/me/documents',
  summary: 'Register an uploaded file as a credential document',
  description:
    'Upload the file first (`POST /files`, purpose NURSE_DOCUMENT), then register it here. Idempotent per file: registering the same file again returns the existing document (`created: false`). A nurse can only register files they uploaded themselves.',
  permission: 'nurse-documents:self',
  rateLimit: { name: 'nurse-doc', config: { points: 30, durationSeconds: 3600 } },
  status: 201,
  body: z.strictObject({
    type: z.enum(DOCUMENT_TYPES),
    fileId: objectId,
    documentNumber: z.string().trim().min(2).max(60).optional(),
    issuedAt: z.coerce.date().optional(),
    expiresAt: z.coerce.date().optional(),
  }),
  response: DocumentSchema.extend({ created: z.boolean() }),
  handler: async ({ auth, body }) => {
    const r = await VerificationService.addDocument(auth.userId, body);
    return { ...toDocumentDTO(r.doc), created: r.created };
  },
});

api.route({
  method: 'get',
  path: '/nurses/me/documents',
  summary: 'My documents (document number masked)',
  permission: 'nurse-documents:self',
  response: z.array(DocumentSchema),
  handler: async ({ auth }) =>
    (await VerificationService.listMine(auth.userId)).map((d) => toDocumentDTO(d)),
});

api.route({
  method: 'post',
  path: '/nurses/me/verification/submit',
  summary: 'Submit my profile and documents for review',
  description:
    'PENDING / REJECTED / EXPIRED -> UNDER_REVIEW. Requires every document type in `verification.requiredDocuments`. Idempotent: submitting while already UNDER_REVIEW changes nothing. A nurse can never approve themselves.',
  permission: 'nurse-documents:self',
  response: z.object({ changed: z.boolean(), verificationStatus: z.string() }),
  handler: async ({ auth, req }) => {
    const r = await VerificationService.submit(auth.userId, auditContext(req));
    return { changed: r.changed, verificationStatus: r.nurse.verificationStatus };
  },
});

// ---------------------------------------------------------------- admin
api.route({
  method: 'get',
  path: '/admin/nurse-documents',
  summary: 'Document review queue',
  permission: 'admin:nurse-documents:review',
  query: z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      status: z.enum(DOCUMENT_STATUSES).optional(),
      type: z.enum(DOCUMENT_TYPES).optional(),
      nurseId: objectId.optional(),
    })
    .strict(),
  response: z.object({ items: z.array(DocumentSchema), meta: pageMeta }),
  handler: async ({ query }) => {
    const { items, total } = await VerificationService.listDocuments(query);
    return {
      items: items.map((d) => toDocumentDTO(d, true)),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  },
});

api.route({
  method: 'get',
  path: '/admin/nurses/:id/verification',
  summary: 'Inspect a nurse and all of their documents',
  description:
    'Includes full document numbers and rejection reasons. Admin only. Files are opened through `POST /files/:id/access-url`.',
  permission: 'admin:nurse-documents:review',
  params: idParams,
  response: z.object({ nurse: NurseProfileSchema, documents: z.array(DocumentSchema) }),
  handler: async ({ params }) => VerificationService.inspect(params.id),
});

api.route({
  method: 'post',
  path: '/admin/nurse-documents/:id/approve',
  summary: 'Approve a document',
  description: 'Idempotent. Audit-logged.',
  permission: 'admin:nurse-documents:review',
  params: idParams,
  response: DocumentSchema.extend({ changed: z.boolean() }),
  handler: async ({ params, req }) => {
    const r = await VerificationService.approveDocument(params.id, auditContext(req));
    return { ...toDocumentDTO(r.doc, true), changed: r.changed };
  },
});

api.route({
  method: 'post',
  path: '/admin/nurse-documents/:id/reject',
  summary: 'Reject a document (reason required)',
  description:
    'Idempotent. Rejecting a VERIFIED required credential returns a VERIFIED nurse to UNDER_REVIEW (not bookable). Audit-logged.',
  permission: 'admin:nurse-documents:review',
  params: idParams,
  body: z.strictObject({ reason }),
  response: DocumentSchema.extend({ changed: z.boolean() }),
  handler: async ({ params, body, req }) => {
    const r = await VerificationService.rejectDocument(params.id, body.reason, auditContext(req));
    return { ...toDocumentDTO(r.doc, true), changed: r.changed };
  },
});

api.route({
  method: 'post',
  path: '/admin/nurses/:id/verification/approve',
  summary: 'Approve a nurse (UNDER_REVIEW -> VERIFIED)',
  description:
    'Requires every required document type to be VERIFIED and unexpired. Idempotent; concurrent decisions cannot produce an invalid state. Audit-logged.',
  permission: 'admin:nurse-documents:review',
  params: idParams,
  response: z.object({ changed: z.boolean(), nurse: NurseProfileSchema }),
  handler: async ({ params, req }) => {
    const r = await VerificationService.approveNurse(params.id, auditContext(req));
    return { changed: r.changed, nurse: toNurseDTO(r.nurse) };
  },
});

api.route({
  method: 'post',
  path: '/admin/nurses/:id/verification/reject',
  summary: 'Reject a nurse verification (reason required)',
  description:
    'Idempotent. Audit-logged. The nurse stays non-bookable; renewal goes through UNDER_REVIEW again.',
  permission: 'admin:nurse-documents:review',
  params: idParams,
  body: z.strictObject({ reason }),
  response: z.object({ changed: z.boolean(), nurse: NurseProfileSchema }),
  handler: async ({ params, body, req }) => {
    const r = await VerificationService.rejectNurse(params.id, body.reason, auditContext(req));
    return { changed: r.changed, nurse: toNurseDTO(r.nurse) };
  },
});

export default api.router;
