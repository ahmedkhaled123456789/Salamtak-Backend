import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { AppError, UnauthorizedError } from '../errors';
import type { Role } from '../constants/rbac';

export interface AccessTokenPayload {
  sub: string;
  role: Role;
  /** Password version: the user's passwordChangedAt (ms) at issue time, 0 if never changed. */
  pv: number;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign({ role: payload.role, pv: payload.pv }, env.jwt.privateKey as string, {
    algorithm: 'RS256',
    subject: payload.sub,
    issuer: env.jwt.issuer,
    audience: env.jwt.audience,
    expiresIn: env.jwt.accessTtlSeconds,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.jwt.publicKey as string, {
      algorithms: ['RS256'], // pinned: no alg confusion / "none"
      issuer: env.jwt.issuer,
      audience: env.jwt.audience,
    });
    if (typeof decoded === 'string' || typeof decoded.sub !== 'string')
      throw new UnauthorizedError('Invalid token', 'INVALID_TOKEN');
    return { sub: decoded.sub, role: decoded.role as Role, pv: Number(decoded.pv ?? 0) };
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    if (err instanceof jwt.TokenExpiredError)
      throw new UnauthorizedError('Access token expired', 'TOKEN_EXPIRED');
    throw new UnauthorizedError('Invalid token', 'INVALID_TOKEN');
  }
}

export interface QuoteTokenPayload {
  pid: string; // patient user id
  svc: string; // service id
  nrs: string; // nurse profile id
  st: number; // start ms
  en: number; // end ms
  tot: number; // patient payable (fils)
  ver: string; // pricing version
  cpn?: string; // coupon code the quote was priced with
}

const QUOTE_AUDIENCE = 'care-quote';

/** Signed (RS256) quote reference. Audience differs from access tokens, so it can never authenticate a request. */
export function signQuoteToken(payload: QuoteTokenPayload, ttlSeconds: number): string {
  return jwt.sign(payload, env.jwt.privateKey as string, {
    algorithm: 'RS256',
    issuer: env.jwt.issuer,
    audience: QUOTE_AUDIENCE,
    expiresIn: ttlSeconds,
  });
}

export function verifyQuoteToken(token: string): QuoteTokenPayload {
  try {
    const d = jwt.verify(token, env.jwt.publicKey as string, {
      algorithms: ['RS256'],
      issuer: env.jwt.issuer,
      audience: QUOTE_AUDIENCE,
    });
    if (typeof d === 'string') throw new Error('bad payload');
    return d as unknown as QuoteTokenPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError)
      throw new AppError(422, 'QUOTE_EXPIRED', 'The price quote has expired; request a new quote');
    throw new AppError(400, 'INVALID_QUOTE', 'Invalid quote token');
  }
}
