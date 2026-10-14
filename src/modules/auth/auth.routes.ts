import type { Request } from 'express';
import { z } from 'zod';
import { createApi } from '../../common/openapi/route';
import { limits } from '../../common/middleware/rateLimit';
import { SELF_REGISTERABLE_ROLES } from '../../common/constants/rbac';
import { auditContext } from '../audit';
import { GENDERS, UserSchema } from '../users';
import { AuthService } from './auth.service';

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const phone = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'must be E.164, e.g. +971501234567');
export const passwordRule = z
  .string()
  .min(10, 'must be at least 10 characters')
  .max(128)
  .regex(/[a-z]/, 'must contain a lowercase letter')
  .regex(/[A-Z]/, 'must contain an uppercase letter')
  .regex(/\d/, 'must contain a digit');

const TokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().openapi({ description: 'Access token lifetime in seconds' }),
});
const AuthResultSchema = z.object({ user: UserSchema, tokens: TokensSchema });

const meta = (req: Request) => ({ ip: req.ip, userAgent: req.get('user-agent') });

const api = createApi('Auth');

api.route({
  method: 'post',
  path: '/auth/register',
  summary: 'Register a patient or nurse',
  description:
    'Creates the user and an empty role profile atomically. ADMIN accounts cannot be self-registered. Sends email verification and a phone OTP.',
  public: true,
  rateLimit: { name: 'register', config: limits.register },
  status: 201,
  message: 'Registered',
  body: z.strictObject({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    email,
    phone,
    password: passwordRule,
    role: z.enum(SELF_REGISTERABLE_ROLES),
    gender: z.enum(GENDERS).optional(),
    dateOfBirth: z.coerce.date().max(new Date()).optional(),
  }),
  response: AuthResultSchema,
  handler: async ({ body, req }) => {
    const { user, tokens } = await AuthService.register(body, meta(req));
    return { user: user.toJSON(), tokens };
  },
});

api.route({
  method: 'post',
  path: '/auth/login',
  summary: 'Log in with email and password',
  public: true,
  rateLimit: { name: 'login', config: limits.login },
  body: z.strictObject({ email, password: z.string().min(1).max(128) }),
  response: AuthResultSchema,
  message: 'Logged in',
  handler: async ({ body, req }) => {
    const { user, tokens } = await AuthService.login(body.email, body.password, meta(req));
    return { user: user.toJSON(), tokens };
  },
});

api.route({
  method: 'post',
  path: '/auth/refresh',
  summary: 'Rotate the refresh token',
  description:
    'Returns a new access+refresh pair; the presented refresh token is invalidated. Re-using an old refresh token revokes the whole session family (REFRESH_TOKEN_REUSED).',
  public: true,
  rateLimit: { name: 'refresh', config: limits.refresh },
  body: z.strictObject({ refreshToken: z.string().min(20).max(200) }),
  response: TokensSchema,
  handler: ({ body, req }) => AuthService.refresh(body.refreshToken, meta(req), auditContext(req)),
});

api.route({
  method: 'post',
  path: '/auth/logout',
  summary: 'Log out (revokes the refresh-token family)',
  description:
    'Idempotent. Takes the refresh token, so it works even after the access token expired.',
  public: true,
  body: z.strictObject({ refreshToken: z.string().min(1).max(200) }),
  message: 'Logged out',
  handler: async ({ body }) => {
    await AuthService.logout(body.refreshToken);
  },
});

api.route({
  method: 'post',
  path: '/auth/forgot-password',
  summary: 'Request a password reset',
  description: 'Always responds 200 regardless of whether the email exists.',
  public: true,
  rateLimit: { name: 'forgot', config: limits.forgotPassword },
  body: z.strictObject({ email }),
  message: 'If the account exists, a reset message has been sent',
  handler: async ({ body }) => {
    await AuthService.forgotPassword(body.email);
  },
});

api.route({
  method: 'post',
  path: '/auth/reset-password',
  summary: 'Reset password with a reset token',
  description: 'Single-use. Revokes all sessions.',
  public: true,
  rateLimit: { name: 'reset', config: limits.otp },
  body: z.strictObject({ token: z.string().min(10).max(200), newPassword: passwordRule }),
  message: 'Password updated',
  handler: async ({ body }) => {
    await AuthService.resetPassword(body.token, body.newPassword);
  },
});

api.route({
  method: 'post',
  path: '/auth/change-password',
  summary: 'Change password',
  description: 'Revokes all existing sessions and returns a fresh token pair.',
  body: z.strictObject({ currentPassword: z.string().min(1).max(128), newPassword: passwordRule }),
  response: TokensSchema,
  message: 'Password changed',
  handler: ({ auth, body, req }) =>
    AuthService.changePassword(auth.userId, body.currentPassword, body.newPassword, meta(req)),
});

api.route({
  method: 'post',
  path: '/auth/verify-email',
  summary: 'Verify email with the emailed token',
  public: true,
  rateLimit: { name: 'verify-email', config: limits.otp },
  body: z.strictObject({ token: z.string().min(10).max(200) }),
  message: 'Email verified',
  handler: async ({ body }) => {
    await AuthService.verifyEmail(body.token);
  },
});

api.route({
  method: 'post',
  path: '/auth/verify-phone',
  summary: 'Verify my phone with the SMS code',
  rateLimit: { name: 'verify-phone', config: limits.otp },
  body: z.strictObject({ otp: z.string().regex(/^\d{6}$/, 'must be 6 digits') }),
  message: 'Phone verified',
  handler: async ({ auth, body }) => {
    await AuthService.verifyPhone(auth.userId, body.otp);
  },
});

api.route({
  method: 'post',
  path: '/auth/resend-verification',
  summary: 'Resend the email link or phone OTP',
  rateLimit: { name: 'resend', config: limits.otp },
  body: z.strictObject({ channel: z.enum(['EMAIL', 'PHONE']) }),
  message: 'Verification sent',
  handler: async ({ auth, body }) => {
    await AuthService.resendVerification(auth.userId, body.channel);
  },
});

export default api.router;
