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

export interface World {
  seed: string;
  options: Options;
  mapSize: number;
  terrain: TerrainLayer;
  // later stages
  site?: { center: Vec2; crossing?: Vec2; harbor?: Vec2; citadelSpot?: Vec2; cost: Grid };
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
  landuse?: {
    areas: { kind: 'field' | 'meadow' | 'pasture' | 'forest' | 'orchard' | 'garden' | 'marsh' | 'commons'; poly: Polygon; stripAngle?: number }[];
  };
  stats: Record<string, number | string>;
}
