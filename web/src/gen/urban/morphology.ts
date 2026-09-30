/**
 * Morphology parameters (URBAN_GEOMETRY.md §7, URBAN_MORPHOLOGY.md §2). A morphology is plain data: the
 * street operators read `field`/`curvature`/…, the plot operator reads `frontage`/`plotDepth`/…, the building
 * operator reads `buildDepth`/`infill`/…. Culture presets turn these dials; later presets (medina, chinese…)
 * plug in by adding data plus operators keyed by `streetOp` / `plotOp` / `buildingOp`.
 */

export type MorphologyId = string;
/** Zones drive plot sizes and the burgage cycle: core (oldest phase), middle, edge (youngest), faubourg, village. */
export type Zone = 'core' | 'middle' | 'edge' | 'faubourg' | 'village';
export type Range = [number, number];

/** Street operators (URBAN_MORPHOLOGY.md §2). Level 1 ops shape the primary network, level 2 ops split quarters. */
export type StreetOpId =
  | 'radials' | 'rings' | 'organicInfill' | 'grid' | 'axis' | 'gateToGate' | 'culDeSacTree' | 'closes'
  | 'wardWalls' | 'defensiveKinks' | 'ribbon' | 'spiral' | 'switchbacks' | 'extraRadials';
export type PlotOpId = 'burgage' | 'courtyard' | 'siheyuan' | 'machiya' | 'compound' | 'garden';
export type BuildingOpId = 'streetFrontRow' | 'courtyardHouse' | 'pavilionCompound' | 'yashiki' | 'machiya' | 'detached' | 'treeHouse' | 'hall' | 'longhouse';
export type RoofKind = 'gable' | 'hip' | 'flat' | 'dome' | 'pyramidal' | 'pagoda' | 'thatch-round' | 'none' | 'tiled-hip';
export type Material = 'timber' | 'stone' | 'brick' | 'mud' | 'wood' | 'paper-wood' | 'living-wood' | 'rock';
/** Architecture of a building type (metadata for later rendering / 3D). */
export interface ArchSpec { typology: string; roof: RoofKind; storeys: Range; material: Material }

export interface MorphologyParams {
  id: MorphologyId;
  /** Street operators in order (documentation + the level-1/level-3 ops that are run). */
  streets: StreetOpId[];
  /** Level-2 street operator: organic cross-field splitting, or a (skewed) lattice. */
  streetOp: 'organic' | 'grid';
  /** Dead ends: occasional closes (Europe), a tree of derbs (medina), none. */
  closeOp: 'closes' | 'culDeSacTree' | 'none';
  plotOp: PlotOpId;
  buildingOp: BuildingOpId;
  /** Lattice orientation: along the main road, or true north. */
  orientation: 'road' | 'cardinal' | 'terrain';
  /** Second lattice (lanes inside wards, e.g. hutongs) spacing per family (0 = none) … */
  laneSpacing: [number, number];
  /** … used below this piece area (m²); larger pieces use the coarse lattice (ward streets). */
  wardArea: number;
  /** gateToGate: lateral wiggle amplitude (m) of the spines. */
  spineAmp: number;
  /** defensiveKinks: crank jogs per radial (masugata, kagi). */
  kinks: number;
  /** Courtyard / compound lots: area range per zone (m²); room depth of courtyard houses (m). */
  houseArea: Record<Zone, Range>;
  roomDepth: Range;
  /** culDeSacTree: no point of a block farther than this from a street or a dead end (m). */
  accessDepth: number;
  /** Twist (radians) added to the radial/tangential field: spiral streets. */
  fieldTwist: number;
  /** Synthetic radials in wide angular gaps. */
  extraRadials: boolean;
  /** rings(square): concentric streets offset from the nucleus every `ringSpacing` m (0 = none). */
  ringSpacing: number;
  /** Regional roads stop at the gates (the interior is served by the town's own streets). */
  gatesOnly?: boolean;
  /** Architecture of the ordinary buildings. */
  arch: ArchSpec;
  /**
   * Growth dials of the phase field: attraction of roads and of the waterfront (fractional cost reduction), low-
   * frequency noise amplitude and wavelength (m), elongation along the main road (0–1), repulsion of wet low ground,
   * and the chance of a second nucleus (bipolar town).
   */
  growth: { road: number; water: number; noise: number; wavelength: number; elongation: number; wet: number; bipolar?: number };
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
  /** Built share of the block per zone (burgage cycle): oldest phase ≈ 0.9, faubourgs ≈ 0.45. */
  coverage: Record<Zone, Range>;
  /** Chance that a wide plot of a dense zone holds a large courtyard building (inn, hall, hôtel). */
  bigCourtChance: number;
  /**
   * Footprint conformity per zone: 1 = footprints take the plot's shape within their depth band (trapezoids where
   * plots fan, skewed quads, polygonal corners); 0 = orthogonal rectangles inside the plot.
   */
  footprintConformity: Record<Zone, number>;
  /** Probability that the irregular corner left beside an orthogonal footprint is built too. */
  cornerFill: Record<Zone, number>;
  /** Weight of a random low-frequency orientation field blended into the radial/tangential cross-field. */
  fieldRandom: number;
  /** Fossilized ring streets are broken into partial arcs: gaps per km of ring. */
  ringGaps: number;
  /** Relative jitter of the phase population shares (ring spacing varies from town to town). */
  shareJitter: number;
  courtyardMin: number;
  /** Gross densities (inhabitants per ha) per zone, used to size phase regions. */
  density: Record<Zone, number>;
}

const EO: MorphologyParams = {
  id: 'european-organic',
  streets: ['radials', 'extraRadials', 'rings', 'organicInfill', 'closes'],
  streetOp: 'organic',
  closeOp: 'closes',
  plotOp: 'burgage',
  buildingOp: 'streetFrontRow',
  orientation: 'road',
  laneSpacing: [0, 0],
  wardArea: 0,
  spineAmp: 0,
  kinks: 0,
  houseArea: { core: [120, 400], middle: [150, 500], edge: [200, 700], faubourg: [250, 800], village: [600, 2000] },
  roomDepth: [4.5, 6],
  accessDepth: 30,
  fieldTwist: 0,
  extraRadials: true,
  ringSpacing: 0,
  arch: { typology: 'gabled-row-house', roof: 'gable', storeys: [2, 4], material: 'timber' },
  growth: { road: 0.3, water: 0.18, noise: 0.26, wavelength: 300, elongation: 0.25, wet: 0.5, bipolar: 0.3 },
  curvature: 0.55,
  fieldNoise: 17,
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
  frontage: { core: [5, 8], middle: [6, 10], edge: [8, 14], faubourg: [7, 13], village: [18, 40] },
  plotDepth: { core: [24, 42], middle: [30, 50], edge: [35, 65], faubourg: [30, 60], village: [40, 80] },
  plotTilt: 6,
  wideLotChance: 0.08,
  buildDepth: { core: [10, 14], middle: [9, 13], edge: [8, 12], faubourg: [8, 12], village: [8, 12] },
  setback: { core: [0, 0.3], middle: [0, 0.8], edge: [0.5, 3], faubourg: [0.5, 3], village: [3, 10] },
  sideGap: { core: [0, 0], middle: [0, 1.2], edge: [0.5, 2.5], faubourg: [0.8, 3], village: [3, 8] },
  infill: { core: 0.92, middle: 0.62, edge: 0.38, faubourg: 0.3, village: 0.12 },
  coverage: { core: [0.86, 0.94], middle: [0.77, 0.86], edge: [0.53, 0.67], faubourg: [0.5, 0.62], village: [0.12, 0.3] },
  bigCourtChance: 0.3,
  footprintConformity: { core: 0.92, middle: 0.75, edge: 0.6, faubourg: 0.4, village: 0.3 },
  ringGaps: 2.2,
  fieldRandom: 0.45,
  shareJitter: 0.22,
  cornerFill: { core: 0.6, middle: 0.35, edge: 0.2, faubourg: 0.1, village: 0 },
  courtyardMin: 9,
  density: { core: 185, middle: 120, edge: 85, faubourg: 55, village: 35 },
};

const BASTIDE: MorphologyParams = {
  ...EO,
  id: 'bastide',
  streets: ['radials', 'grid', 'closes'],
  streetOp: 'grid',
  extraRadials: false,
  arch: { typology: 'arcaded-row-house', roof: 'gable', storeys: [2, 3], material: 'stone' },
  growth: { road: 0.1, water: 0.05, noise: 0.14, wavelength: 380, elongation: 0, wet: 0.5, bipolar: 0 },
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
  coverage: { core: [0.85, 0.92], middle: [0.72, 0.83], edge: [0.55, 0.68], faubourg: [0.38, 0.52], village: [0.12, 0.3] },
  footprintConformity: { core: 0.3, middle: 0.3, edge: 0.3, faubourg: 0.3, village: 0.2 },
  cornerFill: { core: 0.5, middle: 0.3, edge: 0.2, faubourg: 0.1, village: 0 },
  density: { core: 150, middle: 130, edge: 110, faubourg: 55, village: 35 },
};

export const MORPHOLOGIES: Record<string, MorphologyParams> = { 'european-organic': EO, bastide: BASTIDE };

export { EO as EO_BASE };

type Plain = Record<string, unknown>;
const isObj = (v: unknown): v is Plain => !!v && typeof v === 'object' && !Array.isArray(v);
/** Deep merge of plain data (arrays and scalars replaced, nested records merged key by key). */
export function deepMerge<T>(base: T, over: unknown): T {
  if (!isObj(over)) return base;
  const out: Plain = { ...(base as Plain) };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  return out as T;
}

/** A morphology reference: a registered id, or `{ base: id, ...overrides }` (plain data). */
export type MorphRef = string | ({ base: string } & Record<string, unknown>);

export function resolveMorph(ref: MorphRef | undefined, fallback = 'european-organic'): MorphologyParams {
  if (!ref) return MORPHOLOGIES[fallback];
  if (typeof ref === 'string') return MORPHOLOGIES[ref] ?? MORPHOLOGIES[fallback];
  const { base, ...rest } = ref;
  const b = MORPHOLOGIES[base] ?? MORPHOLOGIES[fallback];
  return deepMerge(b, { ...rest, id: typeof rest.id === 'string' ? rest.id : b.id + '*' });
}

/** Linear blend of numeric parameters; discrete choices (operators, typologies) from the dominant side. */
export function blendParams(a: MorphologyParams, b: MorphologyParams, t: number): MorphologyParams {
  const mix = (x: unknown, y: unknown): unknown => {
    if (typeof x === 'number' && typeof y === 'number') return x + (y - x) * t;
    if (Array.isArray(x) && Array.isArray(y) && x.every((v) => typeof v === 'number') && x.length === y.length) return x.map((v, i) => mix(v, y[i]));
    if (isObj(x) && isObj(y)) {
      const o: Plain = {};
      for (const k of Object.keys(x)) o[k] = k in y ? mix(x[k], y[k]) : x[k];
      return o;
    }
    return t < 0.5 ? x : y;
  };
  const r = mix(a, b) as MorphologyParams;
  r.id = t < 0.5 ? a.id : b.id;
  return r;
}
