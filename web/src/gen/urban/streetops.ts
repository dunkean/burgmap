/**
 * Level-1 street operators (URBAN_MORPHOLOGY.md §2): polyline transforms and generators used by the primary
 * network. gateToGate spines wiggle, defensive kinks (masugata, kagi-no-te) jog, axes run gate to gate through the
 * nucleus, regional roads are led to centred gates, spirals and switchbacks are traced.
 */
import type { Vec2, Polyline, Polygon } from '../core/geom';
import { dist, polylineLength, chaikin, simplify } from '../core/geom';
import type { Rng } from '../core/rng';
import { segSegT, pointInRing, orientPos } from '../geo/poly';

const cumOf = (pl: Polyline): number[] => { const c = [0]; for (let i = 1; i < pl.length; i++) c.push(c[i - 1] + dist(pl[i - 1], pl[i])); return c; };

/** Resample at `step` m. */
export function resampleAt(pl: Polyline, step: number): Polyline {
  const cum = cumOf(pl), L = cum[cum.length - 1];
  const n = Math.max(1, Math.round(L / step));
  const out: Vec2[] = [];
  let i = 1;
  for (let k = 0; k <= n; k++) {
    const s = (L * k) / n;
    while (i < pl.length - 1 && cum[i] < s) i++;
    const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    out.push({ x: pl[i - 1].x + (pl[i].x - pl[i - 1].x) * t, y: pl[i - 1].y + (pl[i].y - pl[i - 1].y) * t });
  }
  return out;
}

/**
 * gateToGate spine: lateral displacement by a sum of two sines (wavelengths 70–160 m), amplitude `amp`, tapered to
 * zero over 40 m at both ends so that the spine still meets the gate and the centre.
 */
export function wiggle(pl: Polyline, amp: number, rng: Rng): Polyline {
  if (amp <= 0 || pl.length < 2) return pl;
  const p = resampleAt(pl, 6);
  const cum = cumOf(p), L = cum[cum.length - 1];
  if (L < 100) return pl;
  const w1 = rng.range(70, 120), w2 = rng.range(110, 170), ph1 = rng.range(0, 6.28), ph2 = rng.range(0, 6.28);
  const out = p.map((q, i) => {
    const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
    const l = dist(a, b) || 1;
    const nx = -(b.y - a.y) / l, ny = (b.x - a.x) / l;
    const taper = Math.min(1, cum[i] / 40, (L - cum[i]) / 40);
    const d = amp * taper * (0.65 * Math.sin((cum[i] / w1) * 6.283 + ph1) + 0.35 * Math.sin((cum[i] / w2) * 6.283 + ph2));
    return { x: q.x + nx * d, y: q.y + ny * d };
  });
  return simplify(chaikin(out, 1, false), 0.2);
}

/**
 * Defensive kink (crank): at arclength s the street steps sideways by `off` metres at right angles, runs `len`
 * metres and steps back — two T-like corners in quick succession (masugata / kagi-no-te).
 */
export function crank(pl: Polyline, s: number, off: number, len: number): Polyline {
  const cum = cumOf(pl), L = cum[cum.length - 1];
  if (s < 10 || s + len > L - 10) return pl;
  const at = (x: number): { p: Vec2; d: Vec2 } => {
    let i = 1;
    while (i < pl.length - 1 && cum[i] < x) i++;
    const t = (x - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    const a = pl[i - 1], b = pl[i], l = dist(a, b) || 1;
    return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, d: { x: (b.x - a.x) / l, y: (b.y - a.y) / l } };
  };
  const A = at(s), B = at(s + len);
  const n = { x: -A.d.y, y: A.d.x };
  const before = pl.filter((_, i) => cum[i] < s - 0.01);
  const after = pl.filter((_, i) => cum[i] > s + len + 0.01);
  const mid = pl.filter((_, i) => cum[i] > s + 0.01 && cum[i] < s + len - 0.01).map((q) => ({ x: q.x + n.x * off, y: q.y + n.y * off }));
  return [...before, A.p, { x: A.p.x + n.x * off, y: A.p.y + n.y * off }, ...mid, { x: B.p.x + n.x * off, y: B.p.y + n.y * off }, B.p, ...after];
}

/** First crossing of a ray from c in direction u with a ring (distance), or null. */
function rayRing(c: Vec2, u: Vec2, ring: Polygon, far = 1e4): number | null {
  const q = { x: c.x + u.x * far, y: c.y + u.y * far };
  let bt = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const r = segSegT(c, q, ring[i], ring[(i + 1) % ring.length]);
    if (r && r.t * far > 0.5 && r.t * far < bt) bt = r.t * far;
  }
  return bt < Infinity ? bt : null;
}

/**
 * The four half-axes of a planned town (cardo / decumanus, Chinese N–S axis and E–W avenue, gopuram streets):
 * straight lines from the nucleus polygon (or the centre) to the enclosure along angle + k·90°.
 */
export function axisLines(center: Vec2, angle: number, ring: Polygon, nucleus: Polygon | null, count = 4): { line: Polyline; dir: Vec2; end: Vec2 }[] {
  const out: { line: Polyline; dir: Vec2; end: Vec2 }[] = [];
  for (let k = 0; k < count; k++) {
    const a = angle + (k * 2 * Math.PI) / count;
    const u = { x: Math.cos(a), y: Math.sin(a) };
    const L = rayRing(center, u, ring);
    if (L === null || L < 30) continue;
    const s0 = nucleus && pointInRing(nucleus, center) ? (rayRing(center, u, nucleus) ?? 0) : 0;
    if (L - s0 < 20) continue;
    const start = { x: center.x + u.x * s0, y: center.y + u.y * s0 }, end = { x: center.x + u.x * L, y: center.y + u.y * L };
    out.push({ line: [start, end], dir: u, end });
  }
  return out;
}

/** Offset of a convex ring outward by d (edge lines shifted, mitred). */
export function outsetConvex(ring: Polygon, d: number): Polygon {
  const p = orientPos(ring), n = p.length;
  const lines = p.map((a, i) => {
    const b = p[(i + 1) % n], l = dist(a, b) || 1, dx = (b.x - a.x) / l, dy = (b.y - a.y) / l;
    return { px: a.x + dy * d, py: a.y - dx * d, dx, dy };
  });
  return p.map((_, i) => {
    const A = lines[(i - 1 + n) % n], B = lines[i];
    const den = A.dx * B.dy - A.dy * B.dx;
    if (Math.abs(den) < 1e-9) return { x: B.px, y: B.py };
    const t = ((B.px - A.px) * B.dy - (B.py - A.py) * B.dx) / den;
    return { x: A.px + A.dx * t, y: A.py + A.dy * t };
  });
}

/**
 * Leads regional roads to the centred gates of a planned (convex) enclosure: each road is cut where it first
 * comes within `m` of the enclosure, then follows the offset ring (the short way) to the point in front of the
 * nearest gate, and enters through the gate to the centre along the axis. Roads that would cross water keep their
 * course. Returns the new paths (same order).
 */
export function approachGates(
  roads: Polyline[], ring: Polygon, gates: { p: Vec2; dir: Vec2 }[], center: Vec2, m: number, isWater: (p: Vec2) => boolean,
): Polyline[] {
  const off = outsetConvex(ring, m);
  const cum: number[] = [0];
  for (let i = 1; i <= off.length; i++) cum.push(cum[i - 1] + dist(off[i - 1], off[i % off.length]));
  const L = cum[off.length];
  const locate = (q: Vec2): number => {
    let bs = 0, bd = Infinity;
    for (let i = 0; i < off.length; i++) {
      const a = off[i], b = off[(i + 1) % off.length];
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2));
      const d = Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy);
      if (d < bd) { bd = d; bs = cum[i] + t * Math.sqrt(l2); }
    }
    return bs;
  };
  const atS = (s: number): Vec2 => {
    s = ((s % L) + L) % L;
    let i = 1;
    while (i < off.length && cum[i] < s) i++;
    const a = off[i - 1], b = off[i % off.length];
    const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  const gateS = gates.map((g) => locate({ x: g.p.x + g.dir.x * m, y: g.p.y + g.dir.y * m }));
  return roads.map((pl) => {
    // first vertex inside the offset ring
    let k = -1;
    for (let i = 0; i < pl.length; i++) if (pointInRing(off, pl[i])) { k = i; break; }
    if (k <= 0) return pl;
    const a = pl[k - 1], b = pl[k];
    let bt = 1;
    for (let i = 0; i < off.length; i++) { const r = segSegT(a, b, off[i], off[(i + 1) % off.length]); if (r && r.t < bt) bt = r.t; }
    const entry = { x: a.x + (b.x - a.x) * bt, y: a.y + (b.y - a.y) * bt };
    const se = locate(entry);
    let gi = 0, gd = Infinity;
    gateS.forEach((gs, i) => { const d = Math.abs((((gs - se + L / 2) % L) + L) % L - L / 2); if (d < gd) { gd = d; gi = i; } });
    const d = (((gateS[gi] - se + L / 2) % L) + L) % L - L / 2;
    const walk: Vec2[] = [];
    const nSteps = Math.max(1, Math.ceil(Math.abs(d) / 8));
    for (let j = 0; j <= nSteps; j++) walk.push(atS(se + (d * j) / nSteps));
    const g = gates[gi].p;
    const path = [...pl.slice(0, k), entry, ...walk.slice(1), g, center];
    for (let j = k; j < path.length - 2; j++) if (isWater(path[j])) return pl;
    return simplify(path, 0.3);
  });
}

/** Archimedean-like spiral arm from radius r0 to r1 around c, starting at angle a0, turning `turns` (signed). */
export function spiralArm(c: Vec2, a0: number, r0: number, r1: number, turns: number): Polyline {
  const out: Vec2[] = [];
  const n = Math.max(8, Math.ceil(Math.abs(turns) * 40));
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const r = r0 + (r1 - r0) * t, a = a0 + turns * 2 * Math.PI * t;
    out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return out;
}

export { polylineLength };
