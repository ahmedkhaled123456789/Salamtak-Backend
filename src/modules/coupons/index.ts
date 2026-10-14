import { registerBookingHooks, registerTransitionListener } from '../bookings';
import { CouponService } from './coupon.service';

export { Coupon, CouponRedemption, CouponUserUsage, COUPON_TYPES } from './coupon.models';
export type { CouponDoc } from './coupon.models';
export { CouponService, computeDiscount, toCouponDTO } from './coupon.service';

/** Plugs coupons into booking quote/creation and releases unpaid uses. Called once from createApp(). */
export function registerCouponHooks(): void {
  registerBookingHooks({
    discount: {
      evaluate: (a) => CouponService.evaluate(a),
      redeem: (a, session) => CouponService.redeem(a, session),
    },
  });
  registerTransitionListener('coupons', async (booking, change, session) => {
    if (change.to === 'EXPIRED' || change.to === 'CANCELLED')
      await CouponService.releaseForBooking(booking, `booking ${change.to}`, session);
  });
}
