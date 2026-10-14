import { NotFoundError } from '../../common/errors';
import { SettingsService } from '../settings';
import { DeviceToken, type DevicePlatform, type DeviceTokenDoc } from './device.models';

export const maskToken = (t: string) => `…${t.slice(-6)}`;

export const toDeviceDTO = (d: DeviceTokenDoc) => ({
  id: String(d._id),
  platform: d.platform,
  appVersion: d.appVersion ?? null,
  active: d.active,
  token: maskToken(d.token), // the full token is never returned
  lastSeenAt: d.lastSeenAt,
  createdAt: d.createdAt,
});

export const DeviceService = {
  /**
   * Register or refresh. One atomic upsert on the unique token: concurrent duplicates collapse into
   * one row. If the token belonged to another user it moves to the caller.
   */
  async register(
    userId: string,
    input: { token: string; platform: DevicePlatform; appVersion?: string },
  ): Promise<{ device: DeviceTokenDoc; created: boolean }> {
    const now = new Date();
    const run = () =>
      DeviceToken.findOneAndUpdate(
        { token: input.token },
        {
          $set: {
            userId,
            platform: input.platform,
            active: true,
            lastSeenAt: now,
            ...(input.appVersion && { appVersion: input.appVersion }),
          },
          $setOnInsert: { token: input.token },
        },
        { upsert: true, new: true, includeResultMetadata: true },
      );
    let r;
    try {
      r = await run();
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      r = await run(); // lost the insert race: the row exists now, update it
    }
    const device = r.value as DeviceTokenDoc;
    const created = r.lastErrorObject?.updatedExisting === false;
    // cap active registrations per user: the oldest are deactivated
    const max = await SettingsService.get('devices.maxActivePerUser');
    const active = await DeviceToken.find({ userId, active: true })
      .sort({ lastSeenAt: -1, _id: -1 })
      .select('_id');
    if (active.length > max)
      await DeviceToken.updateMany(
        { _id: { $in: active.slice(max).map((d) => d._id) } },
        { $set: { active: false } },
      );
    return { device, created };
  },

  listMine: (userId: string) => DeviceToken.find({ userId }).sort({ lastSeenAt: -1 }).limit(50),

  /** Only the owner can deactivate; idempotent. Unknown or foreign tokens look identical (404). */
  async unregisterToken(userId: string, token: string): Promise<boolean> {
    const d = await DeviceToken.findOne({ token, userId });
    if (!d) throw new NotFoundError('Device not found', 'DEVICE_NOT_FOUND');
    if (!d.active) return false;
    await DeviceToken.updateOne({ _id: d._id, active: true }, { $set: { active: false } });
    return true;
  },

  async deactivate(userId: string, id: string): Promise<boolean> {
    const d = await DeviceToken.findOne({ _id: id, userId });
    if (!d) throw new NotFoundError('Device not found', 'DEVICE_NOT_FOUND');
    if (!d.active) return false;
    await DeviceToken.updateOne({ _id: id, active: true }, { $set: { active: false } });
    return true;
  },

  /** For the push worker only. */
  activeFor: (userId: string) =>
    DeviceToken.find({ userId, active: true }).sort({ lastSeenAt: -1 }).limit(10).lean(),

  /** Provider said these tokens are dead (uninstalled / expired). */
  deactivateTokens: (tokens: string[]) =>
    tokens.length
      ? DeviceToken.updateMany({ token: { $in: tokens } }, { $set: { active: false } })
      : null,
};
