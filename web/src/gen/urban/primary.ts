/**
 * Level 1b — primary streets and quarters (URBAN_GEOMETRY.md §1.2–1.4): radials from the roads, fossilized
 * rings, the market reserved at the nucleus, the wall line, and quarters = the pieces of every phase band cut
 * by the radials. Every quarter edge is labelled with the street it borders (or wall / water / open land).
 */
import type { Vec2, Polygon, Polyline } from '../core/geom';
import { dist, polylineLength, chaikin, simplify, resample, polygonCentroid } from '../core/geom';
import type { Rng } from '../core/rng';
import type { UrbanCtx } from './context';
import type { PhasePlan } from './phases';
import type { Zone, MorphologyParams } from './morphology';
import { MultiPoly, unionS as union, intersectionS as intersection, differenceS as difference, mpArea } from '../geo/bool';
import { area, pointInRing, distToRing, convexHull, orientPos, cleanRing, segSegT } from '../geo/poly';
import { ribbon } from '../geo/offset';
import { LPoly, insidePieces } from '../geo/split';
import { GridIndex } from '../geo/spatial';
import { Streets, LAB_OPEN, LAB_WALL, LAB_WATER, jitterWidths } from './streets';
import { wiggle, crank, axisLines, spiralArm, outsetConvex } from './streetops';
import { disk } from '../geo/offset';

export interface Quarter {
  lp: LPoly; phase: number; zone: Zone; age: number; kind: 'quarter' | 'market';
  /** Morphology of the quarter (its phase's or sector's); the culture that built it. */
  morph?: MorphologyParams; culture?: string;
}

export interface WallLine { ring: Polygon; gates: { p: Vec2; dir: Vec2; width: number; street: number }[] }

export interface Primary {
  quarters: Quarter[];
  market: Polygon | null;
  radials: number[];
  walls: WallLine[];
  footprint: MultiPoly;
  /** Street id of the ring around the market (-1 if none). */
  marketStreet: number;
}

const inMP = (m: MultiPoly, p: Vec2) => m.some((ph) => pointInRing(ph.outer, p) && !ph.holes.some((h) => pointInRing(h, p)));

/** Smooth a road polyline for use as an urban street. */
export function smoothStreet(pl: Polyline): Polyline {
  if (pl.length < 3) return pl.slice();
  let p = resample(pl, 6);
  p = chaikin(p, 2, false);
  return simplify(p, 0.25);
}

/** Point at arclength s from the END of the polyline, walking backward. */
function pointFromEnd(pl: Polyline, s: number): Vec2 {
  let acc = 0;
  for (let i = pl.length - 1; i > 0; i--) {
    const d = dist(pl[i], pl[i - 1]);
    if (acc + d >= s) { const t = (s - acc) / d; return { x: pl[i].x + (pl[i - 1].x - pl[i].x) * t, y: pl[i].y + (pl[i - 1].y - pl[i].y) * t }; }
    acc += d;
  }
  return pl[0];
}

/** Market polygon: hull of the points where the radials are at ~r from the nucleus, scaled to the target area. */
export function makeMarket(center: Vec2, radials: Polyline[], target: number, rng: Rng, mainAngle: number): Polygon {
  const reaching = radials.filter((pl) => dist(pl[pl.length - 1], center) < 6);
  let s = Math.sqrt(target / Math.PI) * 1.15;
  let poly: Polygon = [];
  for (let it = 0; it < 6; it++) {
    const pts: Vec2[] = [];
    reaching.forEach((pl, i) => {
      const f = 0.85 + 0.35 * ((Math.sin(i * 12.9898 + it) + 1) / 2);
      if (polylineLength(pl) > s * f + 5) pts.push(pointFromEnd(pl, s * f));
    });
    if (pts.length < 3) {
      // through-route: a spindle along the main axis
      const ang = pts.length >= 1 ? Math.atan2(pts[0].y - center.y, pts[0].x - center.x) : mainAngle;
      const L = s * 1.6, W = s * 0.9;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const at = (u: number, v: number) => ({ x: center.x + u * ca - v * sa, y: center.y + u * sa + v * ca });
      pts.length = 0;
      pts.push(at(L, 0), at(0.2 * L, W * 0.55), at(-0.25 * L, W * 0.5), at(-L * 0.9, 0), at(-0.2 * L, -W * 0.5), at(0.25 * L, -W * 0.55));
    }
    poly = orientPos(convexHull(pts));
    const a = area(poly);
    if (a <= 0) break;
    const k = Math.sqrt(target / a);
    if (Math.abs(k - 1) < 0.06) break;
    s *= k;
  }
  void rng;
  return poly;
}

function orientedRectP(c: Vec2, ang: number, len: number, wid: number): Polygon {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const pts: [number, number][] = [[-len / 2, -wid / 2], [len / 2, -wid / 2], [len / 2, wid / 2], [-len / 2, wid / 2]];
  return orientPos(pts.map(([u, w]) => ({ x: c.x + u * ca - w * sa, y: c.y + u * sa + w * ca })));
}

/**
 * Planned towns: inside the enclosure a road follows the lattice — from its gate straight along the grid axis
 * closest to its heading, then along the other axis to the central square (an L, or a straight line).
 */
function gridRadial(pl: Polyline, enc: MultiPoly, center: Vec2, ang: number): Polyline | null {
  let entry = -1;
  for (let i = 0; i < pl.length; i++) if (inMP(enc, pl[i])) { entry = i; break; }
  if (entry <= 0) return null;
  // exact gate point on the enclosure boundary
  const a = pl[entry - 1], b = pl[entry];
  let g = b;
  for (const ph of enc) for (let k = 0; k < ph.outer.length; k++) {
    const r = segSegT(a, b, ph.outer[k], ph.outer[(k + 1) % ph.outer.length]);
    if (r) g = { x: a.x + (b.x - a.x) * r.t, y: a.y + (b.y - a.y) * r.t };
  }
  const axes = [0, 1, 2, 3].map((k) => ({ x: Math.cos(ang + (k * Math.PI) / 2), y: Math.sin(ang + (k * Math.PI) / 2) }));
  const toC = { x: center.x - g.x, y: center.y - g.y };
  let d = axes[0], bd = -Infinity;
  for (const ax of axes) { const v = ax.x * toC.x + ax.y * toC.y; if (v > bd) { bd = v; d = ax; } }
  const t1 = d.x * toC.x + d.y * toC.y;
  const corner = { x: g.x + d.x * t1, y: g.y + d.y * t1 };
  const tail = dist(corner, center) > 3 ? [g, corner, center] : [g, center];
  return pl.slice(0, entry).concat(tail);
}

/** Walk a road path from its end (center side) backward while it stays near the footprint. */
function radialPath(path: Polyline, near: (p: Vec2) => boolean): Polyline | null {
  let i = path.length - 1;
  if (!near(path[i])) {
    // a road ending on another road outside the footprint: take the inside portion from the other side
    let j = i;
    while (j > 0 && !near(path[j])) j--;
    if (j <= 0) return null;
    i = j;
  }
  let k = i;
  while (k > 0 && near(path[k - 1])) k--;
  const out = path.slice(Math.max(0, k - 1), i + 1);
  return out.length >= 2 ? out : null;
}

/** Cut a polyline where it first enters polygon `poly` (walking from start); returns the part before. */
function cutAtPolygon(pl: Polyline, poly: Polygon): Polyline {
  for (let i = 1; i < pl.length; i++) {
    const a = pl[i - 1], b = pl[i];
    let bt = Infinity;
    for (let k = 0; k < poly.length; k++) {
      const r = segSegT(a, b, poly[k], poly[(k + 1) % poly.length]);
      if (r && r.t < bt) bt = r.t;
    }
    if (bt < Infinity) {
      const p = { x: a.x + (b.x - a.x) * bt, y: a.y + (b.y - a.y) * bt };
      return pl.slice(0, i).concat([p]);
    }
    if (pointInRing(poly, b)) return pl.slice(0, i + 1);
  }
  return pl;
}

/** Portions of a closed ring whose vertices satisfy `ok`, as polylines (closed ring returned with repeated start). */
function ringRuns(ring: Polygon, ok: (p: Vec2) => boolean, minLen: number): Polyline[] {
  const n = ring.length;
  const flags = ring.map(ok);
  if (flags.every((f) => f)) return [ring.concat([ring[0]])];
  if (!flags.some((f) => f)) return [];
  let s0 = flags.findIndex((f, i) => !f && flags[(i + 1) % n]);
  s0 = (s0 + 1) % n;
  const runs: Polyline[] = [];
  let cur: Vec2[] = [];
  for (let k = 0; k <= n; k++) {
    const i = (s0 + k) % n;
    if (flags[i] && k < n) cur.push(ring[i]);
    else { if (cur.length >= 2 && polylineLength(cur) >= minLen) runs.push(cur); cur = []; }
  }
  return runs;
}

export interface PrimaryInput {
  phases: PhasePlan[];
  enclosure: MultiPoly;
  walled: boolean;
  faubourg: MultiPoly;
  roads: { path: Polyline; major: boolean }[];
  marketArea: number;
  mainAngle: number;
  extraRadials: boolean;
  /** Zone of the faubourg ribbons (villages use 'village'). */
  faubZone?: Zone;
  // ---- culture operators (M3b)
  /** Nucleus shape (default: the European market hull, or a road-oriented rectangle for grids). */
  nucleus?: { shape: 'hull' | 'rect' | 'square' | 'circle'; area: number; angle: number; ring: number };
  /** axis: four half-axes from the nucleus to the boundary of `extent` (rank 0); roads stop at that boundary. */
  axis?: { angle: number; extent: MultiPoly; width: number };
  /** Region in which the roads follow the lattice (planned grid core). */
  gridCore?: MultiPoly | null;
  /** gateToGate: wiggle of the road spines (m). */
  spineAmp?: number;
  /** defensiveKinks: crank jogs per radial. */
  kinks?: number;
  /** spiral: arms instead of extra radials (count, turns). */
  spiral?: { arms: number; turns: number };
  /** rings(square): concentric streets around the nucleus every `spacing` m. */
  nucleusRings?: { spacing: number; width: number };
}

export function buildPrimary(ctx: UrbanCtx, inp: PrimaryInput, streets: Streets, rng: Rng): Primary {
  const P = ctx.params;
  const footprint = inp.faubourg.length ? union(inp.enclosure, inp.faubourg) : inp.enclosure;
  const nearFoot = (p: Vec2) => footprint.some((ph) => pointInRing(ph.outer, p) || distToRing(ph.outer, p) < 25);
  // ---- radial candidates from the roads
  const rawRadials: { pl: Polyline; major: boolean }[] = [];
  for (const rd of inp.roads) {
    const pl = radialPath(rd.path, nearFoot);
    if (!pl || polylineLength(pl) < 20) continue;
    let sp = smoothStreet(pl);
    if (inp.axis) {
      // planned towns with axes: the road stops at the gate on the axis enclosure; the axes run inside
      const hull = orientPos(convexHull(inp.axis.extent.flatMap((ph) => ph.outer)));
      if (hull.length >= 3 && pointInRing(hull, sp[sp.length - 1])) sp = cutAtPolygon(sp, hull);
      if (sp.length < 2 || polylineLength(sp) < 15) continue;
    } else if (inp.gridCore ? inp.gridCore.length : P.streetOp === 'grid') sp = gridRadial(sp, inp.gridCore ?? inp.enclosure, ctx.center, inp.mainAngle) ?? sp;
    if (inp.spineAmp) sp = wiggle(sp, inp.spineAmp, rng.fork('spine:' + rawRadials.length));
    rawRadials.push({ pl: sp, major: rd.major });
  }
  // roads that join another road before the center must end exactly on it (smoothing moved both)
  for (const r of rawRadials) {
    const e = r.pl[r.pl.length - 1];
    if (dist(e, ctx.center) < 6) continue;
    let best: Vec2 | null = null, bd = 15;
    for (const o of rawRadials) {
      if (o === r) continue;
      for (let i = 1; i < o.pl.length; i++) {
        const a = o.pl[i - 1], b = o.pl[i];
        const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((e.x - a.x) * dx + (e.y - a.y) * dy) / l2));
        const q = { x: a.x + t * dx, y: a.y + t * dy };
        const d = dist(q, e);
        if (d < bd) { bd = d; best = q; }
      }
    }
    if (best) r.pl = r.pl.slice(0, -1).concat([best]);
  }
  // ---- market at the nucleus
  let market: Polygon | null = null;
  const core = inp.phases[0].region;
  if (inp.nucleus && inp.nucleus.area > 0) {
    const nu = inp.nucleus;
    const A = nu.area;
    const shapeAt = (c: Vec2) => nu.shape === 'circle' ? disk(c, Math.sqrt(A / Math.PI), 24)
      : orientedRectP(c, nu.angle, Math.sqrt(A * (nu.shape === 'rect' ? 1.3 : 1)), Math.sqrt(A / (nu.shape === 'rect' ? 1.3 : 1)));
    // planned nuclei (castle, temple, forum) are nudged — by at most half their size — onto dry, flat land
    let nc = ctx.center;
    if (nu.shape !== 'hull') {
      const half = Math.sqrt(A) / 2;
      const wet = (c: Vec2): number => {
        let w = 0;
        for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) {
          const q = { x: c.x + (i / 4) * half, y: c.y + (j / 4) * half };
          if (ctx.isWater(q) || !inMP(core, q)) w++;
        }
        return w;
      };
      let bw = wet(nc) * 100;
      for (let r = 0.1; r <= 0.5 && bw > 0; r += 0.1) for (let k = 0; k < 12; k++) {
        const c = { x: ctx.center.x + Math.cos((k * Math.PI) / 6) * r * half * 2, y: ctx.center.y + Math.sin((k * Math.PI) / 6) * r * half * 2 };
        const sc = wet(c) * 100 + r * 10;
        if (sc < bw) { bw = sc; nc = c; }
      }
    }
    const mk = nu.shape === 'hull' ? makeMarket(ctx.center, rawRadials.map((r) => r.pl), A, rng.fork('market'), inp.mainAngle) : shapeAt(nc);
    const clipped = intersection(mk, core);
    let best: Polygon | null = null;
    for (const ph of clipped) if (!best || area(ph.outer) > area(best)) best = ph.outer;
    if (best && area(best) > 0.4 * A) market = cleanRing(best, 0.5, 2);
    if (market && market.length < 3) market = null;
  } else if (inp.marketArea > 0) {
    const mk = P.streetOp === 'grid'
      ? orientedRectP(ctx.center, inp.mainAngle, Math.sqrt(inp.marketArea * 1.25), Math.sqrt(inp.marketArea / 1.25))
      : makeMarket(ctx.center, rawRadials.map((r) => r.pl), inp.marketArea, rng.fork('market'), inp.mainAngle);
    const clipped = intersection(mk, core);
    let best: Polygon | null = null;
    for (const ph of clipped) if (!best || area(ph.outer) > area(best)) best = ph.outer;
    if (best && area(best) > 0.4 * inp.marketArea) market = cleanRing(best, 0.5, 2);
    if (market && market.length < 3) market = null;
  }
  // ---- register radials (cut at the market)
  const radials: number[] = [];
  const radialLines: Polyline[] = [];
  const wr = rng.fork('widths');
  for (const r of rawRadials) {
    let pl = r.pl;
    if (market) pl = cutAtPolygon(pl, market);
    if (pl.length < 2 || polylineLength(pl) < 15) continue;
    // defensive kinks: cranks near the inner end and near the town entry
    const kk = inp.kinks ?? 0;
    const kr = rng.fork('kinks:' + radials.length);
    for (let j = 0; j < kk; j++) {
      const L = polylineLength(pl);
      if (L < 160) break;
      const sPos = j === 0 ? L - kr.range(70, 110) : kr.range(60, Math.max(61, L * 0.45));
      pl = crank(pl, sPos, (kr.chance(0.5) ? 1 : -1) * kr.range(9, 14), kr.range(18, 28));
    }
    const w = P.widthByRank[r.major ? 0 : 1] * P.widthScale;
    const id = streets.add(pl, jitterWidths(pl, w, P.widthJitter, () => wr.float()), r.major ? 0 : 1, 'radial', 1);
    radials.push(id); radialLines.push(pl);
  }
  // ---- axes (planned towns): gate to gate through the nucleus
  const axisEnds: Vec2[] = [];
  if (inp.axis) {
    // the axes span the whole planned enclosure (crossing a river on bridges)
    const hull = convexHull(inp.axis.extent.flatMap((ph) => ph.outer));
    if (hull.length >= 3) for (const ax of axisLines(ctx.center, inp.axis.angle, orientPos(hull), market)) {
      const id = streets.add(ax.line, inp.axis.width, 0, 'radial', 1);
      radials.push(id); radialLines.push(ax.line);
      axisEnds.push(ax.end);
    }
  }
  // ---- spiral arms (elven): paths winding out from the grove
  if (inp.spiral && market) {
    const encR = Math.sqrt(mpArea(inp.enclosure) / Math.PI);
    const r0 = Math.sqrt(area(market) / Math.PI) + 2;
    const sr = rng.fork('spiral');
    const a0 = sr.range(0, 2 * Math.PI);
    for (let k = 0; k < inp.spiral.arms; k++) {
      const arm = spiralArm(ctx.center, a0 + (k * 2 * Math.PI) / inp.spiral.arms, r0 - 3, encR * 1.6, inp.spiral.turns);
      const line = afterExit(arm, [{ outer: market, holes: [] }]);
      if (!line) continue;
      let piece: Polyline | null = null;
      for (const comp of inp.enclosure) { const pcs = insidePieces(comp.outer, line); if (pcs.length && pcs[0].pts.length >= 2) { piece = pcs[0].pts; break; } }
      if (!piece || polylineLength(piece) < 60) continue;
      const pl = simplify(piece, 0.3);
      const w = P.widthByRank[1] * P.widthScale;
      const id = streets.add(pl, jitterWidths(pl, w, P.widthJitter, () => sr.float()), 1, 'radial', 1);
      radials.push(id); radialLines.push(pl);
    }
  }
  // ---- extra radials in wide angular gaps (large towns)
  if (inp.extraRadials) {
    const encR = Math.sqrt(mpArea(inp.enclosure) / Math.PI);
    if (encR > 170) {
      const angs = radialLines.map((pl) => {
        const q = pl.find((p) => dist(p, ctx.center) > Math.min(encR * 0.7, 150)) ?? pl[0];
        return Math.atan2(q.y - ctx.center.y, q.x - ctx.center.x);
      }).sort((a, b) => a - b);
      const gaps: [number, number][] = [];
      if (!angs.length) gaps.push([0, 2 * Math.PI]);
      for (let i = 0; i < angs.length; i++) {
        const a = angs[i], b = i + 1 < angs.length ? angs[i + 1] : angs[0] + 2 * Math.PI;
        gaps.push([a, b]);
      }
      const er = rng.fork('extraRadials');
      for (const [a, b] of gaps) {
        const gap = b - a;
        // only wide gaps get a synthetic radial, and it starts at the first old wall line (a T on the ring street),
        // not at the market: a few true radials (the roads) reach the centre, the rest is infill
        const k = Math.floor(gap / ((100 * Math.PI) / 180));
        for (let j = 1; j <= k; j++) {
          const th = a + (gap * j) / (k + 1) + er.range(-0.2, 0.2);
          let pl = traceRadial(ctx, th, market, inp.enclosure, er);
          if (!pl) continue;
          if (inp.phases.length >= 2 && inp.phases[0].fossil) {
            pl = afterExit(pl, inp.phases[0].region);
            if (!pl || polylineLength(pl) < 60) continue;
          }
          const w = P.widthByRank[1] * P.widthScale * 0.9;
          const id = streets.add(pl, jitterWidths(pl, w, P.widthJitter, () => er.float()), 1, 'radial', 1);
          radials.push(id); radialLines.push(pl);
        }
      }
    }
  }
  // ---- fossilized rings (older enclosure lines inside the latest one)
  const n = inp.phases.length;
  const enc = inp.enclosure;
  const encInnerOK = (p: Vec2) => inMP(enc, p) && enc.every((ph) => distToRing(ph.outer, p) > 4) && !nearWater(ctx, p, 4);
  for (let k = 0; k < n - 1; k++) {
    const ph = inp.phases[k];
    if (!ph.fossil) continue;
    for (const comp of ph.region) {
      for (const run of ringRuns(comp.outer, encInnerOK, 40)) {
        // the old wall line survives as partial arcs: stretches were built over (blocks straddle the line)
        for (const pl0 of breakRing(simplify(run, 0.2), radialLines, P.ringGaps ?? 0, wr)) {
          const pl = pl0;
          const w = P.widthByRank[1] * P.widthScale * 0.95;
          streets.add(pl, jitterWidths(pl, w, P.widthJitter, () => wr.float()), 1, 'ring', k + 1);
        }
      }
    }
  }
  // ---- concentric rings around the nucleus (pradakshina streets: Madurai's Chitrai, Avani Moola, Masi streets)
  if (inp.nucleusRings && market) {
    const encOK = (p: Vec2) => inMP(enc, p) && enc.every((ph) => distToRing(ph.outer, p) > 6) && !nearWater(ctx, p, 5);
    const nr = rng.fork('nrings');
    for (let k = 1; k < 20; k++) {
      const ringP = outsetConvex(convexHull(market), k * inp.nucleusRings.spacing * nr.range(0.92, 1.08) + inp.nucleusRings.width / 2);
      if (!ringP.some(encOK)) break;
      // dense resample so the runs are cut close to the enclosure and the water
      const dense: Vec2[] = [];
      for (let i = 0; i < ringP.length; i++) {
        const a = ringP[i], b = ringP[(i + 1) % ringP.length];
        const m = Math.max(1, Math.ceil(dist(a, b) / 6));
        for (let j = 0; j < m; j++) dense.push({ x: a.x + ((b.x - a.x) * j) / m, y: a.y + ((b.y - a.y) * j) / m });
      }
      for (const run of ringRuns(dense, encOK, 50)) {
        const pl = simplify(run, 0.3);
        streets.add(pl, jitterWidths(pl, inp.nucleusRings.width, P.widthJitter, () => nr.float()), 1, 'ring', 1);
      }
    }
  }
  // ---- market ring street (frontage around the square)
  let marketStreet = -1;
  if (market) marketStreet = streets.add(market.concat([market[0]]), inp.nucleus?.ring ?? P.widthByRank[2] * P.widthScale, 1, 'ring', 1);
  // ---- network connectivity seed: radials, the market ring, and rings crossed by a radial
  for (const id of radials) streets.connected.add(id);
  if (marketStreet >= 0) streets.connected.add(marketStreet);
  for (const st of streets.list) {
    if (st.role !== 'ring' || streets.connected.has(st.id)) continue;
    let hit = false;
    for (const rid of radials) {
      const r = streets.list[rid];
      for (let i = 1; i < r.path.length && !hit; i++) for (let j = 1; j < st.path.length && !hit; j++) {
        if (segSegT(r.path[i - 1], r.path[i], st.path[j - 1], st.path[j])) hit = true;
      }
      if (hit) break;
    }
    if (hit) streets.connected.add(st.id);
  }
  // ---- walls and gates
  const walls: WallLine[] = [];
  if (inp.walled) {
    for (const comp of enc) {
      const ring = comp.outer;
      const gates: WallLine['gates'] = [];
      for (const id of radials) {
        const st = streets.list[id];
        for (let i = 1; i < st.path.length; i++) {
          const a = st.path[i - 1], b = st.path[i];
          for (let k = 0; k < ring.length; k++) {
            const r = segSegT(a, b, ring[k], ring[(k + 1) % ring.length]);
            if (!r) continue;
            const p = { x: a.x + (b.x - a.x) * r.t, y: a.y + (b.y - a.y) * r.t };
            if (gates.some((g) => dist(g.p, p) < 12)) continue;
            const l = dist(a, b) || 1;
            gates.push({ p, dir: { x: (b.x - a.x) / l, y: (b.y - a.y) / l }, width: st.widths[i], street: id });
          }
        }
      }
      // axis ends on the wall are gates (the lines end exactly on it)
      for (const e of axisEnds) if (distToRing(ring, e) < 1 && !gates.some((g) => dist(g.p, e) < 12)) {
        const l = dist(ctx.center, e) || 1;
        gates.push({ p: e, dir: { x: (e.x - ctx.center.x) / l, y: (e.y - ctx.center.y) / l }, width: inp.axis!.width, street: -1 });
      }
      walls.push({ ring, gates });
    }
  }
  // ---- quarters: phase bands minus the market, cut by the radials
  const cutters: Polygon[] = [];
  for (const id of radials) {
    const rb = ribbon(streets.list[id].path, 0.04);
    if (rb.length >= 3) cutters.push(rb);
  }
  const cutMP: MultiPoly = cutters.length ? union(cutters[0], ...cutters.slice(1)) : [];
  const quarters: Quarter[] = [];
  const bands: { mp: MultiPoly; phase: number; zone: Zone; age: number }[] = inp.phases.map((ph, k) => ({
    mp: k === 0 && market ? difference(ph.band, market) : ph.band, phase: ph.id, zone: ph.zone, age: ph.age,
  }));
  if (inp.faubourg.length) bands.push({ mp: inp.faubourg, phase: n + 1, zone: inp.faubZone ?? 'faubourg', age: 0.1 });
  // label sources
  const src = new GridIndex<{ a: Vec2; b: Vec2; lab: number }>(20);
  for (const st of streets.list) for (let i = 1; i < st.path.length; i++) src.insertSeg(st.path[i - 1], st.path[i], { a: st.path[i - 1], b: st.path[i], lab: st.id });
  const wallRings = walls.map((w) => w.ring);
  const labelOf = (p: Vec2): number => {
    let best = LAB_OPEN, bd = 0.12;
    for (const s of src.queryPt(p, 0.2)) {
      const d = distSeg(p, s.a, s.b);
      if (d < bd) { bd = d; best = s.lab; }
    }
    if (best !== LAB_OPEN) return best;
    if (nearWaterBoundary(ctx, p, 0.3)) return LAB_WATER;
    if (wallRings.some((r) => distToRing(r, p) < 0.3)) return LAB_WALL;
    return LAB_OPEN;
  };
  for (const b of bands) {
    let pieces = cutMP.length ? difference(b.mp, cutMP) : b.mp;
    // any remaining hole (a band no radial crosses): open it with a lane
    let guard = 0;
    while (pieces.some((ph) => ph.holes.length) && guard++ < 6) {
      const ph = pieces.find((x) => x.holes.length)!;
      const h = ph.holes[0];
      let ri = 0;
      for (let i = 1; i < h.length; i++) if (h[i].x > h[ri].x) ri = i;
      const far = { x: h[ri].x + 1e4, y: h[ri].y + 0.37 };
      const pcs = insidePieces(ph.outer, [h[ri], far]);
      const line = pcs.length ? [h[ri], pcs[0].pts[pcs[0].pts.length - 1]] : [h[ri], far];
      const id = streets.add(line, P.widthByRank[2] * P.widthScale, 2, 'street', b.phase);
      src.insertSeg(line[0], line[1], { a: line[0], b: line[1], lab: id });
      const rb = ribbon(line, 0.04);
      pieces = difference(pieces, rb);
    }
    for (const ph of pieces) {
      const pts = ph.outer;
      if (area(pts) < 150) continue;
      const lab = pts.map((p, i) => labelOf(mid(p, pts[(i + 1) % pts.length])));
      if (!lab.some((l) => l >= 0)) continue; // no street access: not urbanized
      quarters.push({ lp: { pts, lab }, phase: b.phase, zone: b.zone, age: b.age, kind: 'quarter' });
    }
  }
  if (market) quarters.push({ lp: { pts: market, lab: market.map(() => marketStreet) }, phase: 1, zone: 'core', age: 1, kind: 'market' });
  return { quarters, market, radials, walls, footprint, marketStreet };
}

const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
function distSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function nearWaterBoundary(ctx: UrbanCtx, p: Vec2, tol: number): boolean {
  for (const ph of ctx.water) {
    if (distToRing(ph.outer, p) < tol) return true;
    for (const h of ph.holes) if (distToRing(h, p) < tol) return true;
  }
  return false;
}
function nearWater(ctx: UrbanCtx, p: Vec2, tol: number): boolean {
  for (const ph of ctx.water) if (pointInRing(ph.outer, p) || distToRing(ph.outer, p) < tol) return true;
  return false;
}

/** Extra radial: from the market edge outward along direction th, gently wandering, clipped to the enclosure. */
function traceRadial(ctx: UrbanCtx, th: number, market: Polygon | null, enc: MultiPoly, rng: Rng): Polyline | null {
  const c = ctx.center;
  let p = { ...c };
  let h = th;
  let wob = 0;
  const pts: Vec2[] = [];
  for (let s = 0; s < 3000; s += 8) {
    if (!inMP(enc, p) && s > 30) { pts.push(p); break; }
    pts.push(p);
    const radial = Math.atan2(p.y - c.y, p.x - c.x);
    let dh = radial - h;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    wob += rng.range(-0.035, 0.035);
    wob *= 0.93;
    h += 0.12 * dh + wob;
    p = { x: p.x + Math.cos(h) * 8, y: p.y + Math.sin(h) * 8 };
    if (ctx.isWater(p)) return null;
  }
  if (pts.length < 4) return null;
  // keep the part outside the market and inside the enclosure (first inside piece that starts at the market)
  let line = pts;
  if (market) {
    const pcs = insidePieces(market, line);
    if (pcs.length) {
      const last = pcs[0].pts[pcs[0].pts.length - 1];
      const k = line.findIndex((q) => !pointInRing(market, q));
      if (k < 0) return null;
      line = [last, ...line.slice(k)];
    }
  }
  const out: Vec2[] = [];
  for (const comp of enc) {
    const pcs = insidePieces(comp.outer, line);
    for (const pc of pcs) if (pc.pts.length >= 2 && polylineLength(pc.pts) > 40) { out.push(...pc.pts); break; }
    if (out.length) break;
  }
  return out.length >= 2 ? simplify(chaikin(out, 1, false), 0.3) : null;
}

export { polygonCentroid };

/** Arclength slice of a polyline. */
function slicePl(pl: Polyline, cum: number[], s0: number, s1: number): Polyline {
  const at = (s: number): Vec2 => {
    let i = 1;
    while (i < pl.length - 1 && cum[i] < s) i++;
    const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return { x: pl[i - 1].x + (pl[i].x - pl[i - 1].x) * t, y: pl[i - 1].y + (pl[i].y - pl[i - 1].y) * t };
  };
  const out = [at(s0)];
  for (let i = 1; i < pl.length - 1; i++) if (cum[i] > s0 && cum[i] < s1) out.push(pl[i]);
  out.push(at(s1));
  return out;
}

/**
 * Ring street broken into partial arcs: `perKm` gaps per km of ring (50–130 m each), kept away from the radial
 * crossings so that every arc stays joined to the network.
 */
export function breakRing(pl: Polyline, radials: Polyline[], perKm: number, rng: Rng): Polyline[] {
  const cum = [0];
  for (let i = 1; i < pl.length; i++) cum.push(cum[i - 1] + dist(pl[i - 1], pl[i]));
  const L = cum[cum.length - 1];
  const nGaps = Math.floor((L / 1000) * perKm + rng.float());
  if (nGaps <= 0 || L < 200) return [pl];
  // arclength of the radial crossings
  const cross: number[] = [];
  for (let i = 1; i < pl.length; i++) for (const r of radials) {
    for (let j = 1; j < r.length; j++) {
      const x = segSegT(pl[i - 1], pl[i], r[j - 1], r[j]);
      if (x) cross.push(cum[i - 1] + x.t * (cum[i] - cum[i - 1]));
    }
    // radials starting or ending on the ring (T junctions)
    for (const e of [r[0], r[r.length - 1]]) {
      const a = pl[i - 1], b = pl[i];
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((e.x - a.x) * dx + (e.y - a.y) * dy) / l2));
      if (Math.hypot(e.x - a.x - t * dx, e.y - a.y - t * dy) < 1) cross.push(cum[i - 1] + t * Math.sqrt(l2));
    }
  }
  if (!cross.length) return [pl];
  const gaps: [number, number][] = [];
  for (let g = 0; g < nGaps * 4 && gaps.length < nGaps; g++) {
    const len = rng.range(50, 130);
    const s0 = rng.range(20, L - len - 20);
    if (s0 < 20) continue;
    const s1 = s0 + len;
    if (cross.some((c) => c > s0 - 35 && c < s1 + 35)) continue;
    if (gaps.some(([a, b]) => s0 < b + 60 && s1 > a - 60)) continue;
    gaps.push([s0, s1]);
  }
  if (!gaps.length) return [pl];
  gaps.sort((a, b) => a[0] - b[0]);
  const out: Polyline[] = [];
  let s = 0;
  // every arc keeps at least one radial crossing (it stays joined to the network)
  const keep = (a: number, b: number) => b - a > 25 && cross.some((c) => c >= a - 0.5 && c <= b + 0.5);
  for (const [a, b] of gaps) { if (keep(s, a)) out.push(slicePl(pl, cum, s, a)); s = b; }
  if (keep(s, L)) out.push(slicePl(pl, cum, s, L));
  return out;
}

/** The part of a polyline (starting inside `region`) after it first leaves the region, starting on its boundary. */
function afterExit(pl: Polyline, region: MultiPoly): Polyline | null {
  for (let i = 1; i < pl.length; i++) {
    const a = pl[i - 1], b = pl[i];
    let bt = Infinity;
    for (const comp of region) for (let k = 0; k < comp.outer.length; k++) {
      const r = segSegT(a, b, comp.outer[k], comp.outer[(k + 1) % comp.outer.length]);
      if (r && r.t < bt) bt = r.t;
    }
    if (bt < Infinity) {
      const e = { x: a.x + (b.x - a.x) * bt, y: a.y + (b.y - a.y) * bt };
      return [e, ...pl.slice(i)];
    }
  }
  return null;
}
