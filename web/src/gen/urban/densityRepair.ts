/** Restore mature residential block density after programme allocation and final roof styling. */
import type { Polygon, Vec2 } from '../core/geom';
import type { MorphologyParams } from './morphology';
import type { CarvedBlock } from './blocks';
import type { EdgeRoofPartition } from './edgeRoofs';
import { area, bboxOf, inscribed, obb, orientPos, pointInRing } from '../geo/poly';
import { polyInside } from '../geo/split';
import { mpArea, tryDifference, tryIntersection, type MultiPoly } from '../geo/bool';
import { blockReach, makeStreetAt } from './access';
import { MIN_BW, MAX_ASPECT } from './buildings';
import { openHoles } from './plots';

export type DensityRepairPartition = Pick<EdgeRoofPartition,
  'ctx' | 'parcels' | 'buildings' | 'gardens' | 'streets' | 'protectedLand' | 'eligible'> & {
  blocks: CarvedBlock[];
  morphology: (block: number) => MorphologyParams;
};
export interface DensityGroup {
  phase: number; zone: string; morphology: string; floor: number;
  area: number; before: number; after: number; shortfall: number;
}
export interface DensityRepairResult {
  enlarged: number; addedArea: number; changedBlocks: Set<number>; groups: DensityGroup[];
}

const meets = (a: Polygon, b: Polygon): boolean => {
  const A = bboxOf(a), B = bboxOf(b);
  return !(A.x0 >= B.x1 || B.x0 >= A.x1 || A.y0 >= B.y1 || B.y0 >= A.y1);
};
/** Local checked intersections refuse an unprovable clearance instead of accepting an empty fallback. */
function clear(subject: Polygon | MultiPoly, bounds: Polygon, obstacles: MultiPoly): boolean {
  for (const obstacle of obstacles) {
    if (!meets(bounds, obstacle.outer)) continue;
    const overlap = tryIntersection(subject, [obstacle]);
    if (overlap.failed || mpArea(overlap.pieces) > 1e-6) return false;
  }
  return true;
}
const contained = (roof: Polygon, owner: Polygon): boolean => {
  if (!polyInside(owner, roof)) return false;
  const outside = tryDifference(roof, owner);
  return !outside.failed && mpArea(outside.pieces) <= 1e-6;
};

const canonicalSides = Array.from({ length: 15 }, (_, n) => [0, 1, 2, 3].map((i) => ((n + 1) >> i) & 1));
// A narrow garden may permit unequal extensions on opposite sides, or on the two axes. These 79 finite
// profiles include the canonical 15 and one side weighted by 1/4 or 4; they keep the completed roof's axis.
const fallbackSides = [...canonicalSides, ...canonicalSides.flatMap((sides) => sides.flatMap((selected, i) => selected
  ? [0.25, 4].map((weight) => sides.map((side, j) => j === i ? weight : side)) : []))];

/** Courtyard destinations use the real holes, rather than treating a ring's whole envelope as an obstacle. */
function courtyardAccess(polys: { poly: Polygon; courtyards?: Polygon[] }[]): { pieces: Polygon[]; probes: Polygon[]; owners: number[] } | null {
  const pieces: Polygon[] = [], probes: Polygon[] = [], owners: number[] = [];
  for (const [i, b] of polys.entries()) {
    if (!b.courtyards?.length) { pieces.push(b.poly); owners.push(i); continue; }
    const occupied = tryDifference(b.poly, b.courtyards.map((outer) => ({ outer, holes: [] })));
    if (occupied.failed) return null;
    for (const part of occupied.pieces) {
      const opened = openHoles(part, 0, true), missing = tryDifference([part], opened), outside = tryDifference(opened, [part]);
      if (missing.failed || outside.failed || mpArea(missing.pieces) > 1e-6 || mpArea(outside.pieces) > 1e-6
        || Math.abs(mpArea(opened) - mpArea([part])) > 1e-5) return null;
      for (const p of opened) { pieces.push(p.outer); owners.push(i); }
    }
    for (const court of b.courtyards) {
      const circle = inscribed(court, [], 0.5), r = Math.min(0.25, circle.r / 3), c = circle.c;
      if (r <= 0.02) continue;
      probes.push(orientPos([{ x: c.x - r, y: c.y - r }, { x: c.x + r, y: c.y - r },
        { x: c.x + r, y: c.y + r }, { x: c.x - r, y: c.y + r }]));
    }
  }
  return { pieces, probes, owners };
}

/**
 * This is a whole-block floor, not the higher target passed to each plot's burgage producer. The existing
 * mature middle-block contract is 0.70–0.85 (urban.densityhealth.test.ts); cap its lower limit by the culture's
 * configured producer lower bound so intentional sparse cultures are never normalised to European density.
 * Young edge, faubourg and village fabric retains its configured garden gaps and distance fading.
 */
export function repairResidentialDensity(input: DensityRepairPartition): DensityRepairResult {
  const changedBlocks = new Set<number>(), result: DensityRepairResult = { enlarged: 0, addedArea: 0, changedBlocks, groups: [] };
  const originalRoofs = input.buildings.map((b) => b.poly.map((p) => ({ ...p })));
  const originalAreas = originalRoofs.map(area), changedBuildings = new Set<number>();
  const groups = new Map<string, { report: DensityGroup; blocks: Set<number> }>();
  input.blocks.forEach((b, bi) => {
    if (b.kind !== 'block' || (b.zone !== 'core' && b.zone !== 'middle')) return;
    const m = input.morphology(bi), floor = Math.min(0.70, m.coverage[b.zone][0]);
    const key = `${b.phase}:${b.zone}:${m.id}:${floor}`;
    const group = groups.get(key) ?? { blocks: new Set<number>(), report: {
      phase: b.phase, zone: b.zone, morphology: m.id, floor, area: 0, before: 0, after: 0, shortfall: 0,
    } };
    group.blocks.add(bi); group.report.area += area(b.poly); groups.set(key, group);
  });
  const streetAt = makeStreetAt(input.streets.list.filter((s) => s.ribbon).map((s) => ({ path: s.path, widths: s.widths, width: s.widths[0] })),
    input.parcels.filter((p) => ['place', 'market', 'quay', 'green'].includes(String(p.use))).map((p) => p.poly));
  for (const { report, blocks } of groups.values()) {
    const indices = input.buildings.flatMap((b, i) => b.parcel !== undefined && blocks.has(input.parcels[b.parcel].block)
      && !['church', 'cathedral', 'landmark'].includes(b.kind) ? [i] : [])
      .sort((a, b) => originalAreas[b] - originalAreas[a] || a - b);
    report.before = indices.reduce((sum, i) => sum + area(input.buildings[i].poly), 0); report.after = report.before;
    const target = report.floor * report.area;
    // Allocate the largest existing roof capacities first without changing producer order or dwelling metadata.
    // Keep the two canonical sweeps; only an exhausted group receives one distinct asymmetric shape search.
    // Every proposal repeats the physical, garden and access proofs under its immutable original 30% cap.
    if (report.after < target) for (let sweep = 0; sweep < 3 && report.after < target; sweep++) for (const index of indices) {
      const fallback = sweep === 2;
      const need = target + 1e-4 - report.after;
      if (need <= 1e-6) break;
      const b = input.buildings[index];
      if (b.parcel === undefined || !input.eligible(b.parcel) || !['house', 'rear', 'back', 'barn', 'shed'].includes(b.kind)
        || b.courtyards?.length || !['gable', 'hip', 'flat'].includes(b.roof ?? '')) continue;
      const parcel = input.parcels[b.parcel], bi = parcel.block, old = b.poly, oldArea = area(old), o = obb(old);
      // Keep the completed roof's own axis. Enlarging its whole rectangle preserves the edge correction.
      if (Math.min(2 * o.hu, 2 * o.hv) < MIN_BW || o.hu / o.hv > MAX_ASPECT) continue;
      // obb's long-axis swap can leave its stored v non-perpendicular. Reconstruct this local frame from u;
      // its centre and the swapped half-extents still describe the same completed roof.
      const perpendicular = { x: -o.u.y, y: o.u.x };
      const at = (u: number, v: number): Vec2 => ({ x: o.c.x + o.u.x * u + perpendicular.x * v, y: o.c.y + o.u.y * u + perpendicular.y * v });
      const rect = (s: number[], t: number): Polygon => orientPos([
        at(-o.hu - s[0] * t, -o.hv - s[2] * t), at(o.hu + s[1] * t, -o.hv - s[2] * t),
        at(o.hu + s[1] * t, o.hv + s[3] * t), at(-o.hu - s[0] * t, o.hv + s[3] * t),
      ]);
      const peers = input.buildings.flatMap((other, i) => other.parcel !== undefined && input.parcels[other.parcel].block === bi ? [{ b: other, index: i }] : []);
      const beforeReach = blockReach(input.blocks[bi].poly, peers.map((p) => p.b.poly), streetAt);
      const court = courtyardAccess(peers.map((p) => p.b));
      if (!court) continue;
      const beforeCourts = court.probes.length ? blockReach(input.blocks[bi].poly, [...court.pieces, ...court.probes], streetAt).slice(court.pieces.length) : [];
      const safe = (poly: Polygon): boolean => {
        if (!contained(old, poly) || !contained(poly, parcel.poly) || !contained(poly, input.blocks[bi].poly)) return false;
        // Clearance is cumulative from entry, just like the immutable growth cap. Separate proposals must
        // not each spend the same numerical contact tolerance against a road, water or masonry reservation.
        const added = tryDifference(poly, originalRoofs[index]);
        if (added.failed || !clear(added.pieces, poly, input.protectedLand)) return false;
        if (!clear(poly, poly, input.buildings.flatMap((other, i) => i !== index && meets(poly, other.poly) ? [{ outer: other.poly, holes: [] }] : []))) return false;
        const dry = (p: Vec2): boolean => p.x >= 3 && p.y >= 3 && p.x <= input.ctx.mapSize - 3 && p.y <= input.ctx.mapSize - 3
          && !input.ctx.isWater(p) && input.ctx.slopeAt(p) <= 0.28;
        if (!poly.every(dry)) return false;
        const bb = bboxOf(poly);
        for (let y = bb.y0; y <= bb.y1; y += 2) for (let x = bb.x0; x <= bb.x1; x += 2) {
          if (pointInRing(poly, { x, y }) && !dry({ x, y })) return false;
        }
        const reached = blockReach(input.blocks[bi].poly, peers.map((p) => p.index === index ? poly : p.b.poly), streetAt);
        if (!reached.every((v, i) => v || !beforeReach[i])) return false;
        if (court.probes.length) {
          const pieces = court.pieces.map((p, i) => peers[court.owners[i]].index === index ? poly : p);
          const reachedCourts = blockReach(input.blocks[bi].poly, [...pieces, ...court.probes], streetAt).slice(pieces.length);
          if (!reachedCourts.every((v, i) => v || !beforeCourts[i])) return false;
        }
        return true;
      };
      const remainingGardens = (poly: Polygon): Polygon[] | null => {
        const gardens: Polygon[] = [];
        for (const garden of input.gardens) {
          if (!meets(poly, garden)) { gardens.push(garden); continue; }
          const free = tryDifference(garden, poly);
          if (free.failed) return null;
          const opened = free.pieces.flatMap((part) => openHoles(part, 0, true).map((p) => p.outer));
          if (Math.abs(opened.reduce((sum, p) => sum + area(p), 0) - mpArea(free.pieces)) > 1e-5) return null;
          gardens.push(...opened);
        }
        return gardens;
      };
      // The existing edge finishing contract allows at most 30% enlargement of one ordinary roof. Spread a
      // phase deficit over its existing dwellings instead of turning a single house into an oversized range.
      const limit = Math.min(originalAreas[index] * 1.3, oldArea + need), baseArea = 4 * o.hu * o.hv;
      const base = rect([0, 0, 0, 0], 0), baseSafe = safe(base);
      if (baseArea > limit + 1e-6 || (!fallback && !baseSafe)) continue;
      let best: Polygon | null = baseArea > oldArea + 1e-6 && baseSafe ? base : null;
      let bestGardens: Polygon[] | null = best && fallback ? remainingGardens(best) : null;
      if (best && fallback && !bestGardens) best = null;
      // Every candidate contains the old roof. Growing just one side can use a garden while leaving its access
      // alley untouched; paired sides also cover roof centres that sit inside an open yard.
      for (const sides of fallback ? fallbackSides : canonicalSides) {
        const nx = sides[0] + sides[1], ny = sides[2] + sides[3];
        const a = nx * ny, c = baseArea - limit, d = nx * 2 * o.hv + ny * 2 * o.hu;
        let hi = a ? (-d + Math.sqrt(d * d - 4 * a * c)) / (2 * a) : -c / d, lo = 0;
        if (hi <= 1e-7) continue;
        const admissible = (t: number): boolean => {
          const width = 2 * o.hu + nx * t, depth = 2 * o.hv + ny * t;
          const candidate = rect(sides, t);
          return Math.max(width, depth) / Math.min(width, depth) <= MAX_ASPECT && safe(candidate)
            && (!fallback || remainingGardens(candidate) !== null);
        };
        if (!admissible(hi)) for (let step = 0; step < 12; step++) { const mid = (lo + hi) / 2; if (admissible(mid)) lo = mid; else hi = mid; }
        else lo = hi;
        const candidate = rect(sides, lo);
        if (area(candidate) <= oldArea + 1e-4 || (best && area(candidate) <= area(best))) continue;
        if (fallback) {
          // A failed maximal garden decomposition cannot suppress a different fully proved side proposal.
          // Do not presume an invalid identity envelope is safe: each enlarged fallback is checked itself.
          const gardens = remainingGardens(candidate);
          if (!gardens || !safe(candidate)) continue;
          bestGardens = gardens;
        }
        best = candidate;
      }
      if (!best) continue;
      const gardens = bestGardens ?? remainingGardens(best);
      if (!gardens) continue;
      const gain = area(best) - oldArea;
      b.poly = best; input.gardens.splice(0, input.gardens.length, ...gardens);
      if (!changedBuildings.has(index)) { changedBuildings.add(index); result.enlarged++; }
      result.addedArea += gain; report.after += gain; changedBlocks.add(bi);
    }
    report.shortfall = Math.max(0, target - report.after); result.groups.push(report);
  }
  return result;
}
