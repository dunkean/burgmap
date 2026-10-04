/**
 * Stand-in fabric of a megacity quarter whose detail is not generated yet (renderer view only): the quarter's inset
 * cut by lanes into block-sized pieces, each with built frontage bands split into small masses. It gives the mid zoom the grain of a city until the
 * real streets, plots and buildings arrive, and it varies like the real fabric does:
 * - grain by age and density: the old dense core in small, irregular blocks on crooked lanes; the younger rings in
 *   larger, more regular blocks; the suburbs in big blocks;
 * - orientation: the lanes run toward the quarter's nucleus and across (radial / tangential), straighter when young;
 * - built form: attached fronts around a small court in the core, perimeter blocks around a garden core in the younger
 *   rings, a thin built rim along the lanes in the suburbs and villages.
 * Deterministic (no random stream: jitter from the quarter id), cached per quarter object and nucleus coordinates.
 */
import type { Polygon, Vec2 } from '../../core/geom';
import { polygonCentroid, dist } from '../../core/geom';
import { area, obb, pointInRing, isSimple, orientPos, cleanRing } from '../../geo/poly';
import { splitByChord, rayHit, polyInside, isConvex, type LPoly } from '../../geo/split';
import { insetConvex } from '../../geo/offset';
import { tryDifference, tryIntersection, mpArea } from '../../geo/bool';
import type { MacroQuarter } from './types';
import type { UrbanZone, PolyH } from '../../types';

const BLOCK: Record<UrbanZone, number> = { core: 2600, middle: 4600, edge: 6500, faubourg: 9500, village: 5500 };
type Fabric = { blocks: Polygon[]; masses: PolyH[] };
const CACHE = new WeakMap<MacroQuarter, { nucleus: string; fabric: Fabric }>();
const MAX_BLOCKS = 64, MAX_MASSES = 512;
export interface FabricBudget { blocks: number; masses: number }
/** Shared by all macro hosts in a World; exact generated quarters are accounted for by the queue cap. */
export const STAND_IN_BUDGET: Readonly<FabricBudget> = { blocks: 12000, masses: 32000 };
export function fabricBudget(quarters: number): FabricBudget {
  if (quarters <= 0) return { blocks: MAX_BLOCKS, masses: MAX_MASSES };
  return { blocks: Math.min(MAX_BLOCKS, Math.floor(STAND_IN_BUDGET.blocks / quarters)), masses: Math.min(MAX_MASSES, Math.floor(STAND_IN_BUDGET.masses / quarters)) };
}

const shrink = (p: Polygon, c: Vec2, k: number): Polygon => p.map((v) => ({ x: c.x + (v.x - c.x) * k, y: c.y + (v.y - c.y) * k }));

export function standIn(q: MacroQuarter, nucleus?: Vec2, budget: FabricBudget = { blocks: MAX_BLOCKS, masses: MAX_MASSES }): Fabric {
  const maxMasses = Math.max(0, Math.min(MAX_MASSES, Math.floor(budget.masses)));
  const maxBlocks = Math.max(0, Math.min(MAX_BLOCKS, maxMasses, Math.floor(budget.blocks)));
  const key = `${nucleus ? `${nucleus.x},${nucleus.y}` : ''};${maxBlocks},${maxMasses}`;
  const cached = CACHE.get(q);
  if (cached?.nucleus === key) return cached.fabric;
  const r: Fabric = { blocks: [], masses: [] };
  CACHE.set(q, { nucleus: key, fabric: r });
  if (q.inset.length < 3 || !maxBlocks || !maxMasses) return r;
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
    if (A < 1.7 * target || d > 10 || pieces.length + queue.length + 1 >= maxBlocks) { pieces.push(lp.pts); continue; }
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
  // True offsets leave lanes of stable width; centroid scaling could cut across a concave block.
  const lane = old ? 3.2 : young ? 5.5 : 4.5;
  const built0 = Math.min(0.85, 0.14 + q.density / 420);
  const shares: number[] = [];
  let fallbackCuts = maxBlocks;
  for (const [pi, p] of pieces.entries()) {
    const clean = orientPos(cleanRing(p, 0.01, 0.01));
    let b = insetConvex(clean, lane / 2);
    if (!contained(p, b)) {
      // A collapsed offset keeps a conservative contained piece, never a ring crossing the original boundary.
      const c = polygonCentroid(clean);
      b = shrink(clean, c, Math.max(0.55, 1 - lane / Math.sqrt(area(clean))));
      if (!contained(p, b)) {
        // A bay or folded arterial boundary can put both centres outside the land. Keep real clipped blocks
        // instead of making the entire quarter disappear. Reserve one block/mass for each remaining piece.
        const slots = maxBlocks - r.blocks.length - (pieces.length - pi - 1);
        const clipped = clippedBlocks(p, lane, target, Math.min(slots, fallbackCuts));
        fallbackCuts -= clipped.cuts;
        for (const block of clipped.blocks) {
          r.blocks.push(block);
          shares.push(Math.max(0.08, Math.min(0.92, built0 + (rnd() - 0.5) * 0.16)));
        }
        continue;
      }
    }
    r.blocks.push(b);
    shares.push(Math.max(0.08, Math.min(0.92, built0 + (rnd() - 0.5) * 0.16)));
  }
  const perimeter = r.blocks.reduce((s, b) => s + b.reduce((a, p, i) => a + dist(p, b[(i + 1) % b.length]), 0), 0);
  const edgeCount = r.blocks.reduce((s, b) => s + b.length, 0);
  // The frontage grain adapts to a bounded quarter budget, rather than invoking the full detail generator.
  const frontage = Math.max(old ? 9 : young ? 16 : 12, perimeter / Math.max(1, maxMasses - edgeCount));
  r.blocks.forEach((b, bi) => {
    const c = polygonCentroid(b), k = Math.sqrt(1 - shares[bi]);
    const hole = shrink(b, c, k);
    const bands = b.map((a, i) => orientPos([a, b[(i + 1) % b.length], hole[(i + 1) % b.length], hole[i]]));
    if (!contained(b, hole) || !bands.every((p) => contained(b, p)) || Math.abs(bands.reduce((s, p) => s + area(p), 0) - area(b) * shares[bi]) > 1e-5) {
      // A non-star-shaped block has no radial perimeter partition. Its clipped courtyard still leaves exact masses.
      const court = tryIntersection(b, hole);
      const built = court.failed ? { failed: true, pieces: [] } : tryDifference(b, court.pieces);
      const available = maxMasses - r.masses.length - (r.blocks.length - bi - 1);
      if (!built.failed && built.pieces.every((p) => contained(b, p.outer)) && built.pieces.length <= available) r.masses.push(...built.pieces);
      return;
    }
    const counts = b.map((a, i) => Math.max(1, Math.ceil(dist(a, b[(i + 1) % b.length]) / frontage)));
    const available = maxMasses - r.masses.length - (r.blocks.length - bi - 1);
    if (counts.reduce((a, n) => a + n, 0) > available) {
      // Keep the whole built band when its detailed seams exceed the budget, rather than losing its last sides.
      r.masses.push({ outer: b, holes: [hole] });
      return;
    }
    bands.forEach((band, i) => {
      const a = b[i], z = b[(i + 1) % b.length], ha = hole[i], hz = hole[(i + 1) % b.length];
      const n = counts[i];
      const at = (p: Vec2, z: Vec2, t: number): Vec2 => ({ x: p.x + (z.x - p.x) * t, y: p.y + (z.y - p.y) * t });
      for (let j = 0; j < n; j++) {
        // Attached old frontages share party walls. Younger rings keep small gaps between their houses.
        const gap = young ? Math.min(0.08 / n, 0.7 / Math.max(1, dist(a, z))) : 0;
        const lo = j / n + gap, hi = (j + 1) / n - gap;
        r.masses.push({ outer: orientPos([at(a, z, lo), at(a, z, hi), at(ha, hz, hi), at(ha, hz, lo)]), holes: [] });
      }
    });
  });
  return r;
}

/** At most maxBlocks cell intersections per quarter; no point sampling or recursive search. */
function clippedBlocks(p: Polygon, lane: number, target: number, limit: number): { blocks: Polygon[]; cuts: number } {
  if (limit <= 0) return { blocks: [], cuts: 0 };
  const ob = obb(p), u = ob.u, v = { x: -u.y, y: u.x }, width = 2 * ob.hu, height = 2 * ob.hv;
  if (width <= lane || height <= lane) return { blocks: [], cuts: 0 };
  const count = Math.min(limit, Math.max(1, Math.ceil(width * height / target)));
  const cols = Math.max(1, Math.min(count, Math.round(Math.sqrt(count * width / height))));
  const rows = Math.max(1, Math.floor(count / cols));
  const dx = width / cols, dy = height / rows;
  if (dx <= lane || dy <= lane) return { blocks: [], cuts: 0 };
  const at = (x: number, y: number): Vec2 => ({ x: ob.c.x + u.x * x + v.x * y, y: ob.c.y + u.y * x + v.y * y });
  const blocks: Polygon[] = [];
  let cuts = 0;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const x0 = -ob.hu + x * dx + lane / 2, x1 = -ob.hu + (x + 1) * dx - lane / 2;
    const y0 = -ob.hv + y * dy + lane / 2, y1 = -ob.hv + (y + 1) * dy - lane / 2;
    const cell = [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)];
    const clipped = tryIntersection(cell, p);
    cuts++;
    if (clipped.failed) continue;
    for (const piece of clipped.pieces) {
      // Blocks are simple rings. Never fill a hole or accept a failed containment proof to spend the budget.
      if (piece.holes.length || !contained(p, piece.outer)) continue;
      blocks.push(piece.outer);
      blocks.sort((a, b) => area(b) - area(a));
      if (blocks.length > limit) blocks.pop();
    }
  }
  return { blocks, cuts };
}

/** Fast for convex subjects; concave candidates require a boolean area proof as well as simple rings. */
function contained(p: Polygon, q: Polygon): boolean {
  if (q.length < 3 || area(q) < 1e-6 || !isSimple(q) || !polyInside(p, q)) return false;
  if (isConvex(p, 1e-10)) return q.every((v) => p.every((a, i) => {
    const b = p[(i + 1) % p.length];
    return ((b.x - a.x) * (v.y - a.y) - (b.y - a.y) * (v.x - a.x)) / Math.max(1e-9, dist(a, b)) >= -1e-8;
  }));
  const outside = tryDifference(q, p);
  return !outside.failed && mpArea(outside.pieces) < 1e-6;
}
