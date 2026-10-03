/**
 * Polygon utilities for the urban geometry kernel.
 *
 * Conventions: meters; polygons are open rings (last vertex != first) normalized to POSITIVE signed area
 * (`polygonArea` > 0). With that orientation the interior lies to the LEFT of every edge, so the inward
 * normal of edge a→b is perp(b − a) = (−dy, dx).
 */
import { Vec2, Polygon, polygonArea, dist } from '../core/geom';

export const SNAP = 100; // 1 cm grid
export const snap = (v: number): number => Math.round(v * SNAP) / SNAP;
export const snapPt = (p: Vec2): Vec2 => ({ x: snap(p.x), y: snap(p.y) });

export const area = (p: Polygon): number => Math.abs(polygonArea(p));

/** Returns the ring with positive signed area (reversing a copy when needed). */
export function orientPos(p: Polygon): Polygon {
  return polygonArea(p) < 0 ? p.slice().reverse() : p;
}

/** Interior angle (radians, 0..2π) at vertex i of a positively oriented polygon. */
export function interiorAngle(p: Polygon, i: number): number {
  const n = p.length;
  const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n];
  const ux = a.x - b.x, uy = a.y - b.y, vx = c.x - b.x, vy = c.y - b.y;
  // angle from (b→c) counter-clockwise to (b→a) is the interior angle for a positive ring
  let ang = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  ang = -ang;
  if (ang < 0) ang += 2 * Math.PI;
  return ang;
}

export function minAngle(p: Polygon): number {
  let m = Infinity;
  for (let i = 0; i < p.length; i++) m = Math.min(m, interiorAngle(p, i));
  return m;
}

/**
 * Snap to 1 cm, drop duplicate vertices, edges shorter than `minEdge`, and vertices whose turn is below
 * `colDeg` degrees (collinear). Keeps orientation. Returns [] when the ring degenerates.
 */
export function cleanRing(p: Polygon, minEdge = 0.3, colDeg = 1, triMax = Infinity, snapIt = true): Polygon {
  let pts = snapIt ? p.map(snapPt) : p.slice();
  const colSin = Math.sin((colDeg * Math.PI) / 180);
  for (let iter = 0; iter < 6; iter++) {
    const n0 = pts.length;
    // duplicates / short edges: merge into the previous kept vertex
    const out: Vec2[] = [];
    for (const q of pts) {
      if (out.length && dist(out[out.length - 1], q) < minEdge) continue;
      out.push(q);
    }
    while (out.length > 2 && dist(out[0], out[out.length - 1]) < minEdge) out.pop();
    pts = out;
    if (pts.length < 3) return [];
    // collinear or spike (turn ~ 180°) vertices
    const keep: Vec2[] = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = keep.length ? keep[keep.length - 1] : pts[(i - 1 + n) % n];
      const b = pts[i], c = pts[(i + 1) % n];
      const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      if (lu < 1e-9 || lv < 1e-9) continue;
      const s = (ux * vy - uy * vx) / (lu * lv), co = (ux * vx + uy * vy) / (lu * lv);
      if (Math.abs(s) < colSin && co > 0 && 0.5 * Math.abs(ux * vy - uy * vx) <= triMax) continue; // straight through
      if (co < -0.99 && 0.5 * Math.abs(ux * vy - uy * vx) < 0.05) continue; // hair / spike (out and back)
      keep.push(b);
    }
    pts = keep;
    if (pts.length < 3) return [];
    if (pts.length === n0) break;
  }
  if (Math.abs(polygonArea(pts)) < 1e-4) return [];
  return pts;
}

/** Proper segment intersection (excluding shared endpoints). Returns t along ab or -1. */
export function segSegT(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { t: number; u: number } | null {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = c.x - a.x, qy = c.y - a.y;
  const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

/** True when the ring has no self-intersections (O(n²), for validation / tests). */
export function isSimple(p: Polygon): boolean {
  const n = p.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      const c = p[j], d = p[(j + 1) % n];
      const r = segSegT(a, b, c, d);
      if (r && r.t > 1e-9 && r.t < 1 - 1e-9 && r.u > 1e-9 && r.u < 1 - 1e-9) return false;
    }
  }
  return true;
}

export function pointInRing(p: Polygon, pt: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[i], b = p[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

export function distToRing(p: Polygon, pt: Vec2): number {
  let best = Infinity;
  for (let i = 0; i < p.length; i++) best = Math.min(best, distToSeg(pt, p[i], p[(i + 1) % p.length]));
  return best;
}

export function signedDistToRing(p: Polygon, pt: Vec2): number {
  const d = distToRing(p, pt);
  return pointInRing(p, pt) ? d : -d;
}

export function perimeter(p: Polygon): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += dist(p[i], p[(i + 1) % p.length]);
  return s;
}

export function bboxOf(p: Vec2[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of p) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
  return { x0, y0, x1, y1 };
}

// ---------------------------------------------------------------- convex hull / OBB

export function convexHull(pts: Vec2[]): Vec2[] {
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cr = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: Vec2[] = [], hi: Vec2[] = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  lo.pop(); hi.pop();
  return lo.concat(hi);
}

export interface OBB { c: Vec2; u: Vec2; v: Vec2; hu: number; hv: number; /** long axis = u, hu >= hv */ }

/** Minimum-area oriented bounding box; `u` is the long axis. */
export function obb(pts: Vec2[]): OBB {
  const h = convexHull(pts);
  let best: OBB | null = null, bestA = Infinity;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const l = dist(a, b);
    if (l < 1e-9) continue;
    const ux = (b.x - a.x) / l, uy = (b.y - a.y) / l;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const q of h) {
      const pu = q.x * ux + q.y * uy, pv = -q.x * uy + q.y * ux;
      if (pu < u0) u0 = pu; if (pu > u1) u1 = pu; if (pv < v0) v0 = pv; if (pv > v1) v1 = pv;
    }
    const A = (u1 - u0) * (v1 - v0);
    if (A < bestA) {
      bestA = A;
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
      const c = { x: cu * ux - cv * uy, y: cu * uy + cv * ux };
      let o: OBB = { c, u: { x: ux, y: uy }, v: { x: -uy, y: ux }, hu: (u1 - u0) / 2, hv: (v1 - v0) / 2 };
      if (o.hv > o.hu) o = { c, u: o.v, v: { x: -o.v.x, y: -o.v.y }, hu: o.hv, hv: o.hu };
      best = o;
    }
  }
  if (!best) {
    const c = pts[0] ?? { x: 0, y: 0 };
    return { c, u: { x: 1, y: 0 }, v: { x: 0, y: 1 }, hu: 0, hv: 0 };
  }
  return best;
}

// ---------------------------------------------------------------- pole of inaccessibility (inradius)

/**
 * Largest inscribed circle (polylabel, Garcia-Castellanos & Lombardo / Mapbox). `holes` optional.
 * Returns center and radius; precision in meters.
 */
export function inscribed(outer: Polygon, holes: Polygon[] = [], precision = 0.5, enough = Infinity): { c: Vec2; r: number } {
  // (`enough`: the search may stop once a circle of that radius is found — for callers that only compare the
  // radius with that threshold; the full search could only return a larger one)
  const rings = [outer, ...holes];
  const bb = bboxOf(outer);
  const w = bb.x1 - bb.x0, h = bb.y1 - bb.y0;
  const cellSize = Math.min(w, h);
  if (cellSize <= 0) return { c: outer[0], r: 0 };
  // (flat coordinates; the same arithmetic as pointInRing / distToSeg, without a point object per edge)
  const RX = rings.map((r) => Float64Array.from(r, (q) => q.x)), RY = rings.map((r) => Float64Array.from(r, (q) => q.y));
  const sd = (x: number, y: number): number => {
    let inside = false, md = Infinity;
    for (let ri = 0; ri < RX.length; ri++) {
      const X = RX[ri], Y = RY[ri], m = X.length;
      for (let i = 0, j = m - 1; i < m; j = i++) {
        const ax = X[i], ay = Y[i], bx = X[j], by = Y[j];
        if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
        const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
        if (d < md) md = d;
      }
    }
    return inside ? md : -md;
  };
  interface Cell { x: number; y: number; h: number; d: number; max: number; seq: number }
  let seq = 0;
  const mk = (x: number, y: number, hh: number): Cell => { const d = sd(x, y); return { x, y, h: hh, d, max: d + hh * Math.SQRT2, seq: seq++ }; };
  // max-heap on `max`, ties to the earliest pushed (the pop order of the former sorted array: an insertion went
  // before its equals and pops came from the end)
  const heap: Cell[] = [];
  const above = (a: Cell, b: Cell): boolean => a.max > b.max || (a.max === b.max && a.seq < b.seq);
  const push = (c: Cell) => {
    let i = heap.length;
    heap.push(c);
    while (i > 0) { const p = (i - 1) >> 1; if (!above(c, heap[p])) break; heap[i] = heap[p]; i = p; }
    heap[i] = c;
  };
  const pop = (): Cell => {
    const top = heap[0], last = heap.pop()!;
    const m = heap.length;
    if (m) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= m) break;
        if (c + 1 < m && above(heap[c + 1], heap[c])) c++;
        if (!above(heap[c], last)) break;
        heap[i] = heap[c]; i = c;
      }
      heap[i] = last;
    }
    return top;
  };
  const queue = { get length() { return heap.length; }, pop };
  let hh = cellSize / 2;
  for (let x = bb.x0; x < bb.x1; x += cellSize) for (let y = bb.y0; y < bb.y1; y += cellSize) push(mk(x + hh, y + hh, hh));
  // centroid-ish seed
  let sx = 0, sy = 0;
  for (const q of outer) { sx += q.x; sy += q.y; }
  let best = mk(sx / outer.length, sy / outer.length, 0);
  const bbc = mk(bb.x0 + w / 2, bb.y0 + h / 2, 0);
  if (bbc.d > best.d) best = bbc;
  let guard = 0;
  while (queue.length && guard++ < 4000 && !(best.d >= enough)) {
    const c = queue.pop();
    if (c.d > best.d) best = c;
    if (c.max - best.d <= precision) continue;
    hh = c.h / 2;
    push(mk(c.x - hh, c.y - hh, hh)); push(mk(c.x + hh, c.y - hh, hh));
    push(mk(c.x - hh, c.y + hh, hh)); push(mk(c.x + hh, c.y + hh, hh));
  }
  return { c: { x: best.x, y: best.y }, r: Math.max(0, best.d) };
}

/** Minimal width of a convex polygon (rotating calipers, O(n²) for small n). */
export function convexWidth(p: Polygon): number {
  let best = Infinity;
  const n = p.length;
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l < 1e-9) continue;
    let far = 0;
    for (const q of p) far = Math.max(far, Math.abs((b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x)) / l);
    best = Math.min(best, far);
  }
  return best;
}

/** Shoelace area of a polygon with holes. */
export function areaWithHoles(outer: Polygon, holes: Polygon[] = []): number {
  let a = area(outer);
  for (const h of holes) a -= area(h);
  return a;
}
