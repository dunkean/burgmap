/**
 * Inca city (Cusco, Ollantaytambo): landmark plans and site features.
 * - the great plaza (haukaypata) with its ushnu (stepped platform of state ritual) and the great halls (kallanka)
 *   on its edges;
 * - the temple (Coricancha): a large kancha of shrines round a court, one closing on the famous curved wall;
 * - royal palaces (hatun kancha): large kanchas with a kallanka facing the plaza;
 * - agricultural terraces (andenes) following the contours on the slopes round the town;
 * - canalized streams (stone-lined channels) through the town.
 * The fortress on the hill (Sacsayhuamán: zigzag terrace walls) is a castle variant (m4/castle.ts).
 */
import type { Vec2, Polygon, Polyline } from '../core/geom';
import { dist, chaikin, simplify, polylineLength } from '../core/geom';
import type { UrbanLine } from '../types';
import type { UrbanCtx } from './context';
import type { CompoundCtx, CompoundOut } from './compounds';
import { registerBuilders } from './compounds';
import { area, orientPos, pointInRing, distToRing, inscribed, obb } from '../geo/poly';
import { MultiPoly, differenceS } from '../geo/bool';
import { ribbon } from '../geo/offset';
import { pieces } from './camps/kit';
import { alongEdge, placeRect, longestEdge, fits } from './m4/kit';
import { rectAt } from './m4/lots';
import { marchingSquares } from '../terrain/contour';
import { rasterizePolys } from '../geo/raster';
import { distanceField } from '../core/field';
import { sampleGrid } from '../core/grid';
import { isoRegions } from './phases';

const empty = (lot: Polygon, use: string): CompoundOut => ({ parcels: [{ poly: lot, use }], buildings: [], lines: [], water: [], landmarks: [] });

/** Index of the lot edge nearest a point (the side facing the plaza or the street). */
function edgeNear(P: Polygon, p: Vec2): number {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    if (dist(a, b) < 8) continue;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = dist(m, p);
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

/** Ranges of rooms along every long side of a lot, the corners left open (kancha layout). */
function ranges(out: CompoundOut, P: Polygon, depth: number, arch: string, skip: number, margin = 1): void {
  for (let i = 0; i < P.length; i++) {
    if (i === skip) continue;
    const a = P[i], b = P[(i + 1) % P.length];
    const L = dist(a, b);
    if (L < 14) continue;
    const r = alongEdge(P, i, depth, L - 2 * (depth * 0.6 + 3), margin);
    if (r && !out.buildings.some((x) => overlapBB(x.poly, r))) out.buildings.push({ poly: r, kind: 'landmark', parcel: 0, arch, roof: 'gable', material: 'stone', storeys: 1, orientation: Math.atan2(b.y - a.y, b.x - a.x) });
  }
}
const overlapBB = (A: Polygon, B: Polygon): boolean => A.some((q) => pointInRing(B, q)) || B.some((q) => pointInRing(A, q));

/** The great plaza: an open paved place with the ushnu near its middle and kallanka halls on its long sides. */
function incaPlaza(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = empty(lot, 'place');
  const P = orientPos(lot);
  const ins = inscribed(P, [], 1);
  const o = obb(P);
  const ang = Math.atan2(o.u.y, o.u.x);
  // the ushnu: a stepped square platform (two terraces) with its stair
  const s = Math.max(8, Math.min(18, Math.sqrt(area(P)) * 0.12));
  const u0 = placeRect(P, ins.c, ang, s / 2, s / 2, 4);
  if (u0) {
    out.buildings.push({ poly: u0, kind: 'landmark', parcel: 0, arch: 'ushnu', roof: 'flat', material: 'stone', storeys: 2, orientation: ang });
    out.landmarks.push({ kind: 'ushnu', poly: u0 });
  }
  // kallankas: great halls along the longest sides (facing the plaza)
  const e1 = longestEdge(P);
  const halls = area(P) > 9000 ? 2 : 1;
  const done: number[] = [];
  for (let k = 0; k < halls; k++) {
    const e = k === 0 ? e1 : longestEdge(P, (a, b) => !done.some((d) => { const A = P[d], B = P[(d + 1) % P.length]; const ua = { x: B.x - A.x, y: B.y - A.y }, ub = { x: b.x - a.x, y: b.y - a.y }; return Math.abs((ua.x * ub.y - ua.y * ub.x) / (Math.hypot(ua.x, ua.y) * Math.hypot(ub.x, ub.y) || 1)) < 0.4 && dist(A, a) < 5; }) && !done.includes(P.indexOf(a)));
    if (e < 0) break;
    done.push(e);
    const L = dist(P[e], P[(e + 1) % P.length]);
    const r = alongEdge(P, e, cx.rng.range(11, 15), Math.min(70, L * 0.55), 1.2);
    if (r && !(u0 && overlapBB(r, u0)) && !out.buildings.some((b) => overlapBB(b.poly, r))) out.buildings.push({ poly: r, kind: 'landmark', parcel: 0, arch: 'kallanka', roof: 'gable', material: 'stone', storeys: 1 });
  }
  return out;
}

/** The temple (Coricancha): shrines round a court inside a fine-masonry enclosure; a curved wall closes one end. */
function incaTemple(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = empty(lot, 'compound:inca-temple');
  const P = orientPos(lot);
  const front = edgeNear(P, cx.center);
  ranges(out, P, cx.rng.range(7.5, 10), 'temple-shrine', front);
  // the curved wall: an apsidal hall on the side opposite the plaza
  const opp = (front + Math.floor(P.length / 2)) % P.length;
  const a = P[opp], b = P[(opp + 1) % P.length];
  const L = dist(a, b);
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const ins = inscribed(P, [], 1).c;
  const W = Math.min(16, L * 0.35), Lh = Math.min(28, L * 0.5);
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const c = { x: m.x + (ins.x - m.x) * 0.35, y: m.y + (ins.y - m.y) * 0.35 };
  const apse: Vec2[] = [];
  const nrm = { x: -Math.sin(ang), y: Math.cos(ang) };
  for (let i = 0; i <= 8; i++) { const t = Math.PI + (i / 8) * Math.PI; apse.push({ x: c.x + Math.cos(ang) * (Math.cos(t) * W / 2) + nrm.x * (Math.sin(t) * W / 2 - Lh / 2), y: c.y + Math.sin(ang) * (Math.cos(t) * W / 2) + nrm.y * (Math.sin(t) * W / 2 - Lh / 2) }); }
  const curved = orientPos([...apse, { x: c.x + Math.cos(ang) * (W / 2) + nrm.x * (Lh / 2), y: c.y + Math.sin(ang) * (W / 2) + nrm.y * (Lh / 2) }, { x: c.x - Math.cos(ang) * (W / 2) + nrm.x * (Lh / 2), y: c.y - Math.sin(ang) * (W / 2) + nrm.y * (Lh / 2) }]);
  if (fits(P, curved, 1.5) && !out.buildings.some((x) => overlapBB(x.poly, curved))) {
    out.buildings.push({ poly: curved, kind: 'landmark', parcel: 0, arch: 'sun-temple', roof: 'gable', material: 'stone', storeys: 1, orientation: ang });
    out.landmarks.push({ kind: 'sun-temple', poly: curved });
  }
  out.lines.push({ kind: 'stone-wall', path: P, closed: true, width: 1.8 });
  return out;
}

/** A royal palace (hatun kancha): ranges round a great court, a kallanka on the side facing the plaza. */
function incaPalace(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out = empty(lot, 'compound:inca-palace');
  const P = orientPos(lot);
  const front = edgeNear(P, cx.center);
  const L = dist(P[front], P[(front + 1) % P.length]);
  const k = alongEdge(P, front, cx.rng.range(11, 14), Math.min(60, L * 0.7), 1.2);
  if (k) out.buildings.push({ poly: k, kind: 'landmark', parcel: 0, arch: 'kallanka', roof: 'gable', material: 'stone', storeys: 1 });
  ranges(out, P, cx.rng.range(6, 8), 'palace-range', front);
  out.lines.push({ kind: 'stone-wall', path: P, closed: true, width: 1.6 });
  return out;
}

let registered = false;
export function registerInca(): void {
  if (registered) return;
  registered = true;
  registerBuilders({ 'inca-plaza': incaPlaza, 'inca-temple': incaTemple, 'inca-palace': incaPalace });
}

/**
 * Agricultural terraces (andenes): contour lines every `step` m of height on the slopes round the town (between
 * 25 and `reach` m from the footprint), drawn as terrace walls; only where the ground is steep enough to need them.
 */
export function andenes(ctx: UrbanCtx, footprint: Polygon[], reach: number): { lines: UrbanLine[]; fields: Polygon[] } {
  const g = ctx.terrain.height, n = g.w, cell = g.cell;
  const fp = rasterizePolys(footprint, n, n, cell);
  const dF = distanceField(fp, n, n, cell).dist;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < g.data.length; i++) if (dF[i] < reach) { lo = Math.min(lo, g.data[i]); hi = Math.max(hi, g.data[i]); }
  if (!(hi > lo)) return { lines: [], fields: [] };
  const step = Math.max(2.2, Math.min(4, (hi - lo) / 40));
  const out: UrbanLine[] = [];
  const ok = (q: Vec2): boolean => {
    const ix = Math.min(n - 1, Math.max(0, Math.floor(q.x / cell))), iy = Math.min(n - 1, Math.max(0, Math.floor(q.y / cell)));
    const d = dF[iy * n + ix];
    if (d < 25 || d > reach) return false;
    if (ctx.isWater(q)) return false;
    const sl = sampleGrid(ctx.terrain.slope, q.x, q.y);
    return sl > 0.07 && sl < 0.6;
  };
  // the terraced land itself: the cells where terraces are built, smoothed into cultivated fields
  const mask = new Float32Array(n * n);
  for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) mask[iy * n + ix] = ok({ x: (ix + 0.5) * cell, y: (iy + 0.5) * cell }) ? 1 : 0;
  const sm = mask.slice();
  for (let pass = 0; pass < 2; pass++) {
    const src = sm.slice();
    for (let iy = 1; iy < n - 1; iy++) for (let ix = 1; ix < n - 1; ix++) {
      let t = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) t += src[(iy + dy) * n + ix + dx];
      sm[iy * n + ix] = t / 9;
    }
  }
  // (clear of the roads and the water)
  let fm: MultiPoly = isoRegions(sm, n, cell, 0.5, 3000).map((ph) => ({ outer: ph.outer, holes: [] }));
  const roadRb: MultiPoly = (ctx.world.roads ?? []).map((r) => ribbon(r.path, r.width + 6)).filter((r) => r.length >= 3).map((r) => ({ outer: r, holes: [] }));
  if (fm.length && roadRb.length) fm = differenceS(fm, roadRb);
  if (fm.length && ctx.water.length) fm = differenceS(fm, ctx.water);
  const fields = pieces(fm, 3000);
  const inField = (q: Vec2) => fields.some((f) => pointInRing(f, q));
  for (let lv = Math.ceil(lo / step) * step; lv < hi; lv += step) {
    for (const p of marchingSquares(g.data, g.w, g.h, lv, cell, cell / 2, cell / 2)) {
      const pts = chaikin(p.pts, 2, p.closed);
      let run: Vec2[] = [];
      const flush = () => { if (run.length >= 3 && polylineLength(run) > 30) out.push({ kind: 'andene', path: simplify(run, 0.6), width: 1 }); run = []; };
      for (const q of pts) { if (ok(q) && inField(q)) run.push(q); else flush(); }
      flush();
    }
  }
  return { lines: out, fields };
}

/** Canalized streams: stone channel walls along both banks of the watercourses inside the town footprint. */
export function canals(ctx: UrbanCtx, footprint: MultiPoly): UrbanLine[] {
  const out: UrbanLine[] = [];
  const inside = (q: Vec2) => footprint.some((ph) => pointInRing(ph.outer, q) && !ph.holes.some((h) => pointInRing(h, q)));
  for (const rv of ctx.terrain.rivers) {
    const pl = rv.path;
    for (const side of [1, -1]) {
      let run: Vec2[] = [];
      const flush = () => { if (run.length >= 2 && polylineLength(run) > 25) out.push({ kind: 'canal-wall', path: run, width: 1 }); run = []; };
      for (let i = 0; i < pl.length; i++) {
        const a = pl[Math.max(0, i - 1)], b = pl[Math.min(pl.length - 1, i + 1)];
        const L = dist(a, b) || 1;
        const nx = -(b.y - a.y) / L, ny = (b.x - a.x) / L;
        const hw = Math.max(1.6, rv.width[i] / 2) + 0.6;
        const q = { x: pl[i].x + nx * hw * side, y: pl[i].y + ny * hw * side };
        // (the town on this bank: the footprint excludes the water itself)
        const bank = { x: pl[i].x + nx * (hw + 6) * side, y: pl[i].y + ny * (hw + 6) * side };
        if (inside(bank) && rv.width[i] < 14) run.push(q); else flush();
      }
      flush();
    }
  }
  void distToRing;
  return out;
}

export type { Polyline };
export { rectAt };
