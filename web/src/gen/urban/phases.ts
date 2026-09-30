/**
 * Level 1a — phases (URBAN_GEOMETRY.md §1.1): population → archetype → nested travel-cost isoline regions
 * R_1 ⊂ … ⊂ R_n sized by population and density, plus faubourg ribbons along the roads outside the enclosure.
 */
import type { Vec2, Polygon, Polyline } from '../core/geom';
import { chaikin, simplify, dist, polylineLength } from '../core/geom';
import type { Rng } from '../core/rng';
import { Noise2D } from '../core/noise';
import { marchingSquares } from '../terrain/contour';
import { distanceField } from '../core/field';
import { blurGrid } from '../core/grid';
import type { SizeName } from '../options';
import type { Archetype, UrbanZone } from '../types';
import type { UrbanCtx } from './context';
import { MultiPoly, PolyH, unionS as union, intersectionS as intersection, differenceS as difference, mpArea } from '../geo/bool';
import { area, cleanRing, orientPos, pointInRing, inscribed } from '../geo/poly';
import { ribbon } from '../geo/offset';
import type { MorphologyParams } from './morphology';

export const POP_RANGE: Record<SizeName, [number, number]> = {
  hamlet: [40, 150], village: [320, 900], town: [2200, 5000], city: [11000, 24000], capital: [40000, 60000],
};

export function choosePopulation(size: SizeName, override: number, rng: Rng): number {
  if (override > 0) return override;
  const [a, b] = POP_RANGE[size];
  return Math.round(a * Math.pow(b / a, rng.float()));
}

export function chooseArchetype(pop: number, nRoads: number, rng: Rng): Archetype {
  if (pop < 200) return 'hamlet';
  if (pop < 1200) {
    // street villages on one through-road; nucleated villages at road junctions
    const pStreet = nRoads <= 2 ? 0.75 : 0.3;
    return rng.chance(pStreet) ? 'street-village' : 'nucleated-village';
  }
  return 'town';
}

export interface PhasePlan {
  id: number;
  kind: 'core' | 'ring' | 'faubourg' | 'village';
  zone: UrbanZone;
  /** Region R_k (enclosed phases) or the ribbon (faubourgs). */
  region: MultiPoly;
  /** Part owned by this phase: R_k \ R_{k-1}. */
  band: MultiPoly;
  /** 1 = oldest. */
  age: number;
  fossil: boolean;
  walled: boolean;
  pop: number;
}

export const zonesFor = (n: number): UrbanZone[] =>
  n === 1 ? ['core'] : n === 2 ? ['core', 'middle'] : n === 3 ? ['core', 'middle', 'edge'] : ['core', 'middle', 'middle', 'edge'];

const SHARES: Record<number, number[]> = { 1: [1], 2: [0.42, 0.58], 3: [0.24, 0.36, 0.4], 4: [0.13, 0.22, 0.3, 0.35] };

/** Smoothed outer regions (with holes) where `v > level`. */
export function isoRegions(v: Float32Array, n: number, cell: number, level: number, minArea: number): PolyH[] {
  const pw = n + 2;
  const pad = new Float32Array(pw * pw).fill(level - 1e6);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) pad[(y + 1) * pw + x + 1] = v[y * n + x];
  const paths = marchingSquares(pad, pw, pw, level, cell, -0.5 * cell, -0.5 * cell);
  const loops: Polygon[] = [];
  for (const p of paths) {
    if (!p.closed || p.pts.length < 6) continue;
    let pts = chaikin(p.pts, 2, true);
    pts = simplify(pts.concat([pts[0]]), 2).slice(0, -1);
    const r = cleanRing(pts, 0.5, 1);
    if (r.length >= 3 && area(r) >= minArea * 0.3) loops.push(r);
  }
  const areas = loops.map(area);
  const depth = loops.map((l, i) => {
    let d = 0;
    for (let j = 0; j < loops.length; j++) if (j !== i && areas[j] > areas[i] && pointInRing(loops[j], l[0])) d++;
    return d;
  });
  const out: PolyH[] = [];
  const outerIdx: number[] = [];
  loops.forEach((l, i) => { if (depth[i] % 2 === 0 && areas[i] >= minArea) { outerIdx.push(i); out.push({ outer: orientPos(l), holes: [] }); } });
  loops.forEach((l, i) => {
    if (depth[i] % 2 === 1 && areas[i] >= 1500) {
      let bi = -1, ba = Infinity;
      outerIdx.forEach((oi, k) => { if (areas[oi] > areas[i] && areas[oi] < ba && pointInRing(loops[oi], l[0])) { ba = areas[oi]; bi = k; } });
      if (bi >= 0) out[bi].holes.push(orientPos(l));
    }
  });
  return out;
}

/** Keeps the components that matter: the one holding (or nearest to) the center, plus large ones. */
function keepMain(m: MultiPoly, center: Vec2, minFrac: number): MultiPoly {
  if (!m.length) return m;
  const tot = mpArea(m);
  let main = m[0], bd = Infinity;
  for (const ph of m) {
    if (pointInRing(ph.outer, center)) { main = ph; bd = -1; break; }
    for (const q of ph.outer) { const d = dist(q, center); if (d < bd) { bd = d; main = ph; } }
  }
  return m.filter((ph) => ph === main || area(ph.outer) >= minFrac * tot);
}

/** Travel-cost field modulated by noise; Infinity where unbuildable. */
export function buildField(ctx: UrbanCtx, rng: Rng): Float32Array {
  const { n, cell, terrain, site } = ctx;
  const N = n * n;
  const noise = new Noise2D(rng.fork('phaseNoise'));
  const f = new Float32Array(N);
  const slopeS = site.fields.slopeS;
  const S = ctx.mapSize;
  for (let i = 0; i < N; i++) {
    const x = ((i % n) + 0.5) * cell, y = (((i / n) | 0) + 0.5) * cell;
    const c = site.cost.data[i];
    const border = x < 0.03 * S || y < 0.03 * S || x > 0.97 * S || y > 0.97 * S;
    if (terrain.water[i] || !isFinite(c) || slopeS[i] > 0.3 || border) { f[i] = Infinity; continue; }
    f[i] = c * (1 + 0.14 * noise.fbm(x / 380, y / 380, 2)) + 40 * Math.max(0, slopeS[i] - 0.1);
  }
  return f;
}

/** Threshold of f such that the region {f < thr} covers `targetArea` m² (from a sorted list). */
function thresholdFor(sorted: Float32Array, cell: number, targetArea: number): number {
  const k = Math.min(sorted.length - 1, Math.max(0, Math.round(targetArea / (cell * cell))));
  return sorted[k];
}

export function regionForArea(ctx: UrbanCtx, f: Float32Array, sorted: Float32Array, targetArea: number, closing = 0): MultiPoly {
  const thr = thresholdFor(sorted, ctx.cell, targetArea);
  const N = f.length;
  const v = new Float32Array(N);
  const cap = thr * 1.6 + 120;
  for (let i = 0; i < N; i++) v[i] = -(isFinite(f[i]) ? Math.min(f[i], cap) : cap);
  // smooth the field so that enclosures are smooth, compact curves (not cell-scale wiggles)
  const rad = Math.max(1, Math.round(22 / ctx.cell));
  const b = blurGrid({ w: ctx.n, h: ctx.n, cell: ctx.cell, data: v }, rad, 2).data;
  for (let i = 0; i < N; i++) v[i] = isFinite(f[i]) ? b[i] : Math.min(b[i], -cap);
  let regs: PolyH[];
  if (closing > 0) {
    // morphological closing (dilate, then erode by `closing` m): enclosures are compact, not lobed
    const inside = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (v[i] > -thr) inside[i] = 1;
    const d1 = distanceField(inside, ctx.n, ctx.n, ctx.cell).dist;
    const outside = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (d1[i] > closing) outside[i] = 1;
    const d2 = distanceField(outside, ctx.n, ctx.n, ctx.cell).dist;
    const ind = new Float32Array(N);
    for (let i = 0; i < N; i++) ind[i] = (inside[i] || d2[i] > closing) && !ctx.terrain.water[i] ? 1 : 0;
    const sm = blurGrid({ w: ctx.n, h: ctx.n, cell: ctx.cell, data: ind }, Math.max(1, Math.round(12 / ctx.cell)), 2).data;
    regs = isoRegions(sm, ctx.n, ctx.cell, 0.5, Math.min(2500, targetArea * 0.05));
  } else regs = isoRegions(v, ctx.n, ctx.cell, -thr, Math.min(2500, targetArea * 0.05));
  let m: MultiPoly = regs;
  if (ctx.water.length) m = difference(m, ctx.water);
  return keepMain(m, ctx.center, 0.1);
}

/** Drops pieces thinner than `minR` (inscribed radius) or smaller than `minA`. */
export function dropSlivers(m: MultiPoly, minA: number, minR: number): MultiPoly {
  return m.filter((ph) => area(ph.outer) >= minA && inscribed(ph.outer, ph.holes, 1).r >= minR);
}

/** Rectangle aligned with `ang`, centered at c. */
export function orientedRect(c: Vec2, ang: number, len: number, wid: number): Polygon {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const pts: [number, number][] = [[-len / 2, -wid / 2], [len / 2, -wid / 2], [len / 2, wid / 2], [-len / 2, wid / 2]];
  return orientPos(pts.map(([u, w]) => ({ x: c.x + u * ca - w * sa, y: c.y + u * sa + w * ca })));
}

export interface EnclosurePlan { phases: PhasePlan[]; enclosure: MultiPoly; walled: boolean }

/** Nested enclosed phases for a town (european-organic or bastide). */
export interface PhaseOverrides { nPh?: number; zones?: UrbanZone[]; faubShare?: number }

export function planTownPhases(ctx: UrbanCtx, pop: number, walled: boolean, mainAngle: number, rng: Rng, ov: PhaseOverrides = {}): EnclosurePlan {
  const P = ctx.params;
  const nPh = ov.nPh ?? (P.streetOp === 'grid' ? 1 : pop < 5000 ? 2 : pop < 20000 ? 3 : 4);
  const zones = ov.zones ?? zonesFor(nPh);
  const faubShare = ov.faubShare ?? (walled ? 0.17 : 0.1);
  const encPop = pop * (1 - faubShare);
  const shares = SHARES[nPh];
  const f = buildField(ctx, rng);
  const vals: number[] = [];
  for (let i = 0; i < f.length; i++) if (isFinite(f[i])) vals.push(f[i]);
  const sorted = Float32Array.from(vals).sort();
  const phases: PhasePlan[] = [];
  let cum = 0;
  let prev: MultiPoly = [];
  for (let k = 0; k < nPh; k++) {
    const ppop = encPop * shares[k];
    const dens = ctx.params.density[zones[k]];
    cum += (ppop / dens) * 1e4;
    let R: MultiPoly;
    if (P.streetOp === 'grid' && k === 0) {
      // bastide: planned oriented rectangle, clipped to buildable land
      const aspect = 1.25 + 0.35 * rng.float();
      const A = cum * 1.08;
      const len = Math.sqrt(A * aspect), wid = A / len;
      const rect = orientedRect(ctx.center, mainAngle, len, wid);
      const land = regionForArea(ctx, f, sorted, cum * 3.2);
      R = intersection(rect, land);
      R = keepMain(R, ctx.center, 0.15);
    } else R = regionForArea(ctx, f, sorted, cum, P.streetOp === 'organic' ? (k === nPh - 1 ? 55 : 35) : 0);
    if (prev.length) {
      R = union(R, prev);
      // keep R_{k-1} strictly nested
    }
    R = R.map((ph) => ({ outer: ph.outer, holes: ph.holes }));
    let band: MultiPoly = prev.length ? difference(R, prev) : R;
    band = dropSlivers(band, 400, 5);
    phases.push({ id: k + 1, kind: zones[k] === 'village' ? 'village' : k === 0 ? 'core' : 'ring', zone: zones[k], region: R, band, age: 1 - k / Math.max(1, nPh), fossil: k < nPh - 1, walled: walled && k === nPh - 1, pop: ppop });
    prev = R;
  }
  return { phases, enclosure: prev, walled };
}

/** Dilates a region by g meters (union with the ribbon of its boundary). */
export function dilate(m: MultiPoly, g: number): MultiPoly {
  if (g <= 0) return m;
  const rings: Polygon[] = [];
  for (const ph of m) {
    for (const r of [ph.outer, ...ph.holes]) {
      const closed = r.concat([r[0]]);
      const rb = ribbon(closed, 2 * g);
      if (rb.length >= 3) rings.push(rb);
    }
  }
  return union(m, ...rings.map((r) => [{ outer: r, holes: [] }] as MultiPoly));
}

export interface RoadIn { path: Polyline; major: boolean }

/**
 * Faubourg ribbons along the roads outside the enclosure: the road from its entry point outward, buffered by a
 * per-road depth, minus the dilated enclosure and water.
 */
export function planFaubourgs(ctx: UrbanCtx, enclosure: MultiPoly, roads: RoadIn[], area: number, glacis: number, rng: Rng, zone: UrbanZone = 'faubourg'): { region: MultiPoly; paths: Polyline[] } {
  if (area < 1500 || !roads.length) return { region: [], paths: [] };
  const inside = (p: Vec2) => enclosure.some((ph) => pointInRing(ph.outer, p) && !ph.holes.some((h) => pointInRing(h, p)));
  const cands: { pts: Polyline; w: number }[] = [];
  for (const rd of roads) {
    // paths run from the map edge towards the center: find the first vertex inside the enclosure
    const pl = rd.path;
    let entry = -1;
    for (let i = 0; i < pl.length; i++) if (inside(pl[i])) { entry = i; break; }
    if (entry <= 0) continue;
    const outward = pl.slice(0, entry + 1).reverse();
    cands.push({ pts: outward, w: rd.major ? 1 : 0.55 });
  }
  if (!cands.length) return { region: [], paths: [] };
  const W = cands.reduce((s, c) => s + c.w, 0);
  const pieces: MultiPoly[] = [];
  const paths: Polyline[] = [];
  const blocked = dilate(enclosure, glacis);
  for (const c of cands) {
    const depth = rng.range(42, 66);
    const L = Math.min(520, (area * c.w) / W / (2 * depth * 0.85)) + glacis;
    if (L < 70 + glacis) continue;
    // cut the outward path at length L
    const out: Polyline = [c.pts[0]];
    let acc = 0;
    for (let i = 1; i < c.pts.length; i++) {
      const d = dist(c.pts[i - 1], c.pts[i]);
      if (acc + d >= L) { const t = (L - acc) / d; out.push({ x: c.pts[i - 1].x + (c.pts[i].x - c.pts[i - 1].x) * t, y: c.pts[i - 1].y + (c.pts[i].y - c.pts[i - 1].y) * t }); break; }
      out.push(c.pts[i]); acc += d;
    }
    if (polylineLength(out) < 60) continue;
    // stay on dry, reasonably flat land
    let cut = out.length;
    for (let i = 1; i < out.length; i++) if (ctx.isWater(out[i]) || ctx.slopeAt(out[i]) > 0.28) { cut = i; break; }
    const pts = out.slice(0, cut);
    if (pts.length < 2 || polylineLength(pts) < 60) continue;
    const rb = ribbon(pts, 2 * depth);
    if (rb.length < 3) continue;
    pieces.push([{ outer: rb, holes: [] }]);
    paths.push(pts);
  }
  if (!pieces.length) return { region: [], paths: [] };
  let region = union(pieces[0], ...pieces.slice(1));
  region = difference(region, blocked);
  if (ctx.water.length) region = difference(region, ctx.water);
  void zone;
  region = dropSlivers(region, 1200, 8);
  return { region, paths };
}
