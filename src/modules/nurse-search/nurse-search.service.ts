import { Types, type PipelineStage } from 'mongoose';
import { AppError, NotFoundError } from '../../common/errors';
import { mediaUrl } from '../../common/utils/media';
import type { LatLng } from '../../common/types/geo';
import { addLocalDays, localDate, localDayBounds } from '../../common/utils/time';
import { AvailabilityService, checkRange, effectiveWindows } from '../availability';
import { BLOCKING_STATUSES, Booking, ReservationService } from '../bookings';
import { getMatchingService, type MatchCandidate } from '../matching';
import { NurseProfile } from '../nurses';
import { PricingService } from '../pricing';
import { NurseServiceOffer, Service, ServiceCatalog, type ServiceDoc } from '../services';
import { SettingsService } from '../settings';
import { formatHHmm } from '../../common/utils/time';

/** Max candidates pulled from MongoDB when ranking/availability must run in application code. */
export const SEARCH_CANDIDATE_CAP = 300;

export const SEARCH_SORTS = ['relevance', 'rating', 'price', 'experience', 'distance'] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

export interface SearchParams {
  serviceId?: string;
  gender?: 'MALE' | 'FEMALE' | 'OTHER';
  startDateTime?: Date;
  endDateTime?: Date;
  location?: LatLng;
  maxDistanceKm?: number;
  /** only nurses whose own service radius covers the location (default true when location given) */
  withinNurseRadius: boolean;
  minExperience?: number;
  minRating?: number;
  minPrice?: number;
  maxPrice?: number;
  languages?: string[];
  specializations?: string[];
  sort: SearchSort;
  page: number;
  limit: number;
}

interface Row {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  user: { firstName: string; lastName: string; profileImage?: Types.ObjectId };
  bio?: string;
  yearsOfExperience: number;
  specializations: string[];
  languages: string[];
  gender?: string;
  serviceRadiusKm: number;
  dailyRateMinor?: number;
  city?: string;
  averageRating: number;
  totalReviews: number;
  totalCompletedBookings: number;
  distanceM?: number;
  unitPriceMinor?: number | null;
}

const displayName = (u: { firstName: string; lastName: string }) =>
  `${u.firstName} ${u.lastName.charAt(0)}.`;

export const NurseSearchService = {
  async search(p: SearchParams) {
    const settings = await SettingsService.getAll();
    const tz = settings['platform.timezone'];
    const now = new Date();

    if (p.sort === 'price' && !p.serviceId)
      throw new AppError(400, 'SORT_REQUIRES_SERVICE', 'Sorting by price requires serviceId');
    if (p.sort === 'distance' && !p.location)
      throw new AppError(400, 'SORT_REQUIRES_LOCATION', 'Sorting by distance requires lat/lng');
    if ((p.minPrice != null || p.maxPrice != null) && !p.serviceId)
      throw new AppError(400, 'FILTER_REQUIRES_SERVICE', 'Price filters require serviceId');
    if (p.minPrice != null && p.maxPrice != null && p.minPrice > p.maxPrice)
      throw new AppError(400, 'INVALID_PRICE_RANGE', 'minPrice must not exceed maxPrice');

    const wantAvail = !!(p.startDateTime && p.endDateTime);
    let startMs = 0;
    let endMs = 0;
    if (wantAvail) {
      startMs = p.startDateTime!.getTime();
      endMs = p.endDateTime!.getTime();
      if (endMs <= startMs || endMs - startMs > settings['booking.maxDurationHours'] * 3_600_000)
        throw new AppError(400, 'INVALID_TIME_RANGE', 'Invalid start/end for availability filter');
    }

    let service: ServiceDoc | null = null;
    let baseRate: number | null = null;
    if (p.serviceId) {
      service = await ServiceCatalog.getById(p.serviceId);
      if (!service.isActive)
        throw new AppError(422, 'SERVICE_INACTIVE', 'This service is not available');
      const rates = await PricingService.activeRates(p.serviceId, now);
      baseRate = rates[service.billingUnit]?.amountMinor ?? null;
    }
    const rateField = service?.billingUnit === 'DAILY' ? 'dailyRateMinor' : 'hourlyRateMinor';

    // ---- stage 1: indexed filters (never nurses that are not ACTIVE + VERIFIED) ----
    const match: Record<string, unknown> = { isBookable: true };
    if (p.gender) match.gender = p.gender;
    if (p.minExperience != null) match.yearsOfExperience = { $gte: p.minExperience };
    if (p.minRating != null) match.averageRating = { $gte: p.minRating };
    if (p.languages?.length) match.languages = { $in: p.languages };
    if (p.specializations?.length) match.specializations = { $in: p.specializations };

    const pipeline: PipelineStage[] = [];
    if (p.location) {
      pipeline.push({
        $geoNear: {
          near: { type: 'Point', coordinates: [p.location.longitude, p.location.latitude] },
          distanceField: 'distanceM',
          spherical: true,
          query: match,
          ...(p.maxDistanceKm != null && { maxDistance: p.maxDistanceKm * 1000 }),
        },
      });
      if (p.withinNurseRadius) {
        pipeline.push({
          $match: { $expr: { $lte: ['$distanceM', { $multiply: ['$serviceRadiusKm', 1000] }] } },
        });
      }
    } else {
      pipeline.push({ $match: match });
    }

    // ---- service offered + effective unit price ----
    if (service) {
      pipeline.push(
        {
          $lookup: {
            from: 'nurseServices',
            let: { nid: '$_id' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$nurseId', '$$nid'] },
                      { $eq: ['$serviceId', new Types.ObjectId(p.serviceId)] },
                      { $eq: ['$isEnabled', true] },
                    ],
                  },
                },
              },
            ],
            as: 'offer',
          },
        },
        { $match: { offer: { $ne: [] } } },
        {
          $addFields: {
            unitPriceMinor: { $ifNull: [{ $first: `$offer.${rateField}` }, baseRate] },
          },
        },
        { $match: { unitPriceMinor: { $ne: null } } },
      );
      if (p.minPrice != null || p.maxPrice != null) {
        pipeline.push({
          $match: {
            unitPriceMinor: {
              ...(p.minPrice != null && { $gte: p.minPrice }),
              ...(p.maxPrice != null && { $lte: p.maxPrice }),
            },
          },
        });
      }
    }

    pipeline.push(
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          pipeline: [{ $project: { firstName: 1, lastName: 1, isActive: 1, profileImage: 1 } }],
          as: 'user',
        },
      },
      { $unwind: '$user' },
      { $match: { 'user.isActive': true } },
    );

    const inMemory = wantAvail || p.sort === 'relevance';
    const projection = {
      $project: {
        user: 1,
        userId: 1,
        bio: 1,
        yearsOfExperience: 1,
        specializations: 1,
        languages: 1,
        gender: 1,
        serviceRadiusKm: 1,
        dailyRateMinor: 1,
        city: 1,
        averageRating: 1,
        totalReviews: 1,
        totalCompletedBookings: 1,
        distanceM: 1,
        unitPriceMinor: 1,
      },
    };
    const dbSort: Record<SearchSort, Record<string, 1 | -1>> = {
      relevance: p.location
        ? { distanceM: 1, _id: 1 }
        : { averageRating: -1, totalReviews: -1, _id: 1 },
      rating: { averageRating: -1, totalReviews: -1, _id: 1 },
      price: { unitPriceMinor: 1, _id: 1 },
      experience: { yearsOfExperience: -1, _id: 1 },
      distance: { distanceM: 1, _id: 1 },
    };

    let rows: Row[];
    let total: number;
    let truncated = false;
    let scores = new Map<string, number>();
    let availMap: Map<string, boolean> | null = null;

    if (!inMemory) {
      const [res] = await NurseProfile.aggregate<{ items: Row[]; total: { n: number }[] }>([
        ...pipeline,
        {
          $facet: {
            items: [
              { $sort: dbSort[p.sort] },
              { $skip: (p.page - 1) * p.limit },
              { $limit: p.limit },
              projection,
            ],
            total: [{ $count: 'n' }],
          },
        },
      ]);
      rows = res?.items ?? [];
      total = res?.total[0]?.n ?? 0;
    } else {
      // Availability and relevance need application logic, so pull a bounded, pre-filtered set.
      let candidates = await NurseProfile.aggregate<Row>([
        ...pipeline,
        { $sort: dbSort[p.sort === 'relevance' ? 'relevance' : p.sort] },
        { $limit: SEARCH_CANDIDATE_CAP },
        projection,
      ]);
      truncated = candidates.length === SEARCH_CANDIDATE_CAP;
      if (wantAvail && candidates.length) {
        const ids = candidates.map((c) => String(c._id));
        const [rules, busy] = await Promise.all([
          AvailabilityService.rulesFor(ids, localDate(startMs, tz), localDate(endMs - 1, tz)),
          ReservationService.busyNurseIds(ids, startMs, endMs, now),
        ]);
        availMap = new Map(
          ids.map((id) => [id, !busy.has(id) && checkRange(rules.get(id)!, startMs, endMs, tz).ok]),
        );
        candidates = candidates.filter((c) => availMap!.get(String(c._id)));
      }
      if (p.sort === 'relevance') {
        const ranked = await getMatchingService().rank(
          {
            serviceRequested: !!service,
            genderPreference: p.gender,
            hasLocation: !!p.location,
            maxDistanceKm: p.maxDistanceKm,
            specializations: p.specializations,
            maxPriceMinor: p.maxPrice,
            availabilityRequested: wantAvail,
          },
          candidates.map((c): MatchCandidate => ({
            nurseId: String(c._id),
            gender: c.gender,
            yearsOfExperience: c.yearsOfExperience,
            averageRating: c.averageRating,
            totalReviews: c.totalReviews,
            specializations: c.specializations,
            distanceKm: c.distanceM != null ? c.distanceM / 1000 : null,
            serviceRadiusKm: c.serviceRadiusKm,
            offersService: true,
            unitPriceMinor: c.unitPriceMinor,
            available: wantAvail ? true : undefined,
          })),
        );
        scores = new Map(ranked.map((r) => [r.nurseId, r.score]));
        const order = new Map(ranked.map((r, i) => [r.nurseId, i]));
        candidates.sort((a, b) => order.get(String(a._id))! - order.get(String(b._id))!);
      }
      total = candidates.length;
      rows = candidates.slice((p.page - 1) * p.limit, p.page * p.limit);
    }

    const offered = new Map<string, string[]>();
    if (rows.length) {
      const offers = await NurseServiceOffer.find({
        nurseId: { $in: rows.map((r) => r._id) },
        isEnabled: true,
      })
        .select('nurseId serviceId')
        .lean();
      for (const o of offers) {
        const k = String(o.nurseId);
        offered.set(k, [...(offered.get(k) ?? []), String(o.serviceId)]);
      }
    }

    const items = rows.map((r) => ({
      id: String(r._id),
      serviceIds: offered.get(String(r._id)) ?? [],
      dailyRateMinor: r.dailyRateMinor ?? null,
      displayName: displayName(r.user),
      imageUrl: mediaUrl(r.user.profileImage),
      bio: r.bio ?? null,
      yearsOfExperience: r.yearsOfExperience,
      specializations: r.specializations,
      languages: r.languages,
      gender: r.gender ?? null,
      averageRating: r.averageRating,
      totalReviews: r.totalReviews,
      totalCompletedBookings: r.totalCompletedBookings,
      city: r.city ?? null,
      serviceRadiusKm: r.serviceRadiusKm,
      distanceKm: r.distanceM != null ? Math.round(r.distanceM / 100) / 10 : null,
      price:
        service && r.unitPriceMinor != null
          ? {
              unit: service.billingUnit,
              unitAmountMinor: r.unitPriceMinor,
              currency: 'AED' as const,
            }
          : null,
      matchScore: scores.get(String(r._id)) ?? null,
      available: wantAvail ? true : null,
    }));
    return {
      items,
      meta: { page: p.page, limit: p.limit, total, totalPages: Math.ceil(total / p.limit) },
      truncated,
    };
  },

  async profile(id: string, viewerRole: string) {
    const nurse = await NurseProfile.findById(id).populate<{
      userId: { firstName: string; lastName: string; isActive: boolean; profileImage?: Types.ObjectId };
    }>('userId', 'firstName lastName isActive profileImage');
    if (!nurse || (viewerRole !== 'ADMIN' && (!nurse.isBookable || !nurse.userId.isActive))) {
      throw new NotFoundError('Nurse not found', 'NURSE_NOT_FOUND');
    }
    const offers = await NurseServiceOffer.find({ nurseId: id, isEnabled: true }).lean();
    const services = await Service.find({
      _id: { $in: offers.map((o) => o.serviceId) },
      isActive: true,
    }).lean();
    const now = new Date();
    const out = [];
    for (const s of services) {
      const o = offers.find((x) => String(x.serviceId) === String(s._id))!;
      const rates = await PricingService.activeRates(String(s._id), now);
      const unit = s.billingUnit;
      const override = unit === 'DAILY' ? o.dailyRateMinor : o.hourlyRateMinor;
      out.push({
        serviceId: String(s._id),
        name: s.name,
        slug: s.slug,
        billingUnit: unit,
        unitAmountMinor: override ?? rates[unit]?.amountMinor ?? null,
        currency: 'AED' as const,
      });
    }
    return {
      id: String(nurse._id),
      serviceIds: out.map((s) => s.serviceId),
      dailyRateMinor: nurse.dailyRateMinor ?? null,
      displayName: displayName(nurse.userId),
      imageUrl: mediaUrl(nurse.userId.profileImage),
      bio: nurse.bio ?? null,
      yearsOfExperience: nurse.yearsOfExperience,
      specializations: nurse.specializations,
      languages: nurse.languages,
      gender: nurse.gender ?? null,
      averageRating: nurse.averageRating,
      totalReviews: nurse.totalReviews,
      totalCompletedBookings: nurse.totalCompletedBookings,
      city: nurse.city ?? null,
      serviceRadiusKm: nurse.serviceRadiusKm,
      isBookable: nurse.isBookable,
      services: out,
    };
  },

  /** Working windows per local date (platform timezone) minus live bookings. At most 31 days. */
  async availability(id: string, from: string, to: string, viewerRole: string) {
    const nurse = await NurseProfile.findById(id);
    if (!nurse || (viewerRole !== 'ADMIN' && !nurse.isBookable))
      throw new NotFoundError('Nurse not found', 'NURSE_NOT_FOUND');
    const tz = await SettingsService.get('platform.timezone');
    if (to < from || addLocalDays(from, 30, tz) < to)
      throw new AppError(400, 'INVALID_DATE_RANGE', 'Range must be 1..31 days');
    const rules = (await AvailabilityService.rulesFor([id], from, to)).get(id)!;
    const [rangeStart] = localDayBounds(from, tz);
    const [, rangeEnd] = localDayBounds(to, tz);
    const now = new Date();
    const busy = await Booking.find({
      nurseId: id,
      status: { $in: BLOCKING_STATUSES },
      startDateTime: { $lt: new Date(rangeEnd) },
      endDateTime: { $gt: new Date(rangeStart) },
      $nor: [{ status: 'PAYMENT_PENDING', holdExpiresAt: { $lte: now } }],
    })
      .select('startDateTime endDateTime')
      .sort({ startDateTime: 1 })
      .lean();
    const days = [];
    for (let d = from; d <= to; d = addLocalDays(d, 1, tz)) {
      const { windows, failure } = effectiveWindows(rules, d, tz);
      days.push({
        date: d,
        available: windows.length > 0,
        blocked: failure ?? null,
        windows: windows.map(([s, e]) => ({ start: formatHHmm(s), end: formatHHmm(e) })),
      });
    }
    return {
      timezone: tz,
      days,
      busy: busy.map((b) => ({ start: b.startDateTime, end: b.endDateTime })),
    };
  },
};
