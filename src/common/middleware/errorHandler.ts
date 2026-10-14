import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { JsonWebTokenError } from 'jsonwebtoken';
import { logger } from '../../config/logger';
import { reportError } from '../../config/monitoring';
import { AppError, ConflictError, NotFoundError } from '../errors';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.path} not found`, 'ROUTE_NOT_FOUND'));
};

interface Mapped {
  status: number;
  errorCode: string;
  message: string;
  details?: unknown;
}

function map(err: unknown): Mapped {
  if (err instanceof AppError)
    return {
      status: err.statusCode,
      errorCode: err.errorCode,
      message: err.message,
      details: err.details,
    };
  if (err instanceof mongoose.Error.ValidationError)
    return {
      status: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'Validation failed',
      details: Object.values(err.errors).map((e) => ({ field: e.path, message: e.message })),
    };
  if (err instanceof mongoose.Error.CastError)
    return { status: 400, errorCode: 'INVALID_ID', message: `Invalid ${err.path}` };
  if ((err as { code?: number })?.code === 11000) {
    const e = new ConflictError('Resource already exists', 'DUPLICATE_RESOURCE');
    return { status: e.statusCode, errorCode: e.errorCode, message: e.message };
  }
  if (err instanceof JsonWebTokenError)
    return { status: 401, errorCode: 'INVALID_TOKEN', message: 'Invalid or expired token' };
  const e = err as { type?: string; status?: number };
  if (e?.type === 'entity.parse.failed')
    return { status: 400, errorCode: 'INVALID_JSON', message: 'Malformed JSON body' };
  if (e?.type === 'entity.too.large')
    return { status: 413, errorCode: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' };
  return { status: 500, errorCode: 'INTERNAL_ERROR', message: 'Something went wrong' };
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const m = map(err);
  if (m.status >= 500) {
    // Never include request bodies (may contain sensitive data) in error logs.
    (req.log ?? logger).error(
      { err: { name: err?.name, message: err?.message, stack: err?.stack } },
      'Unhandled error',
    );
    reportError(err, {
      requestId: typeof req.id === 'string' ? req.id : undefined,
      userId: req.auth?.userId,
      path: req.path,
    });
  }
  const body: Record<string, unknown> = {
    success: false,
    message: m.message,
    errorCode: m.errorCode,
  };
  if (m.details) body.details = m.details;
  res.status(m.status).json(body);
};
