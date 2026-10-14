import { z } from 'zod';
import { GENDERS } from './user.model';

export const UserSchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  phone: z.string(),
  role: z.string(),
  gender: z.enum(GENDERS).optional(),
  dateOfBirth: z.date().optional(),
  profileImage: z.string().optional(),
  profileImageUrl: z.string().optional(),
  isActive: z.boolean(),
  isVerified: z.boolean(),
  emailVerifiedAt: z.date().optional(),
  phoneVerifiedAt: z.date().optional(),
  lastLoginAt: z.date().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
