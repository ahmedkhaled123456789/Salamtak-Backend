import { DateTime, IANAZone } from 'luxon';

/**
 * Timezone-aware helpers. All instants are stored/handled as UTC epoch ms; the platform timezone
 * (default Asia/Dubai, from PlatformSettings) is used only for *business* calculations
 * (weekday, local date, working hours). Never rely on the server's local timezone.
 */

export const isValidTimezone = (tz: string): boolean => IANAZone.isValidZone(tz);

export const MS_MIN = 60_000;

/** "HH:mm" (00:00..24:00) -> minutes since midnight. */
export function parseHHmm(v: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  if (!m) throw new Error(`Invalid time ${v}`);
  const total = Number(m[1]) * 60 + Number(m[2]);
  if (Number(m[2]) > 59 || total > 1440) throw new Error(`Invalid time ${v}`);
  return total;
}

export function formatHHmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Local calendar date (YYYY-MM-DD) of an instant in `tz`. */
export function localDate(ms: number, tz: string): string {
  return DateTime.fromMillis(ms, { zone: tz }).toFormat('yyyy-LL-dd');
}

/** ISO weekday (1=Mon..7=Sun) of a local date string. */
export function isoWeekday(date: string, tz: string): number {
  return DateTime.fromISO(date, { zone: tz }).weekday;
}

/** [startMs, endMs) of a local calendar day. */
export function localDayBounds(date: string, tz: string): [number, number] {
  const start = DateTime.fromISO(date, { zone: tz }).startOf('day');
  return [start.toMillis(), start.plus({ days: 1 }).startOf('day').toMillis()];
}

export const isValidLocalDate = (v: string, tz: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) && DateTime.fromISO(v, { zone: tz }).isValid;

export const addLocalDays = (date: string, days: number, tz: string): string =>
  DateTime.fromISO(date, { zone: tz }).plus({ days }).toFormat('yyyy-LL-dd');

export interface DaySegment {
  date: string;
  /** minutes since local midnight */
  startMin: number;
  endMin: number;
  startMs: number;
  endMs: number;
}

/** Splits [startMs,endMs) into per-local-day segments (DST-safe, uses real elapsed minutes). */
export function splitByLocalDay(startMs: number, endMs: number, tz: string): DaySegment[] {
  const out: DaySegment[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const date = localDate(cursor, tz);
    const [dayStart, dayEnd] = localDayBounds(date, tz);
    const segEnd = Math.min(endMs, dayEnd);
    out.push({
      date,
      startMin: Math.round((cursor - dayStart) / MS_MIN),
      endMin: Math.round((segEnd - dayStart) / MS_MIN),
      startMs: cursor,
      endMs: segEnd,
    });
    cursor = segEnd;
  }
  return out;
}

/**
 * Exact integer round-half-up of (a*b)/c, i.e. floor((2ab + c) / 2c), computed with BigInt so the
 * intermediate product can never lose precision. All inputs must be non-negative safe integers
 * (c > 0) and the result must itself be a safe integer; anything else throws instead of rounding wrongly.
 */
export function mulDivRound(a: number, b: number, c: number): number {
  for (const [name, v] of [
    ['a', a],
    ['b', b],
    ['c', c],
  ] as const) {
    if (!Number.isSafeInteger(v) || v < 0)
      throw new RangeError(`mulDivRound: ${name} must be a non-negative safe integer`);
  }
  if (c === 0) throw new RangeError('mulDivRound: division by zero');
  const bc = BigInt(c);
  const q = (2n * BigInt(a) * BigInt(b) + bc) / (2n * bc);
  if (q > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError('mulDivRound: result exceeds the safe integer range');
  return Number(q);
}
