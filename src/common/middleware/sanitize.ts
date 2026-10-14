import type { NextFunction, Request, Response } from 'express';
import { BadRequestError } from '../errors';

function hasUnsafeKey(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (Array.isArray(value)) return value.some((v) => hasUnsafeKey(v, depth + 1));
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('$') || k.includes('.') || k === '__proto__') return true;
      if (hasUnsafeKey(v, depth + 1)) return true;
    }
  }
  return false;
}

/** Rejects NoSQL-operator injection ({"$gt": ""}) and prototype-pollution keys in body/query/params. */
export function rejectUnsafeKeys(req: Request, _res: Response, next: NextFunction): void {
  if (hasUnsafeKey(req.body) || hasUnsafeKey(req.query) || hasUnsafeKey(req.params)) {
    return next(new BadRequestError('Request contains disallowed keys', 'INVALID_INPUT'));
  }
  next();
}
