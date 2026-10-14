import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { ValidationError } from '../errors';

export interface RequestSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
  /** Parsed against lower-cased request headers (e.g. `idempotency-key`). */
  headers?: ZodType;
}

export function validate(schemas: RequestSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const details: { field: string; message: string }[] = [];
    const valid: Request['valid'] = {};
    for (const part of ['params', 'query', 'body', 'headers'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(part === 'body' ? (req.body ?? {}) : req[part]);
      if (result.success) valid[part] = result.data;
      else
        for (const issue of result.error.issues)
          details.push({ field: [part, ...issue.path].join('.'), message: issue.message });
    }
    if (details.length) return next(new ValidationError(details));
    req.valid = valid;
    next();
  };
}
