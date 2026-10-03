/**
 * Level 1a — phases (URBAN_GEOMETRY.md §1.1): population → archetype → nested travel-cost isoline regions
 * R_1 ⊂ … ⊂ R_n sized by population and density, plus faubourg ribbons along the roads outside the enclosure.
 */
import type { Vec2, Polygon, Polyline } from '../core/geom';
import { chaikin, simplify, dist, polylineLength, resample } from '../core/geom';
import type { Rng } from '../core/rng';
import { Noise2D } from '../core/noise';
import { marchingSquares } from '../terrain/contour';
import { distanceField, forCellsNearPolyline } from '../core/field';
import { blurGrid } from '../core/grid';
import type { SizeName } from '../options';
import type { Archetype, UrbanZone } from '../types';
import type { UrbanCtx } from './context';
import { MultiPoly, PolyH, unionS as union, intersectionS as intersection, differenceS as difference, mpArea } from '../geo/bool';
import { area, cleanRing, orientPos, pointInRing, inscribed } from '../geo/poly';
import { ribbon, sweepLeft } from '../geo/offset';
import type { MorphologyParams } from './morphology';
import { MinHeap } from '../core/pq';
import { rasterizePolys } from '../geo/raster';
import { insidePieces } from '../geo/split';
import { fortifyRegion } from './fortify';
import { D8 } from '../core/grid';

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
  n === 1 ? ['core'] : n === 2 ? ['core', 'middle'] : ['core', 'middle', ...Array.from({ length: n - 2 }, () => 'edge' as UrbanZone)];

const SHARES: Record<number, number[]> = { 1: [1], 2: [0.42, 0.58], 3: [0.24, 0.36, 0.4], 4: [0.13, 0.22, 0.3, 0.35] };

/** Smoothed outer regions (with holes) where `v > level`. */
export function isoRegions(v: Float32Array, n: number, cell: number, level: number, minArea: number, win?: { x0: number; y0: number; w: number; h: number }): PolyH[] {
  // (win: v is a w × h window at cell offset (x0, y0) of the n × n grid; same points as on the whole grid)
  const W = win ? win.w : n, Hh = win ? win.h : n;
  const pw = W + 2, ph = Hh + 2;
  const pad = new Float32Array(pw * ph).fill(level - 1e6);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) pad[(y + 1) * pw + x + 1] = v[y * W + x];
  const paths = marchingSquares(pad, pw, ph, level, cell, -0.5 * cell, -0.5 * cell, win ? win.x0 : 0, win ? win.y0 : 0);
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
export function buildField(ctx: UrbanCtx, rng: Rng, steepMax = 0.2, blocked?: Uint8Array): Float32Array {
  const { n, cell, terrain, site } = ctx;
  const N = n * n;
  const noise = new Noise2D(rng.fork('phaseNoise'));
  const f = new Float32Array(N);
  const slopeS = site.fields.slopeS;
  // local slope (~25 m): valley floors and benches in steep country are buildable although the 100 m-blurred
  // slope says otherwise (it averages in the valley walls)
  const slopeL = GROWTH_CACHE.get(ctx)?.slopeL ?? terrainRaster(terrain, 'slopeL', () => blurGrid(terrain.slope, Math.max(1, Math.round(12 / cell)), 2).data);
  const S = ctx.mapSize;
  // growth dials (URBAN_MORPHOLOGY §1): towns stretch along the roads and the waterfront, avoid wet low ground,
  // and their outlines are irregular (land ownership, soil) — so even a flat site does not give a circle
  const G = ctx.params.growth ?? { road: 0, water: 0, noise: 0.14, wavelength: 380, elongation: 0, wet: 0 };
  const P0 = ctx.center;
  // the growth rasters depend only on the context: computed once per town (the planner re-plans several times)
  let cache = GROWTH_CACHE.get(ctx);
  if (!cache) {
    let dRoad: Float32Array | null = null, dBank: Float32Array | null = null;
    if (G.road > 0) {
      const m = new Uint8Array(N);
      for (const rd of ctx.world.roads ?? []) if (rd.kind !== 'track') forCellsNearPolyline(rd.path, n, n, cell, cell * 0.7, (i) => { m[i] = 1; });
      dRoad = distanceField(m, n, n, cell).dist;
    }
    if (G.water > 0) {
      dBank = terrainRaster(terrain, 'dBank', () => {
        const m = new Uint8Array(N);
        for (let i = 0; i < N; i++) if (terrain.water[i]) m[i] = 1;
        return distanceField(m, n, n, cell).dist;
      });
    }
    cache = { dRoad, dBank, slopeL };
    GROWTH_CACHE.set(ctx, cache);
  }
  const { dRoad, dBank } = cache;
  const hab = site.fields.hab;
  const wl = G.wavelength;
  const ang = mainRoadAngleCtx(ctx);
  const ea = Math.cos(ang), eb = Math.sin(ang);
  for (let i = 0; i < N; i++) {
    const x = ((i % n) + 0.5) * cell, y = (((i / n) | 0) + 0.5) * cell;
    const c = site.cost.data[i];
    const border = x < 0.03 * S || y < 0.03 * S || x > 0.97 * S || y > 0.97 * S;
    const steep = slopeS[i] > 0.3;
    if (terrain.water[i] || !isFinite(c) || border || (steep && slopeL[i] > steepMax) || (blocked && blocked[i])) { f[i] = Infinity; continue; }
    let k = 1 + G.noise * noise.fbm(x / wl, y / wl, 2);
    if (dRoad) k *= 1 - G.road * Math.exp(-dRoad[i] / 55);
    // the waterfront attracts, but wet low ground (floodplain, marsh) repels
    if (dBank) k *= 1 - G.water * Math.exp(-dBank[i] / 70) * (hab[i] > 2.5 ? 1 : -0.6);
    if (G.wet > 0 && hab[i] < 2) k *= 1 + G.wet * (2 - Math.max(0, hab[i])) / 2;
    if (G.elongation > 0) {
      // anisotropic distance: cheaper along the main road axis
      const dx = x - P0.x, dy = y - P0.y, r = Math.hypot(dx, dy) || 1;
      const along = Math.abs((dx * ea + dy * eb) / r);
      k *= 1 - G.elongation * 0.45 * along * along;
    }
    f[i] = c * k + 40 * Math.max(0, (steep ? slopeL[i] : slopeS[i]) - 0.1);
  }
  // bipolar growth: a second nucleus (a burg across the river, an abbey or castle burg) whose region merges
  if (G.bipolar && rng.fork('bipolar').chance(G.bipolar)) {
    const br = rng.fork('bipolar2');
    const R = Math.max(150, Math.sqrt(estAreaOf(ctx) / Math.PI));
    const th = ang + br.range(-0.8, 0.8) + (br.chance(0.5) ? Math.PI : 0);
    const q = { x: P0.x + Math.cos(th) * R * br.range(0.9, 1.3), y: P0.y + Math.sin(th) * R * br.range(0.9, 1.3) };
    const qi = Math.min(n - 1, Math.max(0, Math.floor(q.y / cell))) * n + Math.min(n - 1, Math.max(0, Math.floor(q.x / cell)));
    if (isFinite(f[qi])) {
      const off = R * br.range(0.35, 0.55);
      for (let i = 0; i < N; i++) {
        if (!isFinite(f[i])) continue;
        const x = ((i % n) + 0.5) * cell, y = (((i / n) | 0) + 0.5) * cell;
        const d2 = off + Math.hypot(x - q.x, y - q.y) * 1.1;
        if (d2 < f[i]) f[i] = d2;
      }
    }
  }
  return f;
}

const FIELD_CACHE = new WeakMap<UrbanCtx, Map<string, PhaseField>>();
/** Rasters that depend on the terrain only (shared by every settlement of a map; never mutated). */
const TERRAIN_CACHE = new WeakMap<object, Map<string, Float32Array>>();
function terrainRaster(terrain: UrbanCtx['terrain'], key: string, make: () => Float32Array): Float32Array {
  let m = TERRAIN_CACHE.get(terrain);
  if (!m) { m = new Map(); TERRAIN_CACHE.set(terrain, m); }
  let v = m.get(key);
  if (!v) { v = make(); m.set(key, v); }
  return v;
}
const GROWTH_CACHE = new WeakMap<UrbanCtx, { dRoad: Float32Array | null; dBank: Float32Array | null; slopeL: Float32Array }>();

/** Main road direction at the center (radians). */
function mainRoadAngleCtx(ctx: UrbanCtx): number {
  const c = ctx.center;
  let best = 0, bl = -1;
  for (const rd of ctx.world.roads ?? []) {
    if (rd.kind === 'track') continue;
    const pl = rd.path;
    if (Math.hypot(pl[pl.length - 1].x - c.x, pl[pl.length - 1].y - c.y) > 10) continue;
    const q = pl[Math.max(0, pl.length - 12)];
    if (pl.length > bl) { bl = pl.length; best = Math.atan2(q.y - c.y, q.x - c.x); }
  }
  return best;
}
/** Rough urban area of the settlement (m²) from the context window. */
const estAreaOf = (ctx: UrbanCtx): number => { const R = (ctx.win.x1 - ctx.win.x0) / 2; return Math.PI * Math.max(100, (R - 450) / 2.6) ** 2; };

/** Threshold of f such that the region {f < thr} covers `targetArea` m² (from a sorted list). */
function thresholdFor(sorted: Float32Array, cell: number, targetArea: number): number {
  const k = Math.min(sorted.length - 1, Math.max(0, Math.round(targetArea / (cell * cell))));
  return sorted[k];
}

/**
 * Phase field: f (buildability-weighted travel cost) plus its minimax "spill level" from the center,
 * level(i) = min over 8-paths from the center of max f along the path. Unbuildable land blocks the paths; water
 * with a finite travel cost (fords, the bridge zone) is crossed without raising the level. Hence
 * {level < t} is exactly the connected component of {f < t} holding the nucleus (plus the far bank at a bridge):
 * a phase region never claims disconnected land, and on scarce land it grows along valleys instead.
 * `sorted` holds the levels of buildable cells, so thresholds are chosen on the nucleus component only.
 */
export interface PhaseField { f: Float32Array; lv: Float32Array; sorted: Float32Array }

export function phaseField(ctx: UrbanCtx, f: Float32Array): PhaseField {
  const { n } = ctx;
  const N = n * n;
  const water = ctx.terrain.water;
  // water is crossed only at the road bridges: land beyond water without a street crossing cannot be urbanized
  const bridgeCells = new Uint8Array(N);
  for (const b of ctx.world.bridges ?? []) forCellsNearPolyline([b.a, b.b], n, n, ctx.cell, Math.max(b.width, 6) + ctx.cell, (i) => { bridgeCells[i] = 1; });
  const pass = (i: number) => isFinite(f[i]) || (water[i] !== 0 && bridgeCells[i] === 1);
  const lv = new Float32Array(N).fill(Infinity);
  // start at the center cell, or the nearest buildable cell
  const cx = Math.min(n - 1, Math.max(0, Math.floor(ctx.center.x / ctx.cell))), cy = Math.min(n - 1, Math.max(0, Math.floor(ctx.center.y / ctx.cell)));
  let start = cy * n + cx;
  if (!isFinite(f[start])) {
    let bd = Infinity;
    const R = Math.ceil(150 / ctx.cell);
    for (let y = Math.max(0, cy - R); y <= Math.min(n - 1, cy + R); y++) for (let x = Math.max(0, cx - R); x <= Math.min(n - 1, cx + R); x++) {
      const i = y * n + x, d = (x - cx) ** 2 + (y - cy) ** 2;
      if (isFinite(f[i]) && d < bd) { bd = d; start = i; }
    }
  }
  if (pass(start)) {
    const heap = new MinHeap<number>();
    lv[start] = isFinite(f[start]) ? f[start] : 0;
    heap.push(start, lv[start]);
    while (heap.size) {
      const key = heap.peekKey();
      const c = heap.pop()!;
      if (key > lv[c]) continue;
      const x0 = c % n, y0 = (c / n) | 0;
      for (const [dx, dy] of D8) {
        const x = x0 + dx, y = y0 + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const j = y * n + x;
        if (!pass(j)) continue;
        const l = Math.max(key, isFinite(f[j]) ? f[j] : key);
        if (l < lv[j]) { lv[j] = l; heap.push(j, l); }
      }
    }
  }
  const vals: number[] = [];
  for (let i = 0; i < N; i++) if (isFinite(f[i]) && isFinite(lv[i])) vals.push(lv[i]);
  return { f, lv, sorted: Float32Array.from(vals).sort() };
}

/** Buildable area (m²) of the nucleus component. */
export const componentArea = (fld: PhaseField, cell: number): number => fld.sorted.length * cell * cell;

/** Bounding box (cells) of the finite cells of a phase field (cached per field array). */
const FINITE_BOX = new WeakMap<Float32Array, { x0: number; y0: number; x1: number; y1: number } | null>();
function finiteBox(f: Float32Array, n: number): { x0: number; y0: number; x1: number; y1: number } | null {
  if (FINITE_BOX.has(f)) return FINITE_BOX.get(f)!;
  let x0 = n, y0 = n, x1 = -1, y1 = -1;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!isFinite(f[y * n + x])) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const bb = x1 < 0 ? null : { x0, y0, x1, y1 };
  FINITE_BOX.set(f, bb);
  return bb;
}

export function regionForArea(ctx: UrbanCtx, fld: PhaseField, targetArea: number, closing = 0): MultiPoly {
  const { f, lv, sorted } = fld;
  const thr = thresholdFor(sorted, ctx.cell, targetArea);
  const n = ctx.n, cell = ctx.cell;
  const cap = thr * 1.6 + 120;
  const rad = Math.max(1, Math.round(22 / cell));
  const rad2 = Math.max(1, Math.round(12 / cell));
  // Exact window. Everything below only varies near the finite cells A of f: v is the constant -cap elsewhere,
  // a 2-pass box blur of radius r reaches 2r cells, `inside` ⊂ A, d1 ≤ closing only within closing/cell of A,
  // and `ind` is 0 beyond that. With a margin M ≥ 4r + 1 (blur), > closing/cell + 1 (d1: cells outside the window
  // are farther than `closing` from every source, so every d1 ≤ closing is found through window cells), and
  // ≥ closing/cell + 4r2 + 1 (second blur), each window cell gets the same value as on the whole grid; the
  // window border cells are `outside` sources for d2 on both, which seals d2 inside the window. Cells outside
  // the window would only hold constants (no isoline). On the whole map (main town) the window is the grid.
  const bb = finiteBox(f, n) ?? { x0: 0, y0: 0, x1: n - 1, y1: n - 1 };
  const M = Math.max(4 * rad + 1, closing > 0 ? Math.floor(closing / cell) + 4 * rad2 + 3 : 0) + 2;
  const wx0 = Math.max(0, bb.x0 - M), wy0 = Math.max(0, bb.y0 - M), wx1 = Math.min(n - 1, bb.x1 + M), wy1 = Math.min(n - 1, bb.y1 + M);
  const W = wx1 - wx0 + 1, H = wy1 - wy0 + 1, WN = W * H;
  const win = { x0: wx0, y0: wy0, w: W, h: H };
  const gi = (k: number) => (wy0 + ((k / W) | 0)) * n + wx0 + (k % W);
  const v = new Float32Array(WN);
  // cells below the threshold but outside the nucleus component are lifted to their spill level (≥ thr)
  const fx = (i: number) => (f[i] < thr && !(lv[i] < thr) ? lv[i] : f[i]);
  for (let k = 0; k < WN; k++) { const x = fx(gi(k)); v[k] = -(isFinite(x) ? Math.min(x, cap) : cap); }
  // smooth the field so that enclosures are smooth, compact curves (not cell-scale wiggles)
  const b = blurGrid({ w: W, h: H, cell, data: v }, rad, 2).data;
  for (let k = 0; k < WN; k++) v[k] = isFinite(fx(gi(k))) ? b[k] : Math.min(b[k], -cap);
  let regs: PolyH[];
  if (closing > 0) {
    // morphological closing (dilate, then erode by `closing` m): enclosures are compact, not lobed
    const inside = new Uint8Array(WN);
    for (let k = 0; k < WN; k++) if (v[k] > -thr) inside[k] = 1;
    const d1 = distanceField(inside, W, H, cell).dist;
    const outside = new Uint8Array(WN);
    for (let k = 0; k < WN; k++) if (d1[k] > closing) outside[k] = 1;
    const d2 = distanceField(outside, W, H, cell).dist;
    const ind = new Float32Array(WN);
    for (let k = 0; k < WN; k++) ind[k] = (inside[k] || d2[k] > closing) && !ctx.terrain.water[gi(k)] ? 1 : 0;
    const sm = blurGrid({ w: W, h: H, cell, data: ind }, rad2, 2).data;
    regs = isoRegions(sm, n, cell, 0.5, Math.min(2500, targetArea * 0.05), win);
  } else regs = isoRegions(v, n, cell, -thr, Math.min(2500, targetArea * 0.05), win);
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

export interface EnclosurePlan {
  phases: PhasePlan[]; enclosure: MultiPoly; walled: boolean;
  /** Planned enclosed area (m²) that the nucleus component could not provide (scarce land): goes to faubourgs. */
  shortfall?: number;
  /** Gross-density multiplier applied on scarce land (1 = as planned). */
  densityScale?: number;
}

/** Nested enclosed phases for a town (european-organic or bastide). */
export interface PhaseOverrides {
  nPh?: number; zones?: UrbanZone[]; faubShare?: number;
  /** Cells excluded from growth (land found unreachable by streets in a previous attempt). */
  blocked?: Uint8Array;
  /** Multiplies the region areas (compensates water and smoothing losses on scarce land). */
  areaBoost?: number;
  /** Keep the smoothed isoline outlines (no polygonal wall fit). */
  organicOutline?: boolean;
  /** Explicit phase inputs (culture plans); default: the European recipe from ctx.params. */
  specs?: PhaseInput[];
}

/** Geometric enclosure of area A centred at c: rect, rounded rect (Roman playing card), square, oval, circle. */
export function shapePolygon(shape: PhaseInput['shape'], c: Vec2, ang: number, A: number, aspect: number): Polygon {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const at = (u: number, w: number): Vec2 => ({ x: c.x + u * ca - w * sa, y: c.y + u * sa + w * ca });
  if (shape === 'circle' || shape === 'oval') {
    const asp = shape === 'circle' ? 1 : aspect;
    const b = Math.sqrt(A / (Math.PI * asp)), a = b * asp;
    return orientPos(Array.from({ length: 48 }, (_, k) => { const t = (k / 48) * 2 * Math.PI; return at(a * Math.cos(t), b * Math.sin(t)); }));
  }
  const asp = shape === 'square' ? 1 : aspect;
  const len = Math.sqrt(A * asp), wid = A / len;
  if (shape !== 'rounded-rect') return orientedRect(c, ang, len, wid);
  const r = 0.2 * wid, hx = len / 2, hy = wid / 2;
  const pts: Vec2[] = [];
  for (const [cx, cy, a0] of [[hx - r, hy - r, 0], [-hx + r, hy - r, Math.PI / 2], [-hx + r, -hy + r, Math.PI], [hx - r, -hy + r, 1.5 * Math.PI]] as [number, number, number][]) {
    for (let k = 0; k <= 4; k++) { const t = a0 + (k / 4) * (Math.PI / 2); pts.push(at(cx + r * Math.cos(t), cy + r * Math.sin(t))); }
  }
  return orientPos(pts);
}

/** One enclosed phase as planned by a culture: zone, population share, density, shape of its enclosure. */
export interface PhaseInput {
  zone: UrbanZone;
  share: number;
  density: number;
  shape: 'organic' | 'rect' | 'rounded-rect' | 'square' | 'oval' | 'circle';
  /** Orientation of geometric shapes (radians). */
  angle: number;
  /** Length / width of rect and oval shapes. */
  aspect: number;
  /** Organic shapes: compact enclosure by morphological closing. */
  closing: boolean;
  /** The line becomes a ring street (or kept wall) when a later phase surpasses it. */
  fossil: boolean;
}

export function planTownPhases(ctx: UrbanCtx, pop: number, walled: boolean, mainAngle: number, rng: Rng, ov: PhaseOverrides = {}): EnclosurePlan {
  const P = ctx.params;
  const faubShare = ov.faubShare ?? (walled ? 0.17 : 0.1);
  const encPop = pop * (1 - faubShare);
  let specs: PhaseInput[];
  if (ov.specs?.length) specs = ov.specs;
  else {
    const nPh = ov.nPh ?? (P.streetOp === 'grid' ? 1 : pop < 5000 ? 2 : pop < 20000 ? 3 : 4);
    const zones = ov.zones ?? zonesFor(nPh);
    specs = zones.map((zone, k) => ({
      zone, share: SHARES[nPh][k], density: P.density[zone], shape: P.streetOp === 'grid' && k === 0 ? 'rect' : 'organic',
      angle: mainAngle, aspect: 1.25 + 0.35 * rng.fork('aspect').float(), closing: P.streetOp === 'organic', fossil: k < nPh - 1,
    }));
  }
  const nPh = specs.length;
  const zones = specs.map((s2) => s2.zone);
  // ring spacing varies from town to town
  const sj = P.shareJitter ?? 0;
  const sr = rng.fork('shares');
  const raw = specs.map((s2) => s2.share * (1 + sj * (2 * sr.float() - 1)));
  const rs = raw.reduce((a, b) => a + b, 0);
  const shares = raw.map((x) => x / rs);
  // enclosed area target; on scarce land (steep valleys) buildability is relaxed step by step (hillside towns)
  let total = 0;
  for (let k = 0; k < nPh; k++) total += ((encPop * shares[k]) / specs[k].density) * 1e4;
  // (memoized: the planner re-plans several times with the same field when no cells are blocked)
  const fieldFor = (sm: number): PhaseField => {
    if (ov.blocked) return phaseField(ctx, buildField(ctx, rng, sm, ov.blocked));
    let m = FIELD_CACHE.get(ctx);
    if (!m) { m = new Map(); FIELD_CACHE.set(ctx, m); }
    const key = rng.seedKey + '|' + sm;
    let v = m.get(key);
    if (!v) { v = phaseField(ctx, buildField(ctx, rng, sm)); m.set(key, v); }
    return v;
  };
  let fld = fieldFor(0.2);
  for (const sm of [0.3, 0.4]) {
    if (componentArea(fld, ctx.cell) >= 1.3 * total) break;
    fld = fieldFor(sm);
  }
  // still scarce: hill towns are denser (taller, tighter houses) — up to 1.35× the planned gross density
  const densityScale = Math.min(1.35, Math.max(1, (1.3 * total) / Math.max(1, componentArea(fld, ctx.cell))));
  const phases: PhasePlan[] = [];
  let cum = 0;
  let prev: MultiPoly = [];
  for (let k = 0; k < nPh; k++) {
    const ppop = encPop * shares[k];
    const sp = specs[k];
    const dens = sp.density * densityScale;
    cum += (ppop / dens) * 1e4 * (ov.areaBoost ?? 1);
    let R: MultiPoly;
    if (sp.shape !== 'organic') {
      // planned shape (bastide rectangle, Roman playing card, cardinal square, oval, circle), clipped to the
      // connected buildable land
      const shp = shapePolygon(sp.shape, ctx.center, sp.angle, cum * 1.08, sp.aspect);
      const land = regionForArea(ctx, fld, cum * 3.2);
      R = intersection(shp, land);
      R = keepMain(R, ctx.center, 0.15);
    } else R = regionForArea(ctx, fld, cum, sp.closing ? (k === nPh - 1 ? 55 : 35) : 0);
    if (prev.length) {
      R = union(R, prev);
      // keep R_{k-1} strictly nested
    }
    // wall lines (the walled outer phase, and older lines that fossilize into ring streets) are polygons of
    // straight curtains that circumscribe the region
    if (!ov.organicOutline && ((k < nPh - 1 && sp.fossil) || (k === nPh - 1 && walled))) R = keepMain(fortifyRegion(ctx, R, prev), ctx.center, 0.1);
    R = R.map((ph) => ({ outer: ph.outer, holes: ph.holes }));
    let band: MultiPoly = prev.length ? difference(R, prev) : R;
    band = dropSlivers(band, 400, 5);
    phases.push({ id: k + 1, kind: zones[k] === 'village' ? 'village' : k === 0 ? 'core' : 'ring', zone: zones[k], region: R, band, age: 1 - k / Math.max(1, nPh), fossil: k < nPh - 1 && sp.fossil, walled: walled && k === nPh - 1, pop: ppop });
    prev = R;
  }
  return { phases, enclosure: prev, walled, shortfall: Math.max(0, cum - mpArea(prev)), densityScale };
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
export function planFaubourgs(ctx: UrbanCtx, enclosure: MultiPoly, roads: RoadIn[], area: number, glacis: number, rng: Rng, zone: UrbanZone = 'faubourg', thick = 1): { region: MultiPoly; paths: Polyline[] } {
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
  const noise = new Noise2D(rng.fork('faubNoise'));
  for (const c of cands) {
    // (thick > 1: suburbs, deeper ribbons that reach further out)
    const depth = rng.range(40, 60) * thick;
    // the built ribbon fades out: its mean depth over the length is about 0.62 of the depth at the gate
    const L = Math.min(560 * Math.sqrt(thick), (area * c.w) / W / (2 * depth * 0.62 * 0.85)) + glacis;
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
    for (let i = 1; i < out.length; i++) {
      if (ctx.isWater(out[i])) { cut = i; break; }
      // ribbons climb along valley roads; they stop where the ground stays steep
      if (ctx.slopeAt(out[i]) > 0.28 && (i + 1 >= out.length || ctx.slopeAt(out[i + 1]) > 0.36 || ctx.slopeAt(out[i]) > 0.45)) { cut = i; break; }
    }
    const pts0 = out.slice(0, cut);
    if (pts0.length < 2 || polylineLength(pts0) < 60) continue;
    // resample every 8 m: the depth varies along the road
    const pts = resample(pts0, 8);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
    const Lr = cum[cum.length - 1];
    // per side: depth tapers with the distance from the gate (rows → gaps → scattered houses → fields), with an
    // irregular rear line (field boundaries), and is zero where the side meets water or steep ground
    for (const side of [1, -1]) {
      const sideBias = rng.range(0.75, 1.2);
      const ph = rng.range(0, 100);
      const depths = pts.map((p, i) => {
        const t = (cum[i] - glacis) / Math.max(1, Lr - glacis);
        const taper = t <= 0 ? 1 : Math.max(0, 1 - 0.75 * Math.pow(Math.max(0, t), 1.3));
        const irregular = 1 + 0.32 * noise.fbm(cum[i] / 70 + ph, side * 3.1 + ph, 2);
        let d = depth * sideBias * taper * irregular;
        // the end of the ribbon closes gradually
        d *= Math.min(1, (Lr - cum[i]) / 45 + 0.25);
        // water or steep ground on this side: the ribbon keeps to the other side
        const a2 = pts[Math.max(0, i - 1)], b2 = pts[Math.min(pts.length - 1, i + 1)];
        const l2 = dist(a2, b2) || 1;
        const nx = (-(b2.y - a2.y) / l2) * side, ny = ((b2.x - a2.x) / l2) * side;
        for (const k of [0.35, 0.7, 1]) {
          const q = { x: p.x + nx * d * k, y: p.y + ny * d * k };
          if (ctx.isWater(q) || ctx.slopeAt(q) > 0.3) { d = Math.min(d, Math.max(0, d * k - 12)); break; }
        }
        return Math.max(0, d);
      });
      // one-sided sweep (left of the path for side 1; the reversed path for side −1)
      const sm = depths.map((_, i) => { let s2 = 0, n2 = 0; for (let k = Math.max(0, i - 2); k <= Math.min(depths.length - 1, i + 2); k++) { s2 += depths[k]; n2++; } return s2 / n2; });
      // keep the stretches deeper than 14 m (the ribbon can stop and restart)
      let run: number[] = [];
      const flush = () => {
        if (run.length >= 3) {
          const pl = run.map((i) => pts[i]), dd = run.map((i) => sm[i] + 0.3);
          const sw = side > 0 ? sweepLeft(pl, dd) : sweepLeft(pl.slice().reverse(), dd.slice().reverse());
          if (sw.length >= 3) pieces.push([{ outer: sw, holes: [] }]);
        }
        run = [];
      };
      sm.forEach((d, i) => { if (d >= 14) run.push(i); else flush(); });
      flush();
    }
    paths.push(pts0);
  }
  if (!pieces.length) return { region: [], paths: [] };
  let region = union(pieces[0], ...pieces.slice(1));
  region = difference(region, blocked);
  if (ctx.water.length) region = difference(region, ctx.water);
  void zone;
  region = dropSlivers(region, 1200, 8);
  return { region, paths };
}

/**
 * Enclosure components that no road enters and that do not hold the nucleus (land across water or behind a spur
 * that the phase field reached but no street can serve).
 */
export function unservedComponents(enclosure: MultiPoly, roads: { path: Polyline }[], center: Vec2): MultiPoly {
  const out: MultiPoly = [];
  for (const ph of enclosure) {
    if (pointInRing(ph.outer, center)) continue;
    // a road must run inside the component for a meaningful length (not merely clip a corner)
    const need = Math.min(60, 0.3 * Math.sqrt(area(ph.outer)));
    let len = 0;
    for (const rd of roads) {
      for (const pc of insidePieces(ph.outer, rd.path)) len += polylineLength(pc.pts);
      if (len >= need) break;
    }
    if (len < need) out.push(ph);
  }
  return out;
}

/** Plans the enclosed phases, re-planning once without the components that no road serves. */
export function planServedPhases(ctx: UrbanCtx, pop: number, walled: boolean, mainAngle: number, rng: Rng, roads: { path: Polyline }[], ov: PhaseOverrides = {}): EnclosurePlan {
  let plan = planTownPhases(ctx, pop, walled, mainAngle, rng, ov);
  for (let it = 0; it < 2; it++) {
    const bad = unservedComponents(plan.enclosure, roads, ctx.center);
    if (!bad.length) break;
    const mask = ov.blocked ? ov.blocked.slice() : new Uint8Array(ctx.n * ctx.n);
    rasterizePolys(bad.flatMap((ph) => [ph.outer]), ctx.n, ctx.n, ctx.cell, mask);
    ov = { ...ov, blocked: mask };
    plan = planTownPhases(ctx, pop, walled, mainAngle, rng, ov);
  }
  // the enclosure lost much of its planned area (water, smoothing, unserved land): grow once more
  const achieved = mpArea(plan.enclosure), planned = achieved + (plan.shortfall ?? 0);
  if (achieved < 0.9 * planned && achieved > 0) {
    const boost = Math.min(1.6, planned / achieved);
    const again = planTownPhases(ctx, pop, walled, mainAngle, rng, { ...ov, areaBoost: boost });
    if (!unservedComponents(again.enclosure, roads, ctx.center).length) {
      again.shortfall = Math.max(0, planned - mpArea(again.enclosure));
      plan = again;
    }
  }
  // whatever remains unserved is not enclosed
  const bad = unservedComponents(plan.enclosure, roads, ctx.center);
  if (bad.length) {
    plan.enclosure = plan.enclosure.filter((ph) => !bad.includes(ph));
    for (const phs of plan.phases) { phs.region = difference(phs.region, bad); phs.band = difference(phs.band, bad); }
  }
  return plan;
}
