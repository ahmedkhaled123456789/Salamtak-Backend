import { Schema, model, type InferSchemaType } from 'mongoose';
import { ROLES } from '../../common/constants/rbac';
import { mediaUrl } from '../../common/utils/media';

export const GENDERS = ['MALE', 'FEMALE', 'OTHER'] as const;

const userSchema = new Schema(
  {
    firstName: { type: String, required: true, trim: true, maxlength: 80 },
    lastName: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    phone: { type: String, required: true, trim: true, match: /^\+[1-9]\d{7,14}$/ },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, required: true, enum: ROLES },
    gender: { type: String, enum: GENDERS },
    dateOfBirth: { type: Date },
    /** Public photo (FileObject with purpose PROFILE_IMAGE); also the nurse's photo on the website. */
    profileImage: { type: Schema.Types.ObjectId, ref: 'FileObject' },
    isActive: { type: Boolean, default: true },
    isVerified: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date },
    phoneVerifiedAt: { type: Date },
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: { type: Date },
    lastLoginAt: { type: Date },
    passwordChangedAt: { type: Date },
    blockedReason: { type: String, maxlength: 500 },
  },
  {
    timestamps: true,
    versionKey: false,
    strict: 'throw',
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        ret.id = String(ret._id);
        delete ret._id;
        if (ret.profileImage) {
          ret.profileImageUrl = mediaUrl(ret.profileImage);
          ret.profileImage = String(ret.profileImage);
        }
        delete ret.passwordHash;
        delete ret.failedLoginCount;
        delete ret.lockedUntil;
        return ret;
      },
    },
  },
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ phone: 1 }, { unique: true });
userSchema.index({ role: 1, isActive: 1 });
userSchema.index({ createdAt: -1 });

export type UserAttrs = InferSchemaType<typeof userSchema>;
export const User = model('User', userSchema, 'users');
export type UserDoc = InstanceType<typeof User>;
