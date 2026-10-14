import type { ClientSession } from 'mongoose';
import type { Request } from 'express';
import { AuditLog } from './auditLog.model';

const SENSITIVE_KEY =
  /pass(word)?|token|secret|hash|otp|authorization|cvv|card|iban|healthProfile/i;

/** Recursively drops sensitive keys and converts values to plain JSON-safe data. */
export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[truncated]';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => sanitizeForAudit(v, depth + 1));
  if (typeof value === 'object') {
    const src =
      typeof (value as { toObject?: () => unknown }).toObject === 'function'
        ? ((value as { toObject: () => unknown }).toObject() as Record<string, unknown>)
        : (value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (SENSITIVE_KEY.test(k)) continue;
      out[k] = sanitizeForAudit(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface AuditContext {
  actorId?: string;
  actorRole?: string;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: string;
  oldData?: unknown;
  newData?: unknown;
}

export function auditContext(req: Request): AuditContext {
  return {
    actorId: req.auth?.userId,
    actorRole: req.auth?.role,
    ip: req.ip,
    userAgent: req.get('user-agent')?.slice(0, 300),
    requestId: typeof req.id === 'string' ? req.id : undefined,
  };
}

export const AuditService = {
  async record(ctx: AuditContext, entry: AuditEntry, session?: ClientSession): Promise<void> {
    await AuditLog.create(
      [
        {
          ...ctx,
          ...entry,
          oldData: sanitizeForAudit(entry.oldData),
          newData: sanitizeForAudit(entry.newData),
        },
      ],
      { session },
    );
  },
};
