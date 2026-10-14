import { z } from 'zod';
import { isValidTimezone } from '../../common/utils/time';

const refundTier = z.strictObject({
  minHoursBeforeStart: z
    .number()
    .int()
    .min(0)
    .max(24 * 365),
  refundPercent: z.number().int().min(0).max(100),
  nurseCompensationPercent: z.number().int().min(0).max(100),
});

/** Typed registry of PlatformSettings: key -> [schema, default]. Unknown keys are rejected. */
export const SETTINGS = {
  'platform.timezone': [
    z.string().refine(isValidTimezone, 'must be a valid IANA timezone'),
    'Asia/Dubai',
  ],
  'platform.currency': [z.literal('AED'), 'AED'],
  'booking.holdMinutes': [z.number().int().min(1).max(240), 15],
  'booking.nurseResponseMinutes': [
    z
      .number()
      .int()
      .min(5)
      .max(24 * 60),
    120,
  ],
  /** Reservation grid. Only changeable while no reservations exist (mixed grids would break overlap detection). */
  'booking.slotMinutes': [z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(30)]), 15],
  'booking.minLeadMinutes': [
    z
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 60),
    60,
  ],
  'booking.maxAdvanceDays': [z.number().int().min(1).max(365), 90],
  'booking.maxDurationHours': [
    z
      .number()
      .int()
      .min(1)
      .max(24 * 14),
    72,
  ],
  'booking.startEarlyMinutes': [z.number().int().min(0).max(240), 30],
  'booking.autoCompleteGraceMinutes': [
    z
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 60),
    120,
  ],
  /** Minutes after endDateTime before a never-started CONFIRMED booking is flagged for review. */
  'booking.noShowGraceMinutes': [
    z
      .number()
      .int()
      .min(0)
      .max(24 * 60),
    30,
  ],
  'booking.quoteTtlSeconds': [z.number().int().min(30).max(3600), 600],
  'pricing.weekendDays': [z.array(z.number().int().min(1).max(7)).max(7), [6, 7]],
  /** Earnings stay in pendingBalance for this long after completion before RELEASE. */
  'wallet.releaseDelayHours': [
    z
      .number()
      .int()
      .min(0)
      .max(24 * 60),
    48,
  ],
  /** An asynchronous refund still unconfirmed after this long raises a CRITICAL alert (state is never guessed). */
  'refund.maxProcessingMinutes': [
    z
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 30),
    1440,
  ],
  'refund.statusPollSeconds': [z.number().int().min(1).max(86_400), 300],
  /** Admin wallet adjustments above this go to a second admin for approval instead of applying. */
  'adjustment.maxImmediateMinor': [z.number().int().min(0).max(1_000_000_000), 100_000],
  /** Total |amount| one admin may apply (directly or by approving) within a rolling 24h. */
  'adjustment.maxDailyMinor': [z.number().int().min(0).max(10_000_000_000), 1_000_000],
  /** Phase 4: background jobs, scheduler, notifications and queue-health thresholds. */
  'jobs.schedulerEnabled': [z.boolean(), true],
  'jobs.bookingExpireSeconds': [z.number().int().min(5).max(3600), 60],
  'jobs.noShowSeconds': [z.number().int().min(5).max(3600), 60],
  'jobs.autoCompleteSeconds': [z.number().int().min(5).max(3600), 60],
  'jobs.walletReleaseSeconds': [z.number().int().min(5).max(86_400), 300],
  'jobs.refundSweepSeconds': [z.number().int().min(5).max(3600), 30],
  'jobs.payoutSweepSeconds': [z.number().int().min(5).max(3600), 30],
  'jobs.paymentPollSeconds': [z.number().int().min(5).max(3600), 120],
  'jobs.notificationSweepSeconds': [z.number().int().min(5).max(3600), 30],
  'jobs.queueHealthSeconds': [z.number().int().min(5).max(3600), 60],
  'jobs.reconciliationMinutes': [z.number().int().min(1).max(1440), 15],
  'jobs.workerConcurrency': [z.number().int().min(1).max(50), 5],
  'jobs.attempts': [z.number().int().min(1).max(20), 5],
  'jobs.backoffBaseMs': [z.number().int().min(100).max(600_000), 2000],
  'jobs.removeOnCompleteCount': [z.number().int().min(0).max(100_000), 1000],
  'jobs.removeOnFailCount': [z.number().int().min(0).max(100_000), 5000],
  'jobs.failureAlertAfterAttempts': [z.number().int().min(1).max(20), 3],
  'payment.pollAfterMinutes': [z.number().int().min(1).max(1440), 10],
  'payment.staleAlertMinutes': [z.number().int().min(1).max(10_080), 120],
  'notification.maxAttempts': [z.number().int().min(1).max(20), 5],
  'notification.retryBaseSeconds': [z.number().int().min(1).max(3600), 30],
  'queue.backlogAlertThreshold': [z.number().int().min(1).max(1_000_000), 500],
  'queue.oldestWaitingAlertSeconds': [z.number().int().min(1).max(86_400), 900],
  'queue.workerHeartbeatStaleSeconds': [z.number().int().min(5).max(3600), 120],
  /** Phase 5: files, verification, emergency, chat, reviews. */
  'files.maxUploadBytes': [z.number().int().min(1024).max(20_971_520), 5_242_880],
  'files.signedUrlTtlSeconds': [z.number().int().min(10).max(900), 120],
  'verification.requiredDocuments': [
    z
      .array(
        z.enum([
          'NURSING_LICENSE',
          'IDENTITY_DOCUMENT',
          'CERTIFICATE',
          'QUALIFICATION',
          'INSURANCE',
          'OTHER',
        ]),
      )
      .min(1)
      .max(6),
    ['NURSING_LICENSE', 'IDENTITY_DOCUMENT'],
  ],
  'jobs.documentExpiryMinutes': [z.number().int().min(1).max(1440), 60],
  'jobs.emergencySweepSeconds': [z.number().int().min(5).max(600), 15],
  'jobs.reviewReconcileMinutes': [z.number().int().min(5).max(10_080), 360],
  'devices.maxActivePerUser': [z.number().int().min(1).max(50), 10],
  'emergency.startBufferMinutes': [z.number().int().min(0).max(240), 5],
  'emergency.offerTtlSeconds': [z.number().int().min(10).max(3600), 120],
  'emergency.maxOffers': [z.number().int().min(1).max(20), 5],
  'emergency.requestTtlMinutes': [z.number().int().min(1).max(240), 30],
  'emergency.maxDistanceKm': [z.number().int().min(1).max(200), 30],
  'chat.messageMaxLength': [z.number().int().min(10).max(10_000), 2000],
  'chat.messagesPerMinute': [z.number().int().min(1).max(600), 30],
  'reviews.requireCompletedBookingWithinDays': [z.number().int().min(1).max(3650), 90],
  'refund.maxAttempts': [z.number().int().min(1).max(20), 6],
  'refund.retryBaseSeconds': [z.number().int().min(1).max(3600), 60],
  'refund.alertAfterAttempts': [z.number().int().min(1).max(20), 3],
  'payout.minAmountMinor': [z.number().int().min(1).max(100_000_000), 5000],
  'payout.maxAttempts': [z.number().int().min(1).max(20), 5],
  'payout.retryBaseSeconds': [z.number().int().min(1).max(3600), 60],
  'commission.defaultBps': [z.number().int().min(0).max(10_000), 1500],
  'refund.policy': [
    z.array(refundTier).min(1).max(10),
    [
      { minHoursBeforeStart: 48, refundPercent: 100, nurseCompensationPercent: 0 },
      { minHoursBeforeStart: 24, refundPercent: 50, nurseCompensationPercent: 50 },
      { minHoursBeforeStart: 0, refundPercent: 0, nurseCompensationPercent: 100 },
    ],
  ],
  'matching.weights': [
    z.record(z.string(), z.number().min(0).max(100)),
    {
      availability: 25,
      service: 20,
      distance: 15,
      rating: 15,
      experience: 10,
      specialization: 5,
      price: 5,
      gender: 5,
    },
  ],
} as const;

export type SettingKey = keyof typeof SETTINGS;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export interface RefundTier {
  minHoursBeforeStart: number;
  refundPercent: number;
  nurseCompensationPercent: number;
}

export interface Settings {
  'platform.timezone': string;
  'platform.currency': 'AED';
  'booking.holdMinutes': number;
  'booking.nurseResponseMinutes': number;
  'booking.slotMinutes': 5 | 10 | 15 | 30;
  'booking.minLeadMinutes': number;
  'booking.maxAdvanceDays': number;
  'booking.maxDurationHours': number;
  'booking.startEarlyMinutes': number;
  'booking.autoCompleteGraceMinutes': number;
  'booking.noShowGraceMinutes': number;
  'booking.quoteTtlSeconds': number;
  'pricing.weekendDays': number[];
  'wallet.releaseDelayHours': number;
  'refund.maxProcessingMinutes': number;
  'refund.statusPollSeconds': number;
  'adjustment.maxImmediateMinor': number;
  'adjustment.maxDailyMinor': number;
  'jobs.schedulerEnabled': boolean;
  'jobs.bookingExpireSeconds': number;
  'jobs.noShowSeconds': number;
  'jobs.autoCompleteSeconds': number;
  'jobs.walletReleaseSeconds': number;
  'jobs.refundSweepSeconds': number;
  'jobs.payoutSweepSeconds': number;
  'jobs.paymentPollSeconds': number;
  'jobs.notificationSweepSeconds': number;
  'jobs.queueHealthSeconds': number;
  'jobs.reconciliationMinutes': number;
  'jobs.workerConcurrency': number;
  'jobs.attempts': number;
  'jobs.backoffBaseMs': number;
  'jobs.removeOnCompleteCount': number;
  'jobs.removeOnFailCount': number;
  'jobs.failureAlertAfterAttempts': number;
  'payment.pollAfterMinutes': number;
  'payment.staleAlertMinutes': number;
  'notification.maxAttempts': number;
  'notification.retryBaseSeconds': number;
  'queue.backlogAlertThreshold': number;
  'queue.oldestWaitingAlertSeconds': number;
  'queue.workerHeartbeatStaleSeconds': number;
  'files.maxUploadBytes': number;
  'files.signedUrlTtlSeconds': number;
  'verification.requiredDocuments': (
    | 'NURSING_LICENSE'
    | 'IDENTITY_DOCUMENT'
    | 'CERTIFICATE'
    | 'QUALIFICATION'
    | 'INSURANCE'
    | 'OTHER'
  )[];
  'jobs.documentExpiryMinutes': number;
  'jobs.emergencySweepSeconds': number;
  'jobs.reviewReconcileMinutes': number;
  'devices.maxActivePerUser': number;
  'emergency.startBufferMinutes': number;
  'emergency.offerTtlSeconds': number;
  'emergency.maxOffers': number;
  'emergency.requestTtlMinutes': number;
  'emergency.maxDistanceKm': number;
  'chat.messageMaxLength': number;
  'chat.messagesPerMinute': number;
  'reviews.requireCompletedBookingWithinDays': number;
  'refund.maxAttempts': number;
  'refund.retryBaseSeconds': number;
  'refund.alertAfterAttempts': number;
  'payout.minAmountMinor': number;
  'payout.maxAttempts': number;
  'payout.retryBaseSeconds': number;
  'commission.defaultBps': number;
  'refund.policy': RefundTier[];
  'matching.weights': Record<string, number>;
}
