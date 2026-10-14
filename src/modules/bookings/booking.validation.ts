import { AppError, NotFoundError, NurseNotAvailableError } from '../../common/errors';
import type { LatLng } from '../../common/types/geo';
import { haversineKm } from '../../common/utils/geo';
import { User } from '../users';
import { AvailabilityService } from '../availability';
import { NurseOffers, ServiceCatalog, type ServiceDoc } from '../services';
import { NurseProfile, type NurseProfileDoc } from '../nurses';
import type { Settings } from '../settings';
import { ReservationService } from './reservation.service';

const MIN = 60_000;

export interface BookingWindowInput {
  startMs: number;
  endMs: number;
}

/** Time validation shared by quote and create. Pure given settings + now. */
export function assertValidWindow(
  { startMs, endMs }: BookingWindowInput,
  service: Pick<ServiceDoc, 'minDurationMinutes' | 'maxDurationMinutes'>,
  settings: Settings,
  now: Date,
): void {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new AppError(422, 'INVALID_BOOKING_TIME', 'endDateTime must be after startDateTime');
  }
  const step = settings['booking.slotMinutes'] * MIN;
  if (startMs % step !== 0 || endMs % step !== 0) {
    throw new AppError(
      422,
      'INVALID_BOOKING_TIME',
      `Start and end must be aligned to ${settings['booking.slotMinutes']}-minute boundaries`,
    );
  }
  if (startMs < now.getTime() + settings['booking.minLeadMinutes'] * MIN) {
    throw new AppError(
      422,
      'INVALID_BOOKING_TIME',
      `Bookings must start at least ${settings['booking.minLeadMinutes']} minutes from now`,
    );
  }
  if (startMs > now.getTime() + settings['booking.maxAdvanceDays'] * 24 * 60 * MIN) {
    throw new AppError(
      422,
      'INVALID_BOOKING_TIME',
      `Bookings can be made at most ${settings['booking.maxAdvanceDays']} days ahead`,
    );
  }
  const minutes = (endMs - startMs) / MIN;
  const max = Math.min(service.maxDurationMinutes, settings['booking.maxDurationHours'] * 60);
  if (minutes < service.minDurationMinutes || minutes > max) {
    throw new AppError(
      422,
      'INVALID_DURATION',
      `Duration must be between ${service.minDurationMinutes} and ${max} minutes for this service`,
    );
  }
}

export interface Eligibility {
  service: ServiceDoc;
  nurse: NurseProfileDoc;
  offer: { hourlyRateMinor?: number | null; dailyRateMinor?: number | null };
}

/**
 * Everything that must hold for a (service, nurse, window, location) request, excluding the
 * authoritative conflict check (done under transaction in BookingService.create).
 */
export async function assertEligible(args: {
  serviceId: string;
  nurseId: string;
  window: BookingWindowInput;
  location?: LatLng;
  genderPreference?: string;
  settings: Settings;
  now: Date;
  checkReservations?: boolean;
}): Promise<Eligibility> {
  const service = await ServiceCatalog.getById(args.serviceId).catch((e) => {
    if (e instanceof NotFoundError)
      throw new NotFoundError('Service not found', 'SERVICE_NOT_FOUND');
    throw e;
  });
  if (!service.isActive)
    throw new AppError(422, 'SERVICE_INACTIVE', 'This service is not available');

  assertValidWindow(args.window, service, args.settings, args.now);

  const nurse = await NurseProfile.findById(args.nurseId);
  if (!nurse) throw new NotFoundError('Nurse not found', 'NURSE_NOT_FOUND');
  const userActive = await User.exists({ _id: nurse.userId, isActive: true });
  if (!nurse.isBookable || !userActive) {
    throw new AppError(422, 'NURSE_NOT_BOOKABLE', 'This nurse cannot currently receive bookings');
  }
  const offer = await NurseOffers.get(args.nurseId, args.serviceId);
  if (!offer || !offer.isEnabled) {
    throw new AppError(
      422,
      'SERVICE_NOT_OFFERED',
      'This nurse does not offer the requested service',
    );
  }
  if (args.genderPreference && nurse.gender !== args.genderPreference) {
    throw new AppError(
      422,
      'GENDER_PREFERENCE_MISMATCH',
      'Nurse does not match the gender preference',
    );
  }
  if (args.location && nurse.location?.coordinates?.length === 2) {
    const km = haversineKm(args.location, {
      longitude: nurse.location.coordinates[0]!,
      latitude: nurse.location.coordinates[1]!,
    });
    if (km > nurse.serviceRadiusKm) {
      throw new AppError(
        422,
        'OUT_OF_SERVICE_AREA',
        'The location is outside this nurse’s service area',
      );
    }
  }

  const work = await AvailabilityService.checkWorkingTime(
    args.nurseId,
    args.window.startMs,
    args.window.endMs,
  );
  if (!work.ok) {
    throw new NurseNotAvailableError('Nurse is not available at the requested time', [
      { field: 'startDateTime', message: work.reason },
    ]);
  }
  if (
    args.checkReservations &&
    (await ReservationService.hasConflict(
      args.nurseId,
      args.window.startMs,
      args.window.endMs,
      args.now,
    ))
  ) {
    throw new NurseNotAvailableError('Nurse already has a booking in that time range');
  }
  return {
    service,
    nurse,
    offer: { hourlyRateMinor: offer.hourlyRateMinor, dailyRateMinor: offer.dailyRateMinor },
  };
}
