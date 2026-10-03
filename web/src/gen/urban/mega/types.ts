/**
 * Megacity macro plan (URBAN_MORPHOLOGY §3d): what is generated eagerly above the eager threshold. The plan is plain
 * data (structured-clone safe): the generation worker keeps it in the World and builds the detail of one quarter
 * from it on demand (`megaQuarterDetail`), with the stream `fork('quarter:' + id)`.
 */
import type { Vec2, Polygon, Polyline } from '../../core/geom';
import type { UrbanZone, StreetRole } from '../../types';

/** One street of the arterial graph (its index is its id: quarter edge labels refer to it). */
export interface MacroStreet { path: Polyline; widths: number[]; rank: number; role: StreetRole; phase: number }

/** A nucleus of the polycentric plan: the main core, a fused satellite town, an absorbed village. */
export interface MacroNucleus {
  p: Vec2; kind: 'main' | 'town' | 'village'; r: number; name?: string;
  /** A fused satellite town keeps its own line: a ring boulevard or (walled) a standing wall. */
  ring?: Polygon; walled?: boolean;
}

/** A landmark the quarter detail claims on its best piece (city-rank lots are whole quarters instead). */
export interface MacroWant { kind: string; place: 'near-nucleus' | 'any' | 'edge'; area: [number, number]; data?: unknown }

export type MacroDistrict = 'market' | 'old-town' | 'town' | 'suburb' | 'village' | 'satellite' | 'port' | 'palace' | 'cathedral' | 'craft' | 'gardens';

export interface MacroQuarter {
  /** Stable id (index in the plan). */
  id: number;
  /** Quarter polygon (CCW) and the label of each edge i → i+1 (street id ≥ 0, or LAB_OPEN / LAB_WALL / LAB_WATER). */
  pts: Polygon;
  lab: number[];
  phase: number;
  zone: UrbanZone;
  age: number;
  kind: 'quarter' | 'market' | 'lot' | 'place';
  /** Index into MacroPlan.morphs. */
  morph: number;
  culture: string;
  /** Inhabitants per hectare and the estimated population. */
  density: number;
  pop: number;
  district: MacroDistrict;
  /** Index into MacroPlan.nuclei: the street pattern is oriented on it. */
  nucleus: number;
  /** Compound builder for a lot quarter (palace city, cathedral close) and its data. */
  compound?: string;
  data?: unknown;
  wants: MacroWant[];
  /** Area (m²), box [x0, y0, x1, y1] and the stand-in block drawn until the detail exists. */
  area: number;
  bb: [number, number, number, number];
  inset: Polygon;
}

export interface MacroPlan {
  version: 1;
  /** Seed key of the macro stream (the detail of quarter k uses `new Rng(seedKey).fork('quarter:' + k)`). */
  seedKey: string;
  eagerPop: number;
  population: number;
  center: Vec2;
  mainAngle: number;
  terrainAngle: number;
  waterAngle: number;
  /** Radius of the built-up area (m), and of the urban context window (water, terrain access). */
  cityR: number;
  ctxRadius: number;
  /** Compound claimed on the main market piece (the culture's nucleus: great mosque, temple...), if any. */
  nucleusCompound?: string;
  streets: MacroStreet[];
  quarters: MacroQuarter[];
  nuclei: MacroNucleus[];
  /** Resolved morphologies (MorphologyParams), referenced by index. */
  morphs: unknown[];
  /** Standing wall lines (closed rings) — the quarters' LAB_WALL edges lie on them. */
  wallRings: Polygon[];
  /** Ring lines of the growth phases (oldest first) and the outer limit of the built-up area. */
  rings: Polygon[];
}
