/**
 * Megacity macro plan (URBAN_MORPHOLOGY §3d, "macro level"): growth rings, wall rings and boulevards, radials,
 * absorbed villages and fused satellite towns, the arterial graph and its quarters (an exact partition of the
 * built-up land), with the morphology, density, phase age, culture and district of every quarter, and the
 * city-rank landmark lots. No street, block, plot or building inside a quarter is made here: that is the lazy
 * quarter detail (`detail.ts`).
 *
 * Partition (URBAN_GEOMETRY "partition, never place"): ring lines, radials, village greens and their spokes are
 * inserted into one planar graph; its faces minus the water are the cells; cells are split by straight-ish chords
 * (secondary arterials) until every piece has the size of a quarter. Every split shares its chord vertices, so the
 * quarters tile the land with no gap and no overlap, and every quarter edge knows the street it lies on.
 */
import type { Vec2, Polygon, Polyline } from '../../core/geom';
import { dist, polygonCentroid, polygonArea, simplify, resample, chaikin, polylineLength } from '../../core/geom';
import { Rng } from '../../core/rng';
import { Noise2D } from '../../core/noise';
import type { World, UrbanLayer, UrbanStreet, UrbanWall, UrbanSite, UrbanLine, UrbanZone, PolyH, StreetRole } from '../../types';
import type { MorphologyParams } from '../morphology';
import { applySprawl } from '../morphology';
import { getCulture, resolvePlan, type ResolvedPlan } from '../culture';
import { makeCtx, type UrbanCtx } from '../context';
import { shapePolygon } from '../phases';
import { makeMarket } from '../primary';
import { Streets, LAB_OPEN, LAB_WALL, LAB_WATER } from '../streets';
import { insetPiece } from '../blocks';
import { wallFeatures } from '../walls';
import { StreetGraph } from '../../geo/graph';
import { GridIndex } from '../../geo/spatial';
import { area, pointInRing, inscribed, obb, orientPos, segSegT, bboxOf, distToSeg, convexHull } from '../../geo/poly';
import { splitByChord, rayHit, locate, type LPoly } from '../../geo/split';
import { differenceS, mpArea, type MultiPoly } from '../../geo/bool';
import { openHoles } from '../plots';
import type { MacroPlan, MacroQuarter, MacroStreet, MacroNucleus, MacroDistrict, MacroWant } from './types';

const TAU = Math.PI * 2;
const TMP = -999;
/** The culture's nucleus claimed as a compound on the market piece (as the town stage does). */
const NUCLEUS_COMPOUND: Record<string, string> = { mosque: 'great-mosque', castle: 'castle', temple: 'hindu-temple', grove: 'grove', 'drum-tower': 'drum-tower', ushnu: 'inca-plaza', precinct: 'aztec-precinct', mortuary: 'mortuary-temple', maidan: 'maidan', 'mud-mosque': 'mud-mosque', 'wizard-tower': 'wizard-tower', clocktower: 'clocktower' };

/** A point strictly inside a polygon (centroid when inside, else the inscribed-circle center). */
export function innerPoint(p: Polygon): Vec2 {
  const c = polygonCentroid(p);
  return pointInRing(p, c) ? c : inscribed(p, [], 1).c;
}

/** Number of enclosed growth rings by population (the suburbs outside the last line come on top). */
export const ringCount = (pop: number): number => (pop < 120000 ? 2 : pop < 400000 ? 3 : pop < 1500000 ? 4 : 5);

/** Densities grow with the city (more storeys, smaller courts): ×1 at 40 k … ×1.5 at 5 M. */
export const densityScale = (pop: number): number => Math.max(1, Math.min(1.5, 1 + 0.24 * Math.log10(Math.max(1, pop / 40000))));

/** Target quarter area (m²) by zone (the lazy detail of one quarter stays well under 300 ms). */
const QUARTER_AREA: Record<UrbanZone, number> = { core: 42000, middle: 70000, edge: 110000, faubourg: 150000, village: 90000 };

/** Cumulative land area (m²) inside each growth line (k = 1..nR) and the suburbs' outer limit (k = nR + 1). */
function ringAreas(pop: number, nR: number, density: (k: number) => number): number[] {
  // population shares: geometric growth of the enclosed rings, the suburbs outside the last line
  const faubShare = 0.22;
  const wts = Array.from({ length: nR }, (_, k) => Math.pow(1.9, k));
  const wsum = wts.reduce((a, b) => a + b, 0);
  const shares = [...wts.map((w) => (w / wsum) * (1 - faubShare)), faubShare];
  const areas: number[] = [];
  let acc = 0;
  // (+12 %: the streets of the macro graph)
  for (let k = 1; k <= nR + 1; k++) { acc += ((shares[k - 1] * pop) / density(k)) * 1e4 * 1.12; areas.push(acc); }
  return areas;
}

/** Expected radius (m) of a megacity's built-up area (site selection keeps that much land around the site). */
export function megaRadius(pop: number, opts: World['options']): number {
  const plan = resolvePlan(getCulture(opts.culture).id, pop, opts.cultureMix, opts.plan);
  const nR = ringCount(pop), nPh = plan.phases.length, dS = densityScale(pop);
  const sp = Math.max(0.5, Math.min(2, opts.sprawl ?? 1));
  const zone = (k: number): UrbanZone => (k === 1 ? 'core' : k === 2 ? 'middle' : k <= nR ? 'edge' : 'faubourg');
  const dens = (k: number) => (k <= nR ? plan.phases[Math.min(nPh, Math.max(1, Math.round(1 + ((k - 1) * (nPh - 1)) / Math.max(1, nR - 1)))) - 1].morph : plan.faubourg).density[zone(k)] * dS / sp;
  const a = ringAreas(pop, nR, dens);
  return Math.sqrt(a[nR] / Math.PI);
}

export interface MegaResult {
  layer: UrbanLayer;
  stats: Record<string, number | string>;
  bridges: { a: Vec2; b: Vec2; width: number }[];
}

interface Ray { dx: number; dy: number; ds: number; G: Float32Array; L: Float64Array; rmax: number }

/** Cost-driven star rays from the center: growth cost and cumulative land area along each direction. */
function castRays(world: World, c: Vec2, M: number): Ray[] {
  const t = world.terrain, cost = world.site!.cost;
  const n = cost.w, cell = cost.cell, S = world.mapSize;
  const ds = cell * 0.5, dth = TAU / M;
  const rays: Ray[] = [];
  for (let j = 0; j < M; j++) {
    const th = (j / M) * TAU, dx = Math.cos(th), dy = Math.sin(th);
    // distance to the map border, less a margin
    let rb = Infinity;
    if (dx > 1e-9) rb = Math.min(rb, (S - c.x) / dx); else if (dx < -1e-9) rb = Math.min(rb, -c.x / dx);
    if (dy > 1e-9) rb = Math.min(rb, (S - c.y) / dy); else if (dy < -1e-9) rb = Math.min(rb, -c.y / dy);
    const rmax = Math.max(ds * 4, rb - 150);
    const ns = Math.max(2, Math.floor(rmax / ds));
    const G = new Float32Array(ns + 1), L = new Float64Array(ns + 1);
    let g = 0, la = 0;
    for (let s = 1; s <= ns; s++) {
      const r = s * ds;
      const x = c.x + dx * r, y = c.y + dy * r;
      const ix = Math.min(n - 1, Math.max(0, Math.floor(x / cell))), iy = Math.min(n - 1, Math.max(0, Math.floor(y / cell)));
      const i = iy * n + ix;
      if (t.water[i] !== 0) g += ds * 1.4;
      else {
        let cv = cost.data[i];
        if (!Number.isFinite(cv)) cv = g + ds * 4;
        // (monotone, never stalling, never jumping by more than a steep climb would)
        g = Math.max(g + ds * 0.6, Math.min(cv, g + ds * 8));
        la += r * ds * dth;
      }
      G[s] = g; L[s] = la;
    }
    rays.push({ dx, dy, ds, G, L, rmax });
  }
  return rays;
}

/** First sample index with G ≥ C (binary search on the monotone profile). */
function firstAtLeast(G: Float32Array, C: number): number {
  let lo = 0, hi = G.length - 1;
  if (G[hi] < C) return hi;
  while (lo < hi) { const m = (lo + hi) >> 1; if (G[m] >= C) hi = m; else lo = m + 1; }
  return lo;
}

/** Radius per ray of the cost isoline enclosing `target` m² of land. */
function isoRadii(rays: Ray[], target: number): number[] {
  let maxG = 0;
  for (const r of rays) maxG = Math.max(maxG, r.G[r.G.length - 1]);
  let lo = 0, hi = maxG;
  for (let it = 0; it < 48; it++) {
    const C = (lo + hi) / 2;
    let A = 0;
    for (const r of rays) A += r.L[firstAtLeast(r.G, C)];
    if (A < target) lo = C; else hi = C;
  }
  const C = (lo + hi) / 2;
  return rays.map((r) => firstAtLeast(r.G, C) * r.ds);
}

const smoothCirc = (v: number[], w: number, passes: number): number[] => {
  let a = v.slice();
  const M = a.length;
  for (let p = 0; p < passes; p++) {
    const b = a.slice();
    for (let j = 0; j < M; j++) { let s = 0; for (let k = -w; k <= w; k++) s += a[(j + k + M) % M]; b[j] = s / (2 * w + 1); }
    a = b;
  }
  return a;
};

/** Closed polygon simplification (Ramer–Douglas–Peucker, keeping the ring closed). */
function simplifyRing(ring: Polygon, tol: number): Polygon {
  const s = simplify(ring.concat([ring[0]]), tol);
  s.pop();
  return s.length >= 3 ? s : ring;
}

const starPoly = (c: Vec2, r: number[]): Polygon => orientPos(r.map((v, j) => ({ x: c.x + Math.cos((j / r.length) * TAU) * v, y: c.y + Math.sin((j / r.length) * TAU) * v })));

/** Point where the ray from c along angle a leaves the (star-shaped) ring. */
function ringAt(ring: Polygon, c: Vec2, a: number): Vec2 | null {
  const h = rayHit(ring, c, { x: Math.cos(a), y: Math.sin(a) }, 1e6, 0.01);
  return h ? h.p : null;
}

/** First crossing of a polyline with a closed ring (walking from its start). */
function firstCrossing(pl: Polyline, ring: Polygon, idx?: GridIndex<number>): { p: Vec2; seg: number } | null {
  for (let i = 1; i < pl.length; i++) {
    const a = pl[i - 1], b = pl[i];
    let bt = Infinity;
    const test = (k: number) => {
      const r = segSegT(a, b, ring[k], ring[(k + 1) % ring.length]);
      if (r && r.t < bt) bt = r.t;
    };
    if (idx) idx.forEachIn(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y), test);
    else for (let k = 0; k < ring.length; k++) test(k);
    if (bt < Infinity) return { p: { x: a.x + (b.x - a.x) * bt, y: a.y + (b.y - a.y) * bt }, seg: i };
  }
  return null;
}

function ringIndex(ring: Polygon): GridIndex<number> {
  const g = new GridIndex<number>(60);
  for (let k = 0; k < ring.length; k++) g.insertSeg(ring[k], ring[(k + 1) % ring.length], k);
  return g;
}

/** Faces of the graph with the street id of every edge (bounded faces, CCW). */
function labelledFaces(g: StreetGraph): { pts: Vec2[]; st: number[] }[] {
  type HE = { e: number; fwd: boolean; ang: number };
  const alive = g.edges.filter((e) => e.alive);
  const out = new Map<number, HE[]>();
  const all: HE[] = [];
  for (const e of alive) for (const fwd of [true, false]) {
    const p0 = fwd ? e.pts[0] : e.pts[e.pts.length - 1], p1 = fwd ? e.pts[1] : e.pts[e.pts.length - 2];
    const h = { e: e.id, fwd, ang: Math.atan2(p1.y - p0.y, p1.x - p0.x) };
    const from = fwd ? e.a : e.b;
    let l = out.get(from);
    if (!l) out.set(from, (l = []));
    l.push(h); all.push(h);
  }
  for (const l of out.values()) l.sort((x, y) => x.ang - y.ang);
  const key = (h: HE) => h.e * 2 + (h.fwd ? 0 : 1);
  const used = new Set<number>();
  const faces: { pts: Vec2[]; st: number[] }[] = [];
  for (const h0 of all) {
    if (used.has(key(h0))) continue;
    const pts: Vec2[] = [], st: number[] = [];
    let h = h0, guard = 0;
    while (!used.has(key(h)) && guard++ < 200000) {
      used.add(key(h));
      const e = g.edges[h.e];
      const ep = h.fwd ? e.pts : e.pts.slice().reverse();
      for (let i = 0; i < ep.length - 1; i++) { pts.push(ep[i]); st.push(e.street); }
      const to = h.fwd ? e.b : e.a;
      const l = out.get(to)!;
      const twin = h.e * 2 + (h.fwd ? 1 : 0);
      const ti = l.findIndex((x) => key(x) === twin);
      h = l[(ti - 1 + l.length) % l.length];
    }
    if (polygonArea(pts) > 1e-6) faces.push({ pts, st });
  }
  return faces;
}

/** Removes dangling edges (degree-1 nodes) so that every face is a simple ring. */
function pruneDangling(g: StreetGraph): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const nd of g.nodes) {
      if (nd.edges.length !== 1) continue;
      const e = g.edges[nd.edges[0]];
      if (!e.alive || e.a === e.b) continue;
      e.alive = false;
      g.nodes[e.a].edges = g.nodes[e.a].edges.filter((x) => x !== e.id);
      g.nodes[e.b].edges = g.nodes[e.b].edges.filter((x) => x !== e.id);
      changed = true;
    }
  }
}

/** Removes duplicate consecutive vertices and spikes (a vertex whose neighbours coincide) from a labelled ring. */
function cleanLP(lp: LPoly): LPoly | null {
  let pts = lp.pts.slice(), lab = lp.lab.slice();
  for (let pass = 0; pass < 4; pass++) {
    const P: Vec2[] = [], Lb: number[] = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if (dist(a, b) < 0.02) continue; // edge i collapses: drop vertex i+1's predecessor edge
      P.push(a); Lb.push(lab[i]);
    }
    // spikes: p[i-1] == p[i+1]
    const Q: Vec2[] = [], Lq: number[] = [];
    const m = P.length;
    let spiked = false;
    for (let i = 0; i < m; i++) {
      const prev = P[(i - 1 + m) % m], next = P[(i + 1) % m];
      if (m > 3 && dist(prev, next) < 0.02) { spiked = true; continue; }
      Q.push(P[i]); Lq.push(Lb[i]);
    }
    pts = Q; lab = Lq;
    if (!spiked) break;
  }
  if (pts.length < 3 || polygonArea(pts) <= 1) return null;
  return { pts, lab };
}

export function generateMega(world: World, root: Rng, pop: number, eagerPop: number): MegaResult {
  const T0 = performance.now();
  const tm: Record<string, number> = {};
  let tl = T0;
  const lap = (k: string) => { const t = performance.now(); tm[k] = Math.round(t - tl); tl = t; };
  const rng = root.fork('mega');
  const opts = world.options;
  const culture = getCulture(opts.culture);
  const site = world.site!;
  const c = site.center;
  const plan: ResolvedPlan = resolvePlan(culture.id, pop, opts.cultureMix, opts.plan);
  const sprawl = Math.max(0.5, Math.min(2, opts.sprawl ?? 1));
  if (sprawl !== 1) {
    plan.phases = plan.phases.map((ph) => ({ ...ph, morph: applySprawl(ph.morph, sprawl), sectors: ph.sectors.map((sc) => ({ ...sc, morph: applySprawl(sc.morph, sprawl) })) }));
    plan.faubourg = applySprawl(plan.faubourg, sprawl);
  }
  const nR = ringCount(pop);
  const nPh = plan.phases.length;
  const dS = densityScale(pop);
  // morphologies: one per plan phase, its sectors, the faubourg
  const morphs: MorphologyParams[] = [];
  const morphIdx = (m: MorphologyParams): number => { let i = morphs.indexOf(m); if (i < 0) { i = morphs.length; morphs.push(m); } return i; };
  const ringPhase = (k: number) => plan.phases[Math.min(nPh, Math.max(1, Math.round(1 + ((k - 1) * (nPh - 1)) / Math.max(1, nR - 1)))) - 1];
  const zoneOf = (k: number): UrbanZone => (k === 1 ? 'core' : k === 2 ? 'middle' : k <= nR ? 'edge' : 'faubourg');
  const ringMorph = (k: number): MorphologyParams => (k <= nR ? ringPhase(k).morph : plan.faubourg);
  const areas = ringAreas(pop, nR, (k) => ringMorph(k).density[zoneOf(k)] * dS);
  const estR = Math.sqrt(areas[nR] / Math.PI);
  const coreM = ringMorph(1);
  const ctxRadius = Math.min(world.mapSize / 2, estR * 1.7 + 900);
  const ctx: UrbanCtx = makeCtx(world, coreM, ctxRadius);
  lap('ctx');

  // ---- main road angle, terrain and water directions (as the town stage computes them)
  let mainAngle = 0;
  {
    let bl = -1;
    for (const rd of world.roads ?? []) {
      if (rd.kind === 'track') continue;
      const pl = rd.path;
      if (dist(pl[pl.length - 1], c) > 10) continue;
      const q = pl[Math.max(0, pl.length - 12)];
      if (pl.length > bl) { bl = pl.length; mainAngle = Math.atan2(q.y - c.y, q.x - c.x); }
    }
  }
  const terrainAngle = (() => {
    const g = world.terrain.height;
    let gx = 0, gy = 0;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * TAU, dx = Math.cos(a), dy = Math.sin(a);
      const ix = Math.min(g.w - 1, Math.max(0, Math.floor((c.x + dx * 120) / g.cell))), iy = Math.min(g.h - 1, Math.max(0, Math.floor((c.y + dy * 120) / g.cell)));
      const h = g.data[iy * g.w + ix];
      gx += dx * h; gy += dy * h;
    }
    return Math.hypot(gx, gy) < 1e-6 ? 0 : Math.atan2(gy, gx) + Math.PI / 2;
  })();
  const waterAngle = (() => {
    for (let r = 40; r <= 1600; r += 30) {
      let sx = 0, sy = 0, n = 0;
      for (let k = 0; k < 48; k++) { const a = (k / 48) * TAU; if (ctx.isWater({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r })) { sx += Math.cos(a); sy += Math.sin(a); n++; } }
      if (n && Math.hypot(sx, sy) > 1e-6) return Math.atan2(sy, sx);
    }
    return terrainAngle + Math.PI / 2;
  })();

  // ---- growth rings: cost isolines of the land area each phase needs (planned shapes for planned cultures)
  const M = 192;
  const rays = castRays(world, c, M);
  const gap = Math.max(110, 0.05 * estR);
  const radii: number[][] = [];
  for (let k = 0; k <= nR; k++) {
    // growth is never even: lobes and dents of the line (a few low angular frequencies), stronger on the outer lines
    const r = smoothCirc(isoRadii(rays, areas[k]), 3, 2);
    const rn = rng.fork('ringNoise:' + k);
    const amp = (k === nR ? 0.16 : 0.07 + 0.025 * k) * (plan.phases[0].morph.streetOp === 'grid' ? 0.5 : 1);
    const waves = [2, 3, 5].map((f) => ({ f, a: rn.range(0.4, 1) / f ** 0.5, ph: rn.float() * TAU }));
    const wn = waves.reduce((t, w) => t + w.a, 0);
    radii.push(r.map((v, j) => v * (1 + (amp / wn) * waves.reduce((t, w) => t + w.a * Math.sin(w.f * (j / M) * TAU + w.ph), 0))));
  }
  // suburbs grow along the roads: bulges of the outer limit where a road leaves the last ring
  const roadsIn = (world.roads ?? []).filter((r) => r.kind !== 'track');
  {
    const last = radii[nR - 1], out = radii[nR];
    for (const rd of roadsIn) {
      const pl = rd.path;
      // the road point nearest the last ring line, in angle
      let best: Vec2 | null = null;
      for (let i = pl.length - 1; i >= 0; i--) {
        const a = Math.atan2(pl[i].y - c.y, pl[i].x - c.x);
        const j = ((Math.round((a / TAU) * M) % M) + M) % M;
        if (dist(pl[i], c) >= last[j]) { best = pl[i]; break; }
      }
      if (!best) continue;
      const a0 = Math.atan2(best.y - c.y, best.x - c.x);
      for (let j = 0; j < M; j++) {
        let d = (j / M) * TAU - a0;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        const arc = Math.abs(d) * out[j];
        out[j] += (0.35 * (out[j] - last[j]) + 250) * Math.exp(-((arc / 420) ** 2));
      }
    }
  }
  // nesting and the map border: ring k keeps (nR + 1 − k) gaps inside the border and one gap outside ring k − 1
  for (let k = 0; k <= nR; k++) for (let j = 0; j < M; j++) {
    const lim = rays[j].rmax - (nR - k) * gap;
    const lo = (k === 0 ? 120 + 0.02 * estR : radii[k - 1][j] + gap);
    radii[k][j] = Math.max(lo, Math.min(radii[k][j], lim));
  }
  for (let k = 0; k <= nR; k++) radii[k] = smoothCirc(radii[k], 1, 1);
  for (let k = 1; k <= nR; k++) for (let j = 0; j < M; j++) radii[k][j] = Math.max(radii[k][j], radii[k - 1][j] + gap * 0.8);
  const rings: Polygon[] = [];
  for (let k = 1; k <= nR + 1; k++) {
    const r = radii[k - 1];
    const meanR = r.reduce((a, b) => a + b, 0) / r.length;
    const enc = k <= nR ? ringPhase(k).enc : null;
    const shape = enc ? (enc.shape === 'terraces' ? 'rect' : enc.shape) : 'organic';
    if (shape !== 'organic' && k <= nR) {
      // planned enclosure: the culture's figure, concentric, with the ring's area
      const ang = enc!.orientation === 'cardinal' ? 0 : enc!.orientation === 'terrain' ? terrainAngle : enc!.orientation === 'water' ? waterAngle : mainAngle;
      const A = Math.PI * meanR * meanR;
      const asp = enc!.aspect ? (enc!.aspect[0] + enc!.aspect[1]) / 2 : 1.3;
      rings.push(orientPos(shapePolygon(shape, c, ang, A, asp)));
    } else {
      // organic lines: polygonal curtains (straight stretches of 1–2 % of the radius)
      rings.push(orientPos(simplifyRing(starPoly(c, r), Math.max(4, Math.min(60, 0.008 * meanR)))));
    }
  }
  const outer = rings[nR];
  const ringR = rings.map((r) => Math.sqrt(area(r) / Math.PI));
  lap('rings');

  // ---- walls: which ring lines still stand (the last two of a big city), which became boulevards
  const wallsOpt = opts.walls === 'no' ? 'none' : opts.walls === 'yes' ? 'single' : opts.walls;
  const wallKind = plan.phases[nPh - 1].enc.wall;
  const walledCulture = wallKind !== 'none' && wallKind !== 'hedge';
  const standing = new Set<number>();
  if (wallsOpt !== 'none' && walledCulture) {
    standing.add(nR);
    if (nR >= 3 && wallsOpt !== 'single') standing.add(nR - 1);
    if (wallsOpt === 'double' && nR >= 2) standing.add(nR - 1);
  }

  // ---- streets of the macro graph (ids = indices); label map for quarter edges
  const mstreets: MacroStreet[] = [];
  const labelOf: number[] = [];
  const addStreet = (path: Polyline, width: number, rank: number, role: StreetRole, phase: number, label?: number): number => {
    const id = mstreets.length;
    mstreets.push({ path, widths: path.map(() => width), rank, role, phase });
    labelOf.push(label ?? id);
    return id;
  };
  const g = new StreetGraph();
  const segIdx = new GridIndex<{ a: Vec2; b: Vec2 }>(80);
  const insert = (pl: Polyline, id: number, merge = 0): void => {
    const st = mstreets[id];
    g.insertPolyline(pl, { width: st.widths[0], rank: st.rank, phase: st.phase, kind: st.role === 'ring' ? 'ring' : st.role === 'radial' ? 'radial' : 'street', street: id }, { snapR: 1.5, mergeDist: merge, mergeAngleDeg: 12 });
    for (let i = 1; i < pl.length; i++) segIdx.insertSeg(pl[i - 1], pl[i], { a: pl[i - 1], b: pl[i] });
  };
  const closed = (r: Polygon): Polyline => [...r, r[0]];
  // the market at the meeting of the main roads
  const toCenter = roadsIn.filter((r) => dist(r.path[r.path.length - 1], c) < 10).sort((a, b) => (a.kind === b.kind ? b.path.length - a.path.length : a.kind === 'major' ? -1 : 1));
  const marketA = pop > 500000 ? 14000 : 9000;
  const market = makeMarket(c, toCenter.map((r) => r.path), marketA, rng.fork('market'), mainAngle);
  const marketId = addStreet(closed(market), 12, 0, 'ring', 1);
  insert(closed(market), marketId);
  // ring lines: boulevards on the old lines, wall lines (quarter edges labelled LAB_WALL), the outer limit (open)
  const ringIds: number[] = [];
  for (let k = 1; k <= nR + 1; k++) {
    const r = rings[k - 1];
    let id: number;
    if (k === nR + 1) id = addStreet(closed(r), 0, 0, 'boundary', k, LAB_OPEN);
    else if (standing.has(k)) id = addStreet(closed(r), 0, 0, 'wall-lane', k, LAB_WALL);
    else id = addStreet(closed(r), Math.min(28, 14 + 0.0012 * ringR[k - 1]), 0, 'ring', k);
    ringIds.push(id);
    insert(closed(r), id);
  }
  const ringIdx = rings.map(ringIndex);
  lap('lines');

  // ---- radials: the regional roads (the main ones to the market, the others from the old core line), then new
  // radials out of every ring where the gap between two radials is too wide (more gates in every new wall)
  const radialPaths: Polyline[] = [];
  const radW = (k: number) => Math.min(18, 10 + 0.0006 * ringR[Math.max(0, k - 1)]);
  const coreN = Math.max(3, Math.min(6, toCenter.length));
  roadsIn.forEach((rd) => {
    const reaches = toCenter.indexOf(rd);
    const inner = reaches >= 0 && reaches < coreN ? market : rings[0];
    // centre → out
    let pl = rd.path.slice().reverse();
    pl = simplify(pl, 0.8);
    if (pl.length < 2) return;
    // cut off the part inside the inner line
    let start = 0, sp: Vec2 | null = null;
    if (pointInRing(inner, pl[0])) {
      const x = firstCrossing(pl, inner);
      if (!x) return;
      start = x.seg; sp = x.p;
    }
    let path = (sp ? [sp] : []).concat(pl.slice(start));
    if (!sp && !pointInRing(outer, path[0])) return;
    const x2 = firstCrossing(path, outer, ringIdx[nR]);
    if (!x2) return;
    path = path.slice(0, x2.seg).concat([x2.p]);
    if (polylineLength(path) < 40) return;
    const k0 = inner === market ? 1 : 2;
    const id = addStreet(path, radW(k0), 0, 'radial', k0);
    insert(path, id, 6);
    radialPaths.push(path);
  });
  // a city needs at least three ways out of its market
  {
    const angs = radialPaths.filter((p) => dist(p[0], c) < Math.sqrt(marketA) * 2).map((p) => Math.atan2(p[1].y - c.y, p[1].x - c.x));
    const rn = rng.fork('synthradial');
    for (let k = 0; angs.length < 3 && k < 6; k++) {
      // the widest angular gap
      const s = angs.slice().sort((a, b) => a - b);
      let ga = rn.float() * TAU, gw = TAU;
      for (let i = 0; i < s.length; i++) { const a = s[i], b = i + 1 < s.length ? s[i + 1] : s[0] + TAU; if (s.length && b - a >= (gw === TAU ? 0 : gw)) { gw = b - a; ga = a + gw / 2; } }
      const p0 = ringAt(market, c, ga), p1 = ringAt(outer, c, ga);
      if (!p0 || !p1) break;
      const path = polarPath(c, p0, p1, ga, 0, rn);
      const id = addStreet(path, radW(1), 0, 'radial', 1);
      insert(path, id, 6);
      radialPaths.push(path);
      angs.push(ga);
    }
  }
  const spacing = Math.max(650, Math.min(1500, 520 + 0.3 * Math.sqrt(pop)));
  const rr = rng.fork('radials');
  for (let k = 1; k <= nR; k++) {
    const ring = rings[k - 1];
    const angs: number[] = [];
    for (const pl of radialPaths) {
      const x = firstCrossing(pl, ring, ringIdx[k - 1]);
      if (x) angs.push(Math.atan2(x.p.y - c.y, x.p.x - c.x));
    }
    angs.sort((a, b) => a - b);
    const meanR = ringR[k - 1];
    const add: number[] = [];
    for (let i = 0; i < angs.length; i++) {
      const a = angs[i], b = i + 1 < angs.length ? angs[i + 1] : angs[0] + TAU;
      const arc = (b - a) * meanR;
      if (arc < 1.75 * spacing) continue;
      const m = Math.round(arc / spacing) - 1;
      for (let q = 1; q <= m; q++) add.push(a + ((b - a) * q) / (m + 1) + rr.range(-0.12, 0.12) * ((b - a) / (m + 1)));
    }
    for (const a of add) {
      const p0 = ringAt(ring, c, a), p1 = ringAt(outer, c, a);
      if (!p0 || !p1 || dist(p0, p1) < 2 * gap) continue;
      const path = polarPath(c, p0, p1, a, 0.18 * (spacing / Math.max(400, meanR)), rr);
      const id = addStreet(path, radW(k + 1) * 0.85, 0, 'radial', k + 1);
      insert(path, id, 6);
      radialPaths.push(path);
    }
  }
  lap('radials');

  // ---- nuclei: the main core, fused satellite towns (polycentric), absorbed villages with their green
  const nuclei: MacroNucleus[] = [{ p: c, kind: 'main', r: ringR[0] }];
  const nr = rng.fork('nuclei');
  // fused towns: older market towns the city grew into (own wall or boulevard, market, streets converging on it)
  const nTown = pop >= 2500000 ? 4 : pop >= 1000000 ? 3 : pop >= 400000 ? 2 : pop >= 150000 ? 1 : 0;
  const townR = Math.max(300, Math.min(900, 250 + 0.25 * Math.sqrt(pop)));
  const nVill = Math.max(1, Math.min(22, Math.round(pop / 110000)));
  const free = (p: Vec2, r: number): boolean => {
    if (ctx.isWater(p) || !pointInRing(outer, p)) return false;
    for (const s of segIdx.queryPt(p, r)) if (distToSeg(p, s.a, s.b) < r) return false;
    for (const nu of nuclei) if (dist(nu.p, p) < r + nu.r * 1.8 + 400) return false;
    return true;
  };
  const tryNucleus = (kind: 'town' | 'village', rIn: number, rOut: number, R: number, tries: number): MacroNucleus | null => {
    for (let t = 0; t < tries; t++) {
      // on a radial (a village grew on its road) or between two
      const onRoad = nr.chance(0.7) && radialPaths.length;
      let p: Vec2;
      if (onRoad) {
        const pl = radialPaths[nr.int(0, radialPaths.length - 1)];
        const L = polylineLength(pl);
        const s = nr.range(0.15, 0.85) * L;
        let acc2 = 0, q = pl[0];
        for (let i = 1; i < pl.length; i++) { const d = dist(pl[i - 1], pl[i]); if (acc2 + d >= s) { const u = (s - acc2) / d; q = { x: pl[i - 1].x + (pl[i].x - pl[i - 1].x) * u, y: pl[i - 1].y + (pl[i].y - pl[i - 1].y) * u }; break; } acc2 += d; }
        // the green beside the road
        const a = Math.atan2(q.y - c.y, q.x - c.x) + (nr.chance(0.5) ? 1 : -1) * Math.PI / 2;
        p = { x: q.x + Math.cos(a) * (R + 30), y: q.y + Math.sin(a) * (R + 30) };
      } else {
        const a = nr.float() * TAU;
        const rr2 = nr.range(rIn, rOut);
        p = { x: c.x + Math.cos(a) * rr2, y: c.y + Math.sin(a) * rr2 };
      }
      const d = dist(p, c);
      if (d < rIn || d > rOut) continue;
      if (kind === 'village' ? !free(p, R + 45) : ctx.isWater(p) || !pointInRing(outer, p) || nuclei.some((nu) => dist(nu.p, p) < R + nu.r * 1.8 + 600)) continue;
      // not astride a ring line
      if (rings.some((rg) => Math.abs(d - (ringAt(rg, c, Math.atan2(p.y - c.y, p.x - c.x)) ? dist(ringAt(rg, c, Math.atan2(p.y - c.y, p.x - c.x))!, c) : 0)) < R + 80)) continue;
      return { p, kind, r: R };
    }
    return null;
  };
  for (let k = 0; k < nTown; k++) {
    // (a smaller town where the bands between the ring lines are narrow)
    let nu: MacroNucleus | null = null;
    for (let f = 1; f >= 0.55 && !nu; f -= 0.15) {
      const Rt = townR * f * nr.range(0.9, 1.1);
      nu = tryNucleus('town', ringR[Math.min(1, nR - 1)] + Rt + 200, ringR[nR] - Rt - 150, Rt, 45);
    }
    if (nu) nuclei.push(nu);
  }
  for (let k = 0; k < nVill; k++) {
    const nu = tryNucleus('village', ringR[Math.min(nR - 1, 1)] + 150, ringR[nR] - 250, nr.range(26, 42), 40);
    if (nu) nuclei.push(nu);
  }
  // their greens / markets, ring boulevards and spokes (joined to the first street they meet)
  const spokeTo = (p0: Vec2, a: number, maxL: number): Vec2 | null => {
    const d = { x: Math.cos(a), y: Math.sin(a) };
    const q = { x: p0.x + d.x * maxL, y: p0.y + d.y * maxL };
    let bt = Infinity;
    for (const s of segIdx.query(Math.min(p0.x, q.x), Math.min(p0.y, q.y), Math.max(p0.x, q.x), Math.max(p0.y, q.y))) {
      const r = segSegT(p0, q, s.a, s.b);
      if (r && r.t > 1e-4 && r.t < bt) bt = r.t;
    }
    return bt < Infinity ? { x: p0.x + (q.x - p0.x) * bt, y: p0.y + (q.y - p0.y) * bt } : null;
  };
  const nucStreets: number[] = [];
  for (let ni = 1; ni < nuclei.length; ni++) {
    const nu = nuclei[ni];
    const isTown = nu.kind === 'town';
    const greenR = isTown ? 55 : nu.r;
    const sides = isTown ? 9 : 10;
    const a0 = nr.float() * TAU;
    const green: Polygon = orientPos(Array.from({ length: sides }, (_, k) => {
      const a = a0 + (k / sides) * TAU, rk = greenR * nr.range(0.8, 1.15);
      return { x: nu.p.x + Math.cos(a) * rk, y: nu.p.y + Math.sin(a) * rk };
    }));
    // spokes first (a green with no way out is not built)
    const nSp = isTown ? 6 : nr.int(3, 5);
    const spokes: Polyline[] = [];
    const ringLine: Polygon | null = isTown ? orientPos(Array.from({ length: 24 }, (_, k) => {
      const a = (k / 24) * TAU, rk = nu.r * (1 + 0.12 * Math.sin(3 * a + a0) + nr.range(-0.04, 0.04));
      return { x: nu.p.x + Math.cos(a) * rk, y: nu.p.y + Math.sin(a) * rk };
    })) : null;
    for (let s = 0; s < nSp; s++) {
      const a = a0 + ((s + 0.5) / nSp) * TAU + nr.range(-0.2, 0.2);
      const p0 = ringAt(green, nu.p, a);
      if (!p0) continue;
      if (ringLine) {
        // inside the satellite's own line: to the line; the outer spokes continue to the city's streets
        const pr = ringAt(ringLine, nu.p, a);
        if (!pr) continue;
        spokes.push(polarPath(nu.p, p0, pr, a, 0.05, nr));
        const hit = spokeTo({ x: pr.x + Math.cos(a) * 0.5, y: pr.y + Math.sin(a) * 0.5 }, a, 1800);
        if (hit) spokes.push(polarPath(nu.p, pr, hit, a, 0.04, nr));
      } else {
        const hit = spokeTo(p0, a, 1500);
        if (hit) spokes.push(polarPath(nu.p, p0, hit, a, 0.06, nr));
      }
    }
    if (spokes.length < 2) { nuclei.splice(ni, 1); ni--; continue; }
    const gid = addStreet(closed(green), isTown ? 12 : 8, isTown ? 0 : 1, 'ring', 1);
    insert(closed(green), gid);
    nucStreets.push(gid);
    if (ringLine) {
      // (most fused towns kept their walls: a standing line inside the city, with its gates on the spokes)
      nu.ring = ringLine;
      nu.walled = walledCulture && wallsOpt !== 'none' && nr.chance(0.65);
      const rid = nu.walled ? addStreet(closed(ringLine), 0, 0, 'wall-lane', 2, LAB_WALL) : addStreet(closed(ringLine), 16, 0, 'ring', 2);
      insert(closed(ringLine), rid);
      nucStreets.push(rid);
    }
    for (const sp of spokes) {
      const id = addStreet(sp, isTown ? 12 : 9, isTown ? 0 : 1, 'radial', 2);
      insert(sp, id, 4);
      nucStreets.push(id);
    }
  }
  lap('nuclei');

  // ---- cells: the graph's faces, minus the water
  pruneDangling(g);
  const faces = labelledFaces(g);
  const water = ctx.water;
  const waterBB = water.map((ph) => bboxOf(ph.outer));
  let cells: LPoly[] = [];
  for (const f of faces) {
    const lp0 = cleanLP({ pts: f.pts, lab: f.st.map((s) => labelOf[s] ?? LAB_OPEN) });
    if (!lp0) continue;
    const bb = bboxOf(lp0.pts);
    const wet = water.length && waterBB.some((w) => !(w.x0 > bb.x1 || w.x1 < bb.x0 || w.y0 > bb.y1 || w.y1 < bb.y0));
    if (!wet) { cells.push(lp0); continue; }
    const res = differenceS(lp0.pts, water);
    const pieces: MultiPoly = [];
    for (const ph of res) pieces.push(...(ph.holes.length ? openHoles(ph) : [ph]));
    for (const ph of pieces) {
      const pts = orientPos(ph.outer);
      if (area(pts) < 150) continue;
      const lab = pts.map((a, i) => {
        const b = pts[(i + 1) % pts.length];
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const loc = locate(lp0.pts, m);
        if (loc.d < 0.05 && distToSeg(a, lp0.pts[loc.edge], lp0.pts[(loc.edge + 1) % lp0.pts.length]) < 0.05 && distToSeg(b, lp0.pts[loc.edge], lp0.pts[(loc.edge + 1) % lp0.pts.length]) < 0.05) return lp0.lab[loc.edge];
        return LAB_WATER;
      });
      const lp = cleanLP({ pts, lab });
      if (lp) cells.push(lp);
    }
  }
  lap('faces');

  // ---- secondary arterials: cells split by chords along the radial / tangential field of the nearest nucleus
  const influence = (nu: MacroNucleus) => (nu.kind === 'main' ? Infinity : nu.kind === 'town' ? nu.r * 2.2 : 520);
  const nucleusFor = (p: Vec2): number => {
    let best = 0, bd = Infinity;
    for (let i = 1; i < nuclei.length; i++) { const d = dist(p, nuclei[i].p); if (d < influence(nuclei[i]) && d < bd) { bd = d; best = i; } }
    return best;
  };
  const ringOf = (p: Vec2): number => { for (let k = 1; k <= nR; k++) if (pointInRing(rings[k - 1], p)) return k; return nR + 1; };
  const noise = new Noise2D(rng.fork('arterialNoise'));
  const split = rng.fork('split');
  const quarterArea = (k: number) => QUARTER_AREA[zoneOf(k)] * Math.max(0.7, Math.min(1.6, Math.sqrt(sprawl)));
  const isMarketFace = (lp: LPoly) => lp.lab.every((l) => l === labelOf[marketId]) && pointInRing(lp.pts, c);
  const greenFace = (lp: LPoly): number => {
    for (let i = 1; i < nuclei.length; i++) if (pointInRing(lp.pts, nuclei[i].p) && lp.lab.every((l) => nucStreets.includes(l))) return i;
    return -1;
  };
  // the palace city: a large lot in the middle rings, by the water or on high ground, away from the old towns
  const palaceA = Math.max(40000, Math.min(900000, pop * 0.18));
  let palaceP: Vec2 | null = null;
  {
    const pr = rng.fork('palace');
    const h0 = ctx.heightAt(c);
    let bs = -Infinity;
    const k1 = Math.min(nR, 2), k2 = Math.max(k1, nR - 1);
    for (let k = k1; k <= k2; k++) for (let j = 0; j < 36; j++) {
      const a = (j / 36) * TAU + pr.range(-0.05, 0.05);
      const p0 = ringAt(rings[k - 2] ?? market, c, a), p1 = ringAt(rings[k - 1], c, a);
      if (!p0 || !p1) continue;
      const p = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      if (ctx.isWater(p) || nuclei.some((nu, i) => i > 0 && dist(nu.p, p) < nu.r + 700)) continue;
      let wet = 0;
      for (let q = 0; q < 8; q++) if (ctx.isWater({ x: p.x + Math.cos((q / 8) * TAU) * 350, y: p.y + Math.sin((q / 8) * TAU) * 350 })) wet = 1;
      const sc = 1.2 * wet + (ctx.heightAt(p) - h0) / 50 + pr.float() * 0.8;
      if (sc > bs) { bs = sc; palaceP = p; }
    }
  }
  const final: { lp: LPoly; kind: MacroQuarter['kind']; nucleus: number; tag?: 'palace' }[] = [];
  const queue: LPoly[] = cells.slice().reverse();
  let guard = 0;
  while (queue.length && guard++ < 40000) {
    const X = queue.pop()!;
    if (isMarketFace(X)) { final.push({ lp: X, kind: 'market', nucleus: 0 }); continue; }
    const gf = greenFace(X);
    if (gf >= 0) { final.push({ lp: X, kind: nuclei[gf].kind === 'town' ? 'market' : 'place', nucleus: gf }); continue; }
    const A = area(X.pts);
    const ob = obb(X.pts);
    const k = ringOf(ob.c);
    const T = quarterArea(k);
    const ni = nucleusFor(ob.c);
    const pal = !!palaceP && pointInRing(X.pts, palaceP);
    const Tn = pal ? palaceA : ni > 0 && dist(ob.c, nuclei[ni].p) < (nuclei[ni].kind === 'town' ? nuclei[ni].r : 300) ? QUARTER_AREA.core : T;
    if (A < 1.55 * Tn && ob.hu / Math.max(1, ob.hv) < (pal ? 2.2 : 3.2)) {
      if (pal && A > 0.45 * palaceA) { final.push({ lp: X, kind: 'lot', nucleus: ni, tag: 'palace' }); palaceP = null; } else final.push({ lp: X, kind: 'quarter', nucleus: ni });
      continue;
    }
    const m = ringMorph(k);
    const nu = nuclei[ni].p;
    let th: number;
    if (m.streetOp === 'grid' && ni === 0) th = m.orientation === 'cardinal' ? 0 : m.orientation === 'terrain' ? terrainAngle : m.orientation === 'water' ? waterAngle : mainAngle;
    else th = Math.atan2(ob.c.y - nu.y, ob.c.x - nu.x) + 0.45 * noise.fbm(ob.c.x / 1600, ob.c.y / 1600, 2) + split.range(-0.14, 0.14);
    const fams = [th, th + Math.PI / 2];
    const perpU = fams.map((f) => Math.abs(Math.cos(f) * ob.u.x + Math.sin(f) * ob.u.y));
    const order = perpU[0] <= perpU[1] ? [1, 0] : [0, 1];
    let best: { A: LPoly; B: LPoly; chord: Polyline; cost: number } | null = null;
    for (const fi of order) {
      const f = fams[fi];
      const d = { x: Math.cos(f), y: Math.sin(f) };
      for (const t of [0.5, 0.42, 0.58, 0.34, 0.66]) {
        const tt = t + split.range(-0.03, 0.03);
        const seed = { x: ob.c.x + ob.u.x * (tt - 0.5) * 2 * ob.hu * 0.9, y: ob.c.y + ob.u.y * (tt - 0.5) * 2 * ob.hu * 0.9 };
        if (!pointInRing(X.pts, seed)) continue;
        const h1 = rayHit(X.pts, seed, d, 1e5, 0.01), h2 = rayHit(X.pts, seed, { x: -d.x, y: -d.y }, 1e5, 0.01);
        if (!h1 || !h2) continue;
        const L = dist(h1.p, h2.p);
        if (L < 60) continue;
        // a gentle bend (organic arterials), straight in planned grids
        const bend = m.streetOp === 'grid' ? 0 : split.range(-0.035, 0.035) * L;
        const mid = { x: seed.x - d.y * bend, y: seed.y + d.x * bend };
        let res = splitByChord(X, [h2.p, mid, h1.p], TMP);
        let chord: Polyline = [h2.p, mid, h1.p];
        if (!res) { res = splitByChord(X, [h2.p, seed, h1.p], TMP); chord = [h2.p, seed, h1.p]; }
        if (!res) continue;
        const [P1, P2] = res;
        const a1 = area(P1.pts), a2 = area(P2.pts);
        if (Math.min(a1, a2) < 0.28 * Tn) continue;
        // junction angles with the edges the chord ends on
        let bad = false;
        for (const h of [h1, h2]) {
          const e0 = X.pts[h.edge], e1 = X.pts[(h.edge + 1) % X.pts.length];
          const el = dist(e0, e1) || 1;
          const sn = Math.abs(((e1.x - e0.x) * d.y - (e1.y - e0.y) * d.x) / el);
          if (sn < Math.sin((32 * Math.PI) / 180)) bad = true;
        }
        if (bad) continue;
        const o1 = obb(P1.pts), o2 = obb(P2.pts);
        const cost = Math.abs(a1 - a2) / (a1 + a2) + (fi === order[0] ? 0 : 0.2) + 0.12 * Math.max(0, o1.hu / Math.max(1, o1.hv) - 2.5) + 0.12 * Math.max(0, o2.hu / Math.max(1, o2.hv) - 2.5);
        if (!best || cost < best.cost) best = { A: P1, B: P2, chord, cost };
      }
    }
    if (!best) { final.push({ lp: X, kind: 'quarter', nucleus: ni }); continue; }
    const L = polylineLength(best.chord);
    const rank = L > 900 || A > 6 * Tn ? 1 : 2;
    const id = addStreet(best.chord, rank === 1 ? Math.min(14, 8 + 0.0004 * ringR[Math.min(nR, k) - 1]) : 7, rank, 'street', k);
    for (const Y of [best.A, best.B]) Y.lab = Y.lab.map((l) => (l === TMP ? id : l));
    queue.push(best.B, best.A);
  }
  lap('split');

  // ---- quarters: phase, zone, morphology, density, culture, nucleus, district
  const quarters: MacroQuarter[] = [];
  let palaceQ: MacroQuarter | null = null;
  const mstreetsObj = new Streets();
  for (const st of mstreets) mstreetsObj.add(st.path, st.widths, st.rank, st.role, st.phase, st.widths[0] > 0);
  const fsec = (ph: ResolvedPlan['phases'][number], p: Vec2): { morph: MorphologyParams; culture: string } => {
    if (!ph.sectors.length) return { morph: ph.morph, culture: ph.culture };
    let a = Math.atan2(p.y - c.y, p.x - c.x) - mainAngle;
    a = ((a % TAU) + TAU) % TAU / TAU;
    let acc2 = 0;
    for (const s of ph.sectors) { if (a >= acc2 && a < acc2 + s.share) return { morph: s.morph, culture: s.culture }; acc2 += s.share; }
    return { morph: ph.morph, culture: ph.culture };
  };
  for (const f of final) {
    const pts = f.lp.pts;
    const ip = innerPoint(pts);
    const k = ringOf(ip);
    let zone = zoneOf(k);
    let morph = ringMorph(k), cul = k <= nR ? ringPhase(k).culture : culture.id;
    if (k <= nR) { const s = fsec(ringPhase(k), ip); morph = s.morph; cul = s.culture; }
    let district: MacroDistrict = k === 1 ? 'old-town' : k <= nR ? 'town' : 'suburb';
    const nu = nuclei[f.nucleus];
    if (f.nucleus > 0) {
      const dn = dist(ip, nu.p);
      if (nu.kind === 'town' && dn < nu.r) { zone = 'core'; morph = ringPhase(1).morph; district = 'satellite'; }
      else if (nu.kind === 'village' && dn < 300) { zone = k > nR ? 'middle' : zone; morph = plan.phases[0].morph; district = 'village'; }
    }
    if (f.kind === 'market') district = 'market';
    const A = area(pts);
    const dens = f.kind === 'quarter' ? morph.density[zone] * dS : 0;
    const bb = bboxOf(pts);
    quarters.push({
      id: quarters.length, pts, lab: f.lp.lab, phase: k, zone, age: k, kind: f.kind, morph: morphIdx(morph), culture: cul,
      density: Math.round(dens), pop: Math.round((dens * A) / 1e4), district, nucleus: f.nucleus, wants: [], area: Math.round(A),
      bb: [bb.x0, bb.y0, bb.x1, bb.y1], inset: [],
    });
    if (f.tag === 'palace') palaceQ = quarters[quarters.length - 1];
  }
  morphIdx(plan.faubourg);

  // ---- city-rank landmarks: the cathedral close by the market, the palace city, parish churches and abbeys;
  // the port districts along the water (quays), craftsmen's quarters by the water outside the walls
  const sites: UrbanSite[] = [];
  const lines: UrbanLine[] = [];
  const quays: Polyline[] = [];
  const lm = rng.fork('landmarks');
  const marketLab = labelOf[marketId];
  const byScore = <T>(list: T[], f: (x: T) => number): T | undefined => { let b: T | undefined, bs = -Infinity; for (const x of list) { const s = f(x); if (s > bs) { bs = s; b = x; } } return b; };
  const cat = byScore(quarters.filter((q) => q.kind === 'quarter' && q.phase === 1 && q.lab.includes(marketLab)), (q) => Math.min(q.area, 60000) + lm.float() * 5000);
  if (cat) {
    cat.wants.push({ kind: 'm4-cathedral-close', place: 'near-nucleus', area: [9000, 30000], data: { kind: 'cathedral-close', ang: 0, Lc: pop > 500000 ? 135 : 115 } });
    cat.district = 'cathedral';
  }
  if (palaceQ) {
    const pal = palaceQ as MacroQuarter;
    const ip = innerPoint(pal.pts);
    pal.compound = 'm4-palace'; pal.district = 'palace'; pal.density = 20; pal.pop = Math.round((pal.area * 20) / 1e4);
    pal.data = { kind: 'palace', ang: Math.atan2(c.y - ip.y, c.x - ip.x) };
    sites.push({ id: 'palace', kind: 'palace', role: 'power', lot: pal.pts, anchor: ip, culture: pal.culture });
  }
  // parks, hunting grounds and great cemeteries: a few large green quarters in the outer rings
  {
    const nPark = pop >= 1000000 ? 2 + Math.floor(pop / 2000000) : pop >= 200000 ? 1 : 0;
    const pk = rng.fork('parks');
    const cands = quarters.filter((q) => q.kind === 'quarter' && q.phase >= Math.min(3, nR) && q.district !== 'village' && q.district !== 'satellite' && q.area > 0.7 * quarterArea(q.phase));
    const chosenP: MacroQuarter[] = [];
    for (let t = 0; t < nPark && cands.length; t++) {
      const q = byScore(cands, (x) => {
        const ip = innerPoint(x.pts);
        const dO = Math.min(...chosenP.map((y) => dist(innerPoint(y.pts), ip)), 1e9);
        return Math.min(dO, 4000) / 1000 + ctx.slopeAt(ip) * 20 + x.area / 300000 + pk.float();
      });
      if (!q) break;
      chosenP.push(q);
      cands.splice(cands.indexOf(q), 1);
      q.kind = 'lot'; q.district = 'gardens'; q.density = 0; q.pop = 0; q.wants = [];
      sites.push({ id: 'park:' + q.id, kind: 'park', role: 'civic', lot: q.pts, anchor: innerPoint(q.pts), culture: q.culture });
    }
  }
  // parish churches (one quarter in two in the old rings, one in four outside), abbeys in the outer rings
  for (const q of quarters) {
    if (q.kind !== 'quarter') continue;
    const r = new Rng(rng.seedKey + '\u0001lm:' + q.id);
    const p = q.district === 'village' || q.district === 'satellite' ? 0.8 : q.phase <= 2 ? 0.5 : q.phase <= nR ? 0.3 : 0.22;
    if (r.chance(p)) q.wants.push({ kind: 'parish-church', place: 'near-nucleus', area: [700, 5000] });
    if (q.phase >= 3 && q.area > 70000 && r.chance(0.12)) q.wants.push({ kind: 'm4-monastery', place: 'edge', area: [9000, 26000], data: { kind: 'monastery', ang: 0, order: 'Benedictine' } });
  }
  // ports: quarters along wide water inside or near the walls; their water edges become quays
  {
    const nW = Math.max(1, Math.round(nR / 2));
    for (const q of quarters) {
      if (q.kind !== 'quarter' || q.district === 'palace') continue;
      let wetL = 0;
      for (let i = 0; i < q.pts.length; i++) if (q.lab[i] === LAB_WATER) wetL += dist(q.pts[i], q.pts[(i + 1) % q.pts.length]);
      if (wetL < 140) continue;
      if (q.phase > nR + 0) { if (q.phase === nR + 1 && wetL > 220) q.district = 'craft'; continue; }
      if (q.phase > nR - nW + 1 && q.phase !== 1 && lm.chance(0.35)) continue;
      q.district = 'port';
      // runs of water edges → quay streets
      const n = q.pts.length;
      let s0 = q.lab.findIndex((l, i) => l === LAB_WATER && q.lab[(i - 1 + n) % n] !== LAB_WATER);
      if (s0 < 0) continue; // all water edges: an island quarter, no quay
      for (let k = 0; k < n; k++) {
        const i = (s0 + k) % n;
        if (q.lab[i] !== LAB_WATER || q.lab[(i - 1 + n) % n] === LAB_WATER) continue;
        const run: Vec2[] = [q.pts[i]];
        const idxs: number[] = [];
        let j = i;
        while (q.lab[j] === LAB_WATER && idxs.length < n) { idxs.push(j); run.push(q.pts[(j + 1) % n]); j = (j + 1) % n; }
        if (polylineLength(run) < 60) continue;
        const id = addStreet(run, 10, 2, 'quay', q.phase);
        mstreetsObj.add(run, run.map(() => 10), 2, 'quay', q.phase, true);
        for (const e of idxs) q.lab[e] = id;
        quays.push(run);
        lines.push({ kind: 'quay-edge', path: run, width: 1.1 });
      }
      void s0;
    }
    const ports = quarters.filter((q) => q.district === 'port');
    if (ports.length) {
      const pq = byScore(ports, (q) => -dist(innerPoint(q.pts), c));
      if (pq) sites.push({ id: 'harbour', kind: 'river-port', role: 'port', lot: pq.pts, anchor: innerPoint(pq.pts), culture: pq.culture });
    }
  }
  for (let i = 1; i < nuclei.length; i++) {
    const nu = nuclei[i];
    const ring = orientPos(convexHull(Array.from({ length: 12 }, (_, k) => ({ x: nu.p.x + Math.cos((k / 12) * TAU) * Math.max(120, nu.r), y: nu.p.y + Math.sin((k / 12) * TAU) * Math.max(120, nu.r) }))));
    sites.push({ id: (nu.kind === 'town' ? 'town:' : 'village:') + i, kind: nu.kind === 'town' ? 'satellite-town' : 'absorbed-village', role: 'suburb', lot: ring, anchor: nu.p, culture: culture.id });
  }
  lap('districts');

  // ---- stand-in blocks (the quarter inset by its streets' half widths) and the density raster
  for (const q of quarters) {
    const ins = q.kind === 'market' || q.kind === 'place' ? null : insetPiece({ pts: q.pts, lab: q.lab }, mstreetsObj, (2.6 + 3) / 2);
    q.inset = ins ?? q.pts;
  }
  const S = world.mapSize;
  const dcell = Math.max(60, S / 640);
  const dw = Math.ceil(S / dcell);
  const cov = new Float32Array(dw * dw);
  let dmax = 0;
  for (const q of quarters) {
    const f = q.kind === 'market' || q.kind === 'place' || q.district === 'gardens' ? 0.03 : q.kind === 'lot' ? 0.16 : Math.min(0.92, 0.1 + q.density / 380);
    fillPoly(cov, dw, dcell, q.inset.length >= 3 ? q.inset : q.pts, f);
    dmax = Math.max(dmax, f);
  }
  lap('density');

  // ---- walls: towers and gates on the standing lines
  const walls: UrbanWall[] = [];
  const nearW = (q: Vec2): boolean => ctx.isWater(q);
  const towerShape = plan.render.towerShape ?? 'round';
  const wallOn = (ring: Polygon, gidx: GridIndex<number>, key: string, thickness: number, spacing: number, role: UrbanWall['role']): void => {
    const gates: { p: Vec2; dir: Vec2; width: number }[] = [];
    for (let si = 0; si < mstreets.length; si++) {
      const st = mstreets[si];
      if (st.role !== 'radial') continue;
      const pl = st.path;
      for (let i = 1; i < pl.length; i++) {
        const a = pl[i - 1], b = pl[i];
        gidx.forEachIn(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y), (e) => {
          const r = segSegT(a, b, ring[e], ring[(e + 1) % ring.length]);
          if (!r) return;
          const p = { x: a.x + (b.x - a.x) * r.t, y: a.y + (b.y - a.y) * r.t };
          if (gates.some((x) => dist(x.p, p) < 25)) return;
          const l = dist(a, b) || 1;
          gates.push({ p, dir: { x: (a.x - b.x) / l, y: (a.y - b.y) / l }, width: st.widths[0] + 2 });
        });
      }
    }
    const wf = wallFeatures(ring, gates, rng.fork('wall:' + key), ctx.isWater, nearW, spacing);
    walls.push({ path: ring, closed: true, towers: wf.towers, gates: gates.map((x) => x.p), thickness, gateInfo: gates, pieces: wf.pieces, gateTowers: wf.gateTowers, towerScale: wf.towerScale, curtains: wf.curtains, towerShape, role });
  };
  for (const k of [...standing].sort((a, b) => a - b)) wallOn(rings[k - 1], ringIdx[k - 1], String(k), k === nR ? 3.6 : 3, ringR[k - 1] > 3000 ? 85 : 60, k === nR ? 'town' : 'outer');
  nuclei.forEach((nu, i) => { if (nu.walled && nu.ring) wallOn(nu.ring, ringIndex(nu.ring), 'town:' + i, 2.8, 50, 'quarter'); });
  lap('walls');

  // ---- bridges where the arterials cross the water (rivers, canals; not the open sea)
  const bridges: { a: Vec2; b: Vec2; width: number }[] = [];
  {
    const wseg = new GridIndex<{ a: Vec2; b: Vec2 }>(60);
    for (const ph of water) for (const r of [ph.outer, ...ph.holes]) for (let i = 0; i < r.length; i++) wseg.insertSeg(r[i], r[(i + 1) % r.length], { a: r[i], b: r[(i + 1) % r.length] });
    const inWater = (p: Vec2) => water.some((ph, i) => p.x >= waterBB[i].x0 && p.x <= waterBB[i].x1 && p.y >= waterBB[i].y0 && p.y <= waterBB[i].y1 && pointInRing(ph.outer, p) && !ph.holes.some((h) => pointInRing(h, p)));
    // (a bridge crosses a river: about as long as the river is wide there, never along it, never over a lake)
    const rv = new GridIndex<{ p: Vec2; w: number }>(120);
    for (const r of world.terrain.rivers) r.path.forEach((p, i) => rv.insertBox(p.x, p.y, p.x, p.y, { p, w: Math.max(2.5, r.width[i] ?? 2.5) + 2 }));
    const riverW = (p: Vec2): number => { let bd = 260, w = -1; for (const v of rv.queryPt(p, 260)) { const d = dist(v.p, p); if (d < bd) { bd = d; w = v.w; } } return w; };
    for (const st of mstreets) {
      if (st.role === 'boundary' || st.role === 'wall-lane' || st.role === 'quay' || st.widths[0] <= 0) continue;
      const pl = st.path;
      const hits: { s: number; p: Vec2 }[] = [];
      let acc2 = 0;
      for (let i = 1; i < pl.length; i++) {
        const a = pl[i - 1], b = pl[i], l = dist(a, b);
        for (const s of wseg.query(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y))) {
          const r = segSegT(a, b, s.a, s.b);
          if (r) hits.push({ s: acc2 + r.t * l, p: { x: a.x + (b.x - a.x) * r.t, y: a.y + (b.y - a.y) * r.t } });
        }
        acc2 += l;
      }
      if (!hits.length) continue;
      hits.sort((x, y) => x.s - y.s);
      const uniq = hits.filter((h, i) => i === 0 || h.s - hits[i - 1].s > 0.05);
      for (let i = 0; i + 1 < uniq.length; i++) {
        const a = uniq[i], b = uniq[i + 1];
        const mid = { x: (a.p.x + b.p.x) / 2, y: (a.p.y + b.p.y) / 2 };
        const L = b.s - a.s, w = riverW(mid);
        if (L <= 3 || w < 0 || L > 1.6 * w + 18 || L > 420 || !inWater(mid)) continue;
        const width = Math.max(6, st.widths[0] * 0.8);
        if (bridges.some((x) => dist({ x: (x.a.x + x.b.x) / 2, y: (x.a.y + x.b.y) / 2 }, mid) < Math.max(20, width + x.width))) continue;
        bridges.push({ a: a.p, b: b.p, width });
      }
    }
  }
  lap('bridges');

  // ---- the layer
  const footprintH: PolyH[] = differenceS(outer, water).map((ph) => ({ outer: ph.outer, holes: ph.holes }));
  const layerStreets: UrbanStreet[] = mstreets.filter((s) => s.widths[0] > 0).map((s) => ({
    path: s.path, width: s.widths[0], widths: s.widths, kind: s.rank <= 1 ? 'main' : 'street', rank: s.rank, role: s.role, phase: s.phase,
  }));
  const macro: MacroPlan = {
    version: 1, seedKey: rng.seedKey, eagerPop, population: pop, center: c, mainAngle, terrainAngle, waterAngle, cityR: ringR[nR], ctxRadius,
    nucleusCompound: plan.nucleus.kind !== 'none' ? NUCLEUS_COMPOUND[plan.nucleus.kind] : undefined,
    streets: mstreets, quarters, nuclei, morphs, wallRings: [...[...standing].sort((a, b) => a - b).map((k) => rings[k - 1]), ...nuclei.filter((nu) => nu.walled && nu.ring).map((nu) => nu.ring!)], rings,
  };
  const marketQ = quarters.find((q) => q.kind === 'market' && q.nucleus === 0);
  const layer: UrbanLayer = {
    footprint: footprintH.map((p) => p.outer), footprintH,
    streets: layerStreets, blocks: [], parcels: [], buildings: [], walls, landmarks: [], squares: marketQ ? [marketQ.pts] : [],
    archetype: 'town', population: pop, morphology: coreM.id,
    phases: rings.map((r, i) => ({ id: i + 1, kind: i === 0 ? 'core' : i === nR ? 'faubourg' : 'ring', zone: zoneOf(i + 1), region: [{ outer: r, holes: [] }], walled: standing.has(i + 1), fossil: i + 1 < nR && !standing.has(i + 1) })),
    quarters: quarters.map((q) => ({ poly: { outer: q.pts, holes: [] }, phase: q.phase, zone: q.zone, streetSpace: [] })),
    blockInfo: [], masses: [], backLand: [],
    culture: culture.id, cultures: plan.cultures.map((x) => x.id), renderHints: { ...plan.render, towerShape },
    lines, trees: [], water: [], sites, quays,
    macro, densityGrid: { cell: dcell, w: dw, cov, max: dmax },
  };
  const stats: Record<string, number | string> = {
    pop, archetype: 'town', culture: culture.id, morphology: coreM.id, mega: 1, rings: nR, quarters: quarters.length, nuclei: nuclei.length,
    macroStreets: mstreets.length, walls: walls.length, 'ha.city': Math.round(mpArea(footprintH) / 1e4), eagerPop,
  };
  for (const [k, v] of Object.entries(tm)) stats['ms.mega.' + k] = v;
  stats['ms.urban'] = Math.round(performance.now() - T0);
  return { layer, stats, bridges };
}

/**
 * Street from p0 to p1 around center c (both on lines star-shaped about c), following the angle a with a slow
 * lateral wander (amplitude `amp` radians): the radials of a radio-concentric city.
 */
function polarPath(c: Vec2, p0: Vec2, p1: Vec2, a: number, amp: number, rng: Rng): Polyline {
  const r0 = dist(p0, c), r1 = dist(p1, c);
  const a0 = Math.atan2(p0.y - c.y, p0.x - c.x);
  let a1 = Math.atan2(p1.y - c.y, p1.x - c.x);
  a1 = a0 + Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0));
  const L = Math.abs(r1 - r0);
  const n = Math.max(2, Math.ceil(L / 70));
  const ph = rng.float() * TAU, fr = rng.range(0.6, 1.4);
  const out: Vec2[] = [p0];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const ang = a0 + (a1 - a0) * t + amp * Math.sin(Math.PI * t) * Math.sin(ph + fr * Math.PI * t);
    const r = r0 + (r1 - r0) * t;
    out.push({ x: c.x + Math.cos(ang) * r, y: c.y + Math.sin(ang) * r });
  }
  out.push(p1);
  void a;
  return out;
}

/** Scanline fill of a polygon into a coverage raster (max with the existing value). */
function fillPoly(cov: Float32Array, w: number, cell: number, poly: Polygon, f: number): void {
  let y0 = Infinity, y1 = -Infinity;
  for (const q of poly) { y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
  const r0 = Math.max(0, Math.floor(y0 / cell - 0.5)), r1 = Math.min(w - 1, Math.ceil(y1 / cell - 0.5));
  const xs: number[] = [];
  for (let r = r0; r <= r1; r++) {
    const y = (r + 0.5) * cell;
    xs.length = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > y) !== (b.y > y)) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] / cell - 0.5)), c1 = Math.min(w - 1, Math.floor(xs[k + 1] / cell - 0.5));
      for (let cc = c0; cc <= c1; cc++) { const i = r * w + cc; if (cov[i] < f) cov[i] = f; }
    }
  }
}

void resample; void chaikin;
