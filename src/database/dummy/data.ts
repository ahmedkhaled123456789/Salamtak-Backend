/**
 * Fictional seed content. Everything here is invented: names are generic, emails use the reserved
 * `example.test` domain (RFC 6761, can never be a real mailbox), phones use a placeholder range, and no
 * health information of any kind is included.
 *
 * Stable identifiers (how seeded rows are recognised and de-duplicated; no schema has a free "tag" field):
 *   users      e-mail  seed.patient.NN@example.test / seed.nurse.NN@example.test
 *   services   slug    seed-<name>
 *   coupons    code    SEED...
 *   holidays   name    "Seed: ..." (date is the unique key)
 *   bookings   notes   "[seed:dummy-v1] Fictional booking NN"
 */
export const SEED_TAG = 'seed:dummy-v1';
export const SEED_EMAIL_DOMAIN = 'example.test';
export const SEED_COUNT = 10;

export const seedEmail = (role: 'patient' | 'nurse', n: number) =>
  `seed.${role}.${String(n).padStart(2, '0')}@${SEED_EMAIL_DOMAIN}`;
export const seedPhone = (role: 'patient' | 'nurse', n: number) =>
  `+97155500${role === 'patient' ? 1 : 2}${String(n).padStart(2, '0')}`;
export const bookingMarker = (n: number) =>
  `[${SEED_TAG}] Fictional booking ${String(n).padStart(2, '0')}`;

export const PATIENTS = [
  ['Layla', 'Haddad'],
  ['Omar', 'Rahman'],
  ['Mariam', 'Saeed'],
  ['Yusuf', 'Karim'],
  ['Noor', 'Aziz'],
  ['Hamza', 'Farid'],
  ['Salma', 'Nader'],
  ['Idris', 'Mansour'],
  ['Dina', 'Khoury'],
  ['Tariq', 'Bashir'],
] as const;

export const NURSES = [
  ['Amira', 'Younis'],
  ['Rania', 'Qasim'],
  ['Huda', 'Samara'],
  ['Jamal', 'Idris'],
  ['Leena', 'Fadel'],
  ['Zainab', 'Mourad'],
  ['Karim', 'Tahan'],
  ['Samira', 'Nouri'],
  ['Nadia', 'Halabi'],
  ['Faris', 'Dagher'],
] as const;

/** Verification target per nurse index (0-based). Anything not listed stays PENDING. */
export const NURSE_VERIFICATION: Record<number, 'VERIFIED' | 'UNDER_REVIEW'> = {
  0: 'VERIFIED',
  1: 'VERIFIED',
  2: 'VERIFIED',
  3: 'VERIFIED',
  4: 'VERIFIED',
  5: 'VERIFIED',
  6: 'VERIFIED',
  7: 'VERIFIED',
  8: 'UNDER_REVIEW',
};

export const SPECIALIZATIONS = [
  'elderly care',
  'post-surgery recovery',
  'medication support',
  'physiotherapy assistance',
  'companionship',
];
export const LANGUAGES = [
  ['english', 'arabic'],
  ['english'],
  ['english', 'arabic', 'hindi'],
  ['english', 'tagalog'],
];

/** Fictional street addresses in a real emirate, with approximate (not real-residence) coordinates. */
export const LOCATIONS = [
  {
    address: 'Seed Residence 1, Marina Walk',
    city: 'Dubai',
    latitude: 25.0805,
    longitude: 55.1403,
  },
  {
    address: 'Seed Residence 2, Al Wasl Road',
    city: 'Dubai',
    latitude: 25.2048,
    longitude: 55.2708,
  },
  {
    address: 'Seed Residence 3, Jumeirah Beach Road',
    city: 'Dubai',
    latitude: 25.2285,
    longitude: 55.2585,
  },
  {
    address: 'Seed Residence 4, Business Bay',
    city: 'Dubai',
    latitude: 25.1851,
    longitude: 55.2744,
  },
  {
    address: 'Seed Residence 5, Deira Corniche',
    city: 'Dubai',
    latitude: 25.2697,
    longitude: 55.3095,
  },
];

export const SERVICES = [
  { name: 'Seed Home Nursing', category: 'NURSING', rateMinor: 6000, min: 60, max: 720 },
  { name: 'Seed Elderly Care', category: 'ELDERLY_CARE', rateMinor: 4500, min: 120, max: 720 },
  { name: 'Seed Post-Surgery Care', category: 'POST_SURGERY', rateMinor: 7500, min: 120, max: 720 },
  {
    name: 'Seed Medication Assistance',
    category: 'MEDICATION',
    rateMinor: 3500,
    min: 60,
    max: 240,
  },
  { name: 'Seed Vitals Monitoring', category: 'MONITORING', rateMinor: 5000, min: 60, max: 480 },
  {
    name: 'Seed Companionship Visit',
    category: 'COMPANIONSHIP',
    rateMinor: 3000,
    min: 60,
    max: 480,
  },
  {
    name: 'Seed Daily Assistance',
    category: 'DAILY_ASSISTANCE',
    rateMinor: 4000,
    min: 120,
    max: 720,
  },
  {
    name: 'Seed Chronic Care Support',
    category: 'CHRONIC_CARE',
    rateMinor: 6500,
    min: 120,
    max: 720,
  },
  { name: 'Seed Palliative Support', category: 'OTHER', rateMinor: 7000, min: 120, max: 720 },
  {
    name: 'Seed Rehabilitation Assistance',
    category: 'POST_SURGERY',
    rateMinor: 5500,
    min: 60,
    max: 480,
  },
] as const;

export const HOLIDAYS = [
  { date: '2026-12-02', name: 'Seed: National Day (sample)' },
  { date: '2026-12-03', name: 'Seed: National Day holiday (sample)' },
  { date: '2027-01-01', name: "Seed: New Year's Day (sample)" },
  { date: '2027-02-15', name: 'Seed: Sample holiday 4' },
  { date: '2027-03-20', name: 'Seed: Sample holiday 5' },
  { date: '2027-04-05', name: 'Seed: Sample holiday 6' },
  { date: '2027-05-01', name: 'Seed: Sample holiday 7' },
  { date: '2027-06-10', name: 'Seed: Sample holiday 8' },
  { date: '2027-07-04', name: 'Seed: Sample holiday 9' },
  { date: '2027-08-12', name: 'Seed: Sample holiday 10' },
];

export const COUPONS = [
  {
    code: 'SEEDWELCOME10',
    description: 'Seed: 10% welcome offer',
    type: 'PERCENTAGE',
    valueBps: 1000,
    maxDiscountMinor: 3000,
    usageLimit: 500,
  },
  {
    code: 'SEEDSAVE20',
    description: 'Seed: AED 20 off',
    type: 'FIXED',
    valueMinor: 2000,
    usageLimit: 200,
  },
  {
    code: 'SEEDWEEKEND15',
    description: 'Seed: 15% weekend offer',
    type: 'PERCENTAGE',
    valueBps: 1500,
    maxDiscountMinor: 5000,
    usageLimit: 300,
  },
  {
    code: 'SEEDFAMILY25',
    description: 'Seed: AED 25 family offer',
    type: 'FIXED',
    valueMinor: 2500,
    minBookingAmountMinor: 10000,
    perUserLimit: 2,
  },
  {
    code: 'SEEDLOYALTY5',
    description: 'Seed: 5% loyalty offer',
    type: 'PERCENTAGE',
    valueBps: 500,
  },
  {
    code: 'SEEDNEWYEAR30',
    description: 'Seed: AED 30 new-year offer',
    type: 'FIXED',
    valueMinor: 3000,
    usageLimit: 100,
  },
  {
    code: 'SEEDSPRING12',
    description: 'Seed: 12% spring offer',
    type: 'PERCENTAGE',
    valueBps: 1200,
    maxDiscountMinor: 4000,
  },
  {
    code: 'SEEDELDER18',
    description: 'Seed: 18% elder-care offer',
    type: 'PERCENTAGE',
    valueBps: 1800,
    usageLimit: 150,
  },
  {
    code: 'SEEDREFER10',
    description: 'Seed: AED 10 referral offer',
    type: 'FIXED',
    valueMinor: 1000,
    perUserLimit: 1,
  },
  { code: 'SEEDVIP8', description: 'Seed: 8% member offer', type: 'PERCENTAGE', valueBps: 800 },
] as const;

/** Every collection the seeder can create documents in (dependency order). Used for before/after counting. */
export const SEED_COLLECTIONS = [
  'users',
  'patientProfiles',
  'nurseProfiles',
  'services',
  'servicePrices',
  'nurseServices',
  'nurseAvailabilities',
  'holidays',
  'coupons',
  'bookings',
  'bookingItems',
  'bookingHistories',
  'bookingReservations',
  'auditLogs',
] as const;
