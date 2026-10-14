import '../../common/openapi/extend';
import { z } from 'zod';
import { parseHHmm } from '../../common/utils/time';
import { BLOCK_TYPES } from './nurseAvailability.model';

const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'must be HH:mm (00:00-24:00)')
  .openapi({ example: '08:00' });
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .openapi({ example: '2026-12-01', description: 'Local date in the platform timezone' });

// Refinements can still run when a field regex failed, so never let parsing throw here.
const ordered = (v: object) => {
  const t = v as { startTime?: string; endTime?: string };
  if (!t.startTime || !t.endTime) return true;
  try {
    return parseHHmm(t.startTime) < parseHHmm(t.endTime);
  } catch {
    return true; // the field-level regex already reports the bad format
  }
};

export const weeklyInput = z.strictObject({
  kind: z.literal('WEEKLY'),
  dayOfWeek: z
    .number()
    .int()
    .min(1)
    .max(7)
    .openapi({ description: 'ISO weekday, 1=Monday .. 7=Sunday' }),
  startTime: time,
  endTime: time,
});

export const dateInput = z.strictObject({
  kind: z.literal('DATE'),
  date,
  isAvailable: z.boolean().openapi({
    description:
      'false = unavailable all day; true = the given working window replaces the weekly schedule for that date',
  }),
  startTime: time.optional(),
  endTime: time.optional(),
});

export const blockedInput = z.strictObject({
  kind: z.literal('BLOCKED'),
  type: z.enum(BLOCK_TYPES),
  dateFrom: date,
  dateTo: date,
  reason: z.string().trim().max(200).optional(),
});

export const availabilityCreateBody = z
  .discriminatedUnion('kind', [weeklyInput, dateInput, blockedInput])
  .refine(ordered, { message: 'startTime must be before endTime', path: ['endTime'] })
  .refine(
    (v) =>
      v.kind !== 'DATE' ||
      (v.isAvailable ? !!v.startTime && !!v.endTime : !v.startTime && !v.endTime),
    {
      message: 'DATE: times are required when isAvailable=true and forbidden when false',
      path: ['isAvailable'],
    },
  )
  .refine((v) => v.kind !== 'BLOCKED' || v.dateFrom <= v.dateTo, {
    message: 'dateFrom must be on or before dateTo',
    path: ['dateTo'],
  });
export type AvailabilityCreate = z.infer<typeof availabilityCreateBody>;

export const availabilityPatchBody = z
  .strictObject({
    dayOfWeek: z.number().int().min(1).max(7),
    startTime: time,
    endTime: time,
    date,
    isAvailable: z.boolean(),
    type: z.enum(BLOCK_TYPES),
    dateFrom: date,
    dateTo: date,
    reason: z.string().trim().max(200),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');
export type AvailabilityPatch = z.infer<typeof availabilityPatchBody>;

export const AvailabilityRuleSchema = z.object({
  id: z.string(),
  kind: z.enum(['WEEKLY', 'DATE', 'BLOCKED']),
  dayOfWeek: z.number().nullable(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  date: z.string().nullable(),
  isAvailable: z.boolean().nullable(),
  type: z.enum(BLOCK_TYPES).nullable(),
  dateFrom: z.string().nullable(),
  dateTo: z.string().nullable(),
  reason: z.string().nullable(),
});
