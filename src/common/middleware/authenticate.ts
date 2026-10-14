import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ForbiddenError, UnauthorizedError } from '../errors';
import { hasPermission, type Permission, type Role } from '../constants/rbac';
import { verifyAccessToken } from '../utils/jwt';
import { UserService } from '../../modules/users';

/** Verifies the RS256 access token, then re-checks the user in the DB (blocked users / password change take effect immediately). */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(new UnauthorizedError('Missing bearer token'));
  }
  try {
    const payload = verifyAccessToken(header.slice(7).trim());
    const subject = await UserService.getAuthSubject(payload.sub);
    if (!subject) return next(new UnauthorizedError('Invalid token', 'INVALID_TOKEN'));
    if (!subject.isActive)
      return next(new ForbiddenError('Account is disabled', 'ACCOUNT_DISABLED'));
    if (subject.pv !== payload.pv)
      return next(new UnauthorizedError('Token revoked', 'TOKEN_REVOKED'));
    req.auth = { userId: subject.id, role: subject.role as Role };
    next();
  } catch (err) {
    next(err);
  }
}

export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(new UnauthorizedError());
    if (!hasPermission(req.auth.role, permission)) return next(new ForbiddenError());
    next();
  };
}
