import type { Express } from 'express';
import request from 'supertest';
import { Booking } from '../../src/modules/bookings';
import type { MemoryQueueBackend } from '../../src/queues';
import { getQueueBackend } from '../../src/queues';
import { API } from './harness';
import { completeBooking, payFully } from './finance';
import { at, type BookArgs, type Nurse } from './world';
import type { MockPaymentProvider } from '../../src/providers/payment';
import type { Session } from './harness';

export const memoryQueue = () => getQueueBackend() as MemoryQueueBackend;
const MIN = 60_000;

/** A paid, nurse-accepted (CONFIRMED) booking whose scheduled end was `endedMinAgo` minutes ago and never started. */
export async function confirmedPastBooking(
  app: Express,
  mock: MockPaymentProvider,
  patient: Session,
  nurse: Nurse,
  args: BookArgs,
  endedMinAgo: number,
) {
  const r = await payFully(app, mock, patient, args);
  const acc = await request(app)
    .post(`${API}/bookings/${r.bookingId}/accept`)
    .set(nurse.session.auth)
    .send({});
  if (acc.status !== 200)
    throw new Error(`accept failed ${acc.status} ${JSON.stringify(acc.body)}`);
  await Booking.collection.updateOne(
    { _id: new Booking.base.Types.ObjectId(r.bookingId) },
    {
      $set: {
        startDateTime: new Date(Date.now() - (endedMinAgo + 120) * MIN),
        endDateTime: new Date(Date.now() - endedMinAgo * MIN),
      },
    },
  );
  return r;
}

export { completeBooking, at };
