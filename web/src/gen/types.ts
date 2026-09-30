import type { Vec2, Polygon, Polyline } from './core/geom';
import type { Grid } from './core/grid';
import type { Options } from './options';
import type { NamesLayer } from './names/types';

export type { Vec2, Polygon, Polyline, Grid, Options, NamesLayer };

export interface River { path: Polyline; width: number[]; name?: string; main?: boolean }

export interface TerrainLayer {
  height: Grid;
  slope: Grid;
  /** 0 land, 1 sea, 2 lake, 3 river */
  water: Uint8Array;
  /** Flow accumulation in cells (upstream area incl. own cell, plus injected river inflow). */
  flow: Grid;
  seaLevel: number;
  /** Fraction of the map covered by sea. */
  seaFraction: number;
  /** Closed sea polygons (may extend a couple of cells beyond the map border; clip when rendering). */
  coastline: Polygon[];
  /** Islands (land inside the sea): loops of orientation opposite to the main coastline loop. Absent when none. */
  islands?: Polygon[];
  lakes: Polygon[];
  rivers: River[];
  /** D8 receiver index per cell after depression filling (-1 = outlet). */
  receiver: Int32Array;
  /** Depression-filled surface. */
  filled: Float32Array;
  /** Hint for later stages: side where water leaves the map / sea lies. */
  downSide: 'N' | 'E' | 'S' | 'W';
  seaSide: 'N' | 'E' | 'S' | 'W' | null;
}

export interface SiteFields {
  /** Distance (m) to any water / sea / main river. */
  dWater: Float32Array; dSea: Float32Array; dMain: Float32Array;
  /** Height above the nearest water surface (m). */
  hab: Float32Array;
  /** Slope smoothed over ~100 m. */
  slopeS: Float32Array;
  /** 1 = main river cell, 2 = brook cell (0 elsewhere). */
  riverMask: Uint8Array;
  /** 1 on cells where the main river may be bridged (near the crossing). */
  bridgeZone: Uint8Array;
}

export interface SiteLayer {
  center: Vec2; crossing?: Vec2; harbor?: Vec2; citadelSpot?: Vec2;
  /** Travel cost (m-equivalents) from the center; Infinity where unreachable. */
  cost: Grid;
  /** Approximate radius (m) of the urban footprint reserved for the town (M3). */
  reserveRadius: number;
  fields: SiteFields;
}

export type LandKind = 'field' | 'meadow' | 'pasture' | 'forest' | 'orchard' | 'garden' | 'marsh' | 'commons';
export interface LandArea {
  kind: LandKind; poly: Polygon; holes?: Polygon[];
  /** Furlongs (kind 'field'): strip direction in radians and the strips themselves. */
  stripAngle?: number; strips?: Polygon[];
}
export interface Farmstead { pos: Vec2; angle: number; buildings: Polygon[]; yard: Polygon; drive: Polyline }
export interface LandUseLayer {
  areas: LandArea[];
  farmsteads: Farmstead[];
  /** Outline(s) of the urban reserve (kept free of rural land use). */
  reserve: Polygon[];
}

/** Polygon with holes (all rings positively oriented). */
export interface PolyH { outer: Polygon; holes: Polygon[] }

export type UrbanZone = 'core' | 'middle' | 'edge' | 'faubourg' | 'village';
export type StreetRole = 'radial' | 'ring' | 'street' | 'lane' | 'close' | 'quay' | 'wall-lane' | 'track' | 'boundary';
export type Archetype = 'hamlet' | 'street-village' | 'nucleated-village' | 'town';

export interface UrbanStreet {
  path: Polyline;
  /** Mean full width (m); per-vertex widths in `widths`. */
  width: number;
  widths?: number[];
  kind: 'main' | 'street' | 'alley';
  /** 0 arterial … 4 close (cul-de-sac). */
  rank: number;
  role: StreetRole;
  phase: number;
}
export interface UrbanBlockInfo { quarter: number; phase: number; zone: UrbanZone; kind: 'block' | 'place' | 'market' | 'church' | 'green' }
export type ParcelUse = 'plot' | 'garden' | 'place' | 'market' | 'church' | 'green' | 'farm';
export interface UrbanParcel {
  poly: Polygon; use: ParcelUse | string; block: number;
  /** Street frontage segment (for plots). */
  front?: [Vec2, Vec2];
  zone?: UrbanZone;
}
export interface UrbanBuilding { poly: Polygon; kind: string; height?: number; parcel?: number }
export interface UrbanWall {
  path: Polyline; closed: boolean; towers: Vec2[]; gates: Vec2[]; thickness: number;
  /** Gate openings: center, street direction (unit) and opening width. */
  gateInfo?: { p: Vec2; dir: Vec2; width: number }[];
  /** Wall stretches between the gate openings, and the towers flanking each gate. */
  pieces?: Polyline[];
  gateTowers?: Vec2[];
  /** Relative size of each tower in `towers` (corner towers are bigger). */
  towerScale?: number[];
  /** Straight curtains between consecutive towers (M3b: polygonal fortifications). */
  curtains?: [Vec2, Vec2][];
  /** Tower plan shape (culture / era dependent). */
  towerShape?: 'round' | 'square';
}
export interface UrbanPhase { id: number; kind: 'core' | 'ring' | 'faubourg' | 'village'; zone: UrbanZone; region: PolyH[]; walled: boolean; fossil: boolean }
export interface UrbanQuarter { poly: PolyH; phase: number; zone: UrbanZone; streetSpace: PolyH[] }

export interface UrbanLayer {
  footprint: Polygon[];
  streets: UrbanStreet[];
  blocks: Polygon[];
  parcels: UrbanParcel[];
  buildings: UrbanBuilding[];
  walls?: UrbanWall[];
  landmarks: { kind: string; poly: Polygon; name?: string }[];
  squares: Polygon[];
  // ---- extensions (M3)
  archetype: Archetype;
  population: number;
  morphology: string;
  phases: UrbanPhase[];
  quarters: UrbanQuarter[];
  blockInfo: UrbanBlockInfo[];
  /** Building masses unioned per block (courtyards as holes). */
  masses: PolyH[];
  /** Unbuilt back land (gardens, yards behind the plots). */
  backLand: PolyH[];
  /** Footprint with holes (exact), rural land use is excluded from it. */
  footprintH: PolyH[];
}

export interface World {
  seed: string;
  options: Options;
  mapSize: number;
  terrain: TerrainLayer;
  // later stages
  site?: SiteLayer;
  roads?: { path: Polyline; kind: 'major' | 'minor' | 'track'; width: number }[];
  bridges?: { a: Vec2; b: Vec2; width: number }[];
  urban?: UrbanLayer;
  landuse?: LandUseLayer;
  /** Toponyms with anchor geometry (M5a). */
  names?: NamesLayer;
  /** Stage-internal data for debug rendering (not part of the contract). */
  debug?: Record<string, unknown>;
  stats: Record<string, number | string>;
}
