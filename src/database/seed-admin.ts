/**
 * Creates the first admin account. Admins are never created through the public API.
 * Usage: ADMIN_EMAIL=... ADMIN_PASSWORD=... [ADMIN_ROLE=FINANCE_APPROVER] npm run seed:admin
 */
import bcrypt from 'bcryptjs';
import { connectDatabase, disconnectDatabase, initModels } from '../config/database';
import { env } from '../config/env';
import { User } from '../modules/users';

async function run(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password || password.length < 10) {
    throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (min 10 chars)');
  }
  const role = process.env.ADMIN_ROLE === 'FINANCE_APPROVER' ? 'FINANCE_APPROVER' : 'ADMIN';
  await connectDatabase();
  await initModels();
  const existing = await User.findOne({ email });
  if (existing) {
    console.log(`Admin ${email} already exists`);
  } else {
    await User.create({
      firstName: 'Platform',
      lastName: 'Admin',
      email,
      phone: process.env.ADMIN_PHONE ?? '+971500000000',
      passwordHash: await bcrypt.hash(password, env.BCRYPT_COST),
      role,
      isVerified: true,
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    });
    console.log(`Admin ${email} created`);
  }
  await disconnectDatabase();
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
