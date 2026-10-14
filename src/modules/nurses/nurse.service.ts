import type { ClientSession } from 'mongoose';
import { BadRequestError, ConflictError, NotFoundError } from '../../common/errors';
import { fromGeoPoint, toGeoPoint, type LatLng } from '../../common/types/geo';
import {
  NurseProfile,
  computeBookable,
  type NurseProfileDoc,
  type NurseStatus,
  type VerificationStatus,
} from './nurseProfile.model';

export interface UpdateNurseInput {
  bio?: string;
  yearsOfExperience?: number;
  specializations?: string[];
  languages?: string[];
  gender?: 'MALE' | 'FEMALE' | 'OTHER';
  dailyRateMinor?: number;
  hourlyRateMinor?: number;
  serviceRadiusKm?: number;
  location?: LatLng | null;
  address?: string;
  city?: string;
  country?: string;
}

export function toNurseDTO(n: NurseProfileDoc) {
  return {
    id: String(n._id),
    userId: String(n.userId),
    bio: n.bio ?? null,
    yearsOfExperience: n.yearsOfExperience,
    specializations: n.specializations,
    languages: n.languages,
    gender: n.gender ?? null,
    dailyRateMinor: n.dailyRateMinor ?? null,
    hourlyRateMinor: n.hourlyRateMinor ?? null,
    currency: 'AED' as const,
    serviceRadiusKm: n.serviceRadiusKm,
    location: fromGeoPoint(n.location),
    address: n.address ?? null,
    city: n.city ?? null,
    country: n.country ?? null,
    status: n.status,
    verificationStatus: n.verificationStatus,
    statusReason: n.statusReason ?? null,
    averageRating: n.averageRating,
    totalReviews: n.totalReviews,
    totalCompletedBookings: n.totalCompletedBookings,
    isBookable: n.isBookable,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  };
}

const notFound = () => new NotFoundError('Nurse profile not found', 'NURSE_PROFILE_NOT_FOUND');

export const NurseService = {
  async createEmpty(userId: string, session?: ClientSession): Promise<void> {
    await NurseProfile.create([{ userId }], { session });
  },

  async getByUserId(userId: string): Promise<NurseProfileDoc> {
    const p = await NurseProfile.findOne({ userId });
    if (!p) throw notFound();
    return p;
  },

  async incrementCompleted(id: string, session?: ClientSession): Promise<void> {
    await NurseProfile.updateOne({ _id: id }, { $inc: { totalCompletedBookings: 1 } }, { session });
  },

  async getById(id: string, session?: ClientSession): Promise<NurseProfileDoc> {
    const p = await NurseProfile.findById(id).session(session ?? null);
    if (!p) throw notFound();
    return p;
  },

  /** Nurse self-service. Status/verification/rating fields can never be set here. */
  async update(userId: string, input: UpdateNurseInput): Promise<NurseProfileDoc> {
    const { location, ...rest } = input;
    const update: Record<string, unknown> = {};
    if (Object.keys(rest).length) update.$set = { ...rest };
    if (location === null) update.$unset = { location: 1 };
    else if (location) update.$set = { ...(update.$set as object), location: toGeoPoint(location) };

    const p = await NurseProfile.findOneAndUpdate({ userId }, update, {
      new: true,
      runValidators: true,
    });
    if (!p) throw notFound();
    return p;
  },

  /** A nurse can pause/resume themselves; admin-controlled states cannot be self-changed. */
  async setSelfStatus(userId: string, status: 'ACTIVE' | 'INACTIVE'): Promise<NurseProfileDoc> {
    const current = await this.getByUserId(userId);
    if (current.status !== 'ACTIVE' && current.status !== 'INACTIVE') {
      throw new ConflictError(
        `Status cannot be changed while ${current.status}`,
        'NURSE_STATUS_LOCKED',
      );
    }
    const p = await NurseProfile.findOneAndUpdate(
      { userId, status: { $in: ['ACTIVE', 'INACTIVE'] } },
      { $set: { status, isBookable: computeBookable(status, current.verificationStatus) } },
      { new: true },
    );
    if (!p) throw new ConflictError('Status changed concurrently', 'NURSE_STATUS_LOCKED');
    return p;
  },

  /**
   * Verification transitions. EXPIRED is system-driven (document expiry); REJECTED and EXPIRED can
   * only go back through UNDER_REVIEW, never straight to VERIFIED. PENDING -> VERIFIED is the
   * legacy admin shortcut kept for the Phase 1 endpoint.
   */
  verificationAllowed(from: VerificationStatus, to: VerificationStatus): boolean {
    const table: Record<VerificationStatus, VerificationStatus[]> = {
      PENDING: ['UNDER_REVIEW', 'VERIFIED', 'REJECTED'],
      UNDER_REVIEW: ['VERIFIED', 'REJECTED'],
      VERIFIED: ['UNDER_REVIEW', 'REJECTED', 'EXPIRED'],
      REJECTED: ['UNDER_REVIEW'],
      EXPIRED: ['UNDER_REVIEW'],
    };
    return table[from].includes(to);
  },

  /**
   * Atomic, conditional verification change: succeeds only if the nurse is still in the state we
   * read (so concurrent decisions can never produce an invalid state). Idempotent: asking for the
   * state the nurse is already in returns `changed:false`. Keeps `isBookable` consistent in the same write.
   */
  async setVerification(
    id: string,
    decision: VerificationStatus,
    reason: string | undefined,
    session?: ClientSession,
  ): Promise<{ before: NurseProfileDoc; after: NurseProfileDoc; changed: boolean }> {
    const before = await this.getById(id, session);
    if (before.verificationStatus === decision) return { before, after: before, changed: false };
    if (!this.verificationAllowed(before.verificationStatus, decision))
      throw new ConflictError(
        `Verification cannot move from ${before.verificationStatus} to ${decision}`,
        'INVALID_VERIFICATION_TRANSITION',
      );
    if (decision === 'REJECTED' && !reason)
      throw new BadRequestError('A reason is required to reject', 'REASON_REQUIRED');
    // A suspended nurse can be verified but stays SUSPENDED (non-bookable) until reactivated.
    const status: NurseStatus =
      decision === 'VERIFIED' && before.status === 'PENDING' ? 'ACTIVE' : before.status;
    const after = await NurseProfile.findOneAndUpdate(
      { _id: id, verificationStatus: before.verificationStatus, status: before.status },
      {
        $set: {
          verificationStatus: decision,
          status,
          isBookable: computeBookable(status, decision),
          ...(decision === 'REJECTED' && { statusReason: reason }),
        },
        ...(decision !== 'REJECTED' && { $unset: { statusReason: 1 } }),
      },
      { new: true, session },
    );
    if (!after)
      throw new ConflictError('Verification changed concurrently; retry', 'VERIFICATION_CONFLICT');
    return { before, after, changed: true };
  },

  /** Admin: set verification decision (legacy endpoint; same transition rules as the workflow). */
  async adminSetVerification(
    id: string,
    decision: VerificationStatus,
    reason: string | undefined,
    session?: ClientSession,
  ): Promise<{ before: NurseProfileDoc; after: NurseProfileDoc }> {
    const { before, after } = await this.setVerification(id, decision, reason, session);
    return { before, after };
  },

  async adminSuspend(
    id: string,
    reason: string,
    session?: ClientSession,
  ): Promise<{ before: NurseProfileDoc; after: NurseProfileDoc }> {
    const before = await this.getById(id, session);
    if (before.status === 'SUSPENDED')
      throw new ConflictError('Nurse is already suspended', 'ALREADY_SUSPENDED');
    const after = await NurseProfile.findByIdAndUpdate(
      id,
      { $set: { status: 'SUSPENDED', statusReason: reason, isBookable: false } },
      { new: true, session },
    );
    return { before, after: after as NurseProfileDoc };
  },

  async adminReactivate(
    id: string,
    session?: ClientSession,
  ): Promise<{ before: NurseProfileDoc; after: NurseProfileDoc }> {
    const before = await this.getById(id, session);
    if (before.status !== 'SUSPENDED')
      throw new ConflictError('Nurse is not suspended', 'NOT_SUSPENDED');
    const status: NurseStatus = before.verificationStatus === 'VERIFIED' ? 'ACTIVE' : 'PENDING';
    const after = await NurseProfile.findByIdAndUpdate(
      id,
      {
        $set: { status, isBookable: computeBookable(status, before.verificationStatus) },
        $unset: { statusReason: 1 },
      },
      { new: true, session },
    );
    return { before, after: after as NurseProfileDoc };
  },
};
