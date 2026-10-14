import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { withTransaction } from '../../config/database';
import { getRedis } from '../../config/redis';
import {
  BadRequestError,
  AppError,
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
} from '../../common/errors';
import { randomOtp, randomToken, safeEqual, sha256 } from '../../common/utils/crypto';
import { signAccessToken } from '../../common/utils/jwt';
import { getMessenger } from '../../providers/messaging/messenger';
import { AuditService, type AuditContext } from '../audit';
import { NurseService } from '../nurses';
import { PatientService } from '../patients';
import { User, type UserDoc } from '../users';
import { OneTimeToken } from './oneTimeToken.model';
import { RefreshToken } from './refreshToken.model';

export interface ClientMeta {
  ip?: string;
  userAgent?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export interface RegisterInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  password: string;
  role: 'PATIENT' | 'NURSE';
  gender?: 'MALE' | 'FEMALE' | 'OTHER';
  dateOfBirth?: Date;
}

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const RESET_TTL_MS = 30 * 60 * 1000;
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const OTP_TTL_SECONDS = 600;
const OTP_MAX_ATTEMPTS = 5;

// Compared against when the email is unknown so response time doesn't reveal account existence.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 4);

const pwVersion = (u: { passwordChangedAt?: Date | null }) => u.passwordChangedAt?.getTime() ?? 0;

async function issueTokens(
  user: UserDoc,
  meta: ClientMeta,
  opts: { familyId?: string; session?: ClientSession } = {},
): Promise<{ tokens: TokenPair; hash: string }> {
  const refreshToken = randomToken(48);
  const hash = sha256(refreshToken);
  await RefreshToken.create(
    [
      {
        userId: user._id,
        tokenHash: hash,
        familyId: opts.familyId ?? randomUUID(),
        expiresAt: new Date(Date.now() + env.jwt.refreshTtlSeconds * 1000),
        userAgent: meta.userAgent?.slice(0, 300),
        ip: meta.ip,
      },
    ],
    { session: opts.session },
  );
  const accessToken = signAccessToken({
    sub: String(user._id),
    role: user.role as never,
    pv: pwVersion(user),
  });
  return {
    hash,
    tokens: {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: env.jwt.accessTtlSeconds,
    },
  };
}

function duplicateToConflict(err: unknown): never {
  const e = err as { code?: number; keyPattern?: Record<string, number> };
  if (e?.code === 11000) {
    if (e.keyPattern?.email) throw new ConflictError('Email is already registered', 'EMAIL_TAKEN');
    if (e.keyPattern?.phone) throw new ConflictError('Phone is already registered', 'PHONE_TAKEN');
    throw new ConflictError('Account already exists', 'DUPLICATE_RESOURCE');
  }
  throw err;
}

const otpKey = (userId: string) => `otp:phone:${userId}`;
/** Attempt counter kept apart from the code so INCR can enforce the cap atomically. */
const otpAttemptsKey = (userId: string) => `otp:phone:${userId}:attempts`;

async function sendEmailVerification(user: UserDoc): Promise<void> {
  const token = randomToken(32);
  await OneTimeToken.deleteMany({
    userId: user._id,
    purpose: 'EMAIL_VERIFY',
    usedAt: { $exists: false },
  });
  await OneTimeToken.create({
    userId: user._id,
    purpose: 'EMAIL_VERIFY',
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
  });
  await getMessenger().send({
    channel: 'EMAIL',
    to: user.email,
    purpose: 'EMAIL_VERIFY',
    subject: 'Verify your email',
    body: `Your verification token: ${token}`,
  });
}

async function sendPhoneOtp(user: UserDoc): Promise<void> {
  const otp = randomOtp(6);
  await getRedis()
    .multi()
    .set(
      otpKey(String(user._id)),
      JSON.stringify({ hash: sha256(`${user._id}:${otp}`) }),
      'EX',
      OTP_TTL_SECONDS,
    )
    .del(otpAttemptsKey(String(user._id)))
    .exec();
  await getMessenger().send({
    channel: 'SMS',
    to: user.phone,
    purpose: 'PHONE_OTP',
    body: `Your verification code is ${otp}`,
  });
}

/** Verification delivery must never fail the primary request. */
async function bestEffort(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    // The user can re-request via resend-verification.
    logger.warn({ label, err: (err as Error).message }, 'Verification delivery failed');
  }
}

function recomputeVerified(user: { emailVerifiedAt?: Date | null; phoneVerifiedAt?: Date | null }) {
  return !!user.emailVerifiedAt && !!user.phoneVerifiedAt;
}

export const AuthService = {
  async register(
    input: RegisterInput,
    meta: ClientMeta,
  ): Promise<{ user: UserDoc; tokens: TokenPair }> {
    const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_COST);
    let user: UserDoc;
    let tokens: TokenPair;
    try {
      ({ user, tokens } = await withTransaction(async (session) => {
        const [created] = await User.create(
          [
            {
              firstName: input.firstName,
              lastName: input.lastName,
              email: input.email,
              phone: input.phone,
              role: input.role,
              gender: input.gender,
              dateOfBirth: input.dateOfBirth,
              passwordHash,
            },
          ],
          { session },
        );
        const u = created as UserDoc;
        if (input.role === 'PATIENT') await PatientService.createEmpty(String(u._id), session);
        else await NurseService.createEmpty(String(u._id), session);
        const { tokens: t } = await issueTokens(u, meta, { session });
        return { user: u, tokens: t };
      }));
    } catch (err) {
      return duplicateToConflict(err);
    }
    await bestEffort('email', () => sendEmailVerification(user));
    await bestEffort('phone', () => sendPhoneOtp(user));
    return { user, tokens };
  },

  async login(
    email: string,
    password: string,
    meta: ClientMeta,
  ): Promise<{ user: UserDoc; tokens: TokenPair }> {
    const user = await User.findOne({ email }).select('+passwordHash');
    if (!user) {
      await bcrypt.compare(password, DUMMY_HASH);
      throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError(423, 'ACCOUNT_LOCKED', 'Account temporarily locked due to failed logins');
    }
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      const updated = await User.findByIdAndUpdate(
        user._id,
        { $inc: { failedLoginCount: 1 } },
        { new: true },
      );
      if (updated && updated.failedLoginCount >= MAX_FAILED_LOGINS) {
        await User.updateOne(
          { _id: user._id },
          {
            $set: {
              lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000),
              failedLoginCount: 0,
            },
          },
        );
      }
      throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
    }
    if (!user.isActive) throw new ForbiddenError('Account is disabled', 'ACCOUNT_DISABLED');

    await User.updateOne(
      { _id: user._id },
      { $set: { failedLoginCount: 0, lastLoginAt: new Date() }, $unset: { lockedUntil: 1 } },
    );
    const { tokens } = await issueTokens(user, meta);
    return { user, tokens };
  },

  /**
   * Refresh-token rotation with reuse detection. Presenting an already-rotated token revokes the
   * entire token family (the legitimate client and the thief both lose access).
   */
  async refresh(token: string, meta: ClientMeta, audit: AuditContext): Promise<TokenPair> {
    const hash = sha256(token);

    type Outcome =
      | { kind: 'ok'; tokens: TokenPair }
      | { kind: 'invalid' }
      | { kind: 'reuse'; familyId: string; userId: string };

    const outcome: Outcome = await withTransaction(async (session) => {
      const doc = await RefreshToken.findOne({ tokenHash: hash }).session(session);
      if (!doc) return { kind: 'invalid' };
      if (doc.revokedAt) {
        return doc.revokedReason === 'ROTATED'
          ? { kind: 'reuse', familyId: doc.familyId, userId: String(doc.userId) }
          : { kind: 'invalid' };
      }
      if (doc.expiresAt <= new Date()) return { kind: 'invalid' };

      const user = await User.findById(doc.userId).session(session);
      if (!user || !user.isActive) return { kind: 'invalid' };

      const next = await issueTokens(user, meta, { familyId: doc.familyId, session });
      // Guarded: only one concurrent refresh can flip revokedAt from unset.
      const flipped = await RefreshToken.findOneAndUpdate(
        { _id: doc._id, revokedAt: { $exists: false } },
        { $set: { revokedAt: new Date(), revokedReason: 'ROTATED', replacedByHash: next.hash } },
        { session },
      );
      if (!flipped) return { kind: 'reuse', familyId: doc.familyId, userId: String(doc.userId) };
      return { kind: 'ok', tokens: next.tokens };
    });

    if (outcome.kind === 'ok') return outcome.tokens;
    if (outcome.kind === 'reuse') {
      await RefreshToken.updateMany(
        { familyId: outcome.familyId, revokedAt: { $exists: false } },
        { $set: { revokedAt: new Date(), revokedReason: 'REUSE_DETECTED' } },
      );
      await AuditService.record(
        { ...audit, actorId: outcome.userId },
        {
          action: 'auth.refresh_token_reuse_detected',
          entity: 'User',
          entityId: outcome.userId,
          newData: { familyId: outcome.familyId },
        },
      );
      throw new UnauthorizedError(
        'Refresh token reuse detected; please sign in again',
        'REFRESH_TOKEN_REUSED',
      );
    }
    throw new UnauthorizedError('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
  },

  /** Idempotent: unknown/expired tokens succeed silently. */
  async logout(token: string): Promise<void> {
    const doc = await RefreshToken.findOne({ tokenHash: sha256(token) });
    if (!doc) return;
    await RefreshToken.updateMany(
      { familyId: doc.familyId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date(), revokedReason: 'LOGOUT' } },
    );
  },

  async revokeAllForUser(
    userId: string,
    reason: 'PASSWORD_CHANGE' | 'ADMIN',
    session?: ClientSession,
  ): Promise<void> {
    await RefreshToken.updateMany(
      { userId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date(), revokedReason: reason } },
      { session },
    );
  },

  /** Always resolves identically so callers can't enumerate accounts. */
  async forgotPassword(email: string): Promise<void> {
    const user = await User.findOne({ email });
    if (!user || !user.isActive) return;
    const token = randomToken(32);
    await OneTimeToken.deleteMany({
      userId: user._id,
      purpose: 'PASSWORD_RESET',
      usedAt: { $exists: false },
    });
    await OneTimeToken.create({
      userId: user._id,
      purpose: 'PASSWORD_RESET',
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
    });
    // Not awaited: the response time must not reveal whether the account exists (provider latency).
    void bestEffort('reset-email', () =>
      getMessenger().send({
        channel: 'EMAIL',
        to: user.email,
        purpose: 'PASSWORD_RESET',
        subject: 'Reset your password',
        body: `Your password reset token: ${token}`,
      }),
    );
  },

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const passwordHash = await bcrypt.hash(newPassword, env.BCRYPT_COST);
    await withTransaction(async (session) => {
      const t = await OneTimeToken.findOneAndUpdate(
        {
          tokenHash: sha256(token),
          purpose: 'PASSWORD_RESET',
          usedAt: { $exists: false },
          expiresAt: { $gt: new Date() },
        },
        { $set: { usedAt: new Date() } },
        { session },
      );
      if (!t) throw new BadRequestError('Invalid or expired token', 'INVALID_OR_EXPIRED_TOKEN');
      await User.updateOne(
        { _id: t.userId },
        {
          $set: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0 },
          $unset: { lockedUntil: 1 },
        },
        { session },
      );
      await this.revokeAllForUser(String(t.userId), 'PASSWORD_CHANGE', session);
    });
  },

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    meta: ClientMeta,
  ): Promise<TokenPair> {
    const user = await User.findById(userId).select('+passwordHash');
    if (!user) throw new UnauthorizedError();
    if (!(await bcrypt.compare(currentPassword, user.passwordHash)))
      throw new BadRequestError('Current password is incorrect', 'INVALID_CURRENT_PASSWORD');
    if (currentPassword === newPassword)
      throw new BadRequestError('New password must differ from the current one', 'PASSWORD_REUSED');
    const passwordHash = await bcrypt.hash(newPassword, env.BCRYPT_COST);

    return withTransaction(async (session) => {
      const updated = await User.findByIdAndUpdate(
        userId,
        { $set: { passwordHash, passwordChangedAt: new Date() } },
        { new: true, session },
      );
      await this.revokeAllForUser(userId, 'PASSWORD_CHANGE', session);
      const { tokens } = await issueTokens(updated as UserDoc, meta, { session });
      return tokens;
    });
  },

  async verifyEmail(token: string): Promise<void> {
    await withTransaction(async (session) => {
      const t = await OneTimeToken.findOneAndUpdate(
        {
          tokenHash: sha256(token),
          purpose: 'EMAIL_VERIFY',
          usedAt: { $exists: false },
          expiresAt: { $gt: new Date() },
        },
        { $set: { usedAt: new Date() } },
        { session },
      );
      if (!t) throw new BadRequestError('Invalid or expired token', 'INVALID_OR_EXPIRED_TOKEN');
      const user = await User.findById(t.userId).session(session);
      if (!user) throw new BadRequestError('Invalid or expired token', 'INVALID_OR_EXPIRED_TOKEN');
      user.emailVerifiedAt = new Date();
      user.isVerified = recomputeVerified(user);
      await user.save({ session });
    });
  },

  async verifyPhone(userId: string, otp: string): Promise<void> {
    const redis = getRedis();
    const raw = await redis.get(otpKey(userId));
    if (!raw) throw new BadRequestError('Code expired or not requested', 'OTP_EXPIRED');
    const entry = JSON.parse(raw) as { hash: string };
    // Count the attempt BEFORE comparing, atomically: concurrent guesses can never exceed the cap.
    const [[, attempts]] = (await redis
      .multi()
      .incr(otpAttemptsKey(userId))
      .expire(otpAttemptsKey(userId), OTP_TTL_SECONDS)
      .exec()) as [[Error | null, number], unknown];
    if (attempts > OTP_MAX_ATTEMPTS) {
      await redis.del(otpKey(userId), otpAttemptsKey(userId));
      throw new BadRequestError('Too many attempts; request a new code', 'OTP_ATTEMPTS_EXCEEDED');
    }
    if (!safeEqual(entry.hash, sha256(`${userId}:${otp}`))) {
      throw new BadRequestError('Invalid code', 'INVALID_OTP');
    }
    await redis.del(otpKey(userId), otpAttemptsKey(userId));
    const user = await User.findById(userId);
    if (!user) throw new UnauthorizedError();
    user.phoneVerifiedAt = new Date();
    user.isVerified = recomputeVerified(user);
    await user.save();
  },

  async resendVerification(userId: string, channel: 'EMAIL' | 'PHONE'): Promise<void> {
    const user = await User.findById(userId);
    if (!user) throw new UnauthorizedError();
    if (channel === 'EMAIL') {
      if (user.emailVerifiedAt)
        throw new ConflictError('Email already verified', 'ALREADY_VERIFIED');
      await sendEmailVerification(user);
    } else {
      if (user.phoneVerifiedAt)
        throw new ConflictError('Phone already verified', 'ALREADY_VERIFIED');
      await sendPhoneOtp(user);
    }
  },
};
