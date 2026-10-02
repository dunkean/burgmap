/**
 * Generic siting of a level-1 landmark lot: candidate (centre, orientation, scale) triples are tested against the
 * hard rules (inside / outside a region, dry, clear of the registered streets and of the other lots, separation)
 * and ranked by the landmark's score function (URBAN_LANDMARKS.md §1: distance to the nucleus, height, slope,
 * water frontage, adjacency to arterials and gates, phase, separation). A coarse grid is searched first, then the
 * best candidates are refined locally. Regions are tested on raster masks (O(1) per sample).
 */
import type { Vec2, Polygon } from '../../core/geom';
import { dist, polygonCentroid } from '../../core/geom';
import type { Rng } from '../../core/rng';
import type { MultiPoly } from '../../geo/bool';
import type { UrbanCtx } from '../context';
import type { Streets } from '../streets';
import { bboxOf } from '../../geo/poly';
import { rasterizePolys } from '../../geo/raster';
import { samplePoly, clearOfStreets, polysNear } from './lots';

/** Raster membership test of a region (cell `c` m). */
export class Mask {
  readonly n: number; readonly cell: number; readonly data: Uint8Array;
  constructor(size: number, m: MultiPoly, cell = 4) {
    this.cell = cell;
    this.n = Math.ceil(size / cell);
    this.data = rasterizePolys(m.flatMap((ph) => [ph.outer, ...ph.holes]), this.n, this.n, cell);
  }
  has(p: Vec2): boolean {
    const i = Math.floor(p.x / this.cell), j = Math.floor(p.y / this.cell);
    return i >= 0 && j >= 0 && i < this.n && j < this.n && this.data[j * this.n + i] === 1;
  }
}

export interface LotSpec {
  shape: (c: Vec2, ang: number, k: number) => Polygon;
  centers: Vec2[];
  angles: number[];
  /** Scales tried in order (largest first); the first valid one is kept for each centre / angle. */
  scales: number[];
  /** All samples inside this region (if given). */
  within?: Mask;
  /** No sample inside this region (if given). */
  outside?: Mask;
  /** Clearance from the street ribbons (m). */
  margin: number;
  /** Streets ignored by the clearance test (e.g. the market ring a close may front). */
  ignore?: Set<number>;
  /** Other lots: kept at ≥ gap. */
  avoid: Polygon[];
  gap: number;
  /** Maximum share of samples in water. */
  wet?: number;
  /** Cheap rejection of a centre before any shape is built. */
  centerOk?: (c: Vec2) => boolean;
  score: (poly: Polygon, c: Vec2, ang: number, k: number) => number;
  /** Refinement step of the second pass (m); 0 = none. */
  refine?: number;
}

type Cand = { poly: Polygon; c: Vec2; ang: number; k: number; s: number };

export function siteLot(ctx: UrbanCtx, streets: Streets, spec: LotSpec, rng: Rng): Cand | null {
  const S = ctx.mapSize;
  const evalAt = (c: Vec2, ang: number): Cand | null => {
    if (ctx.isWater(c) || (spec.centerOk && !spec.centerOk(c))) return null;
    for (const k of spec.scales) {
      const poly = spec.shape(c, ang, k);
      const bb = bboxOf(poly);
      if (bb.x0 < 5 || bb.y0 < 5 || bb.x1 > S - 5 || bb.y1 > S - 5) continue;
      const smp = samplePoly(poly, 12);
      let ok = true, wet = 0;
      for (const p of smp) {
        if (spec.within && !spec.within.has(p)) { ok = false; break; }
        if (spec.outside && spec.outside.has(p)) { ok = false; break; }
        if (ctx.isWater(p)) wet++;
      }
      if (!ok || wet > (spec.wet ?? 0) * smp.length) continue;
      if (spec.avoid.some((a) => polysNear(poly, a, spec.gap))) continue;
      if (!clearOfStreets(poly, streets, spec.margin, spec.ignore)) continue;
      return { poly, c, ang, k, s: spec.score(poly, c, ang, k) + 0.05 * rng.float() };
    }
    return null;
  };
  const found: Cand[] = [];
  for (const c of spec.centers) for (const ang of spec.angles) { const r = evalAt(c, ang); if (r && r.s > -1e8) found.push(r); }
  if (!found.length) return null;
  found.sort((a, b) => b.s - a.s);
  let best = found[0];
  const st = spec.refine ?? 0;
  if (st > 0) for (const f of found.slice(0, 4)) {
    for (const [dx, dy] of [[st, 0], [-st, 0], [0, st], [0, -st], [st, st], [-st, -st], [st, -st], [-st, st]]) {
      for (const da of [0, 0.08, -0.08]) {
        const r = evalAt({ x: f.c.x + dx, y: f.c.y + dy }, f.ang + da);
        if (r && r.s > best.s) best = r;
      }
    }
  }
  return best;
}

/** Grid of candidate centres within radius R of c (step m), on land. */
export function gridAround(ctx: UrbanCtx, c: Vec2, R: number, step: number): Vec2[] {
  const out: Vec2[] = [];
  for (let y = c.y - R; y <= c.y + R; y += step) for (let x = c.x - R; x <= c.x + R; x += step) {
    const p = { x, y };
    if (dist(p, c) <= R && !ctx.isWater(p)) out.push(p);
  }
  return out;
}

export { polygonCentroid };
