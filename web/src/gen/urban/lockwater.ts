/** Existing gnomish lock canals are engineered closed circuits, including inland towns.
 * Keep their established plans separate from lagoon channels that require a natural wet outlet. */
import type { Vec2, Polyline } from '../core/geom';
import { dist } from '../core/geom';
import type { Rng } from '../core/rng';
import type { UrbanLine } from '../types';
import type { Streets, StreetRec } from './streets';
const meanW = (s: StreetRec): number => s.widths.reduce((a, b) => a + b, 0) / s.widths.length;

/** The streets dug as canals: the rank-2 cuts of the quarters (level 2, ids from `l2`: not the primary streets). */
const isCanal = (s: StreetRec, l2First: number): boolean => s.id >= l2First && s.ribbon && s.rank === 2 && s.role === 'street' && s.path.length >= 2;

/** Nearest point of a polyline: the point, its tangent and the distance. */
function onPath(pl: Polyline, p: Vec2): { q: Vec2; t: Vec2; d: number } {
  let best = { q: pl[0], t: { x: 1, y: 0 }, d: Infinity };
  for (let i = 1; i < pl.length; i++) {
    const a = pl[i - 1], b = pl[i];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    const q = { x: a.x + dx * u, y: a.y + dy * u };
    const d = dist(p, q);
    if (d < best.d) { const l = Math.sqrt(l2); best = { q, t: { x: dx / l, y: dy / l }, d }; }
  }
  return best;
}

/** Direction of a polyline at its end k (0 = start, 1 = end), pointing out of the line. */
function endDir(pl: Polyline, k: 0 | 1): Vec2 {
  const a = k ? pl[pl.length - 2] : pl[1], b = k ? pl[pl.length - 1] : pl[0];
  const l = dist(a, b) || 1;
  return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
}

/**
 * Canals and footbridges: the water down every canal (with fondamenta 1.2–2 m wide on most, houses straight on the
 * water on some), extended across a land street where the canal goes on beyond it (a bridge carries the street),
 * and a footbridge wherever a calle ends on a canal with a fondamenta (or another calle) across.
 */
export function lockedWaterways(streets: Streets, rng: Rng, isWater: (p: Vec2) => boolean, l2First: number, locks = false): UrbanLine[] {
  const out: UrbanLine[] = [];
  const canals = streets.list.filter((s) => isCanal(s, l2First));
  if (!canals.length) return out;
  const land = streets.list.filter((s) => s.ribbon && !isCanal(s, l2First) && s.path.length >= 2);
  const fond = new Map<number, number>();
  for (const c of canals) fond.set(c.id, rng.chance(0.72) ? Math.min(2, Math.max(1.2, meanW(c) * 0.18)) : 0.25);
  const water = (c: StreetRec) => Math.max(2.2, meanW(c) - 2 * (fond.get(c.id) ?? 0));
  const bridges: { a: Vec2; b: Vec2; w: number }[] = [];
  const addBridge = (c: Vec2, d: Vec2, len: number, w: number) => {
    if (bridges.some((b) => dist({ x: (b.a.x + b.b.x) / 2, y: (b.a.y + b.b.y) / 2 }, c) < 6)) return;
    bridges.push({ a: { x: c.x - d.x * len / 2, y: c.y - d.y * len / 2 }, b: { x: c.x + d.x * len / 2, y: c.y + d.y * len / 2 }, w });
  };
  for (const c of canals) {
    const cw = water(c);
    let pl = c.path.slice();
    for (const k of [0, 1] as const) {
      const e = k ? pl[pl.length - 1] : pl[0];
      const dOut = endDir(c.path, k);
      // what the canal ends on: another canal (the waters meet), a land street (crossed by a bridge when the canal
      // goes on beyond it), or the edge of the town
      let host: StreetRec | null = null, hd = 1.2;
      for (const s of streets.list) {
        if (s === c || !s.ribbon || s.path.length < 2) continue;
        const r = onPath(s.path, e);
        if (r.d < hd) { hd = r.d; host = s; }
      }
      if (!host) {
        // (the canal reaches the river or the sea at the edge of the town: it runs out into it)
        if ([2, 5].some((d) => isWater({ x: e.x + dOut.x * d, y: e.y + dOut.y * d }))) {
          const ext = { x: e.x + dOut.x * 6, y: e.y + dOut.y * 6 };
          pl = k ? [...pl, ext] : [ext, ...pl];
        }
        continue;
      }
      const hw = meanW(host) / 2;
      if (isCanal(host, l2First)) {
        const ext = { x: e.x + dOut.x * hw * 0.8, y: e.y + dOut.y * hw * 0.8 };
        pl = k ? [...pl, ext] : [ext, ...pl];
        continue;
      }
      // a canal beyond the street (another canal ending at the same point from the other side)?
      const beyond = canals.some((o) => o !== c && [o.path[0], o.path[o.path.length - 1]].some((q) => dist(q, e) < 2.5 && ((q.x - e.x) * dOut.x + (q.y - e.y) * dOut.y) > -0.5) && o.id !== c.id);
      const r = onPath(host.path, e);
      // (a quay street with the river or the sea behind it: the canal runs out into the open water)
      const toWater = !beyond && [hw + 2.5, hw + 6].some((d) => isWater({ x: e.x + dOut.x * d, y: e.y + dOut.y * d }));
      if (toWater) {
        const ext = { x: e.x + dOut.x * (hw + 4), y: e.y + dOut.y * (hw + 4) };
        pl = k ? [...pl, ext] : [ext, ...pl];
        addBridge(e, r.t, cw + 2.4, Math.max(3, hw * 2 - 0.6));
      } else if (beyond) {
        const ext = { x: e.x + dOut.x * (hw + 0.5), y: e.y + dOut.y * (hw + 0.5) };
        pl = k ? [...pl, ext] : [ext, ...pl];
        // the street's bridge over the canal
        addBridge(e, r.t, cw + 2.4, Math.max(3, hw * 2 - 0.6));
      } else {
        // the canal stops short of the street (a rounded end at the fondamenta)
        const back = hw + cw / 2 + 0.3;
        const L = dist(pl[k ? pl.length - 1 : 0], pl[k ? pl.length - 2 : 1]);
        if (L > back + 2) {
          const q = { x: e.x - dOut.x * back, y: e.y - dOut.y * back };
          pl = k ? [...pl.slice(0, -1), q] : [q, ...pl.slice(1)];
        }
      }
    }
    out.push({ kind: 'canal', path: pl, width: cw });
    // locks (gnomish canals): a pair of gates across the water every ~80 m, the chamber between them
    if (locks) {
      let acc = 0, next = rng.range(25, 45);
      for (let i = 1; i < pl.length; i++) {
        const a = pl[i - 1], b = pl[i], l = dist(a, b);
        while (acc + l >= next) {
          const t = (next - acc) / l;
          const t2 = Math.min(1, (next + 7 - acc) / l);
          const n = { x: -(b.y - a.y) / l, y: (b.x - a.x) / l };
          for (const tt of [t, t2]) {
            const q = { x: a.x + (b.x - a.x) * tt, y: a.y + (b.y - a.y) * tt };
            out.push({ kind: 'lock-gate', path: [{ x: q.x - n.x * cw / 2, y: q.y - n.y * cw / 2 }, { x: q.x + n.x * cw / 2, y: q.y + n.y * cw / 2 }], width: 0.8 });
          }
          next += rng.range(70, 95);
        }
        acc += l;
      }
    }
  }
  // footbridges: a calle ending on a canal crosses it when a fondamenta or another lane is there to land on
  for (const s of land) {
    if (s.rank < 2 || s.role === 'close') continue;
    for (const k of [0, 1] as const) {
      const e = k ? s.path[s.path.length - 1] : s.path[0];
      let host: StreetRec | null = null, hd = 1.2;
      for (const c of canals) { const r = onPath(c.path, e); if (r.d < hd) { hd = r.d; host = c; } }
      if (!host) continue;
      const cw = water(host);
      const r = onPath(host.path, e);
      const n = { x: -r.t.y, y: r.t.x };
      const dOut = endDir(s.path, k);
      const across = n.x * dOut.x + n.y * dOut.y >= 0 ? n : { x: -n.x, y: -n.y };
      const far = { x: e.x + across.x * (meanW(host) / 2 + 1.5), y: e.y + across.y * (meanW(host) / 2 + 1.5) };
      const fondFar = (fond.get(host.id) ?? 0) > 1;
      const laneFar = land.some((o) => o !== s && o.rank >= 2 && [o.path[0], o.path[o.path.length - 1]].some((q) => dist(q, far) < 9));
      if (!fondFar && !laneFar) continue;
      addBridge(e, across, cw + 2.2, Math.max(2.2, Math.min(4, meanW(s) - 0.4)));
    }
  }
  for (const b of bridges) out.push({ kind: 'footbridge', path: [b.a, b.b], width: b.w });
  return out;
}


