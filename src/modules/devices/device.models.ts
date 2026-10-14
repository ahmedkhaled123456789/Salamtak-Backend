import { Schema, model } from 'mongoose';

export const DEVICE_PLATFORMS = ['IOS', 'ANDROID', 'WEB'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/**
 * Push registration. A token identifies one app installation, so it is globally unique: if a
 * different user signs in on the same device the registration MOVES to them (the previous user stops
 * receiving that device's pushes). Tokens are never returned to anyone but masked.
 */
const deviceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    token: { type: String, required: true, minlength: 16, maxlength: 4096 },
    platform: { type: String, enum: DEVICE_PLATFORMS, required: true },
    appVersion: { type: String, maxlength: 40 },
    active: { type: Boolean, default: true },
    lastSeenAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
deviceSchema.index({ token: 1 }, { unique: true });
deviceSchema.index({ userId: 1, active: 1, lastSeenAt: -1 });
export const DeviceToken = model('DeviceToken', deviceSchema, 'deviceTokens');
export type DeviceTokenDoc = InstanceType<typeof DeviceToken>;
