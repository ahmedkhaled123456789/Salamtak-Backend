import '../../common/openapi/extend';
import { z } from 'zod';
import { createApi } from '../../common/openapi/route';
import { NurseService, toNurseDTO } from './nurse.service';
import { NurseProfileSchema } from './nurse.schemas';

const latLng = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
const minor = z.number().int().min(0).max(100_000_000).openapi({
  description: 'Integer amount in minor units (fils). 250 AED = 25000',
});
const tag = z.string().trim().min(1).max(60);

const updateBody = z
  .strictObject({
    bio: z.string().trim().max(2000),
    yearsOfExperience: z.number().min(0).max(70),
    specializations: z.array(tag).max(20),
    languages: z.array(tag).max(10),
    gender: z.enum(['MALE', 'FEMALE', 'OTHER']),
    dailyRateMinor: minor,
    hourlyRateMinor: minor,
    serviceRadiusKm: z.number().min(0).max(200),
    location: latLng.nullable(),
    address: z.string().trim().max(300),
    city: z.string().trim().max(100),
    country: z.string().trim().max(100),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');

const api = createApi('Nurses');

api.route({
  method: 'get',
  path: '/nurses/me',
  summary: 'Get my nurse profile',
  permission: 'nurse-profile:self',
  response: NurseProfileSchema,
  handler: async ({ auth }) => toNurseDTO(await NurseService.getByUserId(auth.userId)),
});

api.route({
  method: 'patch',
  path: '/nurses/me',
  summary: 'Update my nurse profile',
  description:
    'Status, verification, ratings and booking counters cannot be changed here (strict schema rejects them).',
  permission: 'nurse-profile:self',
  body: updateBody,
  response: NurseProfileSchema,
  message: 'Profile updated',
  handler: async ({ auth, body }) => toNurseDTO(await NurseService.update(auth.userId, body)),
});

api.route({
  method: 'patch',
  path: '/nurses/me/status',
  summary: 'Pause or resume accepting bookings',
  description: 'Only ACTIVE <-> INACTIVE. PENDING and SUSPENDED are admin-controlled.',
  permission: 'nurse-profile:self',
  body: z.strictObject({ status: z.enum(['ACTIVE', 'INACTIVE']) }),
  response: NurseProfileSchema,
  handler: async ({ auth, body }) =>
    toNurseDTO(await NurseService.setSelfStatus(auth.userId, body.status)),
});

export default api.router;
