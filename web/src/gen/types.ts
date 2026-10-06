import type { Vec2, Polygon, Polyline } from './core/geom';
import type { Grid } from './core/grid';
import type { Options, SettlementOverrides } from './options';
import type { NamesLayer } from './names/types';

export type { Vec2, Polygon, Polyline, Grid, Options, NamesLayer };

export type RiverClass = 'brook' | 'stream' | 'river' | 'major';
export interface River {
  path: Polyline; width: number[]; name?: string; main?: boolean;
  /** Stable id (main = 0); `host` = id of the river this one flows into (mouth 'river'). */
  id?: number; host?: number;
  /** Class from the widest point. Only brooks may have a source inside the map. */
  cls?: RiverClass;
  /** Contributing area per vertex (virtual m2, incl. the catchment outside the map) and its external part. */
  area?: number[]; ext?: number[];
  /** Fed from a map edge with an external catchment (or through a lake / tributary that is). */
  edgeFed?: boolean;
  w0?: number;
  source?: 'edge' | 'spring' | 'lake';
  mouth?: 'river' | 'sea' | 'lake' | 'edge';
  /** Lake component ids (internal): outlet source lake / lake the river ends in. */
  lakeId?: number; endLake?: number;
}

export interface CavernLayer {
  /** Display-only cavern envelope around the unchanged normal Underdark layout. */
  floor: PolyH[];
  /** Map rectangle minus floor: impermeable rock, not water. */
  solid: PolyH[];
  /** Small cultivated fungal cavities, connected to the gallery network. Cave mode only. */
  fungalRooms?: PolyH[];
  mask: Uint8Array;
  /** Approximate distance to the displayed solid rock in meters. */
  clearance: Float32Array;
  /** Kept empty: rooms follow real settlement footprints rather than a radial room template. */
  chambers: { center: Vec2; radius: number }[];
}

export interface TerrainLayer {
  caverns?: CavernLayer;
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
  /** Dry islands inside sea polygons, independent of ring winding. Absent when none. */
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
  /** 1 on river cells wider than a brook (need a bridge; brooks may be forded). */
  wide?: Uint8Array;
}

import type { SiteArchetype } from './options';
export type { SiteArchetype };

export interface SiteLayer {
  center: Vec2; crossing?: Vec2; harbor?: Vec2; citadelSpot?: Vec2;
  /** Requested centre could not be used exactly (shown with settlement warnings). */
  warning?: string;
  /** Historical site type the core was placed in, and the feature point that justifies it (bridge point, harbor, confluence...). */
  archetype: SiteArchetype;
  feature?: Vec2;
  /** Quality (0..1) of the best site of each archetype the terrain offers (absent = not available). */
  offers: Partial<Record<SiteArchetype, number>>;
  /** Travel cost (m-equivalents) from the center; Infinity where unreachable. */
  cost: Grid;
  /** Approximate radius (m) of the urban footprint reserved for the town (M3). */
  reserveRadius: number;
  fields: SiteFields;
}

export type LandKind = 'field' | 'meadow' | 'pasture' | 'forest' | 'orchard' | 'garden' | 'marsh' | 'commons';
export interface LandArea {
  kind: LandKind; poly: Polygon; holes?: Polygon[];
  /** Underdark cultivation beds; absent on surface maps and uncultivated cover. */
  cultivation?: 'fungal';
  /** Furlongs (kind 'field'): strip direction in radians and the strips themselves. */
  stripAngle?: number; strips?: Polygon[];
}
export type RoofKind = 'gable' | 'hip' | 'flat' | 'dome' | 'pyramidal' | 'pagoda' | 'thatch-round' | 'none' | 'tiled-hip' | 'conical' | 'barrel' | 'terraced';
export type FarmSize = 'cottage' | 'family' | 'large' | 'manor';
/** One farm building with its architecture metadata (`use`: house, barn, byre, stable, shed, dovecote, gatehouse, ...). */
export interface FarmBuilding {
  poly: Polygon; use: string; arch: string; roof: RoofKind; storeys?: number; material?: string;
  /** Gatehouse with a carriage passage (the way into the yard runs through it). */
  passage?: boolean;
}
/** Piece of a farm lot: farmyard / garden / orchard / paddock partition the lot; ponds, pens, threshing floors and the raised platform lie inside it. */
export interface FarmPlot { kind: 'farmyard' | 'garden' | 'orchard' | 'paddock' | 'pond' | 'pen' | 'threshing-floor' | 'platform'; poly: Polygon }
export interface Farmstead {
  /** Centre of the lot. */
  pos: Vec2; angle: number;
  /** Building footprints (same order as `parts`). */
  buildings: Polygon[]; yard: Polygon; drive: Polyline;
  // ---- farmstead variety (landuse/farms.ts)
  /** Farm type (vierkanthof, longere, einhaus, l-yard, u-yard, haufenhof, masseria, norse-longhouse, minka, ...). */
  type?: string; size?: FarmSize; culture?: string;
  /** The farm lot: a rectangle on its track, partitioned by the farmyard / garden / orchard / paddock plots. */
  lot?: Polygon;
  parts?: FarmBuilding[];
  plots?: FarmPlot[];
  /** Yard walls, enclosure banks and fences (open polylines; the gap is the gate). */
  walls?: Polyline[];
  /** Orchard and shelter-belt trees. */
  trees?: Vec2[];
  /** Gate on the lot front (end of the drive) and a point inside the yard. */
  gate?: Vec2; entry?: Vec2;
  /** Site context tags: slope, wet, exposed, bank-barn, warft. */
  tags?: string[];
  /** Underdark farm production, independent of the chosen surface language family. */
  cultivation?: 'fungal';
}
export interface LandUseLayer {
  areas: LandArea[];
  farmsteads: Farmstead[];
  /** Outline(s) of the urban reserve (kept free of rural land use). */
  reserve: Polygon[];
  /** Permission generated with these areas; late settlement detail must not invent uncovered render patches. */
  naturalGround?: PolyH[];
  /** Opaque landscape under ordinary blocks and informal hut lots, with paving and water excluded. */
  landscapeGround?: PolyH[];
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
  /** A proved pedestrian entrance inside a private plot, rendered as an alley. */
  private?: boolean;
}
export type UrbanStreetTailKind = 'regionalContinuation' | 'urbanJunction' | 'servedDeadEnd' | 'fieldOrFarmAccess' | 'physicalBarrier' | 'unservedOpenEdge';
/** A classification of one physical street end; distances are metres along its original path. */
export interface UrbanStreetTail {
  street: number;
  end: 'start' | 'end';
  kind: UrbanStreetTailKind;
  point: Vec2;
  /** Last path distance required by an occupied parcel frontage or site entrance, from this end. */
  servedFromEnd: number;
  /** Visible public surface beyond the last service; zero for protected continuations. */
  excess: number;
}
export interface UrbanBlockInfo {
  quarter: number; phase: number; zone: UrbanZone; kind: 'block' | 'place' | 'market' | 'church' | 'green' | 'compound' | 'shanty';
  /** Compound lots: the landmark kind (mosque, temple, castle, yamen, …). */
  compound?: string;
  /** Culture that built the block (mixed plans). */
  culture?: string;
  /** Morphology id of the block. */
  morphology?: string;
}
/** Plan lines that are not streets: ward walls, moats, compound walls, terrace retaining walls, cliff faces, hedges. */
export interface UrbanLine { kind: string; path: Polyline; closed?: boolean; width?: number }
/** Tree canopies drawn over the town (elven). */
export interface UrbanTree { x: number; y: number; r: number }
export type ParcelUse = 'plot' | 'garden' | 'place' | 'market' | 'church' | 'green' | 'farm';
export interface UrbanParcel {
  poly: Polygon; use: ParcelUse | string; block: number;
  /** Street frontage segment (for plots). */
  front?: [Vec2, Vec2];
  zone?: UrbanZone;
}
export interface UrbanBuilding {
  poly: Polygon; kind: string; height?: number; parcel?: number;
  // ---- architecture metadata (M3b; drives later rendering / 3D)
  /** Typology id (gabled-row-house, courtyard-house, siheyuan-hall, machiya, longhouse, …). */
  arch?: string;
  roof?: 'gable' | 'hip' | 'flat' | 'dome' | 'pyramidal' | 'pagoda' | 'thatch-round' | 'none' | 'tiled-hip' | 'conical' | 'barrel' | 'terraced';
  storeys?: number;
  material?: string;
  /** Inner courtyards of the building (inside its footprint envelope, not part of `poly`). */
  courtyards?: Polygon[];
  /** Main facade / ridge orientation (radians). */
  orientation?: number;
}
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
  /** What the wall encloses (M4): the town (default), a later outer enclosure, a castle curtain, a walled quarter. */
  role?: 'town' | 'outer' | 'castle' | 'quarter';
}
/**
 * A landmark site (M4): the lot claimed in the partition, its entrance on the street network and a name hook.
 * `name` is left empty by the generator unless the names stage fills it (users may plug their own generator).
 */
export interface UrbanSite {
  id: string;
  /** Landmark kind (castle, cathedral-close, monastery, port, watermill, shanty, ...). */
  kind: string;
  role: 'power' | 'worship' | 'market' | 'civic' | 'port' | 'activity' | 'suburb' | 'shanty';
  /** The lot (or region) claimed in the partition. */
  lot: Polygon;
  /** Entrance on the street network (gate, west door, quay head...). */
  entrance?: Vec2;
  /** Label anchor. */
  anchor: Vec2;
  culture?: string;
  name?: string;
  /** Free-form tags for name generators (order, dedication, trade...). */
  tags?: Record<string, string>;
}
export interface UrbanPhase { id: number; kind: 'core' | 'ring' | 'faubourg' | 'village'; zone: UrbanZone; region: PolyH[]; walled: boolean; fossil: boolean }
export interface UrbanQuarter { poly: PolyH; phase: number; zone: UrbanZone; streetSpace: PolyH[] }

export interface UrbanLayer {
  footprint: Polygon[];
  streets: UrbanStreet[];
  /** Network diagnosis in world coordinates, independent of rural land use and rendering order. */
  openTails?: UrbanStreetTail[];
  /** Exact public street space permitted to take the surrounding landscape material. */
  openEdgeGround?: PolyH[];
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
  /** Unbuilt defensive land (moats and berms), excluded from rural lots separately from the urban footprint. */
  ruralReserve?: PolyH[];
  // ---- culture (M3b), additive
  /** Culture preset id, the cultures present (mixes) and render hints. */
  culture?: string;
  cultures?: string[];
  renderHints?: { towerShape: 'round' | 'square'; compoundWalls?: boolean; wardWalls?: boolean; canopy?: boolean; terraces?: boolean; moat?: boolean; plotLines?: boolean; storeyShade?: boolean; graves?: boolean; stairs?: boolean; lagoon?: boolean; bazaarRoof?: boolean; qanats?: boolean; locks?: boolean; stilts?: boolean; openGround?: boolean; primitive?: boolean; carvedDoors?: boolean };
  lines?: UrbanLine[];
  trees?: UrbanTree[];
  /** Water pieces of the plan (moats, tanks, ponds) — parcels of use 'moat' / 'tank' are also listed here. */
  water?: PolyH[];
  /** Defensive ditch water, also included in water; retained separately from ponds and mill races. */
  moats?: PolyH[];
  // ---- landmarks, activities, port, suburbs (M4), additive
  sites?: UrbanSite[];
  /** Stone quay edges (straight segments on the shoreline). */
  quays?: Polyline[];
  // ---- megacity scaling (URBAN_MORPHOLOGY §3d), additive: present only above the eager threshold
  /** Macro plan: arterial graph and quarters whose detail is generated lazily (`megaQuarterDetail`). */
  macro?: import('./urban/mega/types').MacroPlan;
  /** Built-up fraction raster of the macro plan (far-zoom density tint before / without the detail). */
  densityGrid?: { cell: number; w: number; cov: Float32Array; max: number };
}

import type { SettlementClass } from './options';
export type { SettlementClass };
/**
 * One settlement of the map's settlement system (M3c). The main settlement (index 0) is `world.site` + `world.urban`;
 * secondary ones carry their own urban layer, generated eagerly or (big maps) lazily on demand.
 */
export interface Settlement {
  /** Stable key: the rng stream is `fork('settlement:' + key)`. 'main' for the main settlement. */
  key: string;
  index: number;
  main?: boolean;
  cls: SettlementClass;
  population: number;
  culture: string;
  /** Explicit controls retained for eager, lazy and macro-quarter generation. */
  options?: SettlementOverrides;
  center: Vec2;
  archetype: SiteArchetype;
  /** Projected radius of the built extent (m) and its outline (disc clipped to the region). */
  radius: number;
  extent: Polygon;
  /** Region the settlement may occupy: the Voronoi cell of its site, clipped to the map. */
  region: Polygon;
  /** Explicitly positioned (list mode). */
  fixed?: boolean;
  name?: string;
  /** 'eager' urban generated with the map, 'lazy' generated on demand (viewport), 'farmstead' drawn by land use. */
  detail: 'main' | 'eager' | 'lazy' | 'farmstead';
  urban?: UrbanLayer;
  /** Crossing / harbor points used by its plan. */
  crossing?: Vec2; harbor?: Vec2;
}

export interface World {
  seed: string;
  /** Deterministic identity of the generation inputs in an opt-in workflow. */
  uid?: string;
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
  /** Settlement system (M3c): index 0 = the main settlement. */
  settlements?: Settlement[];
  /** Megacity: the quarters whose detail has been generated (by macro quarter id), merged by `renderView`. */
  megaDetail?: Record<number, UrbanLayer>;
  /** Stage-internal data for debug rendering (not part of the contract). */
  debug?: Record<string, unknown>;
  stats: Record<string, number | string>;
}
