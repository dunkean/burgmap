/**
 * Parish churches embedded in the fabric (coordinator polish): most parish churches are not islands in a
 * churchyard but stand on a lot taken from the street front — a few adjacent burgage plots merged — with houses
 * built against them and only a small parvis (the margin of the lot). About a third keep a churchyard (a whole
 * block, level-2 claim).
 */
import type { Vec2, Polygon } from '../../core/geom';
import { dist } from '../../core/geom';
import type { Rng } from '../../core/rng';
import type { Plot } from '../plots';
import { unionS } from '../../geo/bool';
import { area, cleanRing, pointInRing, distToRing } from '../../geo/poly';
import { churchFootprint } from '../landmarks';

export interface EmbeddedChurch { plots: Plot[]; lot: Polygon; front: [Vec2, Vec2]; parts: Polygon[] }

export function embedChurch(plots: Plot[], pop: number, rng: Rng): EmbeddedChurch | null {
  const runs = new Map<number, Plot[]>();
  for (const p of plots) { if (!runs.has(p.run)) runs.set(p.run, []); runs.get(p.run)!.push(p); }
  let best: { run: Plot[]; s: number } | null = null;
  for (const list of runs.values()) {
    list.sort((a, b) => a.order - b.order);
    for (let i = 0; i < list.length; i++) {
      let W = 0;
      const sel: Plot[] = [];
      for (let j = i; j < list.length && W < 22; j++) { W += dist(list[j].front[0], list[j].front[1]); sel.push(list[j]); }
      if (W < 20 || W > 44 || sel.some((p) => p.depth < 22)) continue;
      // main streets first, the middle of the run rather than its ends
      const s = -sel[0].rank * 2 - Math.abs(i + sel.length / 2 - list.length / 2) / Math.max(1, list.length) + rng.float() * 0.3;
      if (!best || s > best.s) best = { run: sel, s };
    }
  }
  if (!best) return null;
  const run = best.run;
  const u = unionS(run[0].poly, ...run.slice(1).map((p) => [{ outer: p.poly, holes: [] }]));
  if (u.length !== 1 || u[0].holes.length) return null;
  const lot = cleanRing(u[0].outer, 0.01, 0.01, Infinity, false);
  if (Math.abs(area(lot) - run.reduce((t, p) => t + area(p.poly), 0)) > 0.5) return null;
  const fp = churchFootprint(lot, pop, rng, false);
  if (!fp) return null;
  // the church stands at the street (a small parvis in front, houses against its flanks): pushed toward the front
  const front: [Vec2, Vec2] = [run[0].front[0], run[run.length - 1].front[1]];
  const fm = { x: (front[0].x + front[1].x) / 2, y: (front[0].y + front[1].y) / 2 };
  const cs = fp.parts.flat(), c = { x: cs.reduce((t, q) => t + q.x, 0) / cs.length, y: cs.reduce((t, q) => t + q.y, 0) / cs.length };
  const L = dist(c, fm) || 1, d = { x: (fm.x - c.x) / L, y: (fm.y - c.y) / L };
  const at = (k: number) => fp.parts.map((pp) => pp.map((q) => ({ x: q.x + d.x * k, y: q.y + d.y * k })));
  const fits = (ps: Polygon[]) => ps.every((pp) => pp.every((q) => pointInRing(lot, q) && distToRing(lot, q) >= 1.2));
  let lo = 0, hi = L;
  for (let it = 0; it < 18; it++) { const m = (lo + hi) / 2; if (fits(at(m))) lo = m; else hi = m; }
  return { plots: run, lot, front, parts: at(lo) };
}
