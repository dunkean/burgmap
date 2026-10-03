/**
 * Stand-in fabric of a megacity quarter whose detail is not generated yet (renderer view only): the quarter's inset
 * cut by a few straight lanes into block-sized pieces, each with a built mass sized by the quarter's density. It
 * gives the mid zoom the grain of a city until the real streets, plots and buildings arrive. Deterministic (no
 * random stream: jitter from the quarter id), cached per quarter object.
 */
import type { Polygon, Vec2 } from '../../core/geom';
import { polygonCentroid } from '../../core/geom';
import { area, obb, pointInRing } from '../../geo/poly';
import { splitByChord, rayHit, type LPoly } from '../../geo/split';
import type { MacroQuarter } from './types';
import type { UrbanZone } from '../../types';

const BLOCK: Record<UrbanZone, number> = { core: 3200, middle: 4800, edge: 6500, faubourg: 9000, village: 6000 };
const CACHE = new WeakMap<MacroQuarter, { blocks: Polygon[]; masses: Polygon[] }>();

const shrink = (p: Polygon, c: Vec2, k: number): Polygon => p.map((v) => ({ x: c.x + (v.x - c.x) * k, y: c.y + (v.y - c.y) * k }));

export function standIn(q: MacroQuarter): { blocks: Polygon[]; masses: Polygon[] } {
  let r = CACHE.get(q);
  if (r) return r;
  r = { blocks: [], masses: [] };
  CACHE.set(q, r);
  if (q.inset.length < 3) return r;
  if (q.kind !== 'quarter') { r.blocks.push(q.inset); return r; }
  let h = (q.id * 2654435761) >>> 0;
  const rnd = (): number => { h = (Math.imul(h ^ (h >>> 15), 2246822519) + 0x6d2b79f5) >>> 0; return h / 4294967296; };
  const target = BLOCK[q.zone] ?? 6000;
  const queue: { lp: LPoly; d: number }[] = [{ lp: { pts: q.inset, lab: q.inset.map(() => 0) }, d: 0 }];
  const pieces: Polygon[] = [];
  while (queue.length) {
    const { lp, d } = queue.pop()!;
    const A = area(lp.pts);
    if (A < 1.7 * target || d > 9) { pieces.push(lp.pts); continue; }
    const ob = obb(lp.pts);
    let done = false;
    for (let t = 0; t < 3 && !done; t++) {
      const f = 0.5 + (rnd() - 0.5) * 0.3;
      const seed = { x: ob.c.x + ob.u.x * (f - 0.5) * 2 * ob.hu * 0.85, y: ob.c.y + ob.u.y * (f - 0.5) * 2 * ob.hu * 0.85 };
      if (!pointInRing(lp.pts, seed)) continue;
      const a = Math.atan2(ob.v.y, ob.v.x) + (rnd() - 0.5) * 0.4;
      const dir = { x: Math.cos(a), y: Math.sin(a) };
      const h1 = rayHit(lp.pts, seed, dir, 1e5, 0.01), h2 = rayHit(lp.pts, seed, { x: -dir.x, y: -dir.y }, 1e5, 0.01);
      if (!h1 || !h2) continue;
      const res = splitByChord(lp, [h2.p, seed, h1.p], 0);
      if (!res || Math.min(area(res[0].pts), area(res[1].pts)) < 0.3 * target) continue;
      queue.push({ lp: res[0], d: d + 1 }, { lp: res[1], d: d + 1 });
      done = true;
    }
    if (!done) pieces.push(lp.pts);
  }
  // lanes between the pieces, the built share as one mass per piece (inside it, or none)
  const built = Math.min(0.8, 0.14 + q.density / 420);
  for (const p of pieces) {
    const A = area(p);
    const c = polygonCentroid(p);
    if (!pointInRing(p, c)) continue;
    const kb = Math.max(0.55, 1 - 4.5 / Math.sqrt(A));
    const b = shrink(p, c, kb);
    if (!b.every((v) => pointInRing(p, v))) continue;
    r.blocks.push(b);
    const m = shrink(b, c, Math.sqrt(built));
    if (m.every((v) => pointInRing(b, v))) r.masses.push(m);
  }
  return r;
}
