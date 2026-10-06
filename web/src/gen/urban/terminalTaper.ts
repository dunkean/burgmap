/** A long terminal wedge can be unusable even when the whole roof has a wide OBB and core. */
import type { Polygon, Vec2 } from '../core/geom';
import { dist } from '../core/geom';

export interface TerminalTaper {
  edge: number;
  vertex?: boolean;
  capWidth: number;
  thinLength: number;
  tip: Vec2;
  outward: Vec2;
  cut: [Vec2, Vec2];
  widened: [Vec2, Vec2];
}

/** A narrow cap between two long, converging walls; ordinary corner chamfers and triangles are excluded. */
export function terminalTapers(poly: Polygon): TerminalTaper[] {
  if (poly.length < 4) return [];
  const found: TerminalTaper[] = [];
  const positive = poly.reduce((sum, p, i) => {
    const q = poly[(i + 1) % poly.length]; return sum + p.x * q.y - p.y * q.x;
  }, 0) >= 0;
  const reflex = (i: number): boolean => {
    const a = poly[(i - 1 + poly.length) % poly.length], b = poly[i], c = poly[(i + 1) % poly.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    return (positive ? cross : -cross) < -1e-7;
  };
  for (let i = 0; i < poly.length; i++) for (const vertex of [false, true]) {
    // A pointed end must belong to a returning arm. A normal convex 45-degree corner is not an arm.
    const returning = reflex((i - 1 + poly.length) % poly.length) || reflex((i + 1) % poly.length);
    const a = poly[(i - 1 + poly.length) % poly.length], v = poly[i];
    const w = vertex ? v : poly[(i + 1) % poly.length], b = poly[(i + (vertex ? 1 : 2)) % poly.length];
    const cap = dist(v, w), la = dist(v, a), lb = dist(w, b);
    if (cap >= 3.2 || la < 3.6 || lb < 3.6 || dist(a, b) < 3.6) continue;
    const dot = ((a.x - v.x) * (b.x - w.x) + (a.y - v.y) * (b.y - w.y)) / (la * lb);
    if (dot <= 0.5 || (vertex && !returning && (poly.length < 5 || dot <= Math.SQRT1_2 + 1e-6))) continue;
    const tip = { x: (v.x + w.x) / 2, y: (v.y + w.y) / 2 };
    const dx = (a.x + b.x) / 2 - tip.x, dy = (a.y + b.y) / 2 - tip.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) continue;
    const u = { x: dx / length, y: dy / length }, n = { x: -u.y, y: u.x };
    const U = (p: Vec2) => (p.x - tip.x) * u.x + (p.y - tip.y) * u.y;
    const av = U(a) - U(v), bw = U(b) - U(w);
    if (av <= 0 || bw <= 0) continue;
    const start = Math.max(U(v), U(w)), end = Math.min(U(a), U(b));
    if (end - start < 3.6) continue;
    const at = (depth: number): [Vec2, Vec2] => {
      const ta = (depth - U(v)) / av, tb = (depth - U(w)) / bw;
      return [{ x: v.x + ta * (a.x - v.x), y: v.y + ta * (a.y - v.y) },
        { x: w.x + tb * (b.x - w.x), y: w.y + tb * (b.y - w.y) }];
    };
    const width = ([p, q]: [Vec2, Vec2]) => (q.x - p.x) * n.x + (q.y - p.y) * n.y;
    const signed = width(at(start)), sign = Math.sign(signed) || Math.sign(width(at(end)));
    if (!sign) continue;
    const first = Math.abs(signed), last = sign * width(at(end));
    if (first >= 3.2 || last <= first) continue;
    const slope = (last - first) / (end - start), thinLength = Math.min(end - start, (3.2 - first) / slope);
    if (thinLength < 2) continue;
    const cut: [Vec2, Vec2] = last >= 3.6 ? at(start + (3.6 - first) / slope) : [a, b];
    const widen = (3.6 - Math.abs((w.x - v.x) * n.x + (w.y - v.y) * n.y)) / 2;
    found.push({ edge: i, ...(vertex ? { vertex: true } : {}), capWidth: first, thinLength, tip, outward: { x: -u.x, y: -u.y }, cut,
      widened: [{ x: v.x - sign * n.x * widen, y: v.y - sign * n.y * widen },
        { x: w.x + sign * n.x * widen, y: w.y + sign * n.y * widen }] });
  }
  return found;
}

/** Keep the original ring order, changing only the two ends of this terminal cap. */
export function replaceTerminalCap(poly: Polygon, taper: TerminalTaper, cap: [Vec2, Vec2]): Polygon {
  if (taper.vertex) return poly.flatMap((p, i) => i === taper.edge ? cap : [p]);
  return poly.map((p, i) => i === taper.edge ? cap[0] : i === (taper.edge + 1) % poly.length ? cap[1] : p);
}
