export type Vec2 = { x: number; y: number };
export type Polygon = Vec2[];
export type Polyline = Vec2[];

export const v2 = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const norm = (a: Vec2): Vec2 => { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; };
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });

/** Signed area (positive = CCW in a y-up frame, CW visually in y-down). */
export function polygonArea(p: Polygon): number {
  let s = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function polygonCentroid(p: Polygon): Vec2 {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const p0 = p[i], p1 = p[(i + 1) % n];
    const c = p0.x * p1.y - p1.x * p0.y;
    a += c; cx += (p0.x + p1.x) * c; cy += (p0.y + p1.y) * c;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sy = 0;
    for (const q of p) { sx += q.x; sy += q.y; }
    return { x: sx / p.length, y: sy / p.length };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

export function polygonContains(p: Polygon, pt: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[i], b = p[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function bbox(pts: Vec2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function polylineLength(pl: Polyline): number {
  let s = 0;
  for (let i = 1; i < pl.length; i++) s += dist(pl[i - 1], pl[i]);
  return s;
}

/** Resample at (approximately) uniform spacing, keeping endpoints. Returns t-parameters via optional callback data. */
export function resample(pl: Polyline, spacing: number): Polyline {
  if (pl.length < 2) return pl.slice();
  const total = polylineLength(pl);
  const n = Math.max(1, Math.round(total / spacing));
  const step = total / n;
  const out: Polyline = [{ ...pl[0] }];
  let acc = 0, target = step;
  for (let i = 1; i < pl.length && out.length < n; i++) {
    const a = pl[i - 1], b = pl[i];
    const l = dist(a, b);
    while (acc + l >= target && out.length < n) {
      out.push(lerp(a, b, (target - acc) / (l || 1)));
      target += step;
    }
    acc += l;
  }
  out.push({ ...pl[pl.length - 1] });
  return out;
}

/** Chaikin corner cutting. Keeps endpoints for open lines. */
export function chaikin(pl: Polyline, iterations = 2, closed = false): Polyline {
  let cur = pl;
  for (let it = 0; it < iterations; it++) {
    const out: Polyline = [];
    const n = cur.length;
    if (n < 3) return cur;
    if (!closed) out.push(cur[0]);
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = cur[i], b = cur[(i + 1) % n];
      out.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
      out.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    if (!closed) out.push(cur[n - 1]);
    cur = out;
  }
  return cur;
}

/** Ramer-Douglas-Peucker. */
export function simplify(pl: Polyline, tol: number): Polyline {
  if (pl.length < 3) return pl.slice();
  const keep = new Uint8Array(pl.length);
  keep[0] = keep[pl.length - 1] = 1;
  const stack: [number, number][] = [[0, pl.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0, idx = -1;
    const a = pl[s], b = pl[e];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    for (let i = s + 1; i < e; i++) {
      const p = pl[i];
      let d: number;
      if (l2 === 0) d = dist(p, a);
      else {
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
        d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
      }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx >= 0 && maxD > tol) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return pl.filter((_, i) => keep[i]);
}

/** Per-vertex unit normals of a polyline (averaged over adjacent segments). */
export function polylineNormals(pl: Polyline): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < pl.length; i++) {
    const a = pl[Math.max(0, i - 1)], b = pl[Math.min(pl.length - 1, i + 1)];
    const t = norm(sub(b, a));
    out.push({ x: -t.y, y: t.x });
  }
  return out;
}

/** Ribbon polygon around a polyline with per-vertex full widths (or a constant). */
export function offsetRibbon(pl: Polyline, width: number | number[]): Polygon {
  if (pl.length < 2) return [];
  const nrm = polylineNormals(pl);
  const left: Vec2[] = [], right: Vec2[] = [];
  for (let i = 0; i < pl.length; i++) {
    const w = (typeof width === 'number' ? width : width[i]) / 2;
    left.push({ x: pl[i].x + nrm[i].x * w, y: pl[i].y + nrm[i].y * w });
    right.push({ x: pl[i].x - nrm[i].x * w, y: pl[i].y - nrm[i].y * w });
  }
  return left.concat(right.reverse());
}

/** Closest distance from a point to a polyline. */
export function distToPolyline(p: Vec2, pl: Polyline): number {
  let best = Infinity;
  for (let i = 1; i < pl.length; i++) {
    const a = pl[i - 1], b = pl[i];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}
