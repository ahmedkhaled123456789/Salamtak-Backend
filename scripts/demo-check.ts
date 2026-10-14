/**
 * Read-only health check of a dataset (e.g. after `npm run seed:demo`): the platform's own financial reconciliation
 * (ledger, payments, refunds, earnings, payouts — 13 checks) plus counts per booking status. Writes nothing.
 *
 *   MONGODB_URI=… npm run demo:check
 */
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

async function main(): Promise<void> {
  process.env.REDIS_URL ||= 'memory';
  const mongoose = (await import('mongoose')).default;
  const { env } = await import('../src/config/env');
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  try {
    const { ReconciliationService } = await import('../src/modules/finance');
    const { Booking } = await import('../src/modules/bookings');
    const report = await ReconciliationService.run();
    console.log(`reconciliation: ${report.ok ? 'OK' : 'PROBLEMS FOUND'}`);
    for (const c of report.checks) {
      const problems = (c as unknown as { problems?: string[] }).problems ?? [];
      console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name} (checked ${c.checked})${problems.length ? ` — ${problems.slice(0, 3).join(' | ')}` : ''}`);
    }
    console.log('totals:', JSON.stringify(report.totals));
    const byStatus = await Booking.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { n: -1 } }]);
    console.log('bookings by status:', byStatus.map((b) => `${b._id}=${b.n}`).join(', '));
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message.replace(/mongodb(\+srv)?:\/\/[^\s'"]+/gi, 'mongodb://<redacted>') : err);
  process.exit(1);
});
