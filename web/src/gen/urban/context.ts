/** Shared context of the urban stage: world access, water polygons, buildable land, sampling. */
import type { Vec2, Polygon } from '../core/geom';
import { sampleGrid } from '../core/grid';
import type { World, SiteLayer, TerrainLayer } from '../types';
import type { MorphologyParams } from './morphology';
import { MultiPoly, unionMany } from '../geo/bool';
import { ribbon } from '../geo/offset';
import { pointInRing, orientPos } from '../geo/poly';

const WATER_CACHE = new WeakMap<TerrainLayer, MultiPoly>();

export interface UrbanCtx {
  world: World;
  terrain: TerrainLayer;
  site: SiteLayer;
  params: MorphologyParams;
  mapSize: number;
  center: Vec2;
  /** Square window (x0, y0, size) where the town may grow. */
  win: { x0: number; y0: number; x1: number; y1: number };
  water: MultiPoly;
  cell: number;
  n: number;
  isWater: (p: Vec2) => boolean;
  slopeAt: (p: Vec2) => number;
  heightAt: (p: Vec2) => number;
  costAt: (p: Vec2) => number;
}

function waterOf(terrain: TerrainLayer): MultiPoly {
  const cached = WATER_CACHE.get(terrain);
  if (cached) return cached;
  // Camps can have satellites beyond win, and macro faces can extend past it. Water must cover the whole map;
  // clipping centreline vertices to win also omitted segments crossing it with both ends outside.
  const parts: (Polygon | MultiPoly)[] = [];
  for (const rv of terrain.rivers) {
    const rb = ribbon(rv.path, rv.width.map((width) => Math.max(2.5, width) + 2));
    if (rb.length >= 3) parts.push(rb);
  }
  for (const lk of terrain.lakes) if (lk.length >= 3) parts.push(lk);
  const sea: MultiPoly = terrain.coastline.filter((p) => p.length >= 3).map((outer) => ({
    outer, holes: (terrain.islands ?? []).filter((island) => island.length >= 3 && pointInRing(outer, island[0])),
  }));
  if (sea.length) parts.push(sea);
  // unionMany can return a lone operand verbatim. Copy first so freezing the shared cache never freezes terrain.
  const water: MultiPoly = (parts.length ? unionMany(parts, 24, true) : []).map((ph) => ({
    outer: orientPos(ph.outer.map((p) => ({ ...p }))), holes: ph.holes.map((ring) => orientPos(ring.map((p) => ({ ...p })))),
  }));
  for (const ph of water) {
    for (const ring of [ph.outer, ...ph.holes]) { for (const p of ring) Object.freeze(p); Object.freeze(ring); }
    Object.freeze(ph.holes); Object.freeze(ph);
  }
  Object.freeze(water);
  WATER_CACHE.set(terrain, water);
  return water;
}

export function makeCtx(world: World, params: MorphologyParams, radius: number): UrbanCtx {
  const terrain = world.terrain, site = world.site!;
  const S = world.mapSize;
  const c = site.center;
  const R = Math.min(S / 2, radius);
  const win = { x0: Math.max(0, c.x - R), y0: Math.max(0, c.y - R), x1: Math.min(S, c.x + R), y1: Math.min(S, c.y + R) };
  const water = waterOf(terrain);
  const g = terrain.height;
  const n = g.w, cell = g.cell;
  const idx = (p: Vec2) => Math.min(n - 1, Math.max(0, Math.floor(p.y / cell))) * n + Math.min(n - 1, Math.max(0, Math.floor(p.x / cell)));
  return {
    world, terrain, site, params, mapSize: S, center: c, win, water, cell, n,
    isWater: (p) => terrain.water[idx(p)] !== 0,
    slopeAt: (p) => sampleGrid(terrain.slope, p.x, p.y),
    heightAt: (p) => sampleGrid(terrain.height, p.x, p.y),
    costAt: (p) => site.cost.data[idx(p)],
  };
}
