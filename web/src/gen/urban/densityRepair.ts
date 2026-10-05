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
import { PolygonIndex } from './polygonIndex';

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
export type DensityProof = 'proved' | 'refused' | 'unknown';
/** Local checked intersections keep a physical refusal distinct from an unproved operation. */
function clear(subject: Polygon | MultiPoly, bounds: Polygon, obstacles: MultiPoly): DensityProof {
  for (const obstacle of obstacles) {
    if (!meets(bounds, obstacle.outer)) continue;
    const overlap = tryIntersection(subject, [obstacle]);
    if (overlap.failed) return 'unknown';
    if (mpArea(overlap.pieces) > 1e-6) return 'refused';
  }
  return 'proved';
}
const contained = (roof: Polygon, owner: Polygon): DensityProof => {
  if (!polyInside(owner, roof)) return 'refused';
  const outside = tryDifference(roof, owner);
  return outside.failed ? 'unknown' : mpArea(outside.pieces) <= 1e-6 ? 'proved' : 'refused';
};
const exactProofKey = (poly: Polygon): string | null => poly.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
  ? poly.map((p) => `${Object.is(p.x, -0) ? '-0' : p.x}:${Object.is(p.y, -0) ? '-0' : p.y}`).join(';') : null;

/** One immutable search: memoize proved outcomes, never a checked failure or thrown exception. */
export function makeDensityProofMemo(prove: (poly: Polygon) => DensityProof): (poly: Polygon) => DensityProof {
  const memo = new Map<string, Exclude<DensityProof, 'unknown'>>();
  return (poly) => {
    const key = exactProofKey(poly), cached = key !== null ? memo.get(key) : undefined;
    if (cached) { memo.delete(key!); memo.set(key!, cached); return cached; }
    const proof = prove(poly);
    if (key !== null && proof !== 'unknown') {
      if (memo.size >= 256) memo.delete(memo.keys().next().value!);
      memo.set(key, proof);
    }
    return proof;
  };
}

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
 * mature middle-block contract is 0.70â€“0.85 (urban.densityhealth.test.ts); cap its lower limit by the culture's
 * configured producer lower bound so intentional sparse cultures are never normalised to European density.
 * Young edge, faubourg and village fabric retains its configured garden gaps and distance fading.
 */
export function repairResidentialDensity(input: DensityRepairPartition): DensityRepairResult {
  const changedBlocks = new Set<number>(), result: DensityRepairResult = { enlarged: 0, addedArea: 0, changedBlocks, groups: [] };
  const originalRoofs = input.buildings.map((b) => b.poly.map((p) => ({ ...p })));
  const originalAreas = originalRoofs.map(area), changedBuildings = new Set<number>();
  const groups = new Map<string, { report: DensityGroup; blocks: Set<number> }>();
  const roofs = new PolygonIndex(input.buildings.map((b) => b.poly));
  const protectedLand = new PolygonIndex(input.protectedLand.map((p) => p.outer));
  const byBlock = new Map<number, { b: typeof input.buildings[number]; index: number }[]>();
  input.buildings.forEach((b, index) => {
    if (b.parcel === undefined) return;
    const bi = input.parcels[b.parcel].block, peers = byBlock.get(bi) ?? [];
    peers.push({ b, index }); byBlock.set(bi, peers);
  });
  const baselines = new Map<number, { reach: boolean[]; court: ReturnType<typeof courtyardAccess>; courts: boolean[] }>();
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
      const limit = Math.min(originalAreas[index] * 1.3, oldArea + need), baseArea = 4 * o.hu * o.hv;
      // The original unconditional cap rejection precedes all pure proof work. No roof
      // transaction can occur on this branch; only proof calls/timing metrics are avoided.
      if (baseArea > limit + 1e-6) continue;
      const profiles = fallback ? fallbackSides : canonicalSides;
      const maximumStep = (sides: number[]): number => {
        const nx = sides[0] + sides[1], ny = sides[2] + sides[3];
        const a = nx * ny, c = baseArea - limit, d = nx * 2 * o.hv + ny * 2 * o.hu;
        return a ? (-d + Math.sqrt(d * d - 4 * a * c)) / (2 * a) : -c / d;
      };
      // With no useful base and every original profile skipped at its existing step
      // threshold, best necessarily stays null. NaN/uncertain bounds keep the old path.
      if (baseArea <= oldArea + 1e-6 && profiles.every((sides) => maximumStep(sides) <= 1e-7)) continue;
      // obb's long-axis swap can leave its stored v non-perpendicular. Reconstruct this local frame from u;
      // its centre and the swapped half-extents still describe the same completed roof.
      const perpendicular = { x: -o.u.y, y: o.u.x };
      const at = (u: number, v: number): Vec2 => ({ x: o.c.x + o.u.x * u + perpendicular.x * v, y: o.c.y + o.u.y * u + perpendicular.y * v });
      const rect = (s: number[], t: number): Polygon => orientPos([
        at(-o.hu - s[0] * t, -o.hv - s[2] * t), at(o.hu + s[1] * t, -o.hv - s[2] * t),
        at(o.hu + s[1] * t, o.hv + s[3] * t), at(-o.hu - s[0] * t, o.hv + s[3] * t),
      ]);
      const peers = byBlock.get(bi)!;
      let baseline = baselines.get(bi);
      if (!baseline) {
        const reach = blockReach(input.blocks[bi].poly, peers.map((p) => p.b.poly), streetAt);
        const court = courtyardAccess(peers.map((p) => p.b));
        const courts = court?.probes.length ? blockReach(input.blocks[bi].poly, [...court.pieces, ...court.probes], streetAt).slice(court.pieces.length) : [];
        baseline = { reach, court, courts }; baselines.set(bi, baseline);
      }
      const { reach: beforeReach, court, courts: beforeCourts } = baseline;
      if (!court) continue;
      const provePhysical = (poly: Polygon): DensityProof => {
        let ownerProof = contained(old, poly);
        if (ownerProof !== 'proved') return ownerProof;
        ownerProof = contained(poly, parcel.poly);
        if (ownerProof !== 'proved') return ownerProof;
        ownerProof = contained(poly, input.blocks[bi].poly);
        if (ownerProof !== 'proved') return ownerProof;
        // Clearance is cumulative from entry, just like the immutable growth cap. Separate proposals must
        // not each spend the same numerical contact tolerance against a road, water or masonry reservation.
        const added = tryDifference(poly, originalRoofs[index]);
        if (added.failed) return 'unknown';
        const protectedProof = clear(added.pieces, poly, protectedLand.query(poly).map((i) => input.protectedLand[i]));
        if (protectedProof !== 'proved') return protectedProof;
        const peerProof = clear(poly, poly, roofs.query(poly).filter((i) => i !== index).map((i) => ({ outer: input.buildings[i].poly, holes: [] })));
        if (peerProof !== 'proved') return peerProof;
        const dry = (p: Vec2): boolean => p.x >= 3 && p.y >= 3 && p.x <= input.ctx.mapSize - 3 && p.y <= input.ctx.mapSize - 3
          && !input.ctx.isWater(p) && input.ctx.slopeAt(p) <= 0.28;
        if (!poly.every(dry)) return 'refused';
        const bb = bboxOf(poly);
        for (let y = bb.y0; y <= bb.y1; y += 2) for (let x = bb.x0; x <= bb.x1; x += 2) {
          if (pointInRing(poly, { x, y }) && !dry({ x, y })) return 'refused';
        }
        return 'proved';
      };
      const physicalProof = makeDensityProofMemo(provePhysical);
      const proveSafe = (poly: Polygon): boolean => {
        if (physicalProof(poly) !== 'proved') return false;
        const reached = blockReach(input.blocks[bi].poly, peers.map((p) => p.index === index ? poly : p.b.poly), streetAt);
        if (!reached.every((v, i) => v || !beforeReach[i])) return false;
        if (court.probes.length) {
          const pieces = court.pieces.map((p, i) => peers[court.owners[i]].index === index ? poly : p);
          const reachedCourts = blockReach(input.blocks[bi].poly, [...pieces, ...court.probes], streetAt).slice(pieces.length);
          if (!reachedCourts.every((v, i) => v || !beforeCourts[i])) return false;
        }
        return true;
      };
      // This search commits nothing until its best proposal is chosen. Reuse only exact
      // successful physical proofs; failed checked booleans are always allowed to retry.
      const positiveSafe = new Set<string>();
      const exactKey = exactProofKey;
      const safe = (poly: Polygon): boolean => {
        const key = exactKey(poly);
        if (key !== null && positiveSafe.has(key)) return true;
        const proved = proveSafe(poly);
        if (proved && key !== null) positiveSafe.add(key);
        return proved;
      };
      const proveGardens = (poly: Polygon): Polygon[] | null => {
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
      const positiveGardens = new Map<string, Polygon[]>();
      const remainingGardens = (poly: Polygon): Polygon[] | null => {
        const key = exactKey(poly), cached = key !== null ? positiveGardens.get(key) : undefined;
        if (cached) return cached;
        const proved = proveGardens(poly);
        if (proved && key !== null) {
          // A short cache covers the repeated maximal/final proposal without retaining
          // a map's entire garden list for every successful binary-search midpoint.
          if (positiveGardens.size >= 8) positiveGardens.delete(positiveGardens.keys().next().value!);
          positiveGardens.set(key, proved);
        }
        return proved;
      };
      // The existing edge finishing contract allows at most 30% enlargement of one ordinary roof. Spread a
      // phase deficit over its existing dwellings instead of turning a single house into an oversized range.
      const base = rect([0, 0, 0, 0], 0), baseSafe = safe(base);
      if (!fallback && !baseSafe) continue;
      let best: Polygon | null = baseArea > oldArea + 1e-6 && baseSafe ? base : null;
      let bestGardens: Polygon[] | null = best && fallback ? remainingGardens(best) : null;
      if (best && fallback && !bestGardens) best = null;
      // Every candidate contains the old roof. Growing just one side can use a garden while leaving its access
      // alley untouched; paired sides also cover roof centres that sit inside an open yard.
      for (const sides of profiles) {
        const nx = sides[0] + sides[1], ny = sides[2] + sides[3];
        let hi = maximumStep(sides), lo = 0;
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
      b.poly = best; roofs.set(index, best); baselines.delete(bi); input.gardens.splice(0, input.gardens.length, ...gardens);
      if (!changedBuildings.has(index)) { changedBuildings.add(index); result.enlarged++; }
      result.addedArea += gain; report.after += gain; changedBlocks.add(bi);
    }
    report.shortfall = Math.max(0, target - report.after); result.groups.push(report);
  }
  return result;
}
