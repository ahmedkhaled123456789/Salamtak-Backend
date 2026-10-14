import { Schema, model } from 'mongoose';

export const CONTACT_TOPICS = ['CARE', 'BOOKING', 'PARTNER', 'OTHER'] as const;
export type ContactTopic = (typeof CONTACT_TOPICS)[number];
export const CONTACT_STATUSES = ['NEW', 'HANDLED'] as const;

const TWO_YEARS_S = 2 * 365 * 24 * 3600;

/**
 * Message from the public contact form. Minimal personal data (name, email, optional phone, text) and no
 * request metadata (IP, user agent). Deleted automatically two years after creation (data minimisation).
 */
const contactSchema = new Schema(
  {
    name: { type: String, required: true, maxlength: 120 },
    email: { type: String, required: true, lowercase: true, maxlength: 254 },
    phone: { type: String, maxlength: 20 },
    topic: { type: String, enum: CONTACT_TOPICS, required: true },
    message: { type: String, required: true, maxlength: 4000 },
    locale: { type: String, enum: ['en', 'ar'], default: 'en' },
    status: { type: String, enum: CONTACT_STATUSES, default: 'NEW' },
    handledBy: { type: Schema.Types.ObjectId, ref: 'User' },
    handledAt: Date,
    note: { type: String, maxlength: 1000 },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
contactSchema.index({ status: 1, createdAt: -1 });
contactSchema.index({ createdAt: 1 }, { expireAfterSeconds: TWO_YEARS_S });
export const ContactMessage = model('ContactMessage', contactSchema, 'contactMessages');
export type ContactMessageDoc = InstanceType<typeof ContactMessage>;

export const SUBSCRIBER_STATUSES = ['PENDING', 'SUBSCRIBED', 'UNSUBSCRIBED'] as const;

/**
 * Newsletter subscriber with double opt-in: PENDING until the emailed link is used. Tokens are stored as SHA-256
 * hashes only. Unsubscribing keeps the row (so the address is not re-mailed) but clears the tokens.
 */
const subscriberSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, maxlength: 254 },
    locale: { type: String, enum: ['en', 'ar'], default: 'en' },
    status: { type: String, enum: SUBSCRIBER_STATUSES, default: 'PENDING' },
    confirmTokenHash: String,
    confirmExpiresAt: Date,
    unsubscribeTokenHash: String,
    consentAt: Date,
    unsubscribedAt: Date,
    source: { type: String, maxlength: 40, default: 'website' },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
subscriberSchema.index({ email: 1 }, { unique: true });
subscriberSchema.index({ confirmTokenHash: 1 }, { sparse: true });
subscriberSchema.index({ unsubscribeTokenHash: 1 }, { sparse: true });
subscriberSchema.index({ status: 1, createdAt: -1 });
export const NewsletterSubscriber = model('NewsletterSubscriber', subscriberSchema, 'newsletterSubscribers');
export type NewsletterSubscriberDoc = InstanceType<typeof NewsletterSubscriber>;
