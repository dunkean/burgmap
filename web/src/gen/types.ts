import type { Vec2, Polygon, Polyline } from './core/geom';
import type { Grid } from './core/grid';
import type { Options } from './options';

export type { Vec2, Polygon, Polyline, Grid, Options };

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

export interface World {
  seed: string;
  options: Options;
  mapSize: number;
  terrain: TerrainLayer;
  // later stages
  site?: SiteLayer;
  roads?: { path: Polyline; kind: 'major' | 'minor' | 'track'; width: number }[];
  bridges?: { a: Vec2; b: Vec2; width: number }[];
  urban?: {
    footprint: Polygon[];
    streets: { path: Polyline; width: number; kind: 'main' | 'street' | 'alley' }[];
    blocks: Polygon[];
    parcels: { poly: Polygon; use: string }[];
    buildings: { poly: Polygon; kind: string; height?: number }[];
    walls?: { path: Polyline; closed: boolean; towers: Vec2[]; gates: Vec2[]; thickness: number }[];
    landmarks: { kind: string; poly: Polygon; name?: string }[];
    squares: Polygon[];
  };
  landuse?: LandUseLayer;
  stats: Record<string, number | string>;
}
