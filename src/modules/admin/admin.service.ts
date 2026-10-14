import type { FilterQuery } from 'mongoose';
import { withTransaction } from '../../config/database';
import { ForbiddenError } from '../../common/errors';
import { paginate, type PaginationQuery } from '../../common/pagination';
import { AuditLog, AuditService, type AuditContext } from '../audit';
import { AuthService } from '../auth';
import { NurseProfile, NurseService, toNurseDTO, type VerificationStatus } from '../nurses';
import { User, UserService } from '../users';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface DateRange {
  from?: Date;
  to?: Date;
}
const createdAtFilter = ({ from, to }: DateRange) =>
  from || to ? { createdAt: { ...(from && { $gte: from }), ...(to && { $lte: to }) } } : {};

export const AdminService = {
  /** Phase-1 dashboard: user/nurse statistics. Booking/revenue stats arrive with their phases. */
  async dashboard(range: DateRange) {
    const dateFilter = createdAtFilter(range);
    const [totalUsers, totalPatients, totalNurses, verifiedNurses, pendingNurses, suspendedNurses] =
      await Promise.all([
        User.countDocuments(dateFilter),
        User.countDocuments({ ...dateFilter, role: 'PATIENT' }),
        User.countDocuments({ ...dateFilter, role: 'NURSE' }),
        NurseProfile.countDocuments({ ...dateFilter, verificationStatus: 'VERIFIED' }),
        NurseProfile.countDocuments({
          ...dateFilter,
          verificationStatus: { $in: ['PENDING', 'UNDER_REVIEW'] },
        }),
        NurseProfile.countDocuments({ ...dateFilter, status: 'SUSPENDED' }),
      ]);
    return {
      totalUsers,
      totalPatients,
      totalNurses,
      verifiedNurses,
      pendingNurses,
      suspendedNurses,
    };
  },

  listUsers(
    q: PaginationQuery & { role?: string; isActive?: boolean; search?: string } & DateRange,
  ) {
    const filter: FilterQuery<unknown> = { ...createdAtFilter(q) };
    if (q.role) filter.role = q.role;
    if (q.isActive !== undefined) filter.isActive = q.isActive;
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ email: rx }, { firstName: rx }, { lastName: rx }, { phone: rx }];
    }
    return paginate(User, filter, {
      page: q.page,
      limit: q.limit,
      select: '-passwordHash -failedLoginCount -lockedUntil',
    });
  },

  listNurses(
    q: PaginationQuery & { status?: string; verificationStatus?: string; isBookable?: boolean },
  ) {
    const filter: FilterQuery<unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.verificationStatus) filter.verificationStatus = q.verificationStatus;
    if (q.isBookable !== undefined) filter.isBookable = q.isBookable;
    return paginate(NurseProfile, filter, {
      page: q.page,
      limit: q.limit,
      select: '-bookingSeq -ratingSum',
      populate: { path: 'userId', select: 'firstName lastName email phone isActive profileImage' },
    });
  },

  listAuditLogs(q: PaginationQuery & { entity?: string; entityId?: string; action?: string }) {
    const filter: FilterQuery<unknown> = {};
    if (q.entity) filter.entity = q.entity;
    if (q.entityId) filter.entityId = q.entityId;
    if (q.action) filter.action = q.action;
    return paginate(AuditLog, filter, { page: q.page, limit: q.limit, sort: { at: -1 } });
  },

  async verifyNurse(
    id: string,
    decision: VerificationStatus,
    reason: string | undefined,
    ctx: AuditContext,
  ) {
    return withTransaction(async (session) => {
      const { before, after } = await NurseService.adminSetVerification(
        id,
        decision,
        reason,
        session,
      );
      await AuditService.record(
        ctx,
        {
          action: 'nurse.verification_changed',
          entity: 'NurseProfile',
          entityId: id,
          oldData: { verificationStatus: before.verificationStatus, status: before.status },
          newData: { verificationStatus: after.verificationStatus, status: after.status, reason },
        },
        session,
      );
      return toNurseDTO(after);
    });
  },

  async suspendNurse(id: string, reason: string, ctx: AuditContext) {
    return withTransaction(async (session) => {
      const { before, after } = await NurseService.adminSuspend(id, reason, session);
      await AuditService.record(
        ctx,
        {
          action: 'nurse.suspended',
          entity: 'NurseProfile',
          entityId: id,
          oldData: { status: before.status },
          newData: { status: after.status, reason },
        },
        session,
      );
      return toNurseDTO(after);
    });
  },

  async reactivateNurse(id: string, ctx: AuditContext) {
    return withTransaction(async (session) => {
      const { before, after } = await NurseService.adminReactivate(id, session);
      await AuditService.record(
        ctx,
        {
          action: 'nurse.reactivated',
          entity: 'NurseProfile',
          entityId: id,
          oldData: { status: before.status },
          newData: { status: after.status },
        },
        session,
      );
      return toNurseDTO(after);
    });
  },

  async setUserBlocked(
    id: string,
    blocked: boolean,
    reason: string | undefined,
    ctx: AuditContext,
  ) {
    if (id === ctx.actorId)
      throw new ForbiddenError('You cannot block yourself', 'CANNOT_BLOCK_SELF');
    return withTransaction(async (session) => {
      const target = await UserService.getById(id);
      if (target.role === 'ADMIN' || target.role === 'FINANCE_APPROVER')
        throw new ForbiddenError('Admin accounts cannot be blocked here', 'CANNOT_BLOCK_ADMIN');
      const { before, after } = await UserService.setActive(id, !blocked, reason, session);
      if (blocked) await AuthService.revokeAllForUser(id, 'ADMIN', session);
      await AuditService.record(
        ctx,
        {
          action: blocked ? 'user.blocked' : 'user.unblocked',
          entity: 'User',
          entityId: id,
          oldData: { isActive: before.isActive },
          newData: { isActive: after.isActive, reason },
        },
        session,
      );
      return after.toJSON();
    });
  },
};
