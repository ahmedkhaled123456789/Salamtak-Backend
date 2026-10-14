import '../../common/openapi/extend';
import { z } from 'zod';
import { hasPermission } from '../../common/constants/rbac';
import { createApi } from '../../common/openapi/route';
import { FILE_PURPOSES, PRIVATE_FILE_PURPOSES } from './file.models';
import { FileService, toFileDTO } from './file.service';

const FileSchema = z.object({
  id: z.string(),
  purpose: z.enum(FILE_PURPOSES),
  originalName: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  checksumSha256: z.string(),
  createdAt: z.date(),
});
const idParams = z.strictObject({ id: z.string().regex(/^[a-f\d]{24}$/i, 'invalid id') });
const MAX_HARD_BYTES = 20 * 1024 * 1024;

const api = createApi('Files');

api.route({
  method: 'post',
  path: '/files',
  summary: 'Upload a private file (multipart/form-data)',
  description:
    'Field `file` plus text field `purpose`. Only PDF, JPEG, PNG and WebP are accepted: the content, the extension and the declared content type must all agree. Executables, scripts, HTML and SVG are rejected. Size limit: platform setting `files.maxUploadBytes`. The storage key is generated server-side and never returned. Uploading identical content twice returns the existing file (`duplicate: true`).',
  permission: 'files:self',
  rateLimit: { name: 'file-upload', config: { points: 30, durationSeconds: 3600 } },
  status: 201,
  upload: { field: 'file', maxBytes: MAX_HARD_BYTES },
  // public images are uploaded through their owner's endpoint (service image / avatar), never here
  body: z.strictObject({ purpose: z.enum(PRIVATE_FILE_PURPOSES) }),
  response: FileSchema.extend({ duplicate: z.boolean() }),
  handler: async ({ auth, body, req }) => {
    const r = await FileService.upload(auth.userId, body.purpose, req.file);
    return { ...toFileDTO(r.file), duplicate: r.duplicate };
  },
});

api.route({
  method: 'get',
  path: '/files/:id',
  summary: 'File metadata (owner or authorised admin)',
  permission: 'files:self',
  params: idParams,
  response: FileSchema,
  handler: async ({ auth, params }) =>
    toFileDTO(
      await FileService.getAccessible(params.id, {
        userId: auth.userId,
        canReadAny: hasPermission(auth.role, 'admin:files:read'),
      }),
    ),
});

api.route({
  method: 'post',
  path: '/files/:id/access-url',
  summary: 'Get a short-lived signed URL for a private file',
  description:
    'Returns a URL valid for `files.signedUrlTtlSeconds` (default 120s), bound to the requesting user. Private files are never publicly addressable.',
  permission: 'files:self',
  params: idParams,
  response: z.object({ url: z.string(), expiresAt: z.date() }),
  handler: async ({ auth, params }) =>
    FileService.accessUrl(params.id, {
      userId: auth.userId,
      canReadAny: hasPermission(auth.role, 'admin:files:read'),
    }),
});

api.route({
  method: 'get',
  path: '/files/:id/content',
  summary: 'Download a private file via its signed URL',
  description:
    'Authenticated by the signature only (so a viewer component can open it). Expires quickly; `Cache-Control: no-store`.',
  public: true,
  params: idParams,
  query: z.object({
    exp: z.coerce.number().int(),
    u: z.string().regex(/^[a-f\d]{24}$/i),
    sig: z.string().regex(/^[a-f\d]{64}$/i),
  }),
  handler: async ({ params, query, res }) => {
    const { file, data } = await FileService.openSigned(params.id, query);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', String(data.length));
    res.setHeader('Content-Disposition', `attachment; filename="${file.originalName}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).end(data);
  },
});

api.route({
  method: 'get',
  path: '/media/:id',
  summary: 'Public image (service picture or profile photo)',
  description:
    'Serves only files flagged public (service images and profile photos); private documents are 404 here. Immutable: a replaced image gets a new id, so responses are cached for a year.',
  public: true,
  params: idParams,
  handler: async ({ params, res }) => {
    const { file, data } = await FileService.openPublic(params.id);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', String(data.length));
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    // helmet defaults to same-origin; the website is served from another origin
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.status(200).end(data);
  },
});

export default api.router;
