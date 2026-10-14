import type mongoose from 'mongoose';
import { withTransaction } from '../../config/database';
import { AuditService, type AuditContext } from '../audit';
import { Booking, allocateRetained, type BookingDoc } from '../bookings';
import { Payment } from '../payments';
import { Payout } from '../payouts';
import { Refund, RefundService } from '../refunds';
import { Wallet, WalletAdjustment, WalletService, WalletTransaction } from '../wallets';

export interface Check {
  name: string;
  ok: boolean;
  checked: number;
  problems: string[];
}
export interface ReconciliationReport {
  ok: boolean;
  generatedAt: string;
  totals: {
    bookingsPaid: number;
    grossMinor: number;
    patientPaidMinor: number;
    commissionMinor: number;
    nurseEarningMinor: number;
    refundedMinor: number;
    paidOutMinor: number;
  };
  checks: Check[];
}

const MAX_PROBLEMS = 50;
const mk = (name: string): Check & { add(msg: string): void } => {
  const c = {
    name,
    ok: true,
    checked: 0,
    problems: [] as string[],
    add(msg: string) {
      c.ok = false;
      if (c.problems.length < MAX_PROBLEMS) c.problems.push(msg);
    },
  };
  return c;
};

/** Pending earnings a booking SHOULD still hold, derived from its state and immutable snapshot. */
export function expectedPendingMinor(
  b: Pick<
    BookingDoc,
    'status' | 'earningReleasedAt' | 'refund' | 'financialSnapshot' | 'pricingSnapshot'
  >,
): number | null {
  const earning = b.financialSnapshot!.nurseEarningMinor;
  const paid = b.pricingSnapshot!.patientPayableMinor;
  const retained = () =>
    allocateRetained({
      paidMinor: paid,
      refundMinor: b.refund?.amountMinor ?? 0,
      nurseEarningMinor: earning,
      refundPercent: b.refund?.percent ?? undefined,
    }).nurseShareMinor;
  switch (b.status) {
    case 'NURSE_PENDING':
    case 'NURSE_ACCEPTED':
    case 'CONFIRMED':
    case 'CARE_STARTED':
    case 'CARE_IN_PROGRESS':
    case 'DISPUTED': // frozen: still pending
    case 'FAILED': // refund failed: earnings were restored
      return b.earningReleasedAt ? 0 : earning;
    case 'COMPLETED':
      return b.earningReleasedAt ? 0 : earning;
    case 'EXPIRED':
    case 'NURSE_REJECTED':
      return 0; // fully reversed (100% refund)
    case 'REFUND_PENDING':
    case 'REFUNDED':
    case 'CANCELLED':
      return b.earningReleasedAt ? 0 : retained();
    default:
      return null; // unpaid states: no earning expected
  }
}

export const ReconciliationService = {
  /** READ-ONLY. Never changes any data; repairs are explicit, separate operations. */
  async run(): Promise<ReconciliationReport> {
    const checks: Check[] = [];

    // 1. wallet balances vs ledger-derived balances
    const walletCheck = mk('wallet balances equal the ledger');
    const sums = await WalletTransaction.aggregate<{
      _id: mongoose.Types.ObjectId;
      pending: number;
      available: number;
      earned: number;
      withdrawn: number;
    }>([
      {
        $group: {
          _id: '$walletId',
          pending: { $sum: { $cond: [{ $eq: ['$bucket', 'PENDING'] }, '$amountMinor', 0] } },
          available: { $sum: { $cond: [{ $eq: ['$bucket', 'AVAILABLE'] }, '$amountMinor', 0] } },
          earned: { $sum: '$earnedDelta' },
          withdrawn: { $sum: '$withdrawnDelta' },
        },
      },
    ]);
    const byWallet = new Map(sums.map((s) => [String(s._id), s]));
    for await (const w of Wallet.find().lean().cursor()) {
      walletCheck.checked += 1;
      const s = byWallet.get(String(w._id)) ?? {
        pending: 0,
        available: 0,
        earned: 0,
        withdrawn: 0,
      };
      const diffs = [
        ['pending', w.pendingBalanceMinor, s.pending],
        ['available', w.availableBalanceMinor, s.available],
        ['totalEarned', w.totalEarnedMinor, s.earned],
        ['totalWithdrawn', w.totalWithdrawnMinor, s.withdrawn],
      ].filter(([, a, b]) => a !== b);
      for (const [n, a, b] of diffs)
        walletCheck.add(`wallet ${String(w._id)} ${n}: balance ${a} != ledger ${b}`);
      if (
        [
          w.pendingBalanceMinor,
          w.availableBalanceMinor,
          w.totalEarnedMinor,
          w.totalWithdrawnMinor,
        ].some((v) => v < 0)
      )
        walletCheck.add(`wallet ${String(w._id)} has a negative balance`);
    }
    checks.push(walletCheck);

    // 2. ledger rows are internally consistent
    const rowCheck = mk('ledger rows are consistent');
    rowCheck.checked = await WalletTransaction.countDocuments();
    const bad = await WalletTransaction.find({
      $expr: {
        $and: [
          { $ne: ['$bucket', 'NONE'] },
          { $ne: ['$balanceAfter', { $add: ['$balanceBefore', '$amountMinor'] }] },
        ],
      },
    })
      .limit(MAX_PROBLEMS)
      .lean();
    for (const r of bad)
      rowCheck.add(`ledger row ${String(r._id)}: balanceAfter != balanceBefore + amount`);
    checks.push(rowCheck);

    // Checks 3, 4b, 6, 7, 9 and 13b all look at every paid booking. They run in ONE streamed pass (the paid set
    // grows without bound, so it is never held in memory), and the payment + EARNING rows each booking needs are
    // loaded once and shared. Problems for checks 4 and 13 are buffered so every check reports in its usual order.
    const pendingCheck = mk('pending earnings equal eligible bookings');
    const payCheck = mk('payments reconcile with bookings');
    const oblCheck = mk('every pending booking refund has an obligation');
    const comCheck = mk('commission and allocations reconcile with snapshots');
    const earnCheck = mk('earnings are credited exactly once per paid booking');
    const refAmtCheck = mk('refund amounts match obligations and snapshots');
    const payBookingProblems: string[] = [];
    let payBookingChecked = 0;
    const refAmtBookingProblems: string[] = [];
    const totals = {
      bookingsPaid: 0,
      grossMinor: 0,
      patientPaidMinor: 0,
      commissionMinor: 0,
      nurseEarningMinor: 0,
      refundedMinor: 0,
      paidOutMinor: 0,
    };
    const PAID_PAYMENT = ['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED'];

    for await (const b of Booking.find({ paidAt: { $exists: true } })
      .lean()
      .cursor()) {
      const id = String(b._id);
      const pay = b.paymentId ? await Payment.findById(b.paymentId).lean() : null;
      const earningRows = await WalletTransaction.find({
        referenceType: 'BOOKING',
        referenceId: b._id,
        type: 'EARNING',
      }).lean();

      // 3. pending balances equal what eligible bookings should still hold
      const expected = expectedPendingMinor(b as unknown as BookingDoc);
      // no EARNING row = booking settled without a payment (legacy/test flow)
      if (expected !== null && earningRows.length > 0) {
        pendingCheck.checked += 1;
        const net = await WalletService.bookingNet(id);
        if (net.pending !== expected)
          pendingCheck.add(`booking ${id} (${b.status}): pending ${net.pending} != expected ${expected}`);
      }

      // 4b. a paid booking's payment must be in a paid state
      if (b.paymentId) {
        payBookingChecked += 1;
        if (!pay || !PAID_PAYMENT.includes(pay.status))
          payBookingProblems.push(`booking ${id} is paid but its payment is ${pay?.status ?? 'missing'}`);
      }

      // 6. refund obligations exist for bookings awaiting a refund
      if (b.status === 'REFUND_PENDING' && b.paymentId) {
        oblCheck.checked += 1;
        if (!(await Refund.exists({ bookingId: b._id })))
          oblCheck.add(`booking ${id} is REFUND_PENDING without a refund record`);
      }

      // 7. commission / allocation arithmetic from the immutable snapshots
      comCheck.checked += 1;
      const f = b.financialSnapshot!;
      totals.bookingsPaid += 1;
      totals.grossMinor += f.grossMinor;
      totals.patientPaidMinor += f.patientPaidMinor;
      totals.commissionMinor += f.commissionMinor;
      totals.nurseEarningMinor += f.nurseEarningMinor;
      if (f.commissionMinor + f.nurseEarningMinor !== f.grossMinor)
        comCheck.add(`booking ${id}: commission + nurse != gross`);
      if (f.grossMinor - f.discountMinor !== f.patientPaidMinor)
        comCheck.add(`booking ${id}: gross - discount != patient paid`);
      if (f.patientPaidMinor !== b.pricingSnapshot!.patientPayableMinor)
        comCheck.add(`booking ${id}: financial vs pricing snapshot differ`);
      if (
        b.commissionSnapshot!.platformMinor !== f.commissionMinor ||
        b.commissionSnapshot!.nurseMinor !== f.nurseEarningMinor
      )
        comCheck.add(`booking ${id}: commission snapshot differs from financial snapshot`);
      const o = b.cancellationOutcome;
      if (o && o.refundMinor + o.nurseCompensationMinor + o.platformKeptMinor !== f.patientPaidMinor)
        comCheck.add(`booking ${id}: refund + nurse + platform != patient paid`);

      // 9. every settled payment credited the nurse exactly once, with the snapshot amount
      if (b.paymentId && pay && pay.settlement === 'APPLIED') {
        earnCheck.checked += 1;
        const earning = f.nurseEarningMinor;
        if (earning === 0) {
          // zero-earning bookings legitimately have no credit; a non-zero one would be wrong
          const sum = earningRows.reduce((a, r) => a + r.amountMinor, 0);
          if (sum !== 0) earnCheck.add(`booking ${id}: zero earning but ledger credited ${sum}`);
        } else if (earningRows.length === 0) earnCheck.add(`booking ${id}: paid but the nurse was never credited`);
        else if (earningRows.length > 1)
          earnCheck.add(`booking ${id}: credited ${earningRows.length} times (duplicate EARNING)`);
        else if (earningRows[0]!.amountMinor !== earning || earningRows[0]!.bucket !== 'PENDING')
          earnCheck.add(`booking ${id}: EARNING ${earningRows[0]!.amountMinor} != snapshot earning ${earning}`);
      }

      // 13b. the cancellation outcome matches the retained-amount allocation
      if (o && b.financialSnapshot) {
        const alloc = allocateRetained({
          paidMinor: b.pricingSnapshot!.patientPayableMinor,
          refundMinor: o.refundMinor,
          nurseEarningMinor: b.financialSnapshot.nurseEarningMinor,
          refundPercent: o.refundPercent,
        });
        if (alloc.nurseShareMinor !== o.nurseCompensationMinor)
          refAmtBookingProblems.push(
            `booking ${id}: outcome nurse ${o.nurseCompensationMinor} != allocation ${alloc.nurseShareMinor}`,
          );
      }
    }
    checks.push(pendingCheck);

    // 4. payments vs bookings
    for await (const p of Payment.find({
      status: { $in: ['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED'] },
    })
      .lean()
      .cursor()) {
      payCheck.checked += 1;
      const b = await Booking.findById(p.bookingId).lean();
      if (!b) {
        payCheck.add(`payment ${String(p._id)} has no booking`);
        continue;
      }
      if (p.settlement === 'APPLIED') {
        if (String(b.paymentId) !== String(p._id))
          payCheck.add(`payment ${String(p._id)} applied but booking points elsewhere`);
        if (b.pricingSnapshot!.patientPayableMinor !== p.amountMinor)
          payCheck.add(
            `payment ${String(p._id)} amount ${p.amountMinor} != booking payable ${b.pricingSnapshot!.patientPayableMinor}`,
          );
      } else if (!p.settlement)
        payCheck.add(`payment ${String(p._id)} is PAID without a settlement`);
    }
    payCheck.checked += payBookingChecked;
    for (const problem of payBookingProblems) payCheck.add(problem);
    checks.push(payCheck);

    // 5. refunds vs payments
    const refCheck = mk('refunds reconcile with payments');
    const refundSums = await Refund.aggregate<{ _id: mongoose.Types.ObjectId; sum: number }>([
      { $match: { status: 'SUCCEEDED' } },
      { $group: { _id: '$paymentId', sum: { $sum: '$amountMinor' } } },
    ]);
    const refundByPayment = new Map(refundSums.map((r) => [String(r._id), r.sum]));
    for await (const p of Payment.find({
      status: { $in: ['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED'] },
    })
      .lean()
      .cursor()) {
      refCheck.checked += 1;
      const sum = refundByPayment.get(String(p._id)) ?? 0;
      if (p.refundedMinor !== sum)
        refCheck.add(
          `payment ${String(p._id)} refundedMinor ${p.refundedMinor} != succeeded refunds ${sum}`,
        );
      if (p.refundedMinor > p.amountMinor)
        refCheck.add(`payment ${String(p._id)} refunded more than paid`);
      const expect =
        p.refundedMinor === 0
          ? 'PAID'
          : p.refundedMinor >= p.amountMinor
            ? 'REFUNDED'
            : 'PARTIALLY_REFUNDED';
      if (p.status !== expect)
        refCheck.add(`payment ${String(p._id)} status ${p.status} != expected ${expect}`);
    }
    for await (const r of Refund.find({ status: 'SUCCEEDED', bookingId: { $exists: true } })
      .lean()
      .cursor()) {
      const b = await Booking.findById(r.bookingId).lean();
      if (b && b.status !== 'REFUNDED')
        refCheck.add(`refund ${String(r._id)} succeeded but booking is ${b.status}`);
    }
    checks.push(refCheck);

    // 6. refund obligations (computed in the paid-booking pass)
    checks.push(oblCheck);

    // 7. commission / allocation arithmetic (computed in the paid-booking pass)
    totals.refundedMinor = refundByPayment.size
      ? [...refundByPayment.values()].reduce((a, b) => a + b, 0)
      : 0;
    checks.push(comCheck);

    // 8. payouts vs ledger
    const poCheck = mk('payouts reconcile with the ledger');
    for await (const p of Payout.find().lean().cursor()) {
      poCheck.checked += 1;
      const id = String(p._id);
      const has = (suffix: string) =>
        WalletTransaction.findOne({ idempotencyKey: `payout:${id}:${suffix}` }).lean();
      if (!(await has('request'))) poCheck.add(`payout ${id} has no request ledger row`);
      if (p.status === 'PAID') {
        totals.paidOutMinor += p.amountMinor;
        if (!(await has('settled'))) poCheck.add(`payout ${id} is PAID without a settlement row`);
      }
      if (['FAILED', 'CANCELLED'].includes(p.status) && !(await has('reversal')))
        poCheck.add(`payout ${id} is ${p.status} but funds were not returned`);
    }
    const withdrawn = await WalletTransaction.aggregate<{ s: number }>([
      { $group: { _id: null, s: { $sum: '$withdrawnDelta' } } },
    ]);
    if ((withdrawn[0]?.s ?? 0) !== totals.paidOutMinor)
      poCheck.add(`total withdrawn ${withdrawn[0]?.s ?? 0} != paid payouts ${totals.paidOutMinor}`);
    checks.push(poCheck);

    // 9. earnings credited exactly once (computed in the paid-booking pass)
    checks.push(earnCheck);

    // 10. ledger chain: contiguous seq per wallet and unbroken balance chain per bucket
    const chainCheck = mk('ledger chain is continuous');
    {
      let wallet = '';
      let expectSeq = 1;
      let pending = 0;
      let available = 0;
      for await (const r of WalletTransaction.find()
        .sort({ walletId: 1, seq: 1 })
        .lean()
        .cursor()) {
        chainCheck.checked += 1;
        const w = String(r.walletId);
        if (w !== wallet) {
          wallet = w;
          expectSeq = 1;
          pending = 0;
          available = 0;
        }
        if (r.seq !== expectSeq) {
          chainCheck.add(`wallet ${w}: expected ledger seq ${expectSeq}, found ${r.seq}`);
          expectSeq = r.seq;
        }
        expectSeq += 1;
        if (r.bucket === 'PENDING') {
          if (r.balanceBefore !== pending)
            chainCheck.add(`ledger row ${String(r._id)}: pending chain broken`);
          pending = r.balanceAfter;
        } else if (r.bucket === 'AVAILABLE') {
          if (r.balanceBefore !== available)
            chainCheck.add(`ledger row ${String(r._id)}: available chain broken`);
          available = r.balanceAfter;
        }
      }
    }
    checks.push(chainCheck);

    // 11. no orphan ledger rows, no duplicate financial references
    const orphanCheck = mk('no orphan ledger rows or duplicate financial references');
    {
      const walletIds = new Set(
        (await Wallet.find().select('_id').lean()).map((w) => String(w._id)),
      );
      for await (const r of WalletTransaction.find().lean().cursor()) {
        orphanCheck.checked += 1;
        const id = String(r._id);
        if (!walletIds.has(String(r.walletId))) orphanCheck.add(`ledger row ${id} has no wallet`);
        if (r.referenceType === 'BOOKING' && !(await Booking.exists({ _id: r.referenceId })))
          orphanCheck.add(`ledger row ${id} references a missing booking`);
        if (r.referenceType === 'PAYOUT' && !(await Payout.exists({ _id: r.referenceId })))
          orphanCheck.add(`ledger row ${id} references a missing payout`);
        if (r.referenceType === 'MANUAL' && r.type === 'ADJUSTMENT') {
          const adj = await WalletAdjustment.findById(r.referenceId).lean();
          // direct (pre-maker-checker) adjustments have a random reference; approved ones must be APPLIED
          if (adj && adj.status !== 'APPLIED')
            orphanCheck.add(`ledger row ${id} applies an adjustment that is ${adj.status}`);
        }
      }
      const dupes = await WalletTransaction.aggregate<{ _id: unknown; n: number }>([
        {
          $match: {
            type: { $in: ['EARNING', 'RELEASE', 'PAYOUT', 'PAYOUT_SETTLED', 'PAYOUT_REVERSAL'] },
          },
        },
        {
          $group: {
            _id: { t: '$type', rt: '$referenceType', ri: '$referenceId', b: '$bucket' },
            n: { $sum: 1 },
          },
        },
        { $match: { n: { $gt: 1 } } },
        { $limit: MAX_PROBLEMS },
      ]);
      for (const d of dupes)
        orphanCheck.add(`duplicate financial reference: ${JSON.stringify(d._id)} x${d.n}`);
      for await (const pay of Payment.find({ status: 'PAID' }).lean().cursor()) {
        const n = await Payment.countDocuments({
          bookingId: pay.bookingId,
          status: { $in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
          settlement: 'APPLIED',
        });
        if (n > 1) orphanCheck.add(`booking ${String(pay.bookingId)} has ${n} applied payments`);
      }
    }
    checks.push(orphanCheck);

    // 12. payout amounts vs ledger rows
    const poAmtCheck = mk('payout amounts match their ledger rows');
    for await (const p of Payout.find().lean().cursor()) {
      poAmtCheck.checked += 1;
      const id = String(p._id);
      const row = async (suffix: string) =>
        WalletTransaction.findOne({ idempotencyKey: `payout:${id}:${suffix}` }).lean();
      const req = await row('request');
      if (req && req.amountMinor !== -p.amountMinor)
        poAmtCheck.add(`payout ${id}: request row ${req.amountMinor} != -${p.amountMinor}`);
      const settled = await row('settled');
      if (settled && settled.withdrawnDelta !== p.amountMinor)
        poAmtCheck.add(`payout ${id}: settled ${settled.withdrawnDelta} != ${p.amountMinor}`);
      const rev = await row('reversal');
      if (rev && rev.amountMinor !== p.amountMinor)
        poAmtCheck.add(`payout ${id}: reversal ${rev.amountMinor} != ${p.amountMinor}`);
      if (settled && rev) poAmtCheck.add(`payout ${id} was both settled and reversed`);
      if (p.status === 'PROVIDER_PAID')
        poAmtCheck.add(`payout ${id}: provider paid but local settlement is pending`);
    }
    checks.push(poAmtCheck);

    // 13. refund amounts vs obligation, booking snapshot and cancellation outcome
    for await (const r of Refund.find().lean().cursor()) {
      refAmtCheck.checked += 1;
      const id = String(r._id);
      if (r.status === 'PROVIDER_SUCCEEDED')
        refAmtCheck.add(`refund ${id}: provider refunded but local finalization is pending`);
      if (!r.bookingId) continue;
      const b = await Booking.findById(r.bookingId).lean();
      if (!b) {
        refAmtCheck.add(`refund ${id} has no booking`);
        continue;
      }
      if (b.refund && b.refund.amountMinor !== r.amountMinor)
        refAmtCheck.add(
          `refund ${id}: ${r.amountMinor} != booking obligation ${b.refund.amountMinor}`,
        );
      if (b.pricingSnapshot && r.amountMinor > b.pricingSnapshot.patientPayableMinor)
        refAmtCheck.add(`refund ${id}: exceeds what the patient paid`);
    }
    for (const problem of refAmtBookingProblems) refAmtCheck.add(problem);
    checks.push(refAmtCheck);

    return { ok: checks.every((c) => c.ok), generatedAt: new Date().toISOString(), totals, checks };
  },

  /**
   * EXPLICIT repair (never run implicitly): creates the refund obligation + earnings reversal for
   * bookings stuck in REFUND_PENDING without one. Idempotent; audit-logged.
   */
  async repairRefundObligations(ctx: AuditContext): Promise<{ repaired: number }> {
    const stuck = await Booking.find({
      status: 'REFUND_PENDING',
      paymentId: { $exists: true },
    }).lean();
    let repaired = 0;
    for (const b of stuck) {
      if (await Refund.exists({ bookingId: b._id })) continue;
      await withTransaction(async (session) => {
        const doc = await Booking.findById(b._id).session(session);
        if (!doc) return;
        await RefundService.onBookingRefundPending(doc, session);
        await AuditService.record(
          ctx,
          {
            action: 'reconciliation.refund_obligation_repaired',
            entity: 'Booking',
            entityId: String(b._id),
          },
          session,
        );
      });
      repaired += 1;
    }
    return { repaired };
  },
};
