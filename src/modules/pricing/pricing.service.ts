import { createHash } from 'node:crypto';
import { AppError, ConflictError } from '../../common/errors';
import { signQuoteToken } from '../../common/utils/jwt';
import { addLocalDays, localDate } from '../../common/utils/time';
import { withTransaction } from '../../config/database';
import { SettingsService } from '../settings';
import { calculatePrice, type BillingUnit, type CalcResult } from './pricing.calc';
import {
  Commission,
  Holiday,
  ServicePrice,
  type PriceKind,
  type ServicePriceDoc,
} from './pricing.models';

export interface ServiceForPricing {
  id: string;
  name: string;
  slug: string;
  billingUnit: BillingUnit;
  commissionBps?: number | null;
}

export interface NurseRateOverride {
  hourlyRateMinor?: number | null;
  dailyRateMinor?: number | null;
}

export interface CommissionTerms {
  type: 'PERCENTAGE' | 'FIXED';
  bps: number;
  fixedMinor?: number;
  source: 'NURSE' | 'SERVICE' | 'GLOBAL' | 'SERVICE_DEFAULT' | 'PLATFORM_DEFAULT';
  ruleId?: string;
  version?: number;
}

export interface Quote {
  commission: CommissionTerms;
  serviceId: string;
  nurseId: string;
  startDateTime: string;
  endDateTime: string;
  pricing: CalcResult;
  rateSource: 'SERVICE' | 'NURSE_OVERRIDE';
  pricingVersion: string;
  priceRuleIds: string[];
  commissionBps: number;
  quoteToken: string;
  expiresAt: string;
  coupon?: { code: string; discountMinor: number } | null;
}

export interface ActiveRates {
  HOURLY?: ServicePriceDoc;
  DAILY?: ServicePriceDoc;
  WEEKEND_SURCHARGE?: ServicePriceDoc;
  HOLIDAY_SURCHARGE?: ServicePriceDoc;
  fees: ServicePriceDoc[];
}

const active = (at: Date) => ({
  effectiveFrom: { $lte: at },
  $or: [{ effectiveTo: { $exists: false } }, { effectiveTo: { $gt: at } }],
});

export const CommissionService = {
  /** Effective commission terms for (service, nurse) at `at`. */
  async resolve(
    serviceId: string,
    nurseId: string,
    serviceDefaultBps: number | null | undefined,
    defaultBps: number,
    at: Date,
  ): Promise<CommissionTerms> {
    const rows = await Commission.find({
      scopeKey: { $in: [`NURSE:${nurseId}`, `SERVICE:${serviceId}`, 'GLOBAL'] },
      effectiveFrom: { $lte: at },
      $or: [{ effectiveTo: { $exists: false } }, { effectiveTo: { $gt: at } }],
    }).lean();
    for (const scope of ['NURSE', 'SERVICE', 'GLOBAL'] as const) {
      const r = rows.find((x) => x.scope === scope);
      if (r) {
        return {
          type: r.type,
          bps: r.type === 'PERCENTAGE' ? (r.bps ?? 0) : 0,
          fixedMinor: r.type === 'FIXED' ? (r.fixedMinor ?? 0) : undefined,
          source: scope,
          ruleId: String(r._id),
          version: r.version,
        };
      }
    }
    if (serviceDefaultBps != null)
      return { type: 'PERCENTAGE', bps: serviceDefaultBps, source: 'SERVICE_DEFAULT' };
    return { type: 'PERCENTAGE', bps: defaultBps, source: 'PLATFORM_DEFAULT' };
  },

  /** Publishes a new version of a rule and closes the previous one (no in-place edits). */
  async publish(
    input: {
      scope: 'GLOBAL' | 'SERVICE' | 'NURSE';
      serviceId?: string;
      nurseId?: string;
      type: 'PERCENTAGE' | 'FIXED';
      bps?: number;
      fixedMinor?: number;
      effectiveFrom?: Date;
    },
    createdBy?: string,
  ) {
    const scopeKey =
      input.scope === 'GLOBAL'
        ? 'GLOBAL'
        : input.scope === 'SERVICE'
          ? `SERVICE:${input.serviceId}`
          : `NURSE:${input.nurseId}`;
    const effectiveFrom = input.effectiveFrom ?? new Date();
    return withTransaction(async (session) => {
      const current = await Commission.findOne({ scopeKey, isCurrent: true }).session(session);
      if (current && current.effectiveFrom >= effectiveFrom)
        throw new ConflictError(
          'A rule with a later or equal effectiveFrom exists',
          'COMMISSION_DATE_CONFLICT',
        );
      if (current)
        await Commission.updateOne(
          { _id: current._id },
          { $set: { effectiveTo: effectiveFrom, isCurrent: false } },
          { session },
        );
      const [after] = await Commission.create(
        [
          {
            scope: input.scope,
            scopeKey,
            serviceId: input.serviceId,
            nurseId: input.nurseId,
            type: input.type,
            bps: input.type === 'PERCENTAGE' ? input.bps : undefined,
            fixedMinor: input.type === 'FIXED' ? input.fixedMinor : undefined,
            effectiveFrom,
            version: (current?.version ?? 0) + 1,
            createdBy,
          },
        ],
        { session },
      );
      return { before: current, after: after! };
    });
  },

  list() {
    return Commission.find().sort({ scopeKey: 1, effectiveFrom: -1 });
  },
};

export const PricingService = {
  async activeRates(serviceId: string, at: Date): Promise<ActiveRates> {
    const rows = await ServicePrice.find({ serviceId, ...active(at) }).sort({ effectiveFrom: -1 });
    const out: ActiveRates = { fees: [] };
    for (const r of rows) {
      if (r.kind === 'FEE') out.fees.push(r);
      else if (!out[r.kind as Exclude<PriceKind, 'FEE'>])
        out[r.kind as Exclude<PriceKind, 'FEE'>] = r;
    }
    return out;
  },

  /** Publish a new rate version (closes the current one). Never edits history. */
  async publishPrice(
    serviceId: string,
    input: {
      kind: PriceKind;
      code?: string;
      label?: string;
      amountMinor?: number;
      bps?: number;
      effectiveFrom?: Date;
    },
    createdBy?: string,
  ): Promise<{ before: ServicePriceDoc | null; after: ServicePriceDoc }> {
    const code = input.code ?? (input.kind === 'FEE' ? 'FEE' : 'BASE');
    const effectiveFrom = input.effectiveFrom ?? new Date();
    return withTransaction(async (session) => {
      const current = await ServicePrice.findOne({
        serviceId,
        kind: input.kind,
        code,
        isCurrent: true,
      }).session(session);
      if (current && current.effectiveFrom >= effectiveFrom) {
        throw new ConflictError(
          'A rate with a later or equal effectiveFrom already exists',
          'PRICE_EFFECTIVE_DATE_CONFLICT',
        );
      }
      if (current) {
        await ServicePrice.updateOne(
          { _id: current._id },
          { $set: { effectiveTo: effectiveFrom, isCurrent: false } },
          { session },
        );
      }
      const [after] = await ServicePrice.create(
        [
          {
            serviceId,
            kind: input.kind,
            code,
            label: input.label,
            amountMinor: input.amountMinor,
            bps: input.bps,
            effectiveFrom,
            version: (current?.version ?? 0) + 1,
            createdBy,
          },
        ],
        { session },
      );
      return { before: current, after: after! };
    });
  },

  listPrices(serviceId: string) {
    return ServicePrice.find({ serviceId }).sort({ kind: 1, code: 1, effectiveFrom: -1 });
  },

  async holidaysBetween(fromDate: string, toDate: string): Promise<Set<string>> {
    const rows = await Holiday.find({ date: { $gte: fromDate, $lte: toDate } }).lean();
    return new Set(rows.map((r) => r.date));
  },

  /**
   * Server-side quote. The caller must already have validated the time window and nurse/service
   * eligibility. Returns a signed, expiring quoteToken bound to patient+service+nurse+window+total.
   */
  async quote(args: {
    service: ServiceForPricing;
    nurseId: string;
    offer?: NurseRateOverride | null;
    patientId: string;
    startMs: number;
    endMs: number;
    now?: Date;
    /** Server-calculated coupon discount (platform funded; nurse earnings stay GROSS based). */
    coupon?: { code: string; discountMinor: number; fingerprint: string };
  }): Promise<Quote> {
    const now = args.now ?? new Date();
    const settings = await SettingsService.getAll();
    const tz = settings['platform.timezone'];
    const { service, offer } = args;
    const rates = await this.activeRates(service.id, now);

    const base = rates[service.billingUnit];
    const override =
      service.billingUnit === 'HOURLY' ? offer?.hourlyRateMinor : offer?.dailyRateMinor;
    if (override == null && base?.amountMinor == null) {
      throw new AppError(
        422,
        'PRICING_NOT_CONFIGURED',
        'No active price is configured for this service',
      );
    }
    const rateMinor = (override ?? base!.amountMinor) as number;

    const fromDate = localDate(args.startMs, tz);
    const toDate = localDate(args.endMs - 1, tz);
    const holidayDates = await this.holidaysBetween(fromDate, addLocalDays(toDate, 1, tz));
    const commission = await CommissionService.resolve(
      service.id,
      args.nurseId,
      service.commissionBps,
      settings['commission.defaultBps'],
      now,
    );
    const commissionBps = commission.bps;

    const pricing = calculatePrice({
      unit: service.billingUnit,
      rateMinor,
      weekendBps: rates.WEEKEND_SURCHARGE?.bps ?? 0,
      holidayBps: rates.HOLIDAY_SURCHARGE?.bps ?? 0,
      fees: rates.fees.map((f) => ({
        code: f.code,
        label: f.label ?? f.code,
        amountMinor: f.amountMinor ?? 0,
      })),
      weekendDays: settings['pricing.weekendDays'],
      holidayDates,
      startMs: args.startMs,
      endMs: args.endMs,
      tz,
      commissionBps,
      commissionFixedMinor: commission.fixedMinor,
      discountMinor: args.coupon?.discountMinor,
    });

    const used = [base, rates.WEEKEND_SURCHARGE, rates.HOLIDAY_SURCHARGE, ...rates.fees].filter(
      (r): r is ServicePriceDoc => !!r,
    );
    const priceRuleIds = used.map((r) => String(r._id));
    // Version = fingerprint of every input that influenced the number. Any change => quote mismatch.
    const pricingVersion = createHash('sha256')
      .update(
        JSON.stringify({
          rules: used.map((r) => [String(r._id), r.version]),
          override: override ?? null,
          commissionBps,
          commissionFixed: commission.fixedMinor ?? null,
          commissionRule: commission.ruleId ?? null,
          weekend: settings['pricing.weekendDays'],
          holidays: [...holidayDates].sort(),
          tz,
          coupon: args.coupon?.fingerprint ?? null,
        }),
      )
      .digest('hex')
      .slice(0, 16);

    const ttl = settings['booking.quoteTtlSeconds'];
    const quoteToken = signQuoteToken(
      {
        pid: args.patientId,
        svc: service.id,
        nrs: args.nurseId,
        st: args.startMs,
        en: args.endMs,
        tot: pricing.patientPayableMinor,
        ver: pricingVersion,
        ...(args.coupon && { cpn: args.coupon.code }),
      },
      ttl,
    );
    return {
      serviceId: service.id,
      nurseId: args.nurseId,
      startDateTime: new Date(args.startMs).toISOString(),
      endDateTime: new Date(args.endMs).toISOString(),
      pricing,
      rateSource: override != null ? 'NURSE_OVERRIDE' : 'SERVICE',
      pricingVersion,
      priceRuleIds,
      commissionBps,
      commission,
      quoteToken,
      expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
      coupon: args.coupon ? { code: args.coupon.code, discountMinor: pricing.discountMinor } : null,
    };
  },
};
