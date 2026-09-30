/** Wall features: towers every 40–80 m and at corners, gate openings where radials cross the wall. */
import type { Vec2, Polygon, Polyline } from '../core/geom';
import { dist } from '../core/geom';
import type { Rng } from '../core/rng';

function resampleLine(pl: Polyline, step: number): Vec2[] {
  const out: Vec2[] = [pl[0]];
  for (let i = 1; i < pl.length; i++) {
    const a = pl[i - 1], b = pl[i];
    const n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

export interface WallFeatures { towers: Vec2[]; pieces: Polyline[]; gateTowers: Vec2[] }

export function wallFeatures(ring: Polygon, gates: { p: Vec2; width: number }[], rng: Rng, isWater: (p: Vec2) => boolean, nearWater: (p: Vec2) => boolean = () => false): WallFeatures {
  const pts = ring.concat([ring[0]]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const L = cum[cum.length - 1];
  const at = (s: number): Vec2 => {
    s = ((s % L) + L) % L;
    let i = 1;
    while (i < pts.length - 1 && cum[i] < s) i++;
    const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
  };
  // gate positions as arclength
  const gs = gates.map((g) => {
    let bs = 0, bd = Infinity;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((g.p.x - a.x) * dx + (g.p.y - a.y) * dy) / l2));
      const d = Math.hypot(g.p.x - a.x - t * dx, g.p.y - a.y - t * dy);
      if (d < bd) { bd = d; bs = cum[i - 1] + t * Math.sqrt(l2); }
    }
    return { s: bs, half: g.width / 2 + 1.5 };
  }).sort((a, b) => a.s - b.s);
  const nearGate = (s: number, r: number) => gs.some((g) => { const d = Math.abs(((s - g.s + L / 2) % L + L) % L - L / 2); return d < g.half + r; });
  const towers: Vec2[] = [];
  let s = rng.range(10, 40);
  while (s < L - 20) {
    if (!nearGate(s, 10)) { const p = at(s); if (!isWater(p)) towers.push(p); }
    s += rng.range(42, 75);
  }
  const gateTowers: Vec2[] = [];
  for (const g of gs) { gateTowers.push(at(g.s - g.half - 2.2), at(g.s + g.half + 2.2)); }
  // wall pieces between gate openings
  const pieces: Polyline[] = [];
  if (!gs.length) pieces.push(pts);
  else {
    for (let k = 0; k < gs.length; k++) {
      const a = gs[k].s + gs[k].half, b0 = gs[(k + 1) % gs.length].s - gs[(k + 1) % gs.length].half;
      const b = k + 1 < gs.length ? b0 : b0 + L;
      if (b - a < 2) continue;
      const inner: { s: number; p: Vec2 }[] = [];
      for (let i = 0; i < pts.length - 1; i++) {
        for (const off of [0, L]) { const c = cum[i] + off; if (c > a && c < b) inner.push({ s: c, p: pts[i] }); }
      }
      inner.sort((x, y) => x.s - y.s);
      pieces.push([at(a), ...inner.map((o) => o.p), at(b)]);
    }
  }
  // stretches along water (a river crossing the town, a harbour front) stay open: the water is the defence
  const dry: Polyline[] = [];
  for (const pc of pieces) {
    const dense = resampleLine(pc, 4);
    let cur: Vec2[] = [];
    for (const q of dense) {
      if (nearWater(q)) { if (cur.length >= 2) dry.push(cur); cur = []; }
      else cur.push(q);
    }
    if (cur.length >= 2) dry.push(cur);
  }
  const keepT = (t: Vec2) => !nearWater(t);
  return { towers: towers.filter(keepT), pieces: dry.filter((d) => d.length >= 2), gateTowers: gateTowers.filter(keepT) };
}
