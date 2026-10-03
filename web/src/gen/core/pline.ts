import { Vec2, Polyline, dist, polylineLength } from './geom';

/** Polyline helpers shared by the river network builder and the road junction code. */

export interface Near { pt: Vec2; i: number; t: number; d: number }

/** Nearest point on a polyline: segment index `i` (pt lies on i -> i+1) and parameter `t` in [0, 1]. */
export function nearestOn(pl: Polyline, p: Vec2): Near {
  let best = Infinity;
  let res: Near = { pt: pl[0], i: 0, t: 0, d: Infinity };
  for (let i = 0; i + 1 < pl.length; i++) {
    const a = pl[i], b = pl[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    const qx = a.x + t * dx, qy = a.y + t * dy;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (d < best) { best = d; res = { pt: { x: qx, y: qy }, i, t, d }; }
  }
  return res;
}

export interface Hit { pt: Vec2; i: number; t: number; j: number; u: number }

/** Segment/segment intersection (proper, interior of both). */
export function segHit(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { t: number; u: number } | null {
  const r = { x: b.x - a.x, y: b.y - a.y }, s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-12) return null;
  const qp = { x: c.x - a.x, y: c.y - a.y };
  const t = (qp.x * s.y - qp.y * s.x) / den;
  const u = (qp.x * r.y - qp.y * r.x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

/** First crossing of `pl` (walking from its start) with `other`. */
export function firstCrossing(pl: Polyline, other: Polyline, skipFirstLen = 0): Hit | null {
  let acc = 0;
  for (let i = 0; i + 1 < pl.length; i++) {
    const a = pl[i], b = pl[i + 1];
    const sl = dist(a, b);
    let best: Hit | null = null;
    for (let j = 0; j + 1 < other.length; j++) {
      const h = segHit(a, b, other[j], other[j + 1]);
      if (!h) continue;
      if (acc + h.t * sl < skipFirstLen) continue;
      if (!best || h.t < best.t) best = { pt: { x: a.x + (b.x - a.x) * h.t, y: a.y + (b.y - a.y) * h.t }, i, t: h.t, j, u: h.u };
    }
    if (best) return best;
    acc += sl;
  }
  return null;
}

/** Self-intersection test (non-adjacent segments). */
export function selfIntersects(pl: Polyline): boolean {
  const m = pl.length - 1;
  if (m < 48) {
    for (let i = 0; i + 1 < pl.length; i++) {
      for (let j = i + 2; j + 1 < pl.length; j++) {
        if (segHit(pl[i], pl[i + 1], pl[j], pl[j + 1])) return true;
      }
    }
    return false;
  }
  // long polylines: sweep over x (only pairs whose boxes overlap can hit; a tiny margin keeps the test exact)
  const E = 1e-6;
  const x0 = new Float64Array(m), x1 = new Float64Array(m), y0 = new Float64Array(m), y1 = new Float64Array(m);
  const ord: number[] = [];
  for (let i = 0; i < m; i++) {
    const a = pl[i], b = pl[i + 1];
    x0[i] = Math.min(a.x, b.x) - E; x1[i] = Math.max(a.x, b.x) + E; y0[i] = Math.min(a.y, b.y) - E; y1[i] = Math.max(a.y, b.y) + E;
    ord.push(i);
  }
  ord.sort((p, q) => x0[p] - x0[q]);
  const active: number[] = [];
  for (const i of ord) {
    let w = 0;
    for (let k = 0; k < active.length; k++) {
      const j = active[k];
      if (x1[j] < x0[i]) continue;
      active[w++] = j;
      if (Math.abs(i - j) < 2 || y1[j] < y0[i] || y1[i] < y0[j]) continue;
      const lo = Math.min(i, j), hi = Math.max(i, j);
      if (segHit(pl[lo], pl[lo + 1], pl[hi], pl[hi + 1])) return true;
    }
    active.length = w;
    active.push(i);
  }
  return false;
}

export function lengths(pl: Polyline): number[] {
  const s = [0];
  for (let i = 1; i < pl.length; i++) s.push(s[i - 1] + dist(pl[i - 1], pl[i]));
  return s;
}

/** Point at arc length `s` along `pl` and the unit tangent there. */
export function pointAt(pl: Polyline, s: number): { pt: Vec2; dir: Vec2; i: number } {
  let acc = 0;
  for (let i = 1; i < pl.length; i++) {
    const l = dist(pl[i - 1], pl[i]);
    if (acc + l >= s || i === pl.length - 1) {
      const t = l > 0 ? Math.max(0, Math.min(1, (s - acc) / l)) : 0;
      const a = pl[i - 1], b = pl[i];
      const dl = l || 1;
      return { pt: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, dir: { x: (b.x - a.x) / dl, y: (b.y - a.y) / dl }, i: i - 1 };
    }
    acc += l;
  }
  return { pt: pl[0], dir: { x: 1, y: 0 }, i: 0 };
}

/**
 * `pointAt(pl, s)` with the prefix lengths `pre = lengths(pl)` computed once: the same floats as the linear walk
 * (pre[i] is exactly the walk's `acc + l`), found by binary search.
 */
export function pointAtPre(pl: Polyline, pre: number[], s: number): { pt: Vec2; dir: Vec2; i: number } {
  const n = pl.length;
  if (n < 2) return { pt: pl[0], dir: { x: 1, y: 0 }, i: 0 };
  // first i in [1, n-1] with pre[i] >= s, else n-1
  let lo = 1, hi = n - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (pre[m] >= s) hi = m; else lo = m + 1; }
  const i = lo;
  const a = pl[i - 1], b = pl[i];
  const l = dist(a, b);
  const t = l > 0 ? Math.max(0, Math.min(1, (s - pre[i - 1]) / l)) : 0;
  const dl = l || 1;
  return { pt: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, dir: { x: (b.x - a.x) / dl, y: (b.y - a.y) / dl }, i: i - 1 };
}

/**
 * Grid index over the segments of a polyline. `nearest(p, R)` returns exactly `nearestOn(pl, p)` (same segment,
 * same parameter, same distance, first index on ties) when that distance is ≤ R, and null when it is larger.
 * The polyline must not change while the index is used.
 */
export class PolyIndex {
  private cells = new Map<number, number[]>();
  private stamp: Int32Array;
  private tick = 0;
  constructor(readonly pl: Polyline, private cs = 24) {
    this.stamp = new Int32Array(Math.max(1, pl.length));
    for (let i = 0; i + 1 < pl.length; i++) {
      const a = pl[i], b = pl[i + 1];
      const x0 = Math.floor(Math.min(a.x, b.x) / cs), x1 = Math.floor(Math.max(a.x, b.x) / cs);
      const y0 = Math.floor(Math.min(a.y, b.y) / cs), y1 = Math.floor(Math.max(a.y, b.y) / cs);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const k = x * 1048576 + y;
        let l = this.cells.get(k);
        if (!l) { l = []; this.cells.set(k, l); }
        l.push(i);
      }
    }
  }
  nearest(p: Vec2, R: number): Near | null {
    const pl = this.pl, cs = this.cs;
    if (pl.length < 2 || !(R >= 0)) return null;
    const x0 = Math.floor((p.x - R) / cs), x1 = Math.floor((p.x + R) / cs);
    const y0 = Math.floor((p.y - R) / cs), y1 = Math.floor((p.y + R) / cs);
    const tk = ++this.tick;
    let best = Infinity, bi = -1, bt = 0, bx = 0, by = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const l = this.cells.get(x * 1048576 + y);
      if (!l) continue;
      for (const i of l) {
        if (this.stamp[i] === tk) continue;
        this.stamp[i] = tk;
        const a = pl[i], b = pl[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
        const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
        const qx = a.x + t * dx, qy = a.y + t * dy;
        const d = Math.hypot(p.x - qx, p.y - qy);
        if (d < best || (d === best && i < bi)) { best = d; bi = i; bt = t; bx = qx; by = qy; }
      }
    }
    if (bi < 0 || !(best <= R)) return null;
    return { pt: { x: bx, y: by }, i: bi, t: bt, d: best };
  }
}

/** Arc length of a point described by (segment, t). */
export function arcOf(pl: Polyline, i: number, t: number): number {
  let s = 0;
  for (let k = 0; k < i; k++) s += dist(pl[k], pl[k + 1]);
  return s + t * dist(pl[i], pl[i + 1]);
}

/** Smoothed unit tangent around arc length `s` (chord over +-`half` metres). */
export function tangentAt(pl: Polyline, s: number, half = 12): Vec2 {
  const L = polylineLength(pl);
  const a = pointAt(pl, Math.max(0, s - half)).pt, b = pointAt(pl, Math.min(L, s + half)).pt;
  const l = dist(a, b) || 1;
  return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
}

/** Insert the point (seg `i`, param `t`) as a vertex; returns the new vertex index. Reuses an existing vertex when close. */
export function insertVertex(pl: Polyline, i: number, t: number, snap = 0.6): number {
  const a = pl[i], b = pl[i + 1];
  const sl = dist(a, b);
  if (t * sl < snap) return i;
  if ((1 - t) * sl < snap) return i + 1;
  pl.splice(i + 1, 0, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  return i + 1;
}

/** Cubic Bezier samples (excluding the start point, including the end point). */
export function bezier(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, n: number): Vec2[] {
  const out: Vec2[] = [];
  for (let k = 1; k <= n; k++) {
    const t = k / n, m = 1 - t;
    const a = m * m * m, b = 3 * m * m * t, c = 3 * m * t * t, d = t * t * t;
    out.push({ x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y });
  }
  return out;
}

/** Unit vector `v` rotated by `ang` radians. */
export function rot(v: Vec2, ang: number): Vec2 {
  const c = Math.cos(ang), s = Math.sin(ang);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** Sub-polyline between arc lengths s0 and s1. */
export function slicePolyline(pl: Polyline, s0: number, s1: number): Polyline {
  const out: Vec2[] = [pointAt(pl, s0).pt];
  let acc = 0;
  for (let i = 1; i < pl.length; i++) {
    acc += dist(pl[i - 1], pl[i]);
    if (acc > s0 + 1e-6 && acc < s1 - 1e-6) out.push(pl[i]);
  }
  out.push(pointAt(pl, s1).pt);
  return out;
}

/** Distance between two polylines sampled every `step` (min over samples of a). */
export function minDistSampled(a: Polyline, b: Polyline, step = 4): number {
  let m = Infinity;
  const L = polylineLength(a);
  for (let s = 0; s <= L; s += step) m = Math.min(m, nearestOn(b, pointAt(a, s).pt).d);
  return m;
}

/**
 * Reshape the end of `pl` so it arrives at `J` travelling along `u` (unit), blending from the point `lead`
 * metres before the end. `ok` vets the candidate; the result (or null) is returned without mutating `pl`.
 */
export function blendEnd(pl: Polyline, J: Vec2, u: Vec2, lead: number, ok: (cand: Polyline) => boolean, tail = 18): Polyline | null {
  const L = polylineLength(pl);
  const J2 = { x: J.x - u.x * tail, y: J.y - u.y * tail };
  for (const f of [1, 1.6, 2.4]) {
    const ld = Math.min(lead * f, L * 0.9);
    const sQ = Math.max(0, L - ld);
    const q = pointAt(pl, sQ);
    const dq = tangentAt(pl, sQ, 6);
    const D = dist(q.pt, J2);
    if (D < 4) continue;
    const c1 = { x: q.pt.x + dq.x * D * 0.38, y: q.pt.y + dq.y * D * 0.38 };
    const c2 = { x: J2.x - u.x * D * 0.38, y: J2.y - u.y * D * 0.38 };
    const samples = bezier(q.pt, c1, c2, J2, Math.max(6, Math.round(D / 7)));
    const head: Vec2[] = [];
    let acc = 0;
    for (let i = 0; i < pl.length; i++) {
      if (i > 0) acc += dist(pl[i - 1], pl[i]);
      if (acc < sQ - 1e-6) head.push(pl[i]); else break;
    }
    const cand = head.concat([q.pt], samples, [{ x: J.x, y: J.y }]);
    if (ok(cand)) return cand;
  }
  return null;
}
