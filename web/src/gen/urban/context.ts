/** Shared context of the urban stage: world access, water polygons, buildable land, sampling. */
import type { Vec2, Polygon, Polyline } from '../core/geom';
import { dist } from '../core/geom';
import { sampleGrid } from '../core/grid';
import type { World, SiteLayer, TerrainLayer } from '../types';
import type { MorphologyParams } from './morphology';
import { MultiPoly, union, intersection, unionMany } from '../geo/bool';
import { ribbon } from '../geo/offset';
import { cleanRing, orientPos } from '../geo/poly';
import { simplify } from '../core/geom';

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

const square = (x0: number, y0: number, x1: number, y1: number): Polygon => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

/** Clips a polyline to a box, returning the pieces (keeps a margin of one vertex outside). */
function clipPolylineBox(pl: Polyline, b: { x0: number; y0: number; x1: number; y1: number }): Polyline[] {
  const inside = (p: Vec2) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;
  const out: Polyline[] = [];
  let cur: Polyline = [];
  for (let i = 0; i < pl.length; i++) {
    const inI = inside(pl[i]) || (i > 0 && inside(pl[i - 1])) || (i < pl.length - 1 && inside(pl[i + 1]));
    if (inI) cur.push(pl[i]);
    else if (cur.length) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out.filter((c) => c.length >= 2);
}

export function makeCtx(world: World, params: MorphologyParams, radius: number): UrbanCtx {
  const terrain = world.terrain, site = world.site!;
  const S = world.mapSize;
  const c = site.center;
  const R = Math.min(S / 2, radius);
  const win = { x0: Math.max(0, c.x - R), y0: Math.max(0, c.y - R), x1: Math.min(S, c.x + R), y1: Math.min(S, c.y + R) };
  const box = square(win.x0 - 20, win.y0 - 20, win.x1 + 20, win.y1 + 20);
  // water: river ribbons (+1 m bank margin each side), lakes, sea
  const parts: Polygon[] = [];
  for (const rv of terrain.rivers) {
    for (const piece of clipPolylineBox(rv.path, { x0: win.x0 - 40, y0: win.y0 - 40, x1: win.x1 + 40, y1: win.y1 + 40 })) {
      // widths: map piece vertices back to the nearest original index
      const widths = piece.map((p) => {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < rv.path.length; i++) { const d = dist(rv.path[i], p); if (d < bd) { bd = d; bi = i; } }
        return Math.max(2.5, rv.width[bi]) + 2;
      });
      const simp = piece.length > 3 ? piece : piece;
      const rb = ribbon(simp, widths);
      if (rb.length >= 3) parts.push(rb);
    }
  }
  for (const lk of terrain.lakes) { const r = cleanRing(simplify(lk.concat([lk[0]]), 0.5).slice(0, -1)); if (r.length >= 3) parts.push(orientPos(r)); }
  for (const co of terrain.coastline) { const r = cleanRing(simplify(co.concat([co[0]]), 0.5).slice(0, -1)); if (r.length >= 3) parts.push(orientPos(r)); }
  let water: MultiPoly = [];
  if (parts.length) {
    const u = unionMany(parts);
    water = intersection(u, box);
    water = union(water);
  }
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
