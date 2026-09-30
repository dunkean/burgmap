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
import type { Zone } from './morphology';
import { MultiPoly, unionS as union, intersectionS as intersection, differenceS as difference, mpArea } from '../geo/bool';
import { area, pointInRing, distToRing, convexHull, orientPos, cleanRing, segSegT } from '../geo/poly';
import { ribbon } from '../geo/offset';
import { LPoly, insidePieces } from '../geo/split';
import { GridIndex } from '../geo/spatial';
import { Streets, LAB_OPEN, LAB_WALL, LAB_WATER, jitterWidths } from './streets';

export interface Quarter { lp: LPoly; phase: number; zone: Zone; age: number; kind: 'quarter' | 'market' }

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
    if (P.streetOp === 'grid') sp = gridRadial(sp, inp.enclosure, ctx.center, inp.mainAngle) ?? sp;
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
  if (inp.marketArea > 0) {
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
    const w = P.widthByRank[r.major ? 0 : 1] * P.widthScale;
    const id = streets.add(pl, jitterWidths(pl, w, P.widthJitter, () => wr.float()), r.major ? 0 : 1, 'radial', 1);
    radials.push(id); radialLines.push(pl);
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
        const k = Math.floor(gap / ((70 * Math.PI) / 180));
        for (let j = 1; j <= k; j++) {
          const th = a + (gap * j) / (k + 1) + er.range(-0.12, 0.12);
          const pl = traceRadial(ctx, th, market, inp.enclosure, er);
          if (!pl) continue;
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
        const pl = simplify(run, 0.2);
        const w = P.widthByRank[1] * P.widthScale * 0.95;
        streets.add(pl, jitterWidths(pl, w, P.widthJitter, () => wr.float()), 1, 'ring', k + 1);
      }
    }
  }
  // ---- market ring street (frontage around the square)
  let marketStreet = -1;
  if (market) marketStreet = streets.add(market.concat([market[0]]), P.widthByRank[2] * P.widthScale, 1, 'ring', 1);
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
