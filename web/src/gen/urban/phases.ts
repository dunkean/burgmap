/**
 * Level 1a — phases (URBAN_GEOMETRY.md §1.1): population → archetype → nested travel-cost isoline regions
 * R_1 ⊂ … ⊂ R_n sized by population and density, plus faubourg ribbons along the roads outside the enclosure.
 */
import type { Vec2, Polygon, Polyline } from '../core/geom';
import { chaikin, simplify, dist, polylineLength } from '../core/geom';
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
import { ribbon } from '../geo/offset';
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
  n === 1 ? ['core'] : n === 2 ? ['core', 'middle'] : n === 3 ? ['core', 'middle', 'edge'] : ['core', 'middle', 'edge', 'edge'];

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
export function buildField(ctx: UrbanCtx, rng: Rng, steepMax = 0.2, blocked?: Uint8Array): Float32Array {
  const { n, cell, terrain, site } = ctx;
  const N = n * n;
  const noise = new Noise2D(rng.fork('phaseNoise'));
  const f = new Float32Array(N);
  const slopeS = site.fields.slopeS;
  // local slope (~25 m): valley floors and benches in steep country are buildable although the 100 m-blurred
  // slope says otherwise (it averages in the valley walls)
  const slopeL = blurGrid(terrain.slope, Math.max(1, Math.round(12 / cell)), 2).data;
  const S = ctx.mapSize;
  for (let i = 0; i < N; i++) {
    const x = ((i % n) + 0.5) * cell, y = (((i / n) | 0) + 0.5) * cell;
    const c = site.cost.data[i];
    const border = x < 0.03 * S || y < 0.03 * S || x > 0.97 * S || y > 0.97 * S;
    const steep = slopeS[i] > 0.3;
    if (terrain.water[i] || !isFinite(c) || border || (steep && slopeL[i] > steepMax) || (blocked && blocked[i])) { f[i] = Infinity; continue; }
    f[i] = c * (1 + 0.14 * noise.fbm(x / 380, y / 380, 2)) + 40 * Math.max(0, (steep ? slopeL[i] : slopeS[i]) - 0.1);
  }
  return f;
}

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

export function regionForArea(ctx: UrbanCtx, fld: PhaseField, targetArea: number, closing = 0): MultiPoly {
  const { f, lv, sorted } = fld;
  const thr = thresholdFor(sorted, ctx.cell, targetArea);
  const N = f.length;
  const v = new Float32Array(N);
  const cap = thr * 1.6 + 120;
  // cells below the threshold but outside the nucleus component are lifted to their spill level (≥ thr)
  const fx = (i: number) => (f[i] < thr && !(lv[i] < thr) ? lv[i] : f[i]);
  for (let i = 0; i < N; i++) { const x = fx(i); v[i] = -(isFinite(x) ? Math.min(x, cap) : cap); }
  // smooth the field so that enclosures are smooth, compact curves (not cell-scale wiggles)
  const rad = Math.max(1, Math.round(22 / ctx.cell));
  const b = blurGrid({ w: ctx.n, h: ctx.n, cell: ctx.cell, data: v }, rad, 2).data;
  for (let i = 0; i < N; i++) v[i] = isFinite(fx(i)) ? b[i] : Math.min(b[i], -cap);
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
}

export function planTownPhases(ctx: UrbanCtx, pop: number, walled: boolean, mainAngle: number, rng: Rng, ov: PhaseOverrides = {}): EnclosurePlan {
  const P = ctx.params;
  const nPh = ov.nPh ?? (P.streetOp === 'grid' ? 1 : pop < 5000 ? 2 : pop < 20000 ? 3 : 4);
  const zones = ov.zones ?? zonesFor(nPh);
  const faubShare = ov.faubShare ?? (walled ? 0.17 : 0.1);
  const encPop = pop * (1 - faubShare);
  // ring spacing varies from town to town
  const sj = P.shareJitter ?? 0;
  const sr = rng.fork('shares');
  const raw = SHARES[nPh].map((x) => x * (1 + sj * (2 * sr.float() - 1)));
  const rs = raw.reduce((a, b) => a + b, 0);
  const shares = raw.map((x) => x / rs);
  // enclosed area target; on scarce land (steep valleys) buildability is relaxed step by step (hillside towns)
  let total = 0;
  for (let k = 0; k < nPh; k++) total += ((encPop * shares[k]) / ctx.params.density[zones[k]]) * 1e4;
  let fld = phaseField(ctx, buildField(ctx, rng, 0.2, ov.blocked));
  for (const sm of [0.3, 0.4]) {
    if (componentArea(fld, ctx.cell) >= 1.3 * total) break;
    fld = phaseField(ctx, buildField(ctx, rng, sm, ov.blocked));
  }
  // still scarce: hill towns are denser (taller, tighter houses) — up to 1.35× the planned gross density
  const densityScale = Math.min(1.35, Math.max(1, (1.3 * total) / Math.max(1, componentArea(fld, ctx.cell))));
  const phases: PhasePlan[] = [];
  let cum = 0;
  let prev: MultiPoly = [];
  for (let k = 0; k < nPh; k++) {
    const ppop = encPop * shares[k];
    const dens = ctx.params.density[zones[k]] * densityScale;
    cum += (ppop / dens) * 1e4 * (ov.areaBoost ?? 1);
    let R: MultiPoly;
    if (P.streetOp === 'grid' && k === 0) {
      // bastide: planned oriented rectangle, clipped to buildable land
      const aspect = 1.25 + 0.35 * rng.float();
      const A = cum * 1.08;
      const len = Math.sqrt(A * aspect), wid = A / len;
      const rect = orientedRect(ctx.center, mainAngle, len, wid);
      const land = regionForArea(ctx, fld, cum * 3.2);
      R = intersection(rect, land);
      R = keepMain(R, ctx.center, 0.15);
    } else R = regionForArea(ctx, fld, cum, P.streetOp === 'organic' ? (k === nPh - 1 ? 55 : 35) : 0);
    if (prev.length) {
      R = union(R, prev);
      // keep R_{k-1} strictly nested
    }
    // wall lines (the walled outer phase, and older lines that fossilize into ring streets) are polygons of
    // straight curtains that circumscribe the region
    if (!ov.organicOutline && (k < nPh - 1 || walled)) R = keepMain(fortifyRegion(ctx, R, prev), ctx.center, 0.1);
    R = R.map((ph) => ({ outer: ph.outer, holes: ph.holes }));
    let band: MultiPoly = prev.length ? difference(R, prev) : R;
    band = dropSlivers(band, 400, 5);
    phases.push({ id: k + 1, kind: zones[k] === 'village' ? 'village' : k === 0 ? 'core' : 'ring', zone: zones[k], region: R, band, age: 1 - k / Math.max(1, nPh), fossil: k < nPh - 1, walled: walled && k === nPh - 1, pop: ppop });
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
    for (let i = 1; i < out.length; i++) {
      if (ctx.isWater(out[i])) { cut = i; break; }
      // ribbons climb along valley roads; they stop where the ground stays steep
      if (ctx.slopeAt(out[i]) > 0.28 && (i + 1 >= out.length || ctx.slopeAt(out[i + 1]) > 0.36 || ctx.slopeAt(out[i]) > 0.45)) { cut = i; break; }
    }
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
