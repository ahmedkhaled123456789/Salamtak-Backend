import './extend';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z, type ZodType } from 'zod';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { ROLE_PERMISSIONS, type Permission } from '../constants/rbac';
import { AppError } from '../errors';
import { authenticate, requirePermission } from '../middleware/authenticate';
import { rateLimit, type LimitConfig } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';

export const registry = new OpenAPIRegistry();
registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

export const ErrorResponseSchema = registry.register(
  'ErrorResponse',
  z.object({
    success: z.literal(false),
    message: z.string(),
    errorCode: z.string(),
    details: z.array(z.object({ field: z.string().optional(), message: z.string() })).optional(),
  }),
);

type Out<T> = T extends ZodType ? z.output<T> : undefined;

export interface Ctx<B, Q, P> {
  body: B;
  query: Q;
  params: P;
  /** Defined on every non-public route. */
  auth: Express.AuthContext;
  req: Request;
  res: Response;
}

export interface RouteDef<
  B extends ZodType | undefined,
  Q extends ZodType | undefined,
  P extends ZodType | undefined,
> {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** Path relative to /api/v1, express-style (":id"). */
  path: string;
  summary: string;
  description?: string;
  public?: boolean;
  permission?: Permission;
  rateLimit?: { name: string; config: LimitConfig };
  body?: B;
  query?: Q;
  params?: P;
  /** Request headers (lower-case names), validated and documented. Read via req.valid.headers. */
  headers?: ZodType;
  /** Schema of the `data` field in the success envelope. */
  response?: ZodType;
  status?: number;
  message?: string;
  /** Multipart upload of a single file in `field` (memory storage, hard size cap). The file is `req.file`. */
  upload?: { field: string; maxBytes: number };
  handler: (ctx: Ctx<Out<B>, Out<Q>, Out<P>>) => Promise<unknown> | unknown;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Validation error / bad request',
  401: 'Unauthenticated',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  429: 'Rate limited',
};

/** multer (memory) with a hard byte cap; limit/format problems become clean 4xx errors. */
function uploadMiddleware(field: string, maxBytes: number) {
  const m = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 10, parts: 12 },
  }).single(field);
  return (req: Request, res: Response, next: NextFunction) =>
    m(req, res, (err: unknown) => {
      if (!err) return next();
      const code = (err as { code?: string }).code;
      if (code === 'LIMIT_FILE_SIZE')
        return next(new AppError(413, 'FILE_TOO_LARGE', `File exceeds ${maxBytes} bytes`));
      return next(new AppError(400, 'INVALID_UPLOAD', 'Invalid multipart upload'));
    });
}

export function createApi(tag: string) {
  const router = Router();

  function route<
    B extends ZodType | undefined = undefined,
    Q extends ZodType | undefined = undefined,
    P extends ZodType | undefined = undefined,
  >(def: RouteDef<B, Q, P>): void {
    const status = def.status ?? 200;
    const message = def.message ?? (status === 201 ? 'Created' : 'Success');
    const guards = [
      ...(def.rateLimit ? [rateLimit(def.rateLimit.name, def.rateLimit.config)] : []),
      ...(def.public ? [] : [authenticate]),
      ...(def.permission ? [requirePermission(def.permission)] : []),
      ...(def.upload ? [uploadMiddleware(def.upload.field, def.upload.maxBytes)] : []),
      validate({ body: def.body, query: def.query, params: def.params, headers: def.headers }),
    ];

    router[def.method](def.path, ...guards, async (req: Request, res: Response) => {
      const data = await def.handler({
        body: req.valid?.body as Out<B>,
        query: req.valid?.query as Out<Q>,
        params: req.valid?.params as Out<P>,
        auth: req.auth as Express.AuthContext,
        req,
        res,
      });
      if (!res.headersSent) res.status(status).json({ success: true, data: data ?? null, message });
    });

    // --- OpenAPI ---
    const roles = def.permission
      ? Object.entries(ROLE_PERMISSIONS)
          .filter(([, perms]) => (perms as readonly string[]).includes(def.permission as string))
          .map(([r]) => r)
      : undefined;
    const errors = new Set<number>([500]);
    if (def.body || def.query || def.params || def.headers) errors.add(400);
    if (!def.public) errors.add(401);
    if (def.permission) errors.add(403);
    if (def.rateLimit) errors.add(429);
    if (def.params) errors.add(404);

    const successSchema = z.object({
      success: z.literal(true),
      data: def.response ?? z.null(),
      message: z.string(),
    });
    const responses: Record<string, unknown> = {
      [status]: {
        description: 'Success',
        content: { 'application/json': { schema: successSchema } },
      },
    };
    for (const code of errors) {
      responses[String(code)] = {
        description: STATUS_TEXT[code] ?? 'Internal error',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      };
    }

    registry.registerPath({
      method: def.method,
      path: '/api/v1' + def.path.replace(/:(\w+)/g, '{$1}'),
      summary: def.summary,
      description:
        (def.description ? def.description + '\n\n' : '') +
        `**Auth:** ${def.public ? 'public' : 'Bearer JWT'}` +
        (roles ? ` | **Roles:** ${roles.join(', ')}` : ''),
      tags: [tag],
      security: def.public ? [] : [{ bearerAuth: [] }],
      request: {
        ...(def.params ? { params: def.params as never } : {}),
        ...(def.query ? { query: def.query as never } : {}),
        ...(def.headers ? { headers: def.headers as never } : {}),
        ...(def.body
          ? {
              body: {
                required: true,
                content: {
                  [def.upload ? 'multipart/form-data' : 'application/json']: { schema: def.body },
                },
              },
            }
          : {}),
      },
      responses: responses as never,
    });
  }

  return { router, route };
}
