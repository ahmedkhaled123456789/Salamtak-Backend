import { Schema, Types, model, type ClientSession } from 'mongoose';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors';
import { withTransaction } from '../../config/database';
import { AuditService, type AuditContext } from '../audit';
import { SettingsService } from '../settings';
import { WalletService } from './wallet.service';

export const ADJUSTMENT_STATUSES = ['PENDING', 'APPLIED', 'REJECTED'] as const;

const adjustmentSchema = new Schema(
  {
    nurseId: { type: Schema.Types.ObjectId, ref: 'NurseProfile', required: true },
    bucket: { type: String, enum: ['PENDING', 'AVAILABLE'], required: true },
    amountMinor: {
      type: Number,
      required: true,
      validate: { validator: (n: number) => Number.isSafeInteger(n) && n !== 0 },
    },
    reason: { type: String, required: true, maxlength: 500 },
    status: { type: String, enum: ADJUSTMENT_STATUSES, required: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    idempotencyKey: { type: String, required: true },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    decidedAt: Date,
    decisionNote: { type: String, maxlength: 500 },
    ledgerId: { type: Schema.Types.ObjectId, ref: 'WalletTransaction' },
    /** why the request needed a second admin (absent when applied immediately) */
    approvalReason: String,
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
adjustmentSchema.index({ requestedBy: 1, idempotencyKey: 1 }, { unique: true });
adjustmentSchema.index({ status: 1, createdAt: -1 });
adjustmentSchema.index({ requestedBy: 1, createdAt: -1 });
export const WalletAdjustment = model('WalletAdjustment', adjustmentSchema, 'walletAdjustments');
export type WalletAdjustmentDoc = InstanceType<typeof WalletAdjustment>;

/**
 * One row per requesting admin. Touched at the start of every request transaction so concurrent
 * requests by the same admin conflict and are serialized: the rolling daily total can never be
 * overshot by racing requests.
 */
const budgetSchema = new Schema(
  { _id: Schema.Types.ObjectId, n: { type: Number, default: 0 } },
  { versionKey: false },
);
const AdjustmentBudget = model('WalletAdjustmentBudget', budgetSchema, 'walletAdjustmentBudgets');

const DAY_MS = 24 * 3600_000;

/**
 * Maker-checker for manual money movements. Limits come from settings (never hardcoded):
 *  - adjustment.maxImmediateMinor: a single adjustment above this needs a second admin
 *  - adjustment.maxDailyMinor: the rolling 24h total of one admin's requests; beyond it, a second admin
 * A PENDING or REJECTED adjustment never touches a balance, so nothing unapproved can be paid out.
 */
export const WalletAdjustmentService = {
  async request(
    a: {
      nurseId: string;
      bucket: 'PENDING' | 'AVAILABLE';
      amountMinor: number;
      reason: string;
      key: string;
    },
    ctx: AuditContext,
  ): Promise<{ adjustment: WalletAdjustmentDoc; applied: boolean; replay: boolean }> {
    const adminId = ctx.actorId as string;
    const settings = await SettingsService.getAll();
    await WalletService.ensure(a.nurseId);
    await AdjustmentBudget.updateOne(
      { _id: adminId },
      { $setOnInsert: { n: 0 } },
      { upsert: true },
    );
    return withTransaction(async (session) => {
      await AdjustmentBudget.updateOne({ _id: adminId }, { $inc: { n: 1 } }, { session });
      const dup = await WalletAdjustment.findOne({
        requestedBy: adminId,
        idempotencyKey: a.key,
      }).session(session);
      if (dup) {
        if (
          String(dup.nurseId) !== a.nurseId ||
          dup.amountMinor !== a.amountMinor ||
          dup.bucket !== a.bucket
        )
          throw new ConflictError(
            'Idempotency-Key was already used with a different adjustment',
            'IDEMPOTENCY_KEY_REUSED',
          );
        return { adjustment: dup, applied: false, replay: true };
      }
      const abs = Math.abs(a.amountMinor);
      const agg = await WalletAdjustment.aggregate<{ total: number }>([
        {
          $match: {
            requestedBy: new Types.ObjectId(adminId),
            createdAt: { $gte: new Date(Date.now() - DAY_MS) },
            status: { $in: ['APPLIED', 'PENDING'] },
          },
        },
        { $group: { _id: null, total: { $sum: { $abs: '$amountMinor' } } } },
      ]).session(session);
      const usedToday = agg[0]?.total ?? 0;
      let approvalReason: string | undefined;
      if (abs > settings['adjustment.maxImmediateMinor']) approvalReason = 'EXCEEDS_SINGLE_LIMIT';
      else if (usedToday + abs > settings['adjustment.maxDailyMinor'])
        approvalReason = 'EXCEEDS_DAILY_LIMIT';

      const [doc] = await WalletAdjustment.create(
        [
          {
            nurseId: a.nurseId,
            bucket: a.bucket,
            amountMinor: a.amountMinor,
            reason: a.reason,
            status: approvalReason ? 'PENDING' : 'APPLIED',
            requestedBy: adminId,
            idempotencyKey: a.key,
            ...(approvalReason && { approvalReason }),
          },
        ],
        { session },
      );
      if (!approvalReason) await this.applyToLedger(doc!, adminId, session);
      await AuditService.record(
        ctx,
        {
          action: approvalReason ? 'wallet.adjustment_requested' : 'wallet.adjusted',
          entity: 'Wallet',
          entityId: a.nurseId,
          newData: {
            adjustmentId: String(doc!._id),
            bucket: a.bucket,
            amountMinor: a.amountMinor,
            reason: a.reason,
            approvalReason: approvalReason ?? null,
          },
        },
        session,
      );
      return { adjustment: doc!, applied: !approvalReason, replay: false };
    });
  },

  async applyToLedger(
    doc: WalletAdjustmentDoc,
    byAdmin: string,
    session: ClientSession,
  ): Promise<void> {
    const { tx } = await WalletService.apply(
      {
        nurseId: String(doc.nurseId),
        type: 'ADJUSTMENT',
        bucket: doc.bucket,
        amountMinor: doc.amountMinor,
        referenceType: 'MANUAL',
        referenceId: String(doc._id),
        idempotencyKey: `wallet-adjustment:${String(doc._id)}`,
        note: doc.reason,
        createdBy: byAdmin,
      },
      session,
    );
    await WalletAdjustment.updateOne(
      { _id: doc._id },
      { $set: { status: 'APPLIED', ledgerId: tx._id } },
      { session },
    );
    doc.status = 'APPLIED';
    doc.ledgerId = tx._id;
  },

  async approve(id: string, note: string | undefined, ctx: AuditContext) {
    return withTransaction(async (session) => {
      const doc = await WalletAdjustment.findById(id).session(session);
      if (!doc) throw new NotFoundError('Adjustment not found', 'ADJUSTMENT_NOT_FOUND');
      if (String(doc.requestedBy) === ctx.actorId)
        throw new ForbiddenError(
          'A different admin must approve this adjustment',
          'MAKER_CHECKER_VIOLATION',
        );
      // atomic claim: exactly one decision can ever win
      const claimed = await WalletAdjustment.findOneAndUpdate(
        { _id: id, status: 'PENDING' },
        { $set: { decidedBy: ctx.actorId, decidedAt: new Date(), decisionNote: note } },
        { new: true, session },
      );
      if (!claimed) {
        if (doc.status === 'APPLIED') return { adjustment: doc, replay: true };
        throw new ConflictError('Adjustment is not pending', 'ADJUSTMENT_NOT_PENDING');
      }
      await this.applyToLedger(claimed, ctx.actorId as string, session);
      await AuditService.record(
        ctx,
        {
          action: 'wallet.adjustment_approved',
          entity: 'WalletAdjustment',
          entityId: id,
          newData: { amountMinor: claimed.amountMinor, bucket: claimed.bucket },
        },
        session,
      );
      return { adjustment: claimed, replay: false };
    });
  },

  async reject(id: string, note: string, ctx: AuditContext) {
    return withTransaction(async (session) => {
      const doc = await WalletAdjustment.findById(id).session(session);
      if (!doc) throw new NotFoundError('Adjustment not found', 'ADJUSTMENT_NOT_FOUND');
      if (doc.status === 'REJECTED') return { adjustment: doc, replay: true };
      const claimed = await WalletAdjustment.findOneAndUpdate(
        { _id: id, status: 'PENDING' },
        {
          $set: {
            status: 'REJECTED',
            decidedBy: ctx.actorId,
            decidedAt: new Date(),
            decisionNote: note,
          },
        },
        { new: true, session },
      );
      if (!claimed) throw new ConflictError('Adjustment is not pending', 'ADJUSTMENT_NOT_PENDING');
      await AuditService.record(
        ctx,
        {
          action: 'wallet.adjustment_rejected',
          entity: 'WalletAdjustment',
          entityId: id,
          newData: { note },
        },
        session,
      );
      return { adjustment: claimed, replay: false };
    });
  },
};
