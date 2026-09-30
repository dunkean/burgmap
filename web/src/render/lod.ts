/** Level-of-detail selection: pure functions of screen scale (pixels per meter). */
export type Band = 0 | 1 | 2; // 0 far, 1 mid, 2 near

export const MID_SCALE = 0.06;
export const NEAR_SCALE = 0.3;
export const TEXTURE_SCALE = 0.7;
export const SHADOW_SCALE = 0.9;
export const PARCEL_SCALE = 0.3;

/** Per-band vertex decimation tolerance (m). Constant per band so cached paths stay valid. */
export const BAND_MIN_EDGE: readonly number[] = [10, 1.5, 0];

export interface Lod {
  band: Band;
  /** Simplification tolerance in meters (vertices closer than this are dropped). */
  minEdge: number;
  minorRoads: boolean; streets: boolean; alleys: boolean;
  blocks: boolean; landmarks: boolean; towers: boolean; strips: boolean; farmsteads: boolean;
  /** parcels = plot hairlines; buildings = building masses (courtyards as holes). */
  parcels: boolean; buildings: boolean; shadows: boolean; textures: boolean;
  /** Density tint opacity multiplier (fades out when zoomed in). */
  densityAlpha: number;
}

export function lodBand(scale: number): Band { return scale >= NEAR_SCALE ? 2 : scale >= MID_SCALE ? 1 : 0; }

export function selectLod(scale: number): Lod {
  const band = lodBand(scale);
  const fade = scale < NEAR_SCALE ? 1 : Math.max(0, 1 - (scale - NEAR_SCALE) / (NEAR_SCALE * 1.5));
  return {
    band,
    minEdge: BAND_MIN_EDGE[band],
    minorRoads: scale >= 0.02,
    streets: band >= 1, alleys: band >= 2,
    blocks: band >= 1, landmarks: band >= 1, towers: band >= 1, strips: band >= 1, farmsteads: band >= 1,
    parcels: scale >= PARCEL_SCALE, buildings: band >= 1,
    shadows: scale >= SHADOW_SCALE, textures: scale >= TEXTURE_SCALE,
    densityAlpha: band === 2 ? fade : 1,
  };
}

/** Line width in world units: at least `minPx` on screen. */
export const lineWidth = (worldW: number, minPx: number, scale: number): number => Math.max(worldW, minPx / scale);
