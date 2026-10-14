import type { ClientSession } from 'mongoose';
import { BookingConflictError } from '../../common/errors';
import { BookingReservation } from './booking.models';

const MIN = 60_000;
/** Hard upper bound on documents per booking (guards against pathological ranges). */
export const MAX_SLOTS_PER_BOOKING = 2000;

/** Slot start instants covering [startMs, endMs). Both must be aligned to the slot grid. */
export function slotStarts(startMs: number, endMs: number, slotMinutes: number): Date[] {
  const step = slotMinutes * MIN;
  if (startMs % step !== 0 || endMs % step !== 0 || endMs <= startMs) {
    throw new Error('range must be slot-aligned and non-empty');
  }
  const count = (endMs - startMs) / step;
  if (count > MAX_SLOTS_PER_BOOKING) throw new Error('range too long');
  const out: Date[] = [];
  for (let t = startMs; t < endMs; t += step) out.push(new Date(t));
  return out;
}

export const ReservationService = {
  /**
   * Reserve every slot of [start,end) for the booking. The unique {nurseId, slotStart} index makes
   * this fail atomically if ANY slot is already taken, even by a concurrent transaction that this
   * one could not see (snapshot isolation). Must run inside the booking transaction.
   */
  async reserve(
    args: {
      nurseId: string;
      bookingId: string;
      startMs: number;
      endMs: number;
      slotMinutes: number;
      holdExpiresAt: Date;
    },
    session: ClientSession,
  ): Promise<number> {
    const docs = slotStarts(args.startMs, args.endMs, args.slotMinutes).map((slotStart) => ({
      nurseId: args.nurseId,
      bookingId: args.bookingId,
      slotStart,
      state: 'HELD' as const,
      expiresAt: args.holdExpiresAt,
    }));
    try {
      await BookingReservation.insertMany(docs, { session, ordered: true });
    } catch (err) {
      const e = err as { code?: number; writeErrors?: { code?: number }[]; message?: string };
      if (
        e.code === 11000 ||
        e.writeErrors?.some((w) => w.code === 11000) ||
        /E11000/.test(e.message ?? '')
      ) {
        throw new BookingConflictError();
      }
      throw err;
    }
    return docs.length;
  },

  /** HELD -> CONFIRMED (payment succeeded). Clears the expiry. */
  async confirm(bookingId: string, session: ClientSession): Promise<void> {
    await BookingReservation.updateMany(
      { bookingId },
      { $set: { state: 'CONFIRMED' }, $unset: { expiresAt: 1 } },
      { session },
    );
  },

  /** Free every slot of a booking. Idempotent. */
  async release(bookingId: string, session?: ClientSession): Promise<number> {
    const res = await BookingReservation.deleteMany({ bookingId }, { session });
    return res.deletedCount ?? 0;
  },

  /**
   * Is any slot of [start,end) currently held for this nurse? Lapsed HELD slots (hold expired but
   * not yet swept) do not count.
   */
  async hasConflict(
    nurseId: string,
    startMs: number,
    endMs: number,
    now: Date,
    session?: ClientSession,
  ): Promise<boolean> {
    const hit = await BookingReservation.exists({
      nurseId,
      slotStart: { $gte: new Date(startMs), $lt: new Date(endMs) },
      $or: [{ state: 'CONFIRMED' }, { expiresAt: { $gt: now } }],
    }).session(session ?? null);
    return !!hit;
  },

  /** Nurse ids having at least one live reservation inside [start,end). One query for many nurses. */
  async busyNurseIds(
    nurseIds: string[],
    startMs: number,
    endMs: number,
    now: Date,
  ): Promise<Set<string>> {
    const ids = await BookingReservation.distinct('nurseId', {
      nurseId: { $in: nurseIds },
      slotStart: { $gte: new Date(startMs), $lt: new Date(endMs) },
      $or: [{ state: 'CONFIRMED' }, { expiresAt: { $gt: now } }],
    });
    return new Set(ids.map(String));
  },

  hasAnyReservation: async (): Promise<boolean> => !!(await BookingReservation.exists({})),
};
