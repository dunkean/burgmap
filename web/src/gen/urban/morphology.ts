/**
 * Morphology parameters (URBAN_GEOMETRY.md §7, URBAN_MORPHOLOGY.md §2). A morphology is plain data: the
 * street operators read `field`/`curvature`/…, the plot operator reads `frontage`/`plotDepth`/…, the building
 * operator reads `buildDepth`/`infill`/…. Culture presets turn these dials; later presets (medina, chinese…)
 * plug in by adding data plus operators keyed by `streetOp` / `plotOp` / `buildingOp`.
 */

export type MorphologyId = 'european-organic' | 'bastide';
/** Zones drive plot sizes and the burgage cycle: core (oldest phase), middle, edge (youngest), faubourg, village. */
export type Zone = 'core' | 'middle' | 'edge' | 'faubourg' | 'village';
export type Range = [number, number];

export interface MorphologyParams {
  id: MorphologyId;
  /** Street operator: organic cross-field splitting, or a (skewed) lattice. */
  streetOp: 'organic' | 'grid';
  plotOp: 'burgage';
  buildingOp: 'streetFrontRow';
  /** Max heading change of streamlines: curvature × 10° per 10 m. */
  curvature: number;
  /** Amplitude (degrees) and wavelength (m) of the angular noise of the guidance field. */
  fieldNoise: number;
  fieldWavelength: number;
  /** Grid: street spacing along the two lattice axes (m) and skew noise (radians). */
  gridSpacing: [number, number];
  gridSkew: number;
  /** Target block areas (m²) per zone. */
  blockSize: Record<Zone, Range>;
  minBlock: number;
  /** Minimum block width (2 × inscribed radius), m. */
  minWidth: number;
  /** Full street widths by rank 0 (arterial) … 4 (close). */
  widthByRank: number[];
  widthScale: number;
  widthJitter: number;
  /** Fork pieces below this area (m²) become places. */
  placeThreshold: number;
  /** Probability that a deep block gets a close (slit) and its relative depth. */
  deadEndRatio: number;
  slitDepth: number;
  frontage: Record<Zone, Range>;
  plotDepth: Record<Zone, Range>;
  /** Random tilt of plot side lines (degrees). */
  plotTilt: number;
  /** Probability of a double/triple (merchant) plot. */
  wideLotChance: number;
  buildDepth: Record<Zone, Range>;
  setback: Record<Zone, Range>;
  sideGap: Record<Zone, Range>;
  /** Burgage-cycle infill base per zone (0 = house + garden … 1 = fully built). */
  infill: Record<Zone, number>;
  courtyardMin: number;
  /** Gross densities (inhabitants per ha) per zone, used to size phase regions. */
  density: Record<Zone, number>;
}

const EO: MorphologyParams = {
  id: 'european-organic',
  streetOp: 'organic',
  plotOp: 'burgage',
  buildingOp: 'streetFrontRow',
  curvature: 0.55,
  fieldNoise: 12,
  fieldWavelength: 150,
  gridSpacing: [70, 110],
  gridSkew: 0,
  blockSize: {
    core: [2200, 6500], middle: [3500, 10000], edge: [5000, 15000], faubourg: [4500, 14000], village: [7000, 22000],
  },
  minBlock: 700,
  minWidth: 17,
  widthByRank: [8, 6.2, 4.6, 3.2, 2.5],
  widthScale: 1,
  widthJitter: 0.12,
  placeThreshold: 900,
  deadEndRatio: 0.35,
  slitDepth: 0.55,
  frontage: { core: [4.5, 7.5], middle: [6, 10], edge: [8, 14], faubourg: [7, 13], village: [18, 40] },
  plotDepth: { core: [24, 42], middle: [30, 50], edge: [35, 65], faubourg: [30, 60], village: [40, 80] },
  plotTilt: 6,
  wideLotChance: 0.08,
  buildDepth: { core: [10, 14], middle: [9, 13], edge: [8, 12], faubourg: [8, 12], village: [8, 12] },
  setback: { core: [0, 0.3], middle: [0, 0.8], edge: [0.5, 3], faubourg: [0.5, 3], village: [3, 10] },
  sideGap: { core: [0, 0], middle: [0, 1.2], edge: [0.5, 2.5], faubourg: [0.8, 3], village: [3, 8] },
  infill: { core: 0.92, middle: 0.62, edge: 0.38, faubourg: 0.3, village: 0.12 },
  courtyardMin: 9,
  density: { core: 185, middle: 120, edge: 85, faubourg: 55, village: 35 },
};

const BASTIDE: MorphologyParams = {
  ...EO,
  id: 'bastide',
  streetOp: 'grid',
  curvature: 0.05,
  fieldNoise: 1.5,
  fieldWavelength: 400,
  gridSpacing: [52, 96],
  gridSkew: 0.03,
  blockSize: {
    core: [2500, 5500], middle: [2500, 5500], edge: [3000, 7000], faubourg: [4500, 14000], village: [6000, 20000],
  },
  minBlock: 600,
  widthByRank: [8, 7, 5, 3.4, 2.5],
  deadEndRatio: 0.05,
  frontage: { core: [6, 9], middle: [6, 9], edge: [7, 11], faubourg: [7, 13], village: [18, 40] },
  plotDepth: { core: [20, 30], middle: [20, 32], edge: [22, 36], faubourg: [30, 60], village: [40, 80] },
  plotTilt: 1.5,
  infill: { core: 0.72, middle: 0.6, edge: 0.45, faubourg: 0.3, village: 0.12 },
  density: { core: 150, middle: 130, edge: 110, faubourg: 55, village: 35 },
};

export const MORPHOLOGIES: Record<MorphologyId, MorphologyParams> = { 'european-organic': EO, bastide: BASTIDE };

export const MORPHOLOGY_IDS = Object.keys(MORPHOLOGIES) as MorphologyId[];

/** Linear blend of numeric parameters (discrete choices from the dominant side) — used by culture mixing later. */
export function blendParams(a: MorphologyParams, b: MorphologyParams, t: number): MorphologyParams {
  const mix = (x: unknown, y: unknown): unknown => {
    if (typeof x === 'number' && typeof y === 'number') return x + (y - x) * t;
    if (Array.isArray(x) && Array.isArray(y)) return x.map((v, i) => mix(v, y[i]));
    if (x && y && typeof x === 'object' && typeof y === 'object') {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(x)) o[k] = mix((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k]);
      return o;
    }
    return t < 0.5 ? x : y;
  };
  return mix(a, b) as MorphologyParams;
}
