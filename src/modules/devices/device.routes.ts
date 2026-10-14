import '../../common/openapi/extend';
import { z } from 'zod';
import { createApi } from '../../common/openapi/route';
import { DEVICE_PLATFORMS } from './device.models';
import { DeviceService, toDeviceDTO } from './device.service';

const DeviceSchema = z.object({
  id: z.string(),
  platform: z.enum(DEVICE_PLATFORMS),
  appVersion: z.string().nullable(),
  active: z.boolean(),
  token: z.string().openapi({ description: 'Masked; the full token is never returned' }),
  lastSeenAt: z.date(),
  createdAt: z.date(),
});
const limit = { name: 'device-register', config: { points: 30, durationSeconds: 3600 } };

const api = createApi('Devices');

api.route({
  method: 'post',
  path: '/devices',
  summary: 'Register or refresh a push token',
  description:
    'Idempotent upsert on the token. Signing in on a device that another user used moves the registration to the caller. The number of active devices per user is capped (`devices.maxActivePerUser`); the oldest are deactivated.',
  permission: 'devices:self',
  rateLimit: limit,
  status: 201,
  body: z.strictObject({
    token: z.string().trim().min(16).max(4096),
    platform: z.enum(DEVICE_PLATFORMS),
    appVersion: z.string().trim().max(40).optional(),
  }),
  response: DeviceSchema.extend({ created: z.boolean() }),
  handler: async ({ auth, body }) => {
    const r = await DeviceService.register(auth.userId, body);
    return { ...toDeviceDTO(r.device), created: r.created };
  },
});

api.route({
  method: 'get',
  path: '/devices',
  summary: 'My registered devices',
  permission: 'devices:self',
  response: z.array(DeviceSchema),
  handler: async ({ auth }) => (await DeviceService.listMine(auth.userId)).map(toDeviceDTO),
});

api.route({
  method: 'post',
  path: '/devices/unregister',
  summary: 'Stop pushes to this device (call on logout)',
  description: 'Idempotent. Only the owner can unregister; a foreign or unknown token is a 404.',
  permission: 'devices:self',
  rateLimit: limit,
  body: z.strictObject({ token: z.string().trim().min(16).max(4096) }),
  response: z.object({ changed: z.boolean() }),
  handler: async ({ auth, body }) => ({
    changed: await DeviceService.unregisterToken(auth.userId, body.token),
  }),
});

api.route({
  method: 'post',
  path: '/devices/:id/deactivate',
  summary: 'Deactivate one of my devices',
  permission: 'devices:self',
  params: z.strictObject({ id: z.string().regex(/^[a-f\d]{24}$/i, 'invalid id') }),
  response: z.object({ changed: z.boolean() }),
  handler: async ({ auth, params }) => ({
    changed: await DeviceService.deactivate(auth.userId, params.id),
  }),
});

export default api.router;
