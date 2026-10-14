import type { ClientSession } from 'mongoose';
import { NotFoundError } from '../../common/errors';
import { FileService, type UploadedFile } from '../files';
import { User, type UserDoc } from './user.model';

export interface AuthSubject {
  id: string;
  role: string;
  isActive: boolean;
  pv: number;
}

export interface UpdateProfileInput {
  firstName?: string;
  lastName?: string;
  gender?: 'MALE' | 'FEMALE' | 'OTHER';
  dateOfBirth?: Date;
}

export const UserService = {
  /** Minimal fresh read used by the auth middleware on every request. */
  async getAuthSubject(id: string): Promise<AuthSubject | null> {
    const u = await User.findById(id).select('role isActive passwordChangedAt').lean();
    if (!u) return null;
    return {
      id: String(u._id),
      role: u.role,
      isActive: u.isActive,
      pv: u.passwordChangedAt?.getTime() ?? 0,
    };
  },

  async getById(id: string): Promise<UserDoc> {
    const user = await User.findById(id);
    if (!user) throw new NotFoundError('User not found', 'USER_NOT_FOUND');
    return user;
  },

  async updateProfile(id: string, input: UpdateProfileInput): Promise<UserDoc> {
    const user = await User.findByIdAndUpdate(
      id,
      { $set: input },
      { new: true, runValidators: true },
    );
    if (!user) throw new NotFoundError('User not found', 'USER_NOT_FOUND');
    return user;
  },

  /** Replaces the user's public photo (the previous one is deleted). Works for patients and nurses. */
  async setProfileImage(id: string, file: UploadedFile | undefined): Promise<UserDoc> {
    const before = await this.getById(id);
    const img = await FileService.replacePublicImage(
      id,
      'PROFILE_IMAGE',
      file,
      before.profileImage,
    );
    const after = await User.findByIdAndUpdate(
      id,
      { $set: { profileImage: img._id } },
      { new: true },
    );
    return after as UserDoc;
  },

  async setActive(
    id: string,
    isActive: boolean,
    reason: string | undefined,
    session?: ClientSession,
  ): Promise<{ before: UserDoc; after: UserDoc }> {
    const before = await User.findById(id).session(session ?? null);
    if (!before) throw new NotFoundError('User not found', 'USER_NOT_FOUND');
    const after = await User.findByIdAndUpdate(
      id,
      isActive
        ? { $set: { isActive }, $unset: { blockedReason: 1 } }
        : { $set: { isActive, blockedReason: reason } },
      { new: true, session },
    );
    return { before, after: after as UserDoc };
  },
};
