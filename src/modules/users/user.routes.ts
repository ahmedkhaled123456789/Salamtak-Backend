import { z } from 'zod';
import { createApi } from '../../common/openapi/route';
import { GENDERS } from './user.model';
import { UserSchema } from './user.schemas';
import { UserService } from './user.service';

const updateBody = z
  .strictObject({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    gender: z.enum(GENDERS),
    dateOfBirth: z.coerce.date().max(new Date(), 'must be in the past').min(new Date('1900-01-01')),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');

const api = createApi('Users');

api.route({
  method: 'get',
  path: '/users/me',
  summary: 'Get my account',
  permission: 'profile:self',
  response: UserSchema,
  handler: async ({ auth }) => (await UserService.getById(auth.userId)).toJSON(),
});

api.route({
  method: 'patch',
  path: '/users/me',
  summary: 'Update my account',
  description: 'Email/phone/role cannot be changed here.',
  permission: 'profile:self',
  body: updateBody,
  response: UserSchema,
  message: 'Account updated',
  handler: async ({ auth, body }) => (await UserService.updateProfile(auth.userId, body)).toJSON(),
});

const imageParams = z.strictObject({ id: z.string().regex(/^[a-f\d]{24}$/i, 'invalid id') });
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

api.route({
  method: 'put',
  path: '/users/me/avatar',
  summary: 'Upload or replace my profile photo (multipart/form-data)',
  description:
    'Field `file`: JPEG, PNG or WebP. Public: served from `profileImageUrl`. Nurses use this for the photo shown on the website.',
  permission: 'profile:self',
  rateLimit: { name: 'avatar-upload', config: { points: 20, durationSeconds: 3600 } },
  upload: { field: 'file', maxBytes: PHOTO_MAX_BYTES },
  response: UserSchema,
  message: 'Photo updated',
  handler: async ({ auth, req }) => (await UserService.setProfileImage(auth.userId, req.file)).toJSON(),
});

api.route({
  method: 'put',
  path: '/admin/users/:id/avatar',
  summary: "Upload or replace a user's profile photo (admin)",
  description: 'Used to set a nurse or patient photo on their behalf. Same rules as `/users/me/avatar`.',
  permission: 'admin:media:manage',
  params: imageParams,
  upload: { field: 'file', maxBytes: PHOTO_MAX_BYTES },
  response: UserSchema,
  message: 'Photo updated',
  handler: async ({ params, req }) => (await UserService.setProfileImage(params.id, req.file)).toJSON(),
});

export default api.router;
