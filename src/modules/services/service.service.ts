import { BadRequestError, ConflictError, NotFoundError } from '../../common/errors';
import { AuditService, type AuditContext } from '../audit';
import { FileService, mediaUrl, type UploadedFile } from '../files';
import { PricingService, type ServiceForPricing } from '../pricing';
import {
  NurseServiceOffer,
  Service,
  type NurseServiceOfferDoc,
  type ServiceDoc,
} from './service.models';

export interface ServiceInput {
  name: string;
  slug?: string;
  description?: string;
  category?: string;
  billingUnit: 'HOURLY' | 'DAILY';
  minDurationMinutes: number;
  maxDurationMinutes: number;
  expectedDurationMinutes?: number;
  commissionBps?: number;
  sortOrder?: number;
  isActive?: boolean;
}

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);

export function toServiceDTO(s: ServiceDoc, rates?: Record<string, number | null>) {
  return {
    id: String(s._id),
    name: s.name,
    slug: s.slug,
    description: s.description ?? null,
    category: s.category,
    isActive: s.isActive,
    billingUnit: s.billingUnit,
    minDurationMinutes: s.minDurationMinutes,
    maxDurationMinutes: s.maxDurationMinutes,
    expectedDurationMinutes: s.expectedDurationMinutes ?? null,
    sortOrder: s.sortOrder,
    imageUrl: mediaUrl(s.imageId),
    ...(rates ? { currency: 'AED' as const, baseRatesMinor: rates } : {}),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export const toPricingService = (s: ServiceDoc): ServiceForPricing => ({
  id: String(s._id),
  name: s.name,
  slug: s.slug,
  billingUnit: s.billingUnit,
  commissionBps: s.commissionBps ?? null,
});

function assertDurations(min: number, max: number, expected?: number | null) {
  if (min > max)
    throw new BadRequestError(
      'minDurationMinutes must not exceed maxDurationMinutes',
      'INVALID_DURATION_RANGE',
    );
  if (expected != null && (expected < min || expected > max))
    throw new BadRequestError(
      'expectedDurationMinutes must lie within min/max',
      'INVALID_DURATION_RANGE',
    );
}

export const ServiceCatalog = {
  async create(input: ServiceInput, ctx: AuditContext): Promise<ServiceDoc> {
    assertDurations(
      input.minDurationMinutes,
      input.maxDurationMinutes,
      input.expectedDurationMinutes,
    );
    try {
      const s = await Service.create({ ...input, slug: input.slug ?? slugify(input.name) });
      await AuditService.record(ctx, {
        action: 'service.created',
        entity: 'Service',
        entityId: String(s._id),
        newData: s,
      });
      return s;
    } catch (err) {
      if ((err as { code?: number }).code === 11000)
        throw new ConflictError(
          'A service with that name or slug already exists',
          'SERVICE_EXISTS',
        );
      throw err;
    }
  },

  async update(id: string, patch: Partial<ServiceInput>, ctx: AuditContext): Promise<ServiceDoc> {
    const before = await this.getById(id);
    assertDurations(
      patch.minDurationMinutes ?? before.minDurationMinutes,
      patch.maxDurationMinutes ?? before.maxDurationMinutes,
      patch.expectedDurationMinutes ?? before.expectedDurationMinutes,
    );
    try {
      const after = await Service.findByIdAndUpdate(
        id,
        { $set: patch },
        { new: true, runValidators: true },
      );
      await AuditService.record(ctx, {
        action: 'service.updated',
        entity: 'Service',
        entityId: id,
        oldData: before,
        newData: after,
      });
      return after as ServiceDoc;
    } catch (err) {
      if ((err as { code?: number }).code === 11000)
        throw new ConflictError(
          'A service with that name or slug already exists',
          'SERVICE_EXISTS',
        );
      throw err;
    }
  },

  /** Replaces the service picture (the previous one is deleted). */
  async setImage(
    id: string,
    uploaderId: string,
    file: UploadedFile | undefined,
    ctx: AuditContext,
  ): Promise<ServiceDoc> {
    const before = await this.getById(id);
    const img = await FileService.replacePublicImage(uploaderId, 'SERVICE_IMAGE', file, before.imageId);
    const after = await Service.findByIdAndUpdate(id, { $set: { imageId: img._id } }, { new: true });
    await AuditService.record(ctx, {
      action: 'service.image_updated',
      entity: 'Service',
      entityId: id,
      oldData: { imageId: before.imageId ?? null },
      newData: { imageId: img._id },
    });
    return after as ServiceDoc;
  },

  async setActive(id: string, isActive: boolean, ctx: AuditContext): Promise<ServiceDoc> {
    const before = await this.getById(id);
    const after = await Service.findByIdAndUpdate(id, { $set: { isActive } }, { new: true });
    await AuditService.record(ctx, {
      action: isActive ? 'service.activated' : 'service.deactivated',
      entity: 'Service',
      entityId: id,
      oldData: { isActive: before.isActive },
      newData: { isActive },
    });
    return after as ServiceDoc;
  },

  async getById(id: string): Promise<ServiceDoc> {
    const s = await Service.findById(id);
    if (!s) throw new NotFoundError('Service not found', 'SERVICE_NOT_FOUND');
    return s;
  },

  async getActiveBySlug(slug: string): Promise<ServiceDoc> {
    const s = await Service.findOne({ slug: slug.toLowerCase(), isActive: true });
    if (!s) throw new NotFoundError('Service not found', 'SERVICE_NOT_FOUND');
    return s;
  },

  /** Active services visible to clients, each with current base rates (never hardcoded in apps). */
  async listActive() {
    const services = await Service.find({ isActive: true }).sort({ sortOrder: 1, name: 1 });
    return Promise.all(services.map(async (s) => toServiceDTO(s, await this.baseRates(s))));
  },

  async baseRates(s: ServiceDoc): Promise<Record<string, number | null>> {
    const r = await PricingService.activeRates(String(s._id), new Date());
    return {
      hourly: r.HOURLY?.amountMinor ?? null,
      daily: r.DAILY?.amountMinor ?? null,
      weekendSurchargeBps: r.WEEKEND_SURCHARGE?.bps ?? null,
      holidaySurchargeBps: r.HOLIDAY_SURCHARGE?.bps ?? null,
    };
  },
};

export interface OfferInput {
  serviceId: string;
  isEnabled?: boolean;
  hourlyRateMinor?: number | null;
  dailyRateMinor?: number | null;
}

export const NurseOffers = {
  list(nurseId: string) {
    return NurseServiceOffer.find({ nurseId }).lean();
  },

  async get(nurseId: string, serviceId: string): Promise<NurseServiceOfferDoc | null> {
    return NurseServiceOffer.findOne({ nurseId, serviceId });
  },

  /** Upsert the nurse's offered services. Only existing, active services can be offered. */
  async replace(nurseId: string, items: OfferInput[]) {
    const ids = items.map((i) => i.serviceId);
    if (new Set(ids).size !== ids.length)
      throw new BadRequestError('Duplicate serviceId', 'DUPLICATE_SERVICE');
    const found = await Service.countDocuments({ _id: { $in: ids }, isActive: true });
    if (found !== ids.length)
      throw new BadRequestError('Unknown or inactive service in request', 'SERVICE_NOT_FOUND');
    for (const i of items) {
      const $set: Record<string, unknown> = { isEnabled: i.isEnabled ?? true };
      const $unset: Record<string, 1> = {};
      for (const f of ['hourlyRateMinor', 'dailyRateMinor'] as const) {
        if (i[f] === null) $unset[f] = 1;
        else if (i[f] !== undefined) $set[f] = i[f];
      }
      await NurseServiceOffer.updateOne(
        { nurseId, serviceId: i.serviceId },
        { $set, ...(Object.keys($unset).length ? { $unset } : {}) },
        { upsert: true, runValidators: true },
      );
    }
    // Services not in the request are disabled (replace semantics) but kept for history.
    await NurseServiceOffer.updateMany(
      { nurseId, serviceId: { $nin: ids } },
      { $set: { isEnabled: false } },
    );
    return this.list(nurseId);
  },
};
