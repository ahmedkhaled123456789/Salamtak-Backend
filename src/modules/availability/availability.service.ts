import type { FilterQuery } from 'mongoose';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../../common/errors';
import {
  addLocalDays,
  formatHHmm,
  isValidLocalDate,
  localDate,
  parseHHmm,
} from '../../common/utils/time';
import { SettingsService } from '../settings';
import type { AvailabilityCreate, AvailabilityPatch } from './availability.schemas';
import { checkRange, type AvailabilityRule } from './availability.rules';
import { NurseAvailability, type NurseAvailabilityDoc } from './nurseAvailability.model';

const MAX_RULES_PER_NURSE = 200;

export function toAvailabilityDTO(d: NurseAvailabilityDoc) {
  return {
    id: String(d._id),
    kind: d.kind,
    dayOfWeek: d.dayOfWeek ?? null,
    startTime: d.startMinute == null ? null : formatHHmm(d.startMinute),
    endTime: d.endMinute == null ? null : formatHHmm(d.endMinute),
    date: d.date ?? null,
    isAvailable: d.isAvailable ?? null,
    type: d.blockType ?? null,
    dateFrom: d.dateFrom ?? null,
    dateTo: d.dateTo ?? null,
    reason: d.reason ?? null,
  };
}

interface Candidate {
  kind: 'WEEKLY' | 'DATE' | 'BLOCKED';
  dayOfWeek?: number;
  date?: string;
  dateFrom?: string;
  dateTo?: string;
  blockType?: string;
  isAvailable?: boolean;
  startMinute?: number;
  endMinute?: number;
  reason?: string;
}

const overlaps = (a: Candidate, b: Candidate) =>
  a.startMinute! < b.endMinute! && b.startMinute! < a.endMinute!;

function toCandidate(input: AvailabilityCreate, tz: string): Candidate {
  const checkDate = (d: string) => {
    if (!isValidLocalDate(d, tz))
      throw new BadRequestError(`Invalid calendar date ${d}`, 'INVALID_DATE');
  };
  const times = (v: { startTime?: string; endTime?: string }) => {
    const s = parseHHmm(v.startTime!);
    const e = parseHHmm(v.endTime!);
    if (s >= e)
      throw new BadRequestError('startTime must be before endTime', 'INVALID_TIME_WINDOW');
    return { startMinute: s, endMinute: e };
  };
  switch (input.kind) {
    case 'WEEKLY':
      return { kind: 'WEEKLY', dayOfWeek: input.dayOfWeek, ...times(input) };
    case 'DATE':
      checkDate(input.date);
      if (input.isAvailable) {
        if (!input.startTime || !input.endTime)
          throw new BadRequestError('Working window required', 'INVALID_TIME_WINDOW');
        return { kind: 'DATE', date: input.date, isAvailable: true, ...times(input) };
      }
      return { kind: 'DATE', date: input.date, isAvailable: false };
    case 'BLOCKED':
      checkDate(input.dateFrom);
      checkDate(input.dateTo);
      if (input.dateFrom > input.dateTo)
        throw new BadRequestError('dateFrom must be on or before dateTo', 'INVALID_DATE_RANGE');
      if (addLocalDays(input.dateFrom, 366, tz) < input.dateTo)
        throw new BadRequestError('Blocked range cannot exceed one year', 'INVALID_DATE_RANGE');
      return {
        kind: 'BLOCKED',
        blockType: input.type,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        reason: input.reason,
      };
  }
}

async function assertNoConflict(nurseId: string, cand: Candidate, ignoreId?: string) {
  const base: FilterQuery<unknown> = { nurseId };
  if (ignoreId) base._id = { $ne: ignoreId };
  if ((await NurseAvailability.countDocuments(base)) >= MAX_RULES_PER_NURSE)
    throw new AppError(422, 'AVAILABILITY_LIMIT', `At most ${MAX_RULES_PER_NURSE} rules per nurse`);
  if (cand.kind === 'BLOCKED') return;
  const same =
    cand.kind === 'WEEKLY'
      ? await NurseAvailability.find({ ...base, kind: 'WEEKLY', dayOfWeek: cand.dayOfWeek })
      : await NurseAvailability.find({ ...base, kind: 'DATE', date: cand.date });
  for (const other of same) {
    const o: Candidate = {
      kind: other.kind,
      isAvailable: other.isAvailable ?? undefined,
      startMinute: other.startMinute ?? undefined,
      endMinute: other.endMinute ?? undefined,
    };
    const dateClash =
      cand.kind === 'DATE' && (cand.isAvailable === false || o.isAvailable === false);
    if (dateClash || overlaps(cand, o))
      throw new ConflictError('Overlaps an existing availability rule', 'AVAILABILITY_OVERLAP');
  }
}

const FIELDS_BY_KIND: Record<string, string[]> = {
  WEEKLY: ['dayOfWeek', 'startTime', 'endTime'],
  DATE: ['date', 'isAvailable', 'startTime', 'endTime'],
  BLOCKED: ['type', 'dateFrom', 'dateTo', 'reason'],
};

export const AvailabilityService = {
  list(nurseId: string) {
    return NurseAvailability.find({ nurseId }).sort({
      kind: 1,
      dayOfWeek: 1,
      date: 1,
      startMinute: 1,
    });
  },

  async create(nurseId: string, input: AvailabilityCreate): Promise<NurseAvailabilityDoc> {
    const tz = await SettingsService.get('platform.timezone');
    const cand = toCandidate(input, tz);
    await assertNoConflict(nurseId, cand);
    return NurseAvailability.create({ nurseId, ...cand });
  },

  async update(
    nurseId: string,
    id: string,
    patch: AvailabilityPatch,
  ): Promise<NurseAvailabilityDoc> {
    const doc = await NurseAvailability.findOne({ _id: id, nurseId });
    if (!doc) throw new NotFoundError('Availability rule not found', 'AVAILABILITY_NOT_FOUND');
    const tz = await SettingsService.get('platform.timezone');
    const bad = Object.keys(patch).filter((k) => !FIELDS_BY_KIND[doc.kind]!.includes(k));
    if (bad.length)
      throw new BadRequestError(
        `Fields not applicable to ${doc.kind} rules: ${bad.join(', ')}`,
        'FIELD_NOT_APPLICABLE',
      );
    const cur = toAvailabilityDTO(doc);
    const isAvailable = patch.isAvailable ?? cur.isAvailable ?? undefined;
    const merged = {
      kind: doc.kind,
      dayOfWeek: patch.dayOfWeek ?? cur.dayOfWeek ?? undefined,
      startTime:
        doc.kind === 'DATE' && isAvailable === false
          ? undefined
          : (patch.startTime ?? cur.startTime ?? undefined),
      endTime:
        doc.kind === 'DATE' && isAvailable === false
          ? undefined
          : (patch.endTime ?? cur.endTime ?? undefined),
      date: patch.date ?? cur.date ?? undefined,
      isAvailable,
      type: patch.type ?? cur.type ?? undefined,
      dateFrom: patch.dateFrom ?? cur.dateFrom ?? undefined,
      dateTo: patch.dateTo ?? cur.dateTo ?? undefined,
      reason: patch.reason ?? cur.reason ?? undefined,
    };
    const cand = toCandidate(merged as AvailabilityCreate, tz);
    await assertNoConflict(nurseId, cand, id);
    doc.set({
      dayOfWeek: cand.dayOfWeek,
      date: cand.date,
      dateFrom: cand.dateFrom,
      dateTo: cand.dateTo,
      blockType: cand.blockType,
      isAvailable: cand.isAvailable,
      startMinute: cand.startMinute,
      endMinute: cand.endMinute,
      reason: cand.reason,
    });
    await doc.save();
    return doc;
  },

  async remove(nurseId: string, id: string): Promise<void> {
    const res = await NurseAvailability.deleteOne({ _id: id, nurseId });
    if (!res.deletedCount)
      throw new NotFoundError('Availability rule not found', 'AVAILABILITY_NOT_FOUND');
  },

  /** Loads every rule that can affect dates in [fromDate, toDate] for many nurses (one query). */
  async rulesFor(
    nurseIds: string[],
    fromDate: string,
    toDate: string,
  ): Promise<Map<string, AvailabilityRule[]>> {
    const docs = await NurseAvailability.find({
      nurseId: { $in: nurseIds },
      $or: [
        { kind: 'WEEKLY' },
        { kind: 'DATE', date: { $gte: fromDate, $lte: toDate } },
        { kind: 'BLOCKED', dateFrom: { $lte: toDate }, dateTo: { $gte: fromDate } },
      ],
    }).lean();
    const map = new Map<string, AvailabilityRule[]>();
    for (const id of nurseIds) map.set(id, []);
    for (const d of docs) map.get(String(d.nurseId))!.push(d as unknown as AvailabilityRule);
    return map;
  },

  /** Is [startMs,endMs) inside the nurse's working time? (Ignores existing bookings.) */
  async checkWorkingTime(nurseId: string, startMs: number, endMs: number) {
    const tz = await SettingsService.get('platform.timezone');
    const rules = await this.rulesFor([nurseId], localDate(startMs, tz), localDate(endMs - 1, tz));
    return checkRange(rules.get(nurseId)!, startMs, endMs, tz);
  },
};
