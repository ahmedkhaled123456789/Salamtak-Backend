import { Schema } from 'mongoose';

/** GeoJSON Point, [longitude, latitude]. Used with 2dsphere indexes. */
export const geoPointSchema = new Schema(
  {
    type: { type: String, enum: ['Point'], required: true, default: 'Point' },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: (v: number[]) =>
          v.length === 2 && v[0]! >= -180 && v[0]! <= 180 && v[1]! >= -90 && v[1]! <= 90,
        message: 'coordinates must be [longitude, latitude]',
      },
    },
  },
  { _id: false },
);

export interface LatLng {
  latitude: number;
  longitude: number;
}
export const toGeoPoint = ({ latitude, longitude }: LatLng) => ({
  type: 'Point' as const,
  coordinates: [longitude, latitude] as [number, number],
});
export const fromGeoPoint = (p?: { coordinates?: number[] } | null): LatLng | null =>
  p?.coordinates?.length === 2
    ? { longitude: p.coordinates[0]!, latitude: p.coordinates[1]! }
    : null;
