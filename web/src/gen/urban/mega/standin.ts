/**
 * Stand-in fabric of a megacity quarter whose detail is not generated yet (renderer view only): the quarter's inset
 * cut by lanes into block-sized pieces, each with a built mass. It gives the mid zoom the grain of a city until the
 * real streets, plots and buildings arrive, and it varies like the real fabric does:
 * - grain by age and density: the old dense core in small, irregular blocks on crooked lanes; the younger rings in
 *   larger, more regular blocks; the suburbs in big blocks;
 * - orientation: the lanes run toward the quarter's nucleus and across (radial / tangential), straighter when young;
 * - built form: solid blocks with a small court in the core, perimeter blocks around a garden core in the younger
 *   rings, a thin built rim along the lanes in the suburbs and villages.
 * Deterministic (no random stream: jitter from the quarter id), cached per quarter object.
 */
import type { Polygon, Vec2 } from '../../core/geom';
import { polygonCentroid } from '../../core/geom';
import { area, obb, pointInRing } from '../../geo/poly';
import { splitByChord, rayHit, type LPoly } from '../../geo/split';
import type { MacroQuarter } from './types';
import type { UrbanZone, PolyH } from '../../types';

const BLOCK: Record<UrbanZone, number> = { core: 2600, middle: 4600, edge: 6500, faubourg: 9500, village: 5500 };
const CACHE = new WeakMap<MacroQuarter, { blocks: Polygon[]; masses: PolyH[] }>();

const shrink = (p: Polygon, c: Vec2, k: number): Polygon => p.map((v) => ({ x: c.x + (v.x - c.x) * k, y: c.y + (v.y - c.y) * k }));

export function standIn(q: MacroQuarter, nucleus?: Vec2): { blocks: Polygon[]; masses: PolyH[] } {
  let r = CACHE.get(q);
  if (r) return r;
  r = { blocks: [], masses: [] };
  CACHE.set(q, r);
  if (q.inset.length < 3) return r;
  if (q.kind !== 'quarter') { r.blocks.push(q.inset); return r; }
  let h = (q.id * 2654435761) >>> 0;
  const rnd = (): number => { h = (Math.imul(h ^ (h >>> 15), 2246822519) + 0x6d2b79f5) >>> 0; return h / 4294967296; };
  const old = q.phase <= 1 || q.district === 'satellite' || q.district === 'village';
  const young = q.zone === 'faubourg' || q.zone === 'edge';
  // grain: block area by zone, smaller where denser; irregularity by age
  const target = (BLOCK[q.zone] ?? 6000) * Math.max(0.7, Math.min(1.5, Math.sqrt(320 / Math.max(40, q.density || 40))));
  const jitA = old ? 0.55 : young ? 0.12 : 0.28, jitT = old ? 0.4 : young ? 0.15 : 0.28;
  const nu = nucleus ?? polygonCentroid(q.inset);
  const queue: { lp: LPoly; d: number }[] = [{ lp: { pts: q.inset, lab: q.inset.map(() => 0) }, d: 0 }];
  const pieces: Polygon[] = [];
  while (queue.length) {
    const { lp, d } = queue.pop()!;
    const A = area(lp.pts);
    if (A < 1.7 * target || d > 10) { pieces.push(lp.pts); continue; }
    const ob = obb(lp.pts);
    // the cut runs radial or tangential to the nucleus, whichever is closest to across the long axis
    const rad = Math.atan2(ob.c.y - nu.y, ob.c.x - nu.x);
    const across = Math.atan2(ob.v.y, ob.v.x);
    let base = rad;
    for (const f of [rad, rad + Math.PI / 2]) {
      const dv = Math.abs(Math.sin(f - across)), db = Math.abs(Math.sin(base - across));
      if (dv < db) base = f;
    }
    let done = false;
    for (let t = 0; t < 3 && !done; t++) {
      const f = 0.5 + (rnd() - 0.5) * 2 * jitT * 0.5;
      const seed = { x: ob.c.x + ob.u.x * (f - 0.5) * 2 * ob.hu * 0.85, y: ob.c.y + ob.u.y * (f - 0.5) * 2 * ob.hu * 0.85 };
      if (!pointInRing(lp.pts, seed)) continue;
      const a = base + (rnd() - 0.5) * jitA;
      const dir = { x: Math.cos(a), y: Math.sin(a) };
      const h1 = rayHit(lp.pts, seed, dir, 1e5, 0.01), h2 = rayHit(lp.pts, seed, { x: -dir.x, y: -dir.y }, 1e5, 0.01);
      if (!h1 || !h2) continue;
      // crooked lanes in the old fabric: a kink in the middle of the cut
      const kink = old ? (rnd() - 0.5) * 0.14 * Math.hypot(h1.p.x - h2.p.x, h1.p.y - h2.p.y) : 0;
      const mid = { x: seed.x - dir.y * kink, y: seed.y + dir.x * kink };
      const res = splitByChord(lp, kink ? [h2.p, mid, h1.p] : [h2.p, seed, h1.p], 0) ?? (kink ? splitByChord(lp, [h2.p, seed, h1.p], 0) : null);
      if (!res || Math.min(area(res[0].pts), area(res[1].pts)) < 0.3 * target) continue;
      queue.push({ lp: res[0], d: d + 1 }, { lp: res[1], d: d + 1 });
      done = true;
    }
    if (!done) pieces.push(lp.pts);
  }
  // lanes between the pieces (narrow in the old fabric), the built share as one mass per piece
  const lane = old ? 3.2 : young ? 5.5 : 4.5;
  const built0 = Math.min(0.85, 0.14 + q.density / 420);
  for (const p of pieces) {
    const A = area(p);
    const c = polygonCentroid(p);
    if (!pointInRing(p, c)) continue;
    const kb = Math.max(0.55, 1 - lane / Math.sqrt(A));
    const b = shrink(p, c, kb);
    if (!b.every((v) => pointInRing(p, v))) continue;
    r.blocks.push(b);
    const built = Math.max(0.08, Math.min(0.92, built0 + (rnd() - 0.5) * 0.16));
    if (old && built > 0.7) {
      // solid block with a small court
      const hole = shrink(b, c, Math.sqrt(Math.max(0.03, 1 - built)));
      r.masses.push(built > 0.88 ? { outer: b, holes: [] } : { outer: b, holes: [hole] });
    } else {
      // perimeter block: the houses along the lanes, a garden (or yard) core; a thin rim in the suburbs
      const k = Math.sqrt(Math.max(0.05, 1 - built));
      const hole = shrink(b, c, k);
      if (hole.every((v) => pointInRing(b, v))) r.masses.push({ outer: b, holes: [hole] });
    }
  }
  return r;
}
