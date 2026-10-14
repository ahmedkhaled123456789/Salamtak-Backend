import { Schema, model } from 'mongoose';

/** Single-use hashed tokens for password reset and email verification. */
const oneTimeTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    purpose: { type: String, enum: ['PASSWORD_RESET', 'EMAIL_VERIFY'], required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);

oneTimeTokenSchema.index({ tokenHash: 1 }, { unique: true });
oneTimeTokenSchema.index({ userId: 1, purpose: 1 });
oneTimeTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OneTimeToken = model('OneTimeToken', oneTimeTokenSchema, 'passwordResetTokens');
