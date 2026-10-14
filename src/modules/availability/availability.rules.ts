import { isoWeekday, splitByLocalDay } from '../../common/utils/time';

export interface AvailabilityRule {
  kind: 'WEEKLY' | 'DATE' | 'BLOCKED';
  /** WEEKLY: ISO weekday 1..7 */
  dayOfWeek?: number | null;
  /** DATE: local date YYYY-MM-DD */
  date?: string | null;
  /** BLOCKED: inclusive local date range */
  dateFrom?: string | null;
  dateTo?: string | null;
  /** DATE: false => the whole day is unavailable */
  isAvailable?: boolean | null;
  startMinute?: number | null;
  endMinute?: number | null;
}

export type AvailabilityFailure = 'BLOCKED' | 'DAY_UNAVAILABLE' | 'OUTSIDE_WORKING_HOURS';

export type Window = [number, number];

function merge(windows: Window[]): Window[] {
  const sorted = [...windows].sort((a, b) => a[0] - b[0]);
  const out: Window[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else out.push([w[0], w[1]]);
  }
  return out;
}

/**
 * Effective working windows (minutes since local midnight) for one local date.
 * Precedence: BLOCKED (vacation/holiday/blocked) > DATE override > WEEKLY.
 * A DATE override REPLACES the weekly schedule for that date.
 */
export function effectiveWindows(
  rules: AvailabilityRule[],
  date: string,
  tz: string,
): { windows: Window[]; failure?: AvailabilityFailure } {
  if (rules.some((r) => r.kind === 'BLOCKED' && r.dateFrom! <= date && date <= r.dateTo!)) {
    return { windows: [], failure: 'BLOCKED' };
  }
  const dateRules = rules.filter((r) => r.kind === 'DATE' && r.date === date);
  if (dateRules.length) {
    if (dateRules.some((r) => r.isAvailable === false)) {
      return { windows: [], failure: 'DAY_UNAVAILABLE' };
    }
    return { windows: merge(dateRules.map((r) => [r.startMinute!, r.endMinute!] as Window)) };
  }
  const dow = isoWeekday(date, tz);
  const weekly = rules.filter((r) => r.kind === 'WEEKLY' && r.dayOfWeek === dow);
  return { windows: merge(weekly.map((r) => [r.startMinute!, r.endMinute!] as Window)) };
}

/**
 * True iff every local-day slice of [startMs,endMs) lies fully inside one effective working window.
 * Pure function: unit-testable and shared by booking validation and nurse search.
 */
export function checkRange(
  rules: AvailabilityRule[],
  startMs: number,
  endMs: number,
  tz: string,
): { ok: true } | { ok: false; reason: AvailabilityFailure; date: string } {
  for (const seg of splitByLocalDay(startMs, endMs, tz)) {
    const { windows, failure } = effectiveWindows(rules, seg.date, tz);
    if (failure) return { ok: false, reason: failure, date: seg.date };
    const covered = windows.some(([ws, we]) => seg.startMin >= ws && seg.endMin <= we);
    if (!covered) return { ok: false, reason: 'OUTSIDE_WORKING_HOURS', date: seg.date };
  }
  return { ok: true };
}
