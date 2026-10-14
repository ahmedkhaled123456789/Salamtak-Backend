import type { ClientSession } from 'mongoose';
import { setAlertCreatedHook, type RaiseAlert } from '../alerts';
import { registerTransitionListener, type BookingDoc } from '../bookings';
import { NurseProfile } from '../nurses';
import { User } from '../users';
import { NotificationService, type NotifyInput } from './notification.service';

/**
 * Domain event -> notification mapping. Pure functions plus two registration seams; no controller
 * ever sends anything. Texts are deliberately generic: booking number and state only (no address,
 * notes, diagnosis or other health information).
 */
type Draft = Omit<NotifyInput, 'recipientId' | 'referenceKey'> & { who: 'PATIENT' | 'NURSE' };
type Channels = NonNullable<NotifyInput['channels']>;

const IMPORTANT: Channels = ['EMAIL', 'PUSH'];
const PUSH: Channels = ['PUSH'];

export function bookingDrafts(b: BookingDoc, to: string): Draft[] {
  const no = b.bookingNumber;
  const data = { bookingId: String(b._id), bookingNumber: no, status: to };
  const d = (
    who: Draft['who'],
    type: string,
    title: string,
    body: string,
    channels: Channels,
  ): Draft => ({ who, type, title, body, data, channels: [...channels] });
  switch (to) {
    case 'PAYMENT_PENDING':
      return [
        d(
          'PATIENT',
          'BOOKING_CREATED',
          'Booking created',
          `Booking ${no} was created. Complete the payment to confirm it.`,
          PUSH,
        ),
      ];
    case 'PAID':
      return [
        d(
          'PATIENT',
          'PAYMENT_SUCCESSFUL',
          'Payment received',
          `Your payment for booking ${no} was received.`,
          IMPORTANT,
        ),
      ];
    case 'NURSE_PENDING':
      return [
        d(
          'NURSE',
          'NEW_BOOKING_REQUEST',
          'New booking request',
          `Booking ${no} is waiting for your response.`,
          IMPORTANT,
        ),
      ];
    case 'CONFIRMED':
      return [
        d(
          'PATIENT',
          'NURSE_ACCEPTED',
          'Booking confirmed',
          `Your nurse accepted booking ${no}.`,
          IMPORTANT,
        ),
        d('NURSE', 'BOOKING_ACCEPTED', 'Booking accepted', `You accepted booking ${no}.`, PUSH),
      ];
    case 'NURSE_REJECTED':
      return [
        d(
          'PATIENT',
          'NURSE_REJECTED',
          'Booking declined',
          `The nurse could not accept booking ${no}. You will be refunded in full.`,
          IMPORTANT,
        ),
      ];
    case 'EXPIRED':
      return [
        d(
          'PATIENT',
          'BOOKING_EXPIRED',
          'Booking expired',
          `Booking ${no} expired.`,
          b.paidAt ? IMPORTANT : PUSH,
        ),
      ];
    case 'CANCELLED':
      return [
        d(
          'PATIENT',
          'BOOKING_CANCELLED',
          'Booking cancelled',
          `Booking ${no} was cancelled.`,
          IMPORTANT,
        ),
        ...(b.paidAt
          ? [
              d(
                'NURSE',
                'BOOKING_CANCELLED_NURSE',
                'Booking cancelled',
                `Booking ${no} was cancelled.`,
                PUSH,
              ),
            ]
          : []),
      ];
    case 'REFUND_PENDING':
      return [
        d(
          'PATIENT',
          'REFUND_INITIATED',
          'Refund initiated',
          `A refund for booking ${no} was initiated.`,
          IMPORTANT,
        ),
      ];
    case 'REFUNDED':
      return [
        d(
          'PATIENT',
          'REFUND_COMPLETED',
          'Refund completed',
          `The refund for booking ${no} was completed.`,
          IMPORTANT,
        ),
      ];
    case 'CARE_STARTED':
      return [
        d(
          'PATIENT',
          'BOOKING_STARTED',
          'Care started',
          `Care for booking ${no} has started.`,
          PUSH,
        ),
      ];
    case 'COMPLETED':
      return [
        d('PATIENT', 'BOOKING_COMPLETED', 'Care completed', `Booking ${no} was completed.`, PUSH),
      ];
    case 'DISPUTED':
      return [
        d(
          'PATIENT',
          'BOOKING_DISPUTED',
          'Booking under review',
          `Booking ${no} is under review by our team.`,
          IMPORTANT,
        ),
        d(
          'NURSE',
          'BOOKING_DISPUTED_NURSE',
          'Booking under review',
          `Booking ${no} is under review by our team.`,
          IMPORTANT,
        ),
      ];
    default:
      return [];
  }
}

/** Writes the booking notifications inside the booking's own transaction (outbox). */
export async function notifyBookingTransition(
  b: BookingDoc,
  change: { from: string; to: string },
  session: ClientSession,
): Promise<void> {
  for (const draft of bookingDrafts(b, change.to)) {
    const { who, ...rest } = draft;
    await NotificationService.notify(
      {
        ...rest,
        recipientId: String(who === 'PATIENT' ? b.patientId : b.nurseUserId),
        referenceKey: `${String(b._id)}:${change.to}`,
      },
      session,
    );
  }
}

/** Notify a nurse by NURSE PROFILE id (wallet/payout code knows the profile, not the user). */
export async function notifyNurse(
  nurseProfileId: string,
  n: Omit<NotifyInput, 'recipientId'>,
  session?: ClientSession,
): Promise<void> {
  const profile = await NurseProfile.findById(nurseProfileId)
    .select('userId')
    .session(session ?? null);
  if (!profile) return;
  await NotificationService.notify({ ...n, recipientId: String(profile.userId) }, session);
}

/** First occurrence of a CRITICAL alert -> every active finance/admin user, once. */
async function notifyAlert(a: RaiseAlert, session?: ClientSession): Promise<void> {
  if (a.severity !== 'CRITICAL') return;
  const staff = await User.find({
    role: { $in: ['ADMIN', 'FINANCE_APPROVER'] },
    isActive: true,
  })
    .select('_id')
    .session(session ?? null)
    .lean();
  for (const u of staff) {
    await NotificationService.notify(
      {
        recipientId: String(u._id),
        type: 'CRITICAL_ALERT',
        title: 'Critical alert',
        body: a.message.slice(0, 300),
        data: { alertType: a.type, entity: a.entity, ...(a.entityId && { entityId: a.entityId }) },
        // a re-opened alert is a new occurrence: bucket per hour so it is announced again
        referenceKey: a.reopen ? `${a.key}:${new Date().toISOString().slice(0, 13)}` : a.key,
        channels: ['EMAIL', 'PUSH'],
      },
      session,
    );
  }
}

/** Called once from createApp(). */
export function registerNotificationHooks(): void {
  registerTransitionListener('notifications', notifyBookingTransition);
  setAlertCreatedHook(notifyAlert);
}
