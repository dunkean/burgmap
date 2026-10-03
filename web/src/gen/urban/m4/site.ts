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
import { forSamples, clearOfStreets, polysNear } from './lots';

/**
 * Raster membership test of a region (cell `c` m) on the map's lattice. Only the window of the region's box is
 * stored (a 40 km map would need 10^7+ cells per mask); the cells are the ones `rasterizePolys` would set on the
 * whole lattice.
 */
export class Mask {
  readonly n: number; readonly cell: number; readonly data: Uint8Array;
  private x0 = 0; private y0 = 0; private w = 0; private h = 0;
  constructor(size: number, m: MultiPoly, cell = 4) {
    this.cell = cell;
    this.n = Math.ceil(size / cell);
    const rings = m.flatMap((ph) => [ph.outer, ...ph.holes]);
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const r of rings) for (const q of r) { if (q.x < bx0) bx0 = q.x; if (q.x > bx1) bx1 = q.x; if (q.y < by0) by0 = q.y; if (q.y > by1) by1 = q.y; }
    if (!isFinite(bx0)) { this.data = new Uint8Array(0); return; }
    const n = this.n;
    const c0 = Math.max(0, Math.floor(bx0 / cell - 0.5)), c1 = Math.min(n - 1, Math.ceil(bx1 / cell - 0.5));
    const r0 = Math.max(0, Math.floor(by0 / cell - 0.5)), r1 = Math.min(n - 1, Math.ceil(by1 / cell - 0.5));
    if (c1 < c0 || r1 < r0) { this.data = new Uint8Array(0); return; }
    this.x0 = c0; this.y0 = r0; this.w = c1 - c0 + 1; this.h = r1 - r0 + 1;
    this.data = new Uint8Array(this.w * this.h);
    // rasterizePolys on the whole lattice, restricted to the window
    const xs: number[] = [];
    for (let r = r0; r <= r1; r++) {
      const y = (r + 0.5) * cell;
      xs.length = 0;
      for (const p of rings) {
        for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
          const a = p[i], b = p[j];
          if ((a.y > y) !== (b.y > y)) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const ca = Math.max(0, Math.ceil(xs[k] / cell - 0.5)), cb = Math.min(n - 1, Math.floor(xs[k + 1] / cell - 0.5));
        for (let c = ca; c <= cb; c++) this.data[(r - r0) * this.w + (c - c0)] = 1;
      }
    }
  }
  has(p: Vec2): boolean {
    const i = Math.floor(p.x / this.cell), j = Math.floor(p.y / this.cell);
    if (!(i >= 0 && j >= 0 && i < this.n && j < this.n)) return false;
    const u = i - this.x0, v = j - this.y0;
    return u >= 0 && v >= 0 && u < this.w && v < this.h && this.data[v * this.w + u] === 1;
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
      // (samples visited lazily: the first one outside the allowed regions settles it)
      let wet = 0, cnt = 0;
      const ok = forSamples(poly, 12, (p) => {
        if (spec.within && !spec.within.has(p)) return false;
        if (spec.outside && spec.outside.has(p)) return false;
        if (ctx.isWater(p)) wet++;
        cnt++;
        return true;
      }, true);
      if (!ok || wet > (spec.wet ?? 0) * cnt) continue;
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
