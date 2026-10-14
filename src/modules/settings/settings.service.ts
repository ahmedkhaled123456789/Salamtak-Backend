import { Schema, model } from 'mongoose';
import type { ZodType } from 'zod';
import { BadRequestError, ConflictError } from '../../common/errors';
import { SETTINGS, SETTING_KEYS, type SettingKey, type Settings } from './settings.registry';

const platformSettingSchema = new Schema(
  {
    key: { type: String, required: true },
    value: { type: Schema.Types.Mixed, required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
platformSettingSchema.index({ key: 1 }, { unique: true });
export const PlatformSetting = model('PlatformSetting', platformSettingSchema, 'platformSettings');

export const SettingsService = {
  /** All settings merged over defaults, validated. One query per call. */
  async getAll(): Promise<Settings> {
    const rows = await PlatformSetting.find().lean();
    const out: Record<string, unknown> = {};
    for (const key of SETTING_KEYS) out[key] = SETTINGS[key][1];
    for (const row of rows) {
      const entry = SETTINGS[row.key as SettingKey];
      if (!entry) continue; // ignore retired keys
      const parsed = (entry[0] as ZodType).safeParse(row.value);
      if (parsed.success) out[row.key] = parsed.data;
    }
    return out as unknown as Settings;
  },

  async get<K extends SettingKey>(key: K): Promise<Settings[K]> {
    return (await this.getAll())[key];
  },

  /** Validates and stores a setting. Returns the previous and new effective values. */
  async set(
    key: string,
    value: unknown,
    updatedBy?: string,
    hooks: { hasReservations?: () => Promise<boolean> } = {},
  ): Promise<{ key: SettingKey; before: unknown; after: unknown }> {
    if (!(key in SETTINGS)) throw new BadRequestError(`Unknown setting ${key}`, 'UNKNOWN_SETTING');
    const k = key as SettingKey;
    const parsed = (SETTINGS[k][0] as ZodType).safeParse(value);
    if (!parsed.success) {
      throw new BadRequestError(
        'Invalid setting value',
        'INVALID_SETTING',
        parsed.error.issues.map((i) => ({ field: key, message: i.message })),
      );
    }
    const before = (await this.getAll())[k];
    if (
      k === 'booking.slotMinutes' &&
      parsed.data !== before &&
      (await hooks.hasReservations?.())
    ) {
      throw new ConflictError(
        'Slot size cannot change while reservations exist',
        'SLOT_GRID_IN_USE',
      );
    }
    await PlatformSetting.updateOne(
      { key: k },
      { $set: { value: parsed.data, updatedBy } },
      { upsert: true },
    );
    return { key: k, before, after: parsed.data };
  },
};
