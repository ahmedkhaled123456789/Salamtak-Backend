import '../../common/openapi/extend';
import { z } from 'zod';
import { createApi } from '../../common/openapi/route';
import { PatientService, toPatientDTO } from './patient.service';

const phone = z.string().regex(/^\+[1-9]\d{7,14}$/, 'must be E.164, e.g. +971501234567');
const latLng = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

const PatientProfileSchema = z.object({
  id: z.string(),
  userId: z.string(),
  emergencyContact: z
    .object({
      name: z.string().nullish(),
      phone: z.string().nullish(),
      relation: z.string().nullish(),
    })
    .nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  location: latLng.nullable(),
  notes: z.string().nullable().openapi({ description: 'Non-medical notes only' }),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const updateBody = z
  .strictObject({
    emergencyContact: z
      .strictObject({
        name: z.string().trim().min(1).max(120),
        phone,
        relation: z.string().trim().max(60),
      })
      .partial(),
    address: z.string().trim().max(300),
    city: z.string().trim().max(100),
    country: z.string().trim().max(100),
    location: latLng.nullable(),
    notes: z.string().trim().max(500),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');

const api = createApi('Patients');

api.route({
  method: 'get',
  path: '/patients/me',
  summary: 'Get my patient profile',
  permission: 'patient-profile:self',
  response: PatientProfileSchema,
  handler: async ({ auth }) => toPatientDTO(await PatientService.getByUserId(auth.userId)),
});

api.route({
  method: 'patch',
  path: '/patients/me',
  summary: 'Update my patient profile',
  description:
    'Basic, non-medical information only. Medical data lives in a separate resource (later phase).',
  permission: 'patient-profile:self',
  body: updateBody,
  response: PatientProfileSchema,
  message: 'Profile updated',
  handler: async ({ auth, body }) => toPatientDTO(await PatientService.update(auth.userId, body)),
});

export default api.router;
