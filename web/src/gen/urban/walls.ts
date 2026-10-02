/**
 * Wall features on a polygonal wall line: a tower at every vertex (bigger at corners), extra towers on long
 * curtains (spacing ≤ ~55 m, flanking range), a pair of towers flanking each gate opening, and the straight wall
 * pieces between the openings. Stretches along water stay open (the water is the defence).
 */
import type { Vec2, Polygon, Polyline } from '../core/geom';
import { dist } from '../core/geom';
import type { Rng } from '../core/rng';

export interface WallFeatures {
  towers: Vec2[];
  /** Relative tower size (1 = normal; corners are bigger). */
  towerScale: number[];
  pieces: Polyline[];
  gateTowers: Vec2[];
  /** Straight curtains between consecutive towers (or gate towers). */
  curtains: [Vec2, Vec2][];
}

const turnAt = (a: Vec2, b: Vec2, c: Vec2): number => {
  const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
  return Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
};

export function wallFeatures(
  ring: Polygon, gates: { p: Vec2; width: number }[], rng: Rng, isWater: (p: Vec2) => boolean,
  nearWater: (p: Vec2) => boolean = () => false, spacing = 55, stagger?: Vec2[],
): WallFeatures {
  void rng;
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
  // wall pieces between gate openings, as arclength intervals [a, b] (b may exceed L)
  const intervals: [number, number][] = [];
  if (!gs.length) intervals.push([0, L]);
  else for (let k = 0; k < gs.length; k++) {
    const a = gs[k].s + gs[k].half;
    const b0 = gs[(k + 1) % gs.length].s - gs[(k + 1) % gs.length].half;
    const b = k + 1 < gs.length ? b0 : b0 + L;
    if (b - a > 2) intervals.push([a, b]);
  }
  // remove the stretches along water (sampled every 2 m, cut exactly on the edges)
  const dry: [number, number][] = [];
  for (const [a, b] of intervals) {
    let cur = -1;
    const n = Math.max(1, Math.ceil((b - a) / 2));
    for (let k = 0; k <= n; k++) {
      const s = a + ((b - a) * k) / n;
      const wet = nearWater(at(s));
      if (!wet && cur < 0) cur = s;
      if ((wet || k === n) && cur >= 0) { const e = wet ? s - (b - a) / n / 2 : s; if (e - cur > 3) dry.push([cur, e]); cur = -1; }
    }
  }
  const pieces: Polyline[] = [];
  const towers: Vec2[] = [], towerScale: number[] = [], curtains: [Vec2, Vec2][] = [];
  const gateTowers: Vec2[] = [];
  const nearGate = (s: number, r: number) => gs.some((g) => { const d = Math.abs((((s - g.s + L / 2) % L) + L) % L - L / 2); return d < g.half + r; });
  const isGateEnd = (s: number) => gs.some((g) => { const d = Math.abs((((s - g.s + L / 2) % L) + L) % L - L / 2); return Math.abs(d - g.half) < 0.05; });
  for (const [a, b] of dry) {
    // vertices of the ring strictly inside (a, b)
    const inner: { s: number; p: Vec2; i: number }[] = [];
    for (let i = 0; i < pts.length - 1; i++) for (const off of [0, L]) { const c = cum[i] + off; if (c > a + 0.01 && c < b - 0.01) inner.push({ s: c, p: pts[i], i }); }
    inner.sort((x, y) => x.s - y.s);
    const pl = [at(a), ...inner.map((o) => o.p), at(b)];
    pieces.push(pl);
    // tower stops: every vertex (a tower where the wall turns); the piece ends get the gate's flanking tower or,
    // at a water cut, an end tower
    const stops: { s: number; p: Vec2; scale: number; tower: boolean }[] = [];
    const endStop = (s: number, inward: number) => {
      if (isGateEnd(s)) { const q = at(s + inward * 2.2); gateTowers.push(q); return { s: s + inward * 2.2, p: q, scale: 1.1, tower: false }; }
      return { s, p: at(s), scale: 1, tower: !isWater(at(s)) };
    };
    stops.push(endStop(a, 1));
    for (const o of inner) {
      const n = pts.length - 1;
      const tv = turnAt(pts[(o.i - 1 + n) % n], pts[o.i], pts[(o.i + 1) % n]);
      // a vertex next to a gate is covered by the gate's flanking tower (the curtain still breaks there)
      stops.push({ s: o.s, p: o.p, scale: tv > (25 * Math.PI) / 180 ? 1.3 : 1, tower: !nearGate(o.s, 4) });
    }
    stops.push(endStop(b, -1));
    stops.sort((x, y) => x.s - y.s);
    // a vertex tower right next to a gate or end tower is merged into it (the curtain still breaks there)
    for (let k = 1; k < stops.length - 1; k++) {
      if (Math.min(stops[k].s - stops[0].s, stops[stops.length - 1].s - stops[k].s) < 8) stops[k].tower = false;
    }
    // extra towers on long straight curtains (same straight segment, so no new vertex is created)
    const all: typeof stops = [];
    for (let k = 0; k < stops.length; k++) {
      all.push(stops[k]);
      if (k + 1 >= stops.length) break;
      const s0 = stops[k].s, s1 = stops[k + 1].s;
      const m = Math.ceil((s1 - s0) / spacing);
      for (let j = 1; j < m; j++) {
        const s = s0 + ((s1 - s0) * j) / m;
        if (!nearGate(s, 6)) all.push({ s, p: at(s), scale: 0.9, tower: true });
      }
    }
    // the outer wall of a double enceinte: its towers stand midway between the towers of the inner curtain (each
    // covers the gap between two inner ones), not in front of them
    if (stagger && stagger.length >= 2) {
      const proj = (q: Vec2): number => {
        let bs = 0, bd = Infinity;
        for (let i = 1; i < pts.length; i++) {
          const p0 = pts[i - 1], p1 = pts[i];
          const dx = p1.x - p0.x, dy = p1.y - p0.y, l2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((q.x - p0.x) * dx + (q.y - p0.y) * dy) / l2));
          const d = Math.hypot(q.x - p0.x - t * dx, q.y - p0.y - t * dy);
          if (d < bd) { bd = d; bs = cum[i - 1] + t * Math.sqrt(l2); }
        }
        return bs;
      };
      const sIn = stagger.map(proj).sort((x, y) => x - y);
      for (const st of all) if (st.tower) st.tower = false;
      for (let k = 0; k < sIn.length; k++) {
        const s0 = sIn[k], s1 = k + 1 < sIn.length ? sIn[k + 1] : sIn[0] + L;
        if (s1 - s0 < 12) continue;
        for (const off of [0, L]) {
          const m = (s0 + s1) / 2 + off;
          if (m > a + 4 && m < b - 4 && !nearGate(m, 6)) all.push({ s: m, p: at(m), scale: 0.85, tower: true });
        }
      }
      all.sort((x, y) => x.s - y.s);
    }
    for (let k = 0; k < all.length; k++) {
      const st = all[k];
      if (st.tower && !isWater(st.p)) { towers.push(st.p); towerScale.push(st.scale); }
      if (k + 1 < all.length && all[k + 1].s - st.s > 0.5) curtains.push([st.p, all[k + 1].p]);
    }
  }
  return { towers, towerScale, pieces, gateTowers, curtains };
}
