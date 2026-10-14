import { z } from 'zod';
import { createApi } from '../../common/openapi/route';
import { NurseService } from '../nurses';
import {
  AvailabilityRuleSchema,
  availabilityCreateBody,
  availabilityPatchBody,
} from './availability.schemas';
import { AvailabilityService, toAvailabilityDTO } from './availability.service';

const idParams = z.strictObject({ id: z.string().regex(/^[a-f\d]{24}$/i, 'invalid id') });
const api = createApi('Nurse Availability');

const myNurseId = async (userId: string) => String((await NurseService.getByUserId(userId))._id);

api.route({
  method: 'get',
  path: '/nurses/me/availability',
  summary: 'List my availability rules',
  description:
    'Rules are evaluated in the platform timezone (default Asia/Dubai). Precedence: BLOCKED > DATE override > WEEKLY.',
  permission: 'nurse-availability:self',
  response: z.object({ items: z.array(AvailabilityRuleSchema) }),
  handler: async ({ auth }) => ({
    items: (await AvailabilityService.list(await myNurseId(auth.userId))).map(toAvailabilityDTO),
  }),
});

api.route({
  method: 'post',
  path: '/nurses/me/availability',
  summary: 'Add an availability rule',
  description:
    '`WEEKLY`: recurring hours for an ISO weekday. `DATE`: override for one date (unavailable, or replacement hours). `BLOCKED`: vacation/holiday/blocked date range (inclusive). Existing bookings are not affected.',
  permission: 'nurse-availability:self',
  status: 201,
  body: availabilityCreateBody,
  response: AvailabilityRuleSchema,
  handler: async ({ auth, body }) =>
    toAvailabilityDTO(await AvailabilityService.create(await myNurseId(auth.userId), body)),
});

api.route({
  method: 'patch',
  path: '/nurses/me/availability/:id',
  summary: 'Update an availability rule',
  description: 'The rule kind is immutable. Only fields applicable to its kind are accepted.',
  permission: 'nurse-availability:self',
  params: idParams,
  body: availabilityPatchBody,
  response: AvailabilityRuleSchema,
  handler: async ({ auth, params, body }) =>
    toAvailabilityDTO(
      await AvailabilityService.update(await myNurseId(auth.userId), params.id, body),
    ),
});

api.route({
  method: 'delete',
  path: '/nurses/me/availability/:id',
  summary: 'Delete an availability rule',
  permission: 'nurse-availability:self',
  params: idParams,
  handler: async ({ auth, params }) => {
    await AvailabilityService.remove(await myNurseId(auth.userId), params.id);
  },
});

export default api.router;
