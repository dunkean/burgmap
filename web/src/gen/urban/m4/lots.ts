/**
 * Level-1 landmark lots (URBAN_LANDMARKS.md §1): geometric helpers to site a lot (clearance from streets, roads,
 * water and other lots), to give it street access (a street along its front, a connector to the network) and the
 * shape primitives of the landmark plans (oriented rectangles, terrain-fitted convex polygons).
 *
 * A reserved lot is cut out of the phase bands as an exact piece BEFORE quarters are formed (primary.ts), so the
 * blocks around it are bounded by its access street (parvis, esplanade, ring street) or by its wall (backs of
 * houses against a precinct). Its connector is a cut of the partition like a radial.
 */
import type { Vec2, Polygon, Polyline } from '../../core/geom';
import { dist } from '../../core/geom';
import { area, pointInRing, distToSeg, segSegT, orientPos, bboxOf, distToRing } from '../../geo/poly';
import type { MultiPoly } from '../../geo/bool';
import type { Streets } from '../streets';
import type { UrbanCtx } from '../context';
import { GridIndex } from '../../geo/spatial';

/** Spatial index of polylines with half widths (roads): fast clearance tests. */
export class LineIndex {
  private idx = new GridIndex<{ a: Vec2; b: Vec2; hw: number }>(40);
  constructor(lines: { path: Polyline; hw: number }[]) {
    for (const l of lines) for (let i = 1; i < l.path.length; i++) this.idx.insertSeg(l.path[i - 1], l.path[i], { a: l.path[i - 1], b: l.path[i], hw: l.hw });
  }
  clear(poly: Polygon, margin: number): boolean {
    const bb = bboxOf(poly);
    let ok = true;
    this.idx.forEachIn(bb.x0 - margin - 10, bb.y0 - margin - 10, bb.x1 + margin + 10, bb.y1 + margin + 10, (sg) => {
      if (ok && segPolyDist(sg.a, sg.b, poly) < sg.hw + margin) ok = false;
    });
    return ok;
  }
  /** Distance from p to the nearest line (∞ beyond r). */
  dist(p: Vec2, r: number): number {
    let d = Infinity;
    this.idx.forEachIn(p.x - r, p.y - r, p.x + r, p.y + r, (sg) => { d = Math.min(d, distToSeg(p, sg.a, sg.b)); });
    return d;
  }
}

export const TAU = Math.PI * 2;

/** Rectangle [u0,u1]×[v0,v1] in the frame (c, angle). */
export function rectAt(c: Vec2, ang: number, u0: number, u1: number, v0: number, v1: number): Polygon {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const at = (u: number, v: number): Vec2 => ({ x: c.x + u * ca - v * sa, y: c.y + u * sa + v * ca });
  return orientPos([at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)]);
}
/** Point of the frame (c, angle). */
export const frameAt = (c: Vec2, ang: number, u: number, v: number): Vec2 => ({ x: c.x + u * Math.cos(ang) - v * Math.sin(ang), y: c.y + u * Math.sin(ang) + v * Math.cos(ang) });

/** Polygonal ellipse (semi-axes a along `ang`, b across). */
export function ellipseAt(c: Vec2, ang: number, a: number, b: number, n = 36): Polygon {
  return orientPos(Array.from({ length: n }, (_, k) => { const t = (k / n) * TAU; return frameAt(c, ang, a * Math.cos(t), b * Math.sin(t)); }));
}

export const inMP = (m: MultiPoly, p: Vec2): boolean => m.some((ph) => pointInRing(ph.outer, p) && !ph.holes.some((h) => pointInRing(h, p)));

/** Distance between a segment and a polygon (0 when they intersect or the segment is inside). */
export function segPolyDist(a: Vec2, b: Vec2, poly: Polygon): number {
  if (pointInRing(poly, a) || pointInRing(poly, b)) return 0;
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    if (segSegT(a, b, p, q)) return 0;
    d = Math.min(d, distToSeg(p, a, b), distToSeg(a, p, q), distToSeg(b, p, q));
  }
  return d;
}

/** Samples inside a polygon (grid of `step` m) and on its boundary (every step / 2 m). */
export function samplePoly(poly: Polygon, step: number): Vec2[] {
  const out: Vec2[] = [];
  const bb = bboxOf(poly);
  // scanlines: the inside intervals of each row (even–odd crossings), sampled on the same lattice
  const xs: number[] = [];
  for (let y = bb.y0 + step / 2; y < bb.y1; y += step) {
    xs.length = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const p = poly[i], q = poly[j];
      if ((p.y > y) !== (q.y > y)) xs.push(p.x + ((y - p.y) * (q.x - p.x)) / (q.y - p.y));
    }
    xs.sort((u, v) => u - v);
    for (let t = 0; t + 1 < xs.length; t += 2) {
      const k0 = Math.ceil((xs[t] - bb.x0 - step / 2) / step), k1 = Math.floor((xs[t + 1] - bb.x0 - step / 2) / step);
      for (let k = Math.max(0, k0); k <= k1; k++) { const x = bb.x0 + step / 2 + k * step; if (x < bb.x1) out.push({ x, y }); }
    }
  }
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const n = Math.max(1, Math.ceil(dist(a, b) / (step / 2)));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

/** Share of the polygon's samples that lie in water (terrain grid). */
export function wetFraction(ctx: UrbanCtx, poly: Polygon, step = 6): number {
  const s = samplePoly(poly, step);
  if (!s.length) return 0;
  let w = 0;
  for (const p of s) if (ctx.isWater(p)) w++;
  return w / s.length;
}

/** Share of the polygon's samples inside a region. */
export function fracInside(m: MultiPoly, poly: Polygon, step = 8): number {
  const s = samplePoly(poly, step);
  if (!s.length) return 0;
  let k = 0;
  for (const p of s) if (inMP(m, p)) k++;
  return k / s.length;
}

/** True when no polyline (with its half width) comes within `margin` of the polygon. */
export function clearOfLines(poly: Polygon, lines: { path: Polyline; hw: number }[], margin: number): boolean {
  const bb = bboxOf(poly);
  for (const ln of lines) {
    const r = ln.hw + margin;
    for (let i = 1; i < ln.path.length; i++) {
      const a = ln.path[i - 1], b = ln.path[i];
      if (Math.max(a.x, b.x) < bb.x0 - r || Math.min(a.x, b.x) > bb.x1 + r || Math.max(a.y, b.y) < bb.y0 - r || Math.min(a.y, b.y) > bb.y1 + r) continue;
      if (segPolyDist(a, b, poly) < r) return false;
    }
  }
  return true;
}

/** True when no registered street ribbon (except `ignore`) comes within `margin` of the polygon. */
export function clearOfStreets(poly: Polygon, streets: Streets, margin: number, ignore?: Set<number>): boolean {
  const bb = bboxOf(poly);
  const r = margin + 8;
  let ok = true;
  streets.forEachSeg(bb.x0 - r, bb.y0 - r, bb.x1 + r, bb.y1 + r, (st, i) => {
    if (!ok || !st.ribbon || ignore?.has(st.id)) return;
    const hw = Math.max(st.widths[i], st.widths[i + 1]) / 2;
    if (segPolyDist(st.path[i], st.path[i + 1], poly) < hw + margin) ok = false;
  });
  return ok;
}

/** Polygons overlap or come closer than `gap` (vertex / edge distances; containment counts). */
export function polysNear(a: Polygon, b: Polygon, gap: number): boolean {
  const ba = bboxOf(a), bb = bboxOf(b);
  if (ba.x0 > bb.x1 + gap || bb.x0 > ba.x1 + gap || ba.y0 > bb.y1 + gap || bb.y0 > ba.y1 + gap) return false;
  for (let i = 0; i < a.length; i++) if (segPolyDist(a[i], a[(i + 1) % a.length], b) < gap) return true;
  return false;
}

/** Edge runs of a ring flagged by `flag(a, b)` (on the edge midpoint), as polylines; a fully flagged ring closes. */
export function edgeRuns(ring: Polygon, flag: (a: Vec2, b: Vec2) => boolean): { pl: Polyline; closed: boolean }[] {
  const n = ring.length;
  const f = ring.map((p, i) => flag(p, ring[(i + 1) % n]));
  if (f.every(Boolean)) return [{ pl: ring.concat([ring[0]]), closed: true }];
  if (!f.some(Boolean)) return [];
  let s0 = f.findIndex((v, i) => !v && f[(i + 1) % n]);
  s0 = (s0 + 1) % n;
  const out: { pl: Polyline; closed: boolean }[] = [];
  let cur: Vec2[] = [];
  for (let k = 0; k <= n; k++) {
    const i = (s0 + k) % n;
    if (k < n && f[i]) { if (!cur.length) cur.push(ring[i]); cur.push(ring[(i + 1) % n]); }
    else if (cur.length) { out.push({ pl: cur, closed: false }); cur = []; }
  }
  return out;
}

/** Length of a polyline. */
export const plLen = (pl: Polyline): number => { let s = 0; for (let i = 1; i < pl.length; i++) s += dist(pl[i - 1], pl[i]); return s; };

/** Point at arclength s along a polyline. */
export function plAt(pl: Polyline, s: number): { p: Vec2; i: number } {
  let acc = 0;
  for (let i = 1; i < pl.length; i++) {
    const d = dist(pl[i - 1], pl[i]);
    if (acc + d >= s) { const t = d > 0 ? (s - acc) / d : 0; return { p: { x: pl[i - 1].x + (pl[i].x - pl[i - 1].x) * t, y: pl[i - 1].y + (pl[i].y - pl[i - 1].y) * t }, i }; }
    acc += d;
  }
  return { p: pl[pl.length - 1], i: pl.length - 1 };
}

/** Inserts point p (lying on segment i-1..i) as a vertex; returns the new polyline and p's index. */
export function insertAt(pl: Polyline, p: Vec2, i: number): { pl: Polyline; k: number } {
  if (dist(pl[i - 1], p) < 0.05) return { pl, k: i - 1 };
  if (dist(pl[i], p) < 0.05) return { pl, k: i };
  return { pl: [...pl.slice(0, i), p, ...pl.slice(i)], k: i };
}

/** Nearest point of a polyline to p: point, segment end index and distance. */
export function nearestOnPl(pl: Polyline, p: Vec2): { q: Vec2; i: number; d: number } {
  let best = { q: pl[0], i: 1, d: Infinity };
  for (let i = 1; i < pl.length; i++) {
    const a = pl[i - 1], b = pl[i];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const d = dist(p, q);
    if (d < best.d) best = { q, i, d };
  }
  return best;
}

export interface ConnectorOpts {
  /** Polygons the connector may not enter (other lots, its own lot). */
  avoid: Polygon[];
  /** Rings it may not cross (the town wall), except within `gateR` of a gate. */
  noCross?: Polygon[];
  gates?: Vec2[];
  maxLen: number;
  /** Prefer targets on streets with rank ≤ this (main streets first). */
  preferRank?: number;
  /** Preferred directions (unit): rays tried first (e.g. the gate axis of a castle, the west front of a church). */
  dirs?: Vec2[];
}

/**
 * Connector from `from` (on a lot boundary) to the connected street network: a straight cut ending on the first
 * connected street centreline it meets (unconnected streets it crosses on the way join the network through it).
 * Candidates: rays along the preferred directions, then the nearest points of the connected streets. It may not
 * run through water, through the avoided lots, or across the town wall (outside the gates).
 * Returns the polyline (from → point on a street) and the ids of the streets it crosses or ends on.
 */
export function findConnector(ctx: UrbanCtx, streets: Streets, from: Vec2, o: ConnectorOpts): Polyline | null {
  const r = findConnectorX(ctx, streets, from, o);
  return r ? r.path : null;
}
export const CONN_DBG: { log: ((s: string) => void) | null } = { log: null };
export function findConnectorX(ctx: UrbanCtx, streets: Streets, from: Vec2, o: ConnectorOpts): { path: Polyline; met: number[] } | null {
  const why = (s: string) => CONN_DBG.log?.(s);
  const targets: Vec2[] = [];
  for (const d of o.dirs ?? []) targets.push({ x: from.x + d.x * o.maxLen, y: from.y + d.y * o.maxLen });
  const cands: { q: Vec2; d: number }[] = [];
  for (const st of streets.list) {
    if (!st.ribbon || !streets.connected.has(st.id) || st.role === 'close') continue;
    const n = nearestOnPl(st.path, from);
    if (n.d > o.maxLen) continue;
    cands.push({ q: n.q, d: n.d + (st.rank > (o.preferRank ?? 9) ? 60 : 0) });
  }
  cands.sort((a, b) => a.d - b.d);
  for (const c of cands.slice(0, 12)) targets.push(c.q);
  for (const q of targets) {
    if (dist(from, q) < 0.5) continue;
    // crossings with street centrelines along from → q (beyond q by 1 m, so a target on a street is met)
    const L0 = dist(from, q);
    const qq = { x: from.x + ((q.x - from.x) * (L0 + 1)) / L0, y: from.y + ((q.y - from.y) * (L0 + 1)) / L0 };
    const xs: { t: number; p: Vec2; id: number; conn: boolean }[] = [];
    for (const st of streets.query([from, qq, from], 2)) {
      if (!st.ribbon || st.role === 'close') continue;
      for (let i = 1; i < st.path.length; i++) {
        const r = segSegT(from, qq, st.path[i - 1], st.path[i]);
        if (r && r.t > 1e-3) xs.push({ t: r.t, p: { x: from.x + (qq.x - from.x) * r.t, y: from.y + (qq.y - from.y) * r.t }, id: st.id, conn: streets.connected.has(st.id) });
      }
    }
    xs.sort((a, b) => a.t - b.t);
    const k = xs.findIndex((x) => x.conn);
    if (k < 0) { why('no connected hit ' + xs.length); continue; }
    const hit = xs[k].p;
    const len = dist(from, hit);
    if (len > o.maxLen || len < 0.5) { why('len ' + len.toFixed(0)); continue; }
    // crossing an unconnected street within 8 m of the end (a near-parallel graze) is not a junction: skip
    if (xs.slice(0, k).some((x) => len * (1 - x.t / xs[k].t) < 8 || x.t * len < 6)) { why('graze'); continue; }
    let ok = true;
    for (let s2 = 1.5; s2 < len - 0.5 && ok; s2 += 3) {
      const p = { x: from.x + ((hit.x - from.x) * s2) / len, y: from.y + ((hit.y - from.y) * s2) / len };
      if (ctx.isWater(p)) ok = false;
      else if (o.avoid.some((a) => pointInRing(a, p) && distToRing(a, p) > 0.3)) ok = false;
    }
    if (!ok) { why('water/avoid'); continue; }
    if (o.noCross) for (const ring of o.noCross) for (let j = 0; j < ring.length && ok; j++) {
      const r = segSegT(from, hit, ring[j], ring[(j + 1) % ring.length]);
      if (r && r.t > 1e-3 && r.t < 1 - 1e-3) {
        const x = { x: from.x + (hit.x - from.x) * r.t, y: from.y + (hit.y - from.y) * r.t };
        if (!(o.gates ?? []).some((g) => dist(g, x) < 10)) ok = false;
      }
    }
    if (ok) return { path: [from, hit], met: xs.slice(0, k + 1).map((x) => x.id) };
    why('wall');
  }
  return null;
}

/** Convex polygon from radii at evenly spaced angles (jittered), as the convex hull of the vertices. */
export function radialPolygon(c: Vec2, a0: number, radii: number[]): Polygon {
  const n = radii.length;
  return orientPos(radii.map((r, k) => ({ x: c.x + Math.cos(a0 + (k / n) * TAU) * r, y: c.y + Math.sin(a0 + (k / n) * TAU) * r })));
}

/** Scales a polygon about a point. */
export const scalePoly = (p: Polygon, c: Vec2, k: number): Polygon => p.map((q) => ({ x: c.x + (q.x - c.x) * k, y: c.y + (q.y - c.y) * k }));

/** Polygon area helper re-export. */
export { area };
