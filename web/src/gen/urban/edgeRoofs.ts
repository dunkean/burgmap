/** Finish ordinary roofs at settlement edges without turning a planning line into a saw cut. */
import type { Polygon, Vec2 } from '../core/geom';
import type { UrbanBuilding, UrbanParcel } from '../types';
import type { UrbanCtx } from './context';
import type { Quarter } from './primary';
import type { Streets } from './streets';
import { LAB_OPEN, LAB_WALL } from './streets';
import { area, bboxOf, distToSeg, distToRing, isSimple, obb, orientPos, pointInRing } from '../geo/poly';
import { isConvex, polyInside } from '../geo/split';
import { union, tryDifference, tryIntersection, mpArea, type MultiPoly } from '../geo/bool';
import { openHoles } from './plots';
import { blockReach, makeStreetAt } from './access';
import { MIN_BW, MAX_ASPECT } from './buildings';
import { PolygonIndex } from './polygonIndex';
import { makeHullRectangleOverlap } from './roofRetention';
import { makeGardenOpening } from './gardenProof';
import { makeObstacleSelection } from './obstacleIndex';

interface Frame { at: (u: number, d: number) => Vec2; us: number[]; ds: number[] }
function frame(poly: Polygon, front: [Vec2, Vec2]): Frame {
  const [a, b] = front, length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const t = { x: (b.x - a.x) / length, y: (b.y - a.y) / length }, n = { x: -t.y, y: t.x };
  return {
    at: (u, d) => ({ x: a.x + t.x * u + n.x * d, y: a.y + t.y * u + n.y * d }),
    us: poly.map((p) => (p.x - a.x) * t.x + (p.y - a.y) * t.y),
    ds: poly.map((p) => (p.x - a.x) * n.x + (p.y - a.y) * n.y),
  };
}
const rectangle = (f: Frame, u0: number, u1: number, d0: number, d1: number): Polygon => orientPos([f.at(u0, d0), f.at(u1, d0), f.at(u1, d1), f.at(u0, d1)]);

/** A true frontage-aligned rectangle; clipping this envelope would recreate the reported sheared roof. */
export function roofEnvelope(poly: Polygon, front: [Vec2, Vec2]): Polygon {
  const f = frame(poly, front);
  return rectangle(f, Math.min(...f.us), Math.max(...f.us), Math.min(...f.ds), Math.max(...f.ds));
}

/** A useful rectangular inset in the existing convex roof, retaining at least 65% of its built area. */
export function insetEdgeRoof(poly: Polygon, front: [Vec2, Vec2]): Polygon | null {
  if (!isConvex(poly, 1e-3)) return null;
  const f = frame(poly, front), low = Math.min(...f.ds), high = Math.max(...f.ds);
  const levels = [...f.ds];
  for (let i = 0; i <= 16; i++) levels.push(low + (high - low) * i / 16);
  levels.sort((a, b) => a - b);
  const depths = levels.filter((d, i) => !i || d - levels[i - 1] > 1e-5);
  const section = (depth: number): [number, number] | null => {
    const hits: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length, a = f.ds[i] - depth, b = f.ds[j] - depth;
      if (Math.abs(a) < 1e-8) hits.push(f.us[i]);
      if (a * b < 0) hits.push(f.us[i] + (f.us[j] - f.us[i]) * a / (a - b));
    }
    return hits.length >= 2 ? [Math.min(...hits), Math.max(...hits)] : null;
  };
  let best: Polygon | null = null;
  for (const d0 of depths) for (const d1 of depths) {
    if (d1 - d0 < MIN_BW || d0 - low > 3) continue;
    let u0 = -Infinity, u1 = Infinity;
    for (const d of [d0, d1, ...f.ds.filter((v) => v > d0 && v < d1)]) {
      const s = section(d);
      if (!s) { u1 = -Infinity; break; }
      u0 = Math.max(u0, s[0]); u1 = Math.min(u1, s[1]);
    }
    // Every cross-section of a convex polygon varies linearly between its vertex depths.
    // The common lateral interval therefore proves the entire rectangle, rather than just four sampled corners.
    const width = u1 - u0 - 2e-7, depth = d1 - d0 - 2e-7;
    if (width < MIN_BW || Math.max(width, depth) / Math.min(width, depth) > MAX_ASPECT) continue;
    const r = rectangle(f, u0 + 1e-7, u1 - 1e-7, d0 + 1e-7, d1 - 1e-7);
    if (best && area(r) <= area(best)) continue;
    const outside = tryDifference(r, poly);
    if (outside.failed || mpArea(outside.pieces) > 1e-6 || !polyInside(poly, r) || area(r) < 0.65 * area(poly)) continue;
    if (!best || area(r) > area(best)) best = r;
  }
  return best;
}

/** Try nearby whole rectangles inside the same lot before shrinking a clipped wall-side corner. */
function* relocatedRoofs(poly: Polygon, plot: Polygon, front: [Vec2, Vec2], sizes?: { width: number; depth: number }[]): Generator<Polygon> {
  const f = frame(poly, front), u0 = Math.min(...f.us), u1 = Math.max(...f.us), d0 = Math.min(...f.ds), d1 = Math.max(...f.ds);
  const candidates: { poly: Polygon; move: number }[] = [];
  const retainedUpper = makeHullRectangleOverlap(f.us.map((x, i) => ({ x, y: f.ds[i] })));
  const coordinateScale = Math.max(1, ...poly.flatMap((p) => [Math.abs(p.x), Math.abs(p.y)]));
  const areaMargin = Math.max(1e-5, 512 * Number.EPSILON * coordinateScale * coordinateScale * (poly.length + 8));
  for (const { width, depth } of sizes ?? [1, 0.9, 0.8].map((scale) => ({ width: (u1 - u0) * scale, depth: (d1 - d0) * scale }))) {
    if (Math.min(width, depth) < MIN_BW || Math.max(width, depth) / Math.min(width, depth) > MAX_ASPECT || width * depth < 0.65 * area(poly) || width * depth > 1.3 * area(poly)) continue;
    for (const du of [0, -2, 2, -4, 4, -6, 6, -8, 8]) for (const dd of [0, -2, 2, -4, 4, -6, 6, -8, 8]) {
      const lowU = (u0 + u1 - width) / 2 + du, highU = (u0 + u1 + width) / 2 + du;
      const lowD = (d0 + d1 - depth) / 2 + dd, highD = (d0 + d1 + depth) / 2 + dd;
      if (retainedUpper(lowU, lowD, highU, highD) + areaMargin < 0.5 * area(poly)) continue;
      const r = rectangle(f, lowU, highU, lowD, highD);
      if (!polyInside(plot, r)) continue;
      candidates.push({ poly: r, move: Math.hypot(du, dd) });
    }
  }
  candidates.sort((a, b) => area(b.poly) - area(a.poly) || a.move - b.move);
  for (const candidate of candidates) {
    const outside = tryDifference(candidate.poly, plot), retained = tryIntersection(candidate.poly, poly);
    if (!outside.failed && !retained.failed && mpArea(outside.pieces) <= 1e-6 && mpArea(retained.pieces) >= 0.5 * area(poly)) yield candidate.poly;
  }
}

interface CriticalRoofCandidate { roof: Polygon; owner: Polygon; original: Polygon; move: number }
/** These checks are pure: defer them until the sorted consumer actually needs this proposal. */
function retainsRoof(candidate: CriticalRoofCandidate): boolean {
  const retained = tryIntersection(candidate.roof, candidate.original);
  return !retained.failed && mpArea(retained.pieces) >= 0.5 * area(candidate.original);
}
function insideRoofOwner(candidate: CriticalRoofCandidate): boolean {
  const outside = tryDifference(candidate.roof, candidate.owner);
  return !outside.failed && mpArea(outside.pieces) <= 1e-6;
}
function provedRoof(candidate: CriticalRoofCandidate): boolean {
  return retainsRoof(candidate) && insideRoofOwner(candidate);
}

/** Critical placements touch real parcel edges instead of depending on a coarse translation grid. */
function criticalRoofCandidates(poly: Polygon, plot: Polygon, axis: [Vec2, Vec2], mode: 'regular' | 'supplement' | 'rare' | 'transfer' = 'regular', holes: Polygon[] = []): CriticalRoofCandidate[] {
  const f = frame(poly, axis), pf = frame(orientPos(plot), axis);
  const cu = (Math.min(...f.us) + Math.max(...f.us)) / 2, cd = (Math.min(...f.ds) + Math.max(...f.ds)) / 2;
  const oldBounds = bboxOf(poly);
  const retainedUpper = makeHullRectangleOverlap(f.us.map((x, i) => ({ x, y: f.ds[i] })));
  const ownerU0 = Math.min(...pf.us), ownerU1 = Math.max(...pf.us), ownerD0 = Math.min(...pf.ds), ownerD1 = Math.max(...pf.ds);
  const ownerWidth = ownerU1 - ownerU0, ownerDepth = ownerD1 - ownerD0;
  const coordinateScale = Math.max(1, ...poly.flatMap((p) => [Math.abs(p.x), Math.abs(p.y)]),
    ...plot.flatMap((p) => [Math.abs(p.x), Math.abs(p.y)]));
  // Broad-phase bounds reject only far outside numerical uncertainty. All remaining proposals
  // retain their exact 1e-6 m² ownership and 50% retained-area checks below.
  const areaMargin = Math.max(1e-5, 512 * Number.EPSILON * coordinateScale * coordinateScale * (poly.length + plot.length + 4));
  const spanMargin = 0.020001 + 128 * Number.EPSILON * coordinateScale;
  const centerMargin = 0.010001 + 128 * Number.EPSILON * coordinateScale;
  const oldArea = area(poly), oldRatio = (Math.max(...f.us) - Math.min(...f.us)) / (Math.max(...f.ds) - Math.min(...f.ds));
  const rare = mode === 'rare' || mode === 'transfer';
  const oldCenter = mode === 'transfer' ? obb(poly).c : undefined;
  const minimumArea = (rare ? 0.5 : 0.65) * oldArea;
  // A previously clipped, undersized dwelling still needs room for the minimum useful whole roof.
  const maximumArea = rare ? Math.max(1.3 * oldArea, MIN_BW * MIN_BW) : 1.3 * oldArea;
  const candidates: CriticalRoofCandidate[] = [];
  const ratios = [oldRatio, 1, 1.25, 1.5, 1.75, 2, 0.5, 3, 1 / 3];
  const sizes = mode !== 'regular' ? (() => {
    // Aim just inside the selected strict area floor: world-coordinate shoelace arithmetic can round
    // an exact threshold below it. This numerical margin changes the target, never the measured limits.
    const coordinate = Math.max(1, ...poly.flatMap((p) => [Math.abs(p.x), Math.abs(p.y)]));
    const margin = Math.max(1e-7, 32 * Number.EPSILON * coordinate * coordinate);
    const targets = mode === 'transfer' ? [maximumArea, oldArea, 0.9 * oldArea, 0.8 * oldArea,
      0.75 * oldArea, 0.7 * oldArea, 0.65 * oldArea, 0.6 * oldArea, 0.55 * oldArea,
      minimumArea + margin, Math.max(minimumArea, MIN_BW * MIN_BW) + margin, MIN_BW * MIN_BW]
      : mode === 'rare' ? [0.64 * oldArea, 0.625 * oldArea, 0.6 * oldArea, 0.575 * oldArea,
      0.55 * oldArea, 0.525 * oldArea, minimumArea + margin,
      Math.max(minimumArea, MIN_BW * MIN_BW) + margin, MIN_BW * MIN_BW]
      : [oldArea, 0.9 * oldArea, 0.8 * oldArea, 0.75 * oldArea, 0.7 * oldArea,
        minimumArea + margin, Math.max(minimumArea, MIN_BW * MIN_BW) + margin];
    return targets.filter((a, i) => a >= minimumArea && a <= maximumArea && !targets.slice(0, i).some((b) => Math.abs(a - b) < 1e-8))
      .flatMap((target) => [
        ...ratios.map((ratio) => ({ width: Math.sqrt(target * ratio), depth: Math.sqrt(target / ratio) })),
        // A discrete aspect list otherwise misses the legal interval between a narrow fixed ratio
        // and the next ratio whose short side cannot fit the parcel. Test both exact width endpoints.
        { width: MIN_BW, depth: target / MIN_BW }, { width: target / MIN_BW, depth: MIN_BW },
      ]);
  })() : [1, 0.8, 0.65].flatMap((fraction) => ratios.map((ratio) => ({
    width: Math.sqrt(oldArea * fraction * ratio), depth: Math.sqrt(oldArea * fraction / ratio),
  })));
  const rectangles = new Set<string>(), dimensions = new Set<string>();
  for (const { width, depth } of sizes) {
    const dimension = `${width}:${depth}`;
    if (dimensions.has(dimension)) continue;
    dimensions.add(dimension);
    if (Math.min(width, depth) < MIN_BW || Math.max(width, depth) / Math.min(width, depth) > MAX_ASPECT
      || width > ownerWidth + spanMargin || depth > ownerDepth + spanMargin) continue;
    // polyInside accepts at most one centimetre outside an owner edge. Projection onto
    // a unit axis cannot increase that distance; retain extra room for frame rounding.
    // Non-finite bounds stay on the existing exact path.
    const centerMayFit = (c: { u: number; d: number }): boolean =>
      !(c.u - width / 2 < ownerU0 - centerMargin || c.u + width / 2 > ownerU1 + centerMargin
        || c.d - depth / 2 < ownerD0 - centerMargin || c.d + depth / 2 > ownerD1 + centerMargin);
    const rings = mode === 'transfer' ? [pf, ...holes.map((p) => frame(p, axis))] : [pf];
    let lines = rings.flatMap((ring) => ring.us.flatMap((u, i) => {
      const j = (i + 1) % ring.us.length, du = ring.us[j] - u, dd = ring.ds[j] - ring.ds[i], length = Math.hypot(du, dd);
      if (length < 1e-8) return [];
      const nu = -dd / length, nd = du / length;
      const support = Math.abs(nu) * width / 2 + Math.abs(nd) * depth / 2 + 1e-7;
      return (mode === 'transfer' ? [-1, 1] : [1]).map((sign) => ({ nu, nd, k: nu * u + nd * ring.ds[i] + sign * support }));
    }));
    // Same eight-metre movement limit as the ordinary search; its four bounds are also useful critical edges.
    lines.push({ nu: 1, nd: 0, k: cu - 8 }, { nu: -1, nd: 0, k: -cu - 8 },
      { nu: 0, nd: 1, k: cd - 8 }, { nu: 0, nd: -1, k: -cd - 8 });
    // A support line missing the whole relocation square cannot produce a local projection
    // or intersection. Keep a generous rounding margin for the existing determinant floor.
    const lineScale = Math.max(1, Math.abs(cu), Math.abs(cd), ...lines.map((line) => Math.abs(line.k)));
    const lineMargin = 3e-6 + 128 * Number.EPSILON * lineScale / 1e-8;
    lines = lines.filter((line) => Math.abs(line.k - line.nu * cu - line.nd * cd)
      <= (Math.abs(line.nu) + Math.abs(line.nd)) * (8 + lineMargin));
    const centers = [{ u: cu, d: cd }];
    if (mode === 'transfer') {
      const center = frame([oldCenter!], axis), u = center.us[0], d = center.ds[0];
      // A fixed local grid also supplies interior positions in a concave, two-owner garden union.
      for (const du of [0, -2, 2, -4, 4, -6, 6]) for (const dd of [0, -2, 2, -4, 4, -6, 6]) centers.push({ u: u + du, d: d + dd });
    }
    for (const [i, a] of lines.entries()) {
      const shift = a.k - a.nu * cu - a.nd * cd;
      centers.push({ u: cu + a.nu * shift, d: cd + a.nd * shift });
      for (const b of lines.slice(i + 1)) {
        const det = a.nu * b.nd - a.nd * b.nu;
        if (Math.abs(det) < 1e-8) continue;
        centers.push({ u: (a.k * b.nd - a.nd * b.k) / det, d: (a.nu * b.k - a.k * b.nu) / det });
      }
    }
    // Preserve the exact earlier-center predicate (including rejected earlier centers), without
    // allocating/scanning the entire prefix for every line-pair intersection.
    const previous = new Map<number, { u: number; d: number }[]>();
    // The bounded window is +/-8,000,003 microcells. A 2^24 stride gives exact unique
    // integer keys below 2^48; no string allocation is needed for the neighbour probes.
    const stride = 1 << 24, offset = 1 << 23;
    const contained = centers.filter((c) => {
      // A center farther than the allowed window plus the duplicate radius cannot suppress
      // any admissible center. Keep nearby rejected centers, just as the old full-prefix scan did.
      if (!(Math.abs(c.u - cu) <= 8 + 3e-6 && Math.abs(c.d - cd) <= 8 + 3e-6)) return false;
      const within = Math.abs(c.u - cu) <= 8 + 1e-8 && Math.abs(c.d - cd) <= 8 + 1e-8;
      const x = Math.floor((c.u - cu) / 1e-6), y = Math.floor((c.d - cd) / 1e-6);
      const possible = within && centerMayFit(c);
      let duplicate = false;
      for (let dx = -2; possible && dx <= 2 && !duplicate; dx++) for (let dy = -2; dy <= 2 && !duplicate; dy++) {
        const neighbours = previous.get((x + dx + offset) * stride + y + dy + offset);
        if (neighbours) for (const p of neighbours) {
          if (Math.hypot(p.u - c.u, p.d - c.d) < 1e-6) { duplicate = true; break; }
        }
      }
      const key = (x + offset) * stride + y + offset, bucket = previous.get(key) ?? [];
      bucket.push(c); previous.set(key, bucket);
      // Record even impossible preceding centers: their original duplicate predicate
      // can still suppress a later admissible center. Only mean members are pruned.
      return possible && !duplicate
        && polyInside(plot, rectangle(f, c.u - width / 2, c.u + width / 2, c.d - depth / 2, c.d + depth / 2));
    });
    if (contained.length) {
      const center = { u: contained.reduce((sum, p) => sum + p.u, 0) / contained.length,
        d: contained.reduce((sum, p) => sum + p.d, 0) / contained.length };
      // Interior placements can preserve access where every boundary-touching placement blocks a yard.
      centers.push(center, ...contained.map((p) => ({ u: (p.u + center.u) / 2, d: (p.d + center.d) / 2 })));
    }
    for (const c of centers) {
      if (!Number.isFinite(c.u + c.d) || Math.abs(c.u - cu) > 8 + 1e-8 || Math.abs(c.d - cd) > 8 + 1e-8 || !centerMayFit(c)) continue;
      const r = rectangle(f, c.u - width / 2, c.u + width / 2, c.d - depth / 2, c.d + depth / 2);
      if (mode === 'transfer') {
        const newCenter = f.at(c.u, c.d);
        if (Math.hypot(newCenter.x - oldCenter!.x, newCenter.y - oldCenter!.y) > 8 + 1e-8) continue;
      }
      const bounds = bboxOf(r);
      const overlapWidth = Math.max(0, Math.min(bounds.x1, oldBounds.x1) - Math.max(bounds.x0, oldBounds.x0));
      const overlapDepth = Math.max(0, Math.min(bounds.y1, oldBounds.y1) - Math.max(bounds.y0, oldBounds.y0));
      if (overlapWidth * overlapDepth + areaMargin < 0.5 * oldArea
        || retainedUpper(c.u - width / 2, c.d - depth / 2, c.u + width / 2, c.d + depth / 2) + areaMargin < 0.5 * oldArea
        || !polyInside(plot, r) || area(r) < minimumArea || area(r) > maximumArea) continue;
      const key = r.map((p) => `${p.x}:${p.y}`).join(';');
      if (rectangles.has(key)) continue;
      rectangles.add(key);
      candidates.push({ roof: r, owner: plot, original: poly, move: Math.hypot(c.u - cu, c.d - cd) });
    }
  }
  candidates.sort((a, b) => area(b.roof) - area(a.roof) || a.move - b.move);
  return candidates;
}

function* criticalRoofs(poly: Polygon, plot: Polygon, axis: [Vec2, Vec2], mode: 'regular' | 'supplement' | 'rare' | 'transfer' = 'regular', holes: Polygon[] = []): Generator<Polygon> {
  for (const candidate of criticalRoofCandidates(poly, plot, axis, mode, holes)) if (provedRoof(candidate)) yield candidate.roof;
}

/** Rare constrained corners can need a shorter/deeper rectangle or the roof's own dominant axis. */
function* fittedRoofs(poly: Polygon, plot: Polygon, front: [Vec2, Vec2], cutAxes: [Vec2, Vec2][]): Generator<Polygon> {
  yield* relocatedRoofs(poly, plot, front);
  const inset = insetEdgeRoof(poly, front);
  if (inset) yield inset;
  const rebalance = (axis: [Vec2, Vec2]): { width: number; depth: number }[] => {
    const f = frame(poly, axis), width = Math.max(...f.us) - Math.min(...f.us), depth = Math.max(...f.ds) - Math.min(...f.ds);
    return [1, 0.8, 0.65].flatMap((retained) => [width / depth, 1, 2, 0.5, 3, 1 / 3].map((ratio) => {
      const area0 = retained * area(poly);
      return { width: Math.sqrt(area0 * ratio), depth: Math.sqrt(area0 / ratio) };
    }));
  };
  yield* relocatedRoofs(poly, plot, front, rebalance(front));
  const o = obb(poly), dx = front[1].x - front[0].x, dy = front[1].y - front[0].y;
  const direction = Math.abs(o.u.x * dx + o.u.y * dy) >= Math.abs(o.v.x * dx + o.v.y * dy) ? o.u : o.v;
  const axis: [Vec2, Vec2] = [front[0], { x: front[0].x + direction.x, y: front[0].y + direction.y }];
  if (Math.abs(direction.x * dy - direction.y * dx) > 1e-5 * Math.hypot(dx, dy)) {
    yield* relocatedRoofs(poly, plot, axis);
    const rotatedInset = insetEdgeRoof(poly, axis);
    if (rotatedInset) yield rotatedInset;
    yield* relocatedRoofs(poly, plot, axis, rebalance(axis));
  }
  // Only genuinely unresolved clipped roofs reach this fallback. Include the actual clipped edge's axis.
  const axes: [Vec2, Vec2][] = [];
  for (const candidate of [front, axis, ...cutAxes]) {
    const vx = candidate[1].x - candidate[0].x, vy = candidate[1].y - candidate[0].y, length = Math.hypot(vx, vy);
    if (length < 1e-8 || axes.some(([a, b]) => Math.abs(vx * (b.y - a.y) - vy * (b.x - a.x)) <= 1e-5 * length * Math.hypot(b.x - a.x, b.y - a.y))) continue;
    axes.push(candidate);
    yield* criticalRoofs(poly, plot, candidate);
  }
  // Preserve every already-successful placement; only roofs unresolved in all existing frames
  // reach these intermediate areas and minimum-width shapes, with the same critical centers/guards.
  for (const candidate of axes) yield* criticalRoofs(poly, plot, candidate, 'supplement');
  // Last resort for genuinely constrained corners: a triangle can hold at most half its lot area
  // as a rectangle. Keep at least half the existing dwelling, all access and every physical boundary.
  // Its useful inscribed rectangle can align with an owner edge absent from the clipped roof's
  // frontage, OBB and boundary contacts. Add only the owner's real, distinct axes at this final stage.
  const rareAxes = [...axes];
  for (const [i, a] of plot.entries()) {
    const b = plot[(i + 1) % plot.length], vx = b.x - a.x, vy = b.y - a.y, length = Math.hypot(vx, vy);
    if (length < 1e-8 || rareAxes.some(([c, d]) => Math.abs(vx * (d.y - c.y) - vy * (d.x - c.x)) <= 1e-5 * length * Math.hypot(d.x - c.x, d.y - c.y))) continue;
    rareAxes.push([a, b]);
  }
  for (const candidate of rareAxes) yield* criticalRoofs(poly, plot, candidate, 'rare');
}

/** Checked union used to enlarge the owner at every partition level together. A failed proof changes nothing. */
function mergeLand(a: MultiPoly | Polygon, b: Polygon): MultiPoly | null {
  const overlap = tryIntersection(a, b);
  if (overlap.failed) return null;
  const merged = union(a, b), before = Array.isArray(a) && a.length && 'x' in a[0] ? area(a as Polygon) : mpArea(a as MultiPoly);
  const lost = tryDifference(a, merged), missing = tryDifference(b, merged);
  if (lost.failed || missing.failed || mpArea(lost.pieces) > 1e-6 || mpArea(missing.pieces) > 1e-6 || Math.abs(mpArea(merged) - before - area(b) + mpArea(overlap.pieces)) > 0.01) return null;
  return merged;
}

/** Transfer unions retain every existing owner vertex. Ordinary union cleanup can erase a short T junction. */
function mergeTransferLand(a: MultiPoly | Polygon, b: Polygon): MultiPoly | null {
  const pieces: MultiPoly = a.length && 'x' in a[0] ? [{ outer: a as Polygon, holes: [] }] : a as MultiPoly;
  const bounds = bboxOf([...pieces.flatMap((p) => p.outer), ...b]);
  const box: Polygon = [
    { x: bounds.x0 - 1, y: bounds.y0 - 1 }, { x: bounds.x1 + 1, y: bounds.y0 - 1 },
    { x: bounds.x1 + 1, y: bounds.y1 + 1 }, { x: bounds.x0 - 1, y: bounds.y1 + 1 },
  ];
  // Checked differences preserve raw boundary edges and distinguish engine failure from empty land.
  // Double complement produces the union without the ordinary union's near-collinear ring cleanup.
  const outside = tryDifference(box, pieces, b);
  if (outside.failed) return null;
  const merged = tryDifference(box, outside.pieces);
  if (merged.failed) return null;
  const lost = tryDifference(pieces, merged.pieces), missing = tryDifference(b, merged.pieces);
  const extra = tryDifference(merged.pieces, pieces, b), overlap = tryIntersection(pieces, b);
  if (lost.failed || missing.failed || extra.failed || overlap.failed || mpArea(lost.pieces) > 1e-6
    || mpArea(missing.pieces) > 1e-6 || mpArea(extra.pieces) > 1e-6
    || Math.abs(mpArea(merged.pieces) - mpArea(pieces) - area(b) + mpArea(overlap.pieces)) > 0.01) return null;
  return merged.pieces;
}
const simpleMerge = (a: Polygon, b: Polygon): Polygon | null => {
  const m = mergeLand(a, b);
  return m?.length === 1 && !m[0].holes.length && isSimple(m[0].outer) ? m[0].outer : null;
};
const meets = (a: Polygon, b: Polygon): boolean => {
  const A = bboxOf(a), B = bboxOf(b);
  return !(A.x0 > B.x1 || A.x1 < B.x0 || A.y0 > B.y1 || A.y1 < B.y0);
};
const adjacentBounds = (a: Polygon, b: Polygon): boolean => {
  const A = bboxOf(a), B = bboxOf(b);
  // Touching shared edges are candidates, not an occupancy overlap. Exact land proofs follow below.
  return !(A.x0 > B.x1 + 0.01 || A.x1 < B.x0 - 0.01 || A.y0 > B.y1 + 0.01 || A.y1 < B.y0 - 0.01);
};
const clear = (subject: Polygon | MultiPoly, obstacles: MultiPoly): boolean => {
  if (!obstacles.length) return true;
  const overlap = tryIntersection(subject, obstacles);
  return !overlap.failed && mpArea(overlap.pieces) <= 1e-6;
};

/** Move the boolean kernel's ordered outer-box filter before repeated ring conversion. */
function indexedClearance(obstacles: MultiPoly): (subject: Polygon | MultiPoly) => boolean {
  const select = makeObstacleSelection(obstacles);
  return (subject) => clear(subject, select(subject));
}

/** Preserve the actual frontage arc; a curved street's endpoint chord need not lie on its plot ring. */
function preservesFront(parcel: UrbanParcel, replacement: Polygon): boolean {
  if (!parcel.front) return false;
  const poly = parcel.poly;
  const locate = (p: Vec2) => {
    let best = { edge: 0, t: 0, point: poly[0], distance: Infinity };
    for (const [edge, a] of poly.entries()) {
      const z = poly[(edge + 1) % poly.length], dx = z.x - a.x, dy = z.y - a.y, length2 = dx * dx + dy * dy;
      const t = length2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2)) : 0;
      const point = { x: a.x + t * dx, y: a.y + t * dy }, distance = Math.hypot(p.x - point.x, p.y - point.y);
      if (distance < best.distance) best = { edge, t, point, distance };
    }
    return best;
  };
  const A = locate(parcel.front[0]), B = locate(parcel.front[1]);
  const walk = (a: typeof A, z: typeof A): Polygon => {
    if (a.edge === z.edge && a.t <= z.t) return [a.point, z.point];
    const path = [a.point];
    for (let k = 1; k <= poly.length; k++) {
      const i = (a.edge + k) % poly.length;
      path.push(poly[i]);
      if (i === z.edge) break;
    }
    return [...path, z.point];
  };
  const length = (path: Polygon) => path.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0);
  const forward = walk(A, B), reverse = walk(B, A).reverse(), arc = length(forward) <= length(reverse) ? forward : reverse;
  return arc.slice(1).every((z, i) => {
    const a = arc[i], dx = z.x - a.x, dy = z.y - a.y, length2 = dx * dx + dy * dy;
    if (length2 < 1e-12) return distToRing(replacement, a) <= 0.01;
    // Cover the whole old segment with collinear new boundary intervals, rather than testing endpoints alone.
    const spans = replacement.flatMap((p, j) => {
      const q = replacement[(j + 1) % replacement.length];
      const t0 = ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2;
      const t1 = ((q.x - a.x) * dx + (q.y - a.y) * dy) / length2;
      const low = Math.max(0, Math.min(t0, t1)), high = Math.min(1, Math.max(t0, t1));
      if (high <= low || Math.abs(t1 - t0) < 1e-12) return [];
      const on = (t: number) => ({ x: p.x + (q.x - p.x) * (t - t0) / (t1 - t0), y: p.y + (q.y - p.y) * (t - t0) / (t1 - t0) });
      return [low, high].every((t) => distToSeg(on(t), a, z) <= 0.01) ? [{ low, high }] : [];
    }).sort((p, q) => p.low - q.low);
    let end = 0;
    for (const span of spans) { if (span.low > end + 1e-9) return false; end = Math.max(end, span.high); }
    return end >= 1 - 1e-9;
  });
}

/** Positive-length boundary inside a convex rectangle is an actual crossing, not a corner contact. */
function boundaryRunInside(roof: Polygon, a: Vec2, b: Vec2): number {
  let low = 0, high = 1;
  for (const [i, p] of roof.entries()) {
    const q = roof[(i + 1) % roof.length], dx = q.x - p.x, dy = q.y - p.y;
    const start = dx * (a.y - p.y) - dy * (a.x - p.x);
    const end = dx * (b.y - p.y) - dy * (b.x - p.x), change = end - start;
    // Strict half-planes exclude collinear boundary runs along the roof perimeter.
    if (change === 0) { if (start <= 0) return 0; }
    else if (change > 0) low = Math.max(low, -start / change);
    else high = Math.min(high, -start / change);
    if (high <= low) return 0;
  }
  return (high - low) * Math.hypot(b.x - a.x, b.y - a.y);
}

/** Construct a candidate inside the unchanged measured ceiling, rather than widening its tolerance. */
function roundedGrowthEnvelope(poly: Polygon, axis: [Vec2, Vec2]): Polygon | null {
  const f = frame(poly, axis), u0 = Math.min(...f.us), u1 = Math.max(...f.us);
  const d0 = Math.min(...f.ds), d1 = Math.max(...f.ds), envelope = rectangle(f, u0, u1, d0, d1);
  const excess = area(envelope) - 2 * area(poly);
  const coordinate = Math.max(1, ...poly.flatMap((p) => [Math.abs(p.x), Math.abs(p.y)]));
  const margin = 32 * Number.EPSILON * coordinate * coordinate;
  if (excess <= 0 || excess > margin || u1 <= u0 || d1 <= d0) return null;
  const inset = (excess + margin) / (2 * (u1 - u0 + d1 - d0));
  // The ordinary cap, dimensions and <=1e-6 original-roof retention proofs still apply below.
  return rectangle(f, u0 + inset, u1 - inset, d0 + inset, d1 - inset);
}

/** Independently prove the raw old land plus whole roof, without counting overlap twice. */
function conservesRoofUnion(old: Polygon | MultiPoly, roof: Polygon, next: MultiPoly): boolean {
  const previous = old.length && 'x' in old[0] ? [{ outer: old as Polygon, holes: [] }] : old as MultiPoly;
  const expected = [...previous, { outer: roof, holes: [] }];
  const lost = tryDifference(expected, next), added = tryDifference(next, expected);
  const fresh = tryDifference(roof, previous);
  return !lost.failed && !added.failed && !fresh.failed && mpArea(lost.pieces) <= 1e-6 && mpArea(added.pieces) <= 1e-6
    && Math.abs(mpArea(previous) + mpArea(fresh.pieces) - mpArea(next)) <= 0.01;
}

/** Rigid, bounded translations only: no clipping, resizing, rotation or changed architecture metadata. */
function* seamTranslations(poly: Polygon): Generator<Polygon> {
  for (const radius of [0.000125, 0.00025, 0.0005, 0.000999]) for (let direction = 0; direction < 16; direction++) {
    const angle = 2 * Math.PI * direction / 16, dx = radius * Math.cos(angle), dy = radius * Math.sin(angle);
    yield poly.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  }
}

export interface EdgeRoofPartition {
  ctx: UrbanCtx;
  quarters: Quarter[];
  blocks: { poly: Polygon; quarter: number }[];
  quarterOf?: (block: number) => number;
  parcels: UrbanParcel[];
  buildings: UrbanBuilding[];
  streetSpace: MultiPoly[];
  footprint: MultiPoly;
  gardens: Polygon[];
  streets: Streets;
  /** Real streets, walls, moat/berm, water and external road reservations. */
  protectedLand: MultiPoly;
  phases?: { id: number; region: MultiPoly; band: MultiPoly }[];
  allowGrowth: boolean;
  eligible: (parcel: number) => boolean;
}

/** Final deterministic geometry pass: no new RNG, no removed dwellings, and no movement of fixed macro frames. */
export function finishEdgeRoofs(input: EdgeRoofPartition): { grown: number; fitted: number; constrained: number; changedBlocks: Set<number>; growth: Map<number, Polygon[]> } {
  const changedBlocks = new Set<number>(), growth = new Map<number, Polygon[]>();
  let grown = 0, fitted = 0, constrained = 0;
  const unresolved: number[] = [];
  const initialRoofs = input.buildings.map((b) => b.poly);
  const protectedNear = makeObstacleSelection(input.protectedLand);
  const protectedClear = (subject: Polygon | MultiPoly) => clear(subject, protectedNear(subject));
  const waterClear = indexedClearance(input.ctx.water), openedGardens = makeGardenOpening();
  const roofs = new PolygonIndex(input.buildings.map((b) => b.poly));
  const parcels = new PolygonIndex(input.parcels.map((p) => p.poly));
  const blocks = new PolygonIndex(input.blocks.map((b) => b.poly));
  const quarters = new PolygonIndex(input.quarters.map((q) => q.lp.pts));
  const byBlock = new Map<number, { b: typeof input.buildings[number]; index: number }[]>();
  input.buildings.forEach((b, index) => {
    if (b.parcel === undefined) return;
    const bi = input.parcels[b.parcel].block, peers = byBlock.get(bi) ?? [];
    peers.push({ b, index }); byBlock.set(bi, peers);
  });
  const reachByBlock = new Map<number, boolean[]>();
  const boundaries = input.quarters.map((q) => q.lp.pts.map((a, i) => ({ a, b: q.lp.pts[(i + 1) % q.lp.pts.length], lab: q.lp.lab[i] })));
  const streetAt = makeStreetAt(input.streets.list.filter((s) => s.ribbon).map((s) => ({ path: s.path, widths: s.widths, width: s.widths[0] })), input.parcels.filter((p) => ['place', 'market', 'quay', 'green'].includes(String(p.use))).map((p) => p.poly));
  for (const [index, b] of input.buildings.entries()) {
    if (b.parcel === undefined || !input.eligible(b.parcel) || !['house', 'rear', 'back', 'barn', 'shed'].includes(b.kind) || b.courtyards?.length || !['gable', 'hip', 'flat'].includes(b.roof ?? '') || !isConvex(b.poly, 1e-3)) continue;
    const ownFrame = obb(b.poly);
    if (4 * ownFrame.hu * ownFrame.hv - area(b.poly) <= 0.02) continue;
    const parcel = input.parcels[b.parcel];
    if (!parcel.front) continue;
    const bi = parcel.block, qi = input.quarterOf?.(bi) ?? input.blocks[bi].quarter, quarter = input.quarters[qi];
    const env = roofEnvelope(b.poly, parcel.front), delta = area(env) - area(b.poly);
    if (delta <= 0.02) continue;
    // Only an actual non-street outer edge or standing wall can trigger the correction.
    // A corner near an edge is insufficient: the clipped roof must retain a run along that edge.
    const contacts = boundaries[qi].filter((e) => e.lab === LAB_OPEN || e.lab === LAB_WALL).filter((e) => b.poly.some((a, i) => {
      const z = b.poly[(i + 1) % b.poly.length], m = { x: (a.x + z.x) / 2, y: (a.y + z.y) / 2 };
      const tolerance = e.lab === LAB_WALL ? 3.05 : 0.15;
      return Math.hypot(z.x - a.x, z.y - a.y) >= 1 && [a, z, m].every((p) => distToSeg(p, e.a, e.b) <= tolerance);
    }));
    if (!contacts.length) continue;
    const peers = byBlock.get(bi)!;
    const beforeReach = reachByBlock.get(bi) ?? blockReach(input.blocks[bi].poly, peers.map((p) => p.b.poly), streetAt);
    reachByBlock.set(bi, beforeReach);
    const accessible = (poly: Polygon, block: Polygon): boolean => {
      const reached = blockReach(block, peers.map((p) => p.index === index ? poly : p.b.poly), streetAt);
      return reached.every((v, j) => v || (!beforeReach[j] && peers[j].index !== index));
    };
    const roofClear = (poly: Polygon): boolean => roofs.query(poly, true).every((j) => j === index || clear(poly, [{ outer: input.buildings[j].poly, holes: [] }]));
    let expanded = false;
    // The existing frontage envelope remains first. A clipped roof's own dominant axis can need
    // less land, so try its true perpendicular frame through the same complete ownership transaction.
    // Reconstruct the perpendicular in roofEnvelope; do not depend on an OBB's returned secondary axis.
    const dominantAxis: [Vec2, Vec2] = [ownFrame.c, { x: ownFrame.c.x + ownFrame.u.x, y: ownFrame.c.y + ownFrame.u.y }];
    for (const candidate of input.allowGrowth ? [env, roofEnvelope(b.poly, dominantAxis)] : []) {
      const env = candidate, delta = area(env) - area(b.poly);
      const width = Math.hypot(env[1].x - env[0].x, env[1].y - env[0].y), depth = Math.hypot(env[2].x - env[1].x, env[2].y - env[1].y);
      if (input.allowGrowth && delta <= area(b.poly) && Math.min(width, depth) >= MIN_BW && Math.max(width, depth) / Math.min(width, depth) <= MAX_ASPECT && contacts.some((e) => e.lab === LAB_OPEN)) {
        const claim = tryDifference(env, parcel.poly);
        const safe = (p: Vec2) => p.x >= Math.max(3, input.ctx.win.x0) && p.y >= Math.max(3, input.ctx.win.y0) && p.x <= Math.min(input.ctx.mapSize - 3, input.ctx.win.x1) && p.y <= Math.min(input.ctx.mapSize - 3, input.ctx.win.y1) && !input.ctx.isWater(p) && input.ctx.slopeAt(p) <= 0.28;
        let dry = env.every(safe);
        const bb = bboxOf(env);
        for (let y = bb.y0; y <= bb.y1 && dry; y += 2) for (let x = bb.x0; x <= bb.x1; x += 2) if (pointInRing(env, { x, y }) && !safe({ x, y })) { dry = false; break; }
        const parcelPeers = parcels.query(env, true).filter((j) => j !== b.parcel).map((j) => ({ outer: input.parcels[j].poly, holes: [] }));
        const blockPeers = blocks.query(env, true).filter((j) => j !== bi).map((j) => ({ outer: input.blocks[j].poly, holes: [] }));
        const quarterPeers = quarters.query(env, true).filter((j) => j !== qi).map((j) => ({ outer: input.quarters[j].lp.pts, holes: [] }));
        if (!claim.failed && dry && protectedClear(env) && clear(claim.pieces, parcelPeers) && clear(env, blockPeers) && clear(env, quarterPeers) && roofClear(env)) {
          const newPlot = simpleMerge(parcel.poly, env), newBlock = simpleMerge(input.blocks[bi].poly, env), newQuarter = simpleMerge(quarter.lp.pts, env), newFootprint = mergeLand(input.footprint, env);
          const space = tryDifference(input.streetSpace[qi] ?? [], env), extra = tryDifference(env, quarter.lp.pts);
          const gardens = input.gardens.map((p) => meets(env, p) ? tryDifference(p, env) : { pieces: [{ outer: p, holes: [] }], failed: false });
          const phases = (input.phases ?? []).map((p) => ({ p, region: p.id >= quarter.phase ? mergeLand(p.region, env) : p.region, band: p.id === quarter.phase ? mergeLand(p.band, env) : p.band }));
          const otherBands = (input.phases ?? []).filter((p) => p.id !== quarter.phase).flatMap((p) => p.band);
          if (newPlot && newBlock && newQuarter && newFootprint && !space.failed && !extra.failed && clear(extra.pieces, otherBands) && phases.every((p) => p.region && p.band) && gardens.every((g) => !g.failed) && accessible(env, newBlock)) {
            parcel.poly = newPlot; input.blocks[bi].poly = newBlock;
            quarter.lp = { pts: newQuarter, lab: newQuarter.map((a, i) => {
              const z = newQuarter[(i + 1) % newQuarter.length], m = { x: (a.x + z.x) / 2, y: (a.y + z.y) / 2 };
              return boundaries[qi].find((e) => [a, z, m].every((p) => distToSeg(p, e.a, e.b) < 0.01))?.lab ?? LAB_OPEN;
            }) };
            input.streetSpace[qi] = space.pieces; input.footprint = newFootprint;
            for (const p of phases) { p.p.region = p.region!; p.p.band = p.band!; }
            input.gardens.splice(0, input.gardens.length, ...gardens.flatMap((g) => g.pieces.flatMap((p) => openHoles(p, 0, true).map((s) => s.outer))));
            b.poly = env; roofs.set(index, env); parcels.set(b.parcel, newPlot);
            blocks.set(bi, newBlock); quarters.set(qi, newQuarter); reachByBlock.delete(bi); grown++; expanded = true; changedBlocks.add(bi);
            if (extra.pieces.length) growth.set(quarter.phase, [...(growth.get(quarter.phase) ?? []), ...extra.pieces.map((p) => p.outer)]);
          }
        }
      }
      if (expanded) break;
    }
    if (expanded) continue;
    // A wall, water bank or occupied neighbour keeps its real boundary. Fit an intact rectangle on the inside.
    let fittedHere = false;
    for (const fittedRoof of fittedRoofs(b.poly, parcel.poly, parcel.front, contacts.map((e) => [e.a, e.b]))) {
      // A lot can include a standing fence or wall reserve. Containment alone does not protect it.
      // Preserve any existing boundary contact while refusing newly occupied protected ground.
      const added = tryDifference(fittedRoof, b.poly);
      if (added.failed || !protectedClear(added.pieces)) continue;
      if (!roofClear(fittedRoof) || !accessible(fittedRoof, input.blocks[bi].poly)) continue;
      const gardens = input.gardens.map((p) => meets(fittedRoof, p) ? tryDifference(p, fittedRoof) : { pieces: [{ outer: p, holes: [] }], failed: false });
      const freed = tryDifference(b.poly, fittedRoof);
      if (freed.failed || gardens.some((g) => g.failed)) continue;
      input.gardens.splice(0, input.gardens.length, ...[...gardens.flatMap((g) => g.pieces), ...freed.pieces].flatMap((p) => openHoles(p, 0, true).map((s) => s.outer)));
      b.poly = fittedRoof; roofs.set(index, fittedRoof); reachByBlock.delete(bi); fitted++; fittedHere = true; changedBlocks.add(bi); break;
    }
    if (!fittedHere && parcel.use === 'plot' && !peers.some((p) => p.b.courtyards?.length)) {
      // An artificial lot interface can prevent a useful whole dwelling despite free garden immediately
      // next door. Transfer only the new roof's claim, with both owners proved before changing either.
      const candidates: { proposal: CriticalRoofCandidate; donor: number }[] = [];
      const maximumArea = Math.max(1.3 * area(b.poly), MIN_BW * MIN_BW);
      const radius = 8 + Math.sqrt(maximumArea * (MAX_ASPECT + 1 / MAX_ASPECT)) / 2;
      const localWindow: Polygon = [
        { x: ownFrame.c.x - radius, y: ownFrame.c.y - radius }, { x: ownFrame.c.x + radius, y: ownFrame.c.y - radius },
        { x: ownFrame.c.x + radius, y: ownFrame.c.y + radius }, { x: ownFrame.c.x - radius, y: ownFrame.c.y + radius },
      ];
      // Index ordering is the original parcel order. Pad beyond adjacentBounds' exact
      // centimetre contact tolerance, then retain that original predicate below.
      const donorScale = Math.max(1, ...parcel.poly.flatMap((p) => [Math.abs(p.x), Math.abs(p.y)]));
      const donorMargin = 0.010001 + 128 * Number.EPSILON * donorScale;
      for (const donorIndex of parcels.queryBounds(bboxOf(parcel.poly), true, donorMargin)) {
        const donor = input.parcels[donorIndex];
        if (donorIndex === b.parcel || donor.block !== bi || donor.use !== 'plot' || !donor.front
          || donor.zone !== parcel.zone || !input.eligible(donorIndex) || !adjacentBounds(parcel.poly, donor.poly)
          || ![...donor.poly.map((p) => distToRing(parcel.poly, p)), ...parcel.poly.map((p) => distToRing(donor.poly, p))].some((d) => d <= 0.01)) continue;
        const occupied = roofs.query(donor.poly, true).filter((j) => j !== index).map((j) => ({ outer: input.buildings[j].poly, holes: [] }));
        const free = tryDifference(donor.poly, occupied, protectedNear(donor.poly));
        if (free.failed) continue;
        const joined = mergeTransferLand(free.pieces, parcel.poly);
        if (!joined) continue;
        // Candidate boundaries are local to the existing eight-metre relocation radius, even for a long lot.
        const local = tryIntersection(joined, localWindow), land = local.pieces;
        if (local.failed) continue;
        const axes: [Vec2, Vec2][] = [];
        for (const axis of [parcel.front, dominantAxis, ...contacts.map((e): [Vec2, Vec2] => [e.a, e.b]),
          ...land.flatMap((p) => [p.outer, ...p.holes]).flatMap((ring) => ring.map((a, i): [Vec2, Vec2] => [a, ring[(i + 1) % ring.length]]))]) {
          const dx = axis[1].x - axis[0].x, dy = axis[1].y - axis[0].y, length = Math.hypot(dx, dy);
          if (length < 1e-8 || axes.some(([a, z]) => Math.abs(dx * (z.y - a.y) - dy * (z.x - a.x)) <= 1e-5 * length * Math.hypot(z.x - a.x, z.y - a.y))) continue;
          axes.push(axis);
        }
        for (const piece of land) for (const axis of axes) {
          for (const proposal of criticalRoofCandidates(b.poly, piece.outer, axis, 'transfer', piece.holes)) candidates.push({ proposal, donor: donorIndex });
        }
      }
      // Preserve built area first across all donors and orientations, then consider the existing rare floor.
      // Stable sorting before pure proof filtering preserves the original accepted-candidate order.
      // Stop proving the remaining donors/axes as soon as the first complete transaction succeeds.
      candidates.sort((a, z) => area(z.proposal.roof) - area(a.proposal.roof));
      for (const { proposal, donor: donorIndex } of candidates) {
        const roof = proposal.roof, donor = input.parcels[donorIndex];
        if (!retainsRoof(proposal)) continue;
        const claim = tryDifference(roof, parcel.poly);
        if (claim.failed || mpArea(claim.pieces) <= 1e-6) continue;
        const insideDonor = tryDifference(claim.pieces, donor.poly);
        if (insideDonor.failed || mpArea(insideDonor.pieces) > 1e-6) continue;
        const insideBlock = tryDifference(roof, input.blocks[bi].poly);
        if (insideBlock.failed || mpArea(insideBlock.pieces) > 1e-6 || !insideRoofOwner(proposal)) continue;
        const safe = (p: Vec2) => p.x >= Math.max(3, input.ctx.win.x0) && p.y >= Math.max(3, input.ctx.win.y0)
          && p.x <= Math.min(input.ctx.mapSize - 3, input.ctx.win.x1) && p.y <= Math.min(input.ctx.mapSize - 3, input.ctx.win.y1)
          && !input.ctx.isWater(p) && input.ctx.slopeAt(p) <= 0.28;
        let dry = roof.every(safe);
        const bounds = bboxOf(roof);
        for (let y = bounds.y0; y <= bounds.y1 && dry; y += 2) for (let x = bounds.x0; x <= bounds.x1; x += 2) {
          if (pointInRing(roof, { x, y }) && !safe({ x, y })) { dry = false; break; }
        }
        const parcelPeers = parcels.query(roof, true).filter((j) => j !== b.parcel && j !== donorIndex).map((j) => ({ outer: input.parcels[j].poly, holes: [] }));
        const blockPeers = blocks.query(roof, true).filter((j) => j !== bi).map((j) => ({ outer: input.blocks[j].poly, holes: [] }));
        const quarterPeers = quarters.query(roof, true).filter((j) => j !== qi).map((j) => ({ outer: input.quarters[j].lp.pts, holes: [] }));
        if (!dry || !protectedClear(roof) || !waterClear(roof)
          || !clear(claim.pieces, parcelPeers) || !clear(roof, blockPeers) || !clear(roof, quarterPeers) || !roofClear(roof)) continue;
        const ownerLand = mergeTransferLand(parcel.poly, roof), donorRest = tryDifference(donor.poly, claim.pieces);
        const newOwner = ownerLand?.length === 1 && !ownerLand[0].holes.length && isSimple(ownerLand[0].outer) ? ownerLand[0].outer : null;
        if (!newOwner || donorRest.failed || donorRest.pieces.length !== 1 || donorRest.pieces[0].holes.length
          || !isSimple(donorRest.pieces[0].outer) || mpArea(donorRest.pieces) < MIN_BW * MIN_BW) continue;
        const newDonor = donorRest.pieces[0].outer;
        if (!preservesFront(parcel, newOwner) || !preservesFront(donor, newDonor) || !clear(newOwner, donorRest.pieces)) continue;
        const donorRoofs = input.buildings.filter((other) => other.parcel === donorIndex);
        const donorLost = donorRoofs.map((other) => tryDifference(other.poly, newDonor));
        if (donorLost.some((d) => d.failed || mpArea(d.pieces) > 1e-6)) continue;
        // Conserve the existing union, including any inherited microscopic interface overlap, rather
        // than double-counting two owners' old areas. The new owners must themselves be disjoint.
        const oldLand = mergeTransferLand(parcel.poly, donor.poly), newLand = mergeTransferLand(newOwner, newDonor);
        if (!oldLand || !newLand) continue;
        const lost = tryDifference(oldLand, newLand), extra = tryDifference(newLand, oldLand);
        if (lost.failed || extra.failed || mpArea(lost.pieces) > 1e-6 || mpArea(extra.pieces) > 1e-6
          || Math.abs(mpArea(oldLand) - mpArea(newLand)) > 0.01 || !accessible(roof, input.blocks[bi].poly)) continue;
        const gardens = input.gardens.map((p) => meets(roof, p) ? tryDifference(p, roof) : { pieces: [{ outer: p, holes: [] }], failed: false });
        const freed = tryDifference(b.poly, roof);
        if (freed.failed || gardens.some((g) => g.failed)) continue;
        const gardenPieces = [...gardens.flatMap((g) => g.pieces), ...freed.pieces], opened = openedGardens(gardenPieces);
        if (!opened) continue;
        parcel.poly = newOwner; donor.poly = newDonor; b.poly = roof;
        parcels.set(b.parcel, newOwner); parcels.set(donorIndex, newDonor); roofs.set(index, roof); reachByBlock.delete(bi);
        input.gardens.splice(0, input.gardens.length, ...opened);
        fitted++; fittedHere = true; changedBlocks.add(bi); break;
      }
    }
    if (!fittedHere) { constrained++; unresolved.push(index); }
  }
  // Run only after the complete original pass: new exterior transactions cannot displace any
  // already accepted roof or change which of the existing candidates succeeds later in that pass.
  for (const index of input.allowGrowth ? unresolved : []) {
    const b = input.buildings[index], owner = b.parcel!, parcel = input.parcels[owner];
    if (parcel.use !== 'plot' || !parcel.front) continue;
    const bi = parcel.block, qi = input.quarterOf?.(bi) ?? input.blocks[bi].quarter, quarter = input.quarters[qi];
    const peers = byBlock.get(bi)!;
    if (peers.some((p) => p.b.courtyards?.length)) continue;
    // Earlier accepted growth can replace this quarter's geometry and split its labelled edges.
    // Reconstruct both contacts and label inheritance from the current partition for every roof.
    const currentBoundary = quarter.lp.pts.map((a, i) => ({ a,
      b: quarter.lp.pts[(i + 1) % quarter.lp.pts.length], lab: quarter.lp.lab[i] }));
    const contacts = currentBoundary.filter((e) => e.lab === LAB_OPEN && b.poly.some((a, i) => {
      const z = b.poly[(i + 1) % b.poly.length], m = { x: (a.x + z.x) / 2, y: (a.y + z.y) / 2 };
      return Math.hypot(z.x - a.x, z.y - a.y) >= 1
        && [a, z, m].every((p) => distToSeg(p, e.a, e.b) <= 0.15);
    }));
    if (!contacts.length) continue;
    const ownFrame = obb(b.poly);
    const dominant: [Vec2, Vec2] = [ownFrame.c, { x: ownFrame.c.x + ownFrame.u.x, y: ownFrame.c.y + ownFrame.u.y }];
    const beforeReach = reachByBlock.get(bi) ?? blockReach(input.blocks[bi].poly, peers.map((p) => p.b.poly), streetAt);
    reachByBlock.set(bi, beforeReach);
    const axes: [Vec2, Vec2][] = [parcel.front, dominant];
    const envelopes = axes.map((axis) => roofEnvelope(b.poly, axis));
    // Existing envelopes retain priority. Only rounding-rejected ceilings get a new bounded proposal.
    const rounded = axes.flatMap((axis) => { const poly = roundedGrowthEnvelope(b.poly, axis); return poly ? [poly] : []; });
    // A triangle's other actual side can enclose the whole dwelling on free exterior land while
    // its frontage and OBB axis hit a neighbour. Keep every original coupled attempt first;
    // append real sides in vertex order, including their strictly capped rounding construction.
    const edgeEnvelopes = b.poly.flatMap((p, i) => {
      const axis: [Vec2, Vec2] = [p, b.poly[(i + 1) % b.poly.length]];
      const envelope = roofEnvelope(b.poly, axis), rounded = roundedGrowthEnvelope(b.poly, axis);
      return rounded ? [envelope, rounded] : [envelope];
    });
    for (const roof of [...envelopes, ...rounded, ...edgeEnvelopes]) {
      const oldArea = area(b.poly), delta = area(roof) - oldArea;
      const width = Math.hypot(roof[1].x - roof[0].x, roof[1].y - roof[0].y);
      const depth = Math.hypot(roof[2].x - roof[1].x, roof[2].y - roof[1].y);
      // This is the existing exterior-growth allowance, not the smaller inside-lot transfer allowance.
      if (delta <= 0.02 || delta > oldArea || Math.min(width, depth) < MIN_BW
        || Math.max(width, depth) / Math.min(width, depth) > MAX_ASPECT || !isSimple(roof)) continue;
      const lostRoof = tryDifference(b.poly, roof), claim = tryDifference(roof, parcel.poly);
      const exterior = tryDifference(roof, input.footprint), extra = tryDifference(roof, quarter.lp.pts);
      if (lostRoof.failed || claim.failed || exterior.failed || extra.failed || mpArea(lostRoof.pieces) > 1e-6
        || mpArea(exterior.pieces) <= 1e-6 || mpArea(extra.pieces) <= 1e-6) continue;
      const crossed = currentBoundary.filter((e) => boundaryRunInside(roof, e.a, e.b) > 0);
      // An old open contact cannot authorize growth through another actual closed edge.
      if (!crossed.length || crossed.some((e) => e.lab !== LAB_OPEN)) continue;
      const safe = (p: Vec2) => p.x >= Math.max(3, input.ctx.win.x0) && p.y >= Math.max(3, input.ctx.win.y0)
        && p.x <= Math.min(input.ctx.mapSize - 3, input.ctx.win.x1) && p.y <= Math.min(input.ctx.mapSize - 3, input.ctx.win.y1)
        && !input.ctx.isWater(p) && input.ctx.slopeAt(p) <= 0.28;
      let dry = roof.every(safe);
      const bounds = bboxOf(roof);
      for (let y = bounds.y0; y <= bounds.y1 && dry; y += 2) for (let x = bounds.x0; x <= bounds.x1; x += 2) {
        if (pointInRing(roof, { x, y }) && !safe({ x, y })) { dry = false; break; }
      }
      const blockPeers = blocks.query(roof, true).filter((j) => j !== bi).map((j) => ({ outer: input.blocks[j].poly, holes: [] }));
      const quarterPeers = quarters.query(roof, true).filter((j) => j !== qi).map((j) => ({ outer: input.quarters[j].lp.pts, holes: [] }));
      const otherBands = (input.phases ?? []).filter((p) => p.id !== quarter.phase).flatMap((p) => p.band);
      if (!dry || !protectedClear(roof) || !waterClear(roof) || !clear(roof, blockPeers) || !clear(roof, quarterPeers)
        || !clear(extra.pieces, otherBands) || !roofs.query(roof, true).every((j) => j === index
          || clear(roof, [{ outer: input.buildings[j].poly, holes: [] }]))) continue;
      let accepted = false;
      const allParcelPeers = parcels.query(roof, true).filter((j) => j !== owner)
        .map((j) => ({ outer: input.parcels[j].poly, holes: [] }));
      if (clear(claim.pieces, allParcelPeers)) {
        // The extra land is exterior ground, not another owner's plot. No donor is needed;
        // prove every planning level and garden before publishing this single-owner transaction.
        const ownerLand = mergeTransferLand(parcel.poly, roof);
        const blockLand = mergeTransferLand(input.blocks[bi].poly, roof);
        const quarterLand = mergeTransferLand(quarter.lp.pts, roof);
        const footprint = mergeTransferLand(input.footprint, roof);
        const single = (land: MultiPoly | null): Polygon | null => land?.length === 1
          && !land[0].holes.length && isSimple(land[0].outer) ? land[0].outer : null;
        const newOwner = single(ownerLand), newBlock = single(blockLand), newQuarter = single(quarterLand);
        const space = tryDifference(input.streetSpace[qi] ?? [], roof);
        const phases = (input.phases ?? []).map((p) => ({ p,
          region: p.id >= quarter.phase ? mergeTransferLand(p.region, roof) : p.region,
          band: p.id === quarter.phase ? mergeTransferLand(p.band, roof) : p.band }));
        const ownRoofs = input.buildings.filter((p) => p.parcel === owner).map((p) => ({ outer: p.poly, holes: [] }));
        const retained = newOwner ? tryDifference(ownRoofs, newOwner) : null;
        const ownersUnchanged = newOwner && parcels.query(newOwner, true).filter((j) => j !== owner).every((j) => {
          const oldOverlap = tryIntersection(parcel.poly, input.parcels[j].poly);
          const newOverlap = tryIntersection(newOwner, input.parcels[j].poly);
          if (oldOverlap.failed || newOverlap.failed) return false;
          const introduced = tryDifference(newOverlap.pieces, oldOverlap.pieces);
          return !introduced.failed && mpArea(introduced.pieces) <= 1e-6;
        });
        const gardens = input.gardens.map((p) => meets(roof, p) ? tryDifference(p, roof)
          : { pieces: [{ outer: p, holes: [] }], failed: false });
        const opened = gardens.every((g) => !g.failed) ? openedGardens(gardens.flatMap((g) => g.pieces)) : null;
        const peers = byBlock.get(bi)!;
        const beforeReach = reachByBlock.get(bi) ?? blockReach(input.blocks[bi].poly, peers.map((p) => p.b.poly), streetAt);
        const afterReach = newBlock && blockReach(newBlock, peers.map((p) => p.index === index ? roof : p.b.poly), streetAt);
        if (newOwner && newBlock && newQuarter && footprint && ownerLand && blockLand && quarterLand
          && preservesFront(parcel, newOwner) && retained && !retained.failed && mpArea(retained.pieces) <= 1e-6
          && ownersUnchanged && !space.failed && opened
          && conservesRoofUnion(parcel.poly, roof, ownerLand) && conservesRoofUnion(input.blocks[bi].poly, roof, blockLand)
          && conservesRoofUnion(quarter.lp.pts, roof, quarterLand) && conservesRoofUnion(input.footprint, roof, footprint)
          && phases.every((p) => p.region && p.band
            && (p.p.id < quarter.phase || conservesRoofUnion(p.p.region, roof, p.region))
            && (p.p.id !== quarter.phase || conservesRoofUnion(p.p.band, roof, p.band)))
          && afterReach && afterReach.every((v, j) => v || (!beforeReach[j] && peers[j].index !== index))) {
          parcel.poly = newOwner; b.poly = roof; input.blocks[bi].poly = newBlock;
          quarter.lp = { pts: newQuarter, lab: newQuarter.map((a, i) => {
            const z = newQuarter[(i + 1) % newQuarter.length], m = { x: (a.x + z.x) / 2, y: (a.y + z.y) / 2 };
            return currentBoundary.find((e) => [a, z, m].every((p) => distToSeg(p, e.a, e.b) < 0.01))?.lab ?? LAB_OPEN;
          }) };
          input.streetSpace[qi] = space.pieces; input.footprint = footprint;
          for (const p of phases) { p.p.region = p.region!; p.p.band = p.band!; }
          input.gardens.splice(0, input.gardens.length, ...opened);
          roofs.set(index, roof); parcels.set(owner, newOwner); blocks.set(bi, newBlock); quarters.set(qi, newQuarter);
          reachByBlock.delete(bi); grown++; constrained--; changedBlocks.add(bi); accepted = true;
          growth.set(quarter.phase, [...(growth.get(quarter.phase) ?? []), ...extra.pieces.map((p) => p.outer)]);
        }
      }
      if (accepted) break;
      for (const donorIndex of parcels.query(roof, true)) {
        const donor = input.parcels[donorIndex];
        if (donorIndex === owner || donor.block !== bi || donor.use !== 'plot' || !donor.front
          || donor.zone !== parcel.zone || !input.eligible(donorIndex) || !adjacentBounds(parcel.poly, donor.poly)
          || ![...donor.poly.map((p) => distToRing(parcel.poly, p)), ...parcel.poly.map((p) => distToRing(donor.poly, p))]
            .some((d) => d <= 0.01)) continue;
        const donorClaim = tryIntersection(claim.pieces, donor.poly);
        const parcelPeers = parcels.query(roof, true).filter((j) => j !== owner && j !== donorIndex)
          .map((j) => ({ outer: input.parcels[j].poly, holes: [] }));
        if (donorClaim.failed || mpArea(donorClaim.pieces) <= 1e-6 || !clear(claim.pieces, parcelPeers)) continue;
        const ownerLand = mergeTransferLand(parcel.poly, roof);
        const newOwner = ownerLand?.length === 1 && !ownerLand[0].holes.length && isSimple(ownerLand[0].outer) ? ownerLand[0].outer : null;
        if (!newOwner) continue;
        // Also resolve any inherited microscopic owner overlap. Conserving the original union below
        // prevents either double-counting that strip or silently losing its raw boundary land.
        const donorRest = tryDifference(donor.poly, newOwner);
        if (donorRest.failed || donorRest.pieces.length !== 1 || donorRest.pieces[0].holes.length
          || !isSimple(donorRest.pieces[0].outer) || mpArea(donorRest.pieces) < MIN_BW * MIN_BW) continue;
        const newDonor = donorRest.pieces[0].outer;
        if (!preservesFront(parcel, newOwner) || !preservesFront(donor, newDonor) || !clear(newOwner, donorRest.pieces)) continue;
        const donorRoofs = input.buildings.flatMap((other, j) => other.parcel === donorIndex ? [{ b: other, index: j }] : []);
        const donorLost = donorRoofs.map((other) => ({ other, lost: tryDifference(other.b.poly, newDonor) }));
        if (donorLost.some((d) => d.lost.failed)) continue;
        const displaced = donorLost.filter((d) => mpArea(d.lost.pieces) > 1e-6);
        if (displaced.length > 1) continue;
        const shifts: ({ index: number; old: Polygon; poly: Polygon } | undefined)[] = [undefined];
        if (displaced.length) {
          shifts.length = 0;
          const peer = displaced[0].other, old = peer.b.poly;
          // A first-pass success cannot silently change in this later coupled transaction.
          if (initialRoofs[peer.index] !== old || peer.b.courtyards?.length || !isSimple(old)) continue;
          // Only repair an inherited owner/donor seam under an actual unchanged neighbour.
          const inherited = tryIntersection(parcel.poly, donor.poly), seam = tryIntersection(displaced[0].lost.pieces, inherited.pieces);
          const unrelated = tryDifference(displaced[0].lost.pieces, seam.pieces);
          if (inherited.failed || seam.failed || unrelated.failed || mpArea(unrelated.pieces) > 1e-6) continue;
          for (const translated of seamTranslations(old)) {
            if (!isSimple(translated) || Math.abs(area(translated) - area(old)) > 1e-6
              || Math.hypot(translated[0].x - old[0].x, translated[0].y - old[0].y) > 0.001) continue;
            const outside = tryDifference(translated, newDonor), footprintLost = tryDifference(translated, input.footprint);
            const blockLost = tryDifference(translated, input.blocks[bi].poly), quarterLost = tryDifference(translated, quarter.lp.pts);
            // The peer claims no additional block, quarter or phase land. The primary exterior
            // growth retains its other-band proof above, while the whole peer stays inside here.
            if (outside.failed || footprintLost.failed || blockLost.failed || quarterLost.failed || mpArea(outside.pieces) > 1e-6
              || mpArea(footprintLost.pieces) > 1e-6 || mpArea(blockLost.pieces) > 1e-6 || mpArea(quarterLost.pieces) > 1e-6) continue;
            let dryTranslated = translated.every(safe);
            const bounds = bboxOf(translated);
            for (let y = bounds.y0; y <= bounds.y1 && dryTranslated; y += 2) for (let x = bounds.x0; x <= bounds.x1; x += 2) {
              if (pointInRing(translated, { x, y }) && !safe({ x, y })) { dryTranslated = false; break; }
            }
            const otherRoofs = roofs.query(translated, true).filter((j) => j !== peer.index && j !== index)
              .map((j) => ({ outer: input.buildings[j].poly, holes: [] }));
            const otherBlocks = blocks.query(translated, true).filter((j) => j !== bi)
              .map((j) => ({ outer: input.blocks[j].poly, holes: [] }));
            const otherQuarters = quarters.query(translated, true).filter((j) => j !== qi)
              .map((j) => ({ outer: input.quarters[j].lp.pts, holes: [] }));
            if (!dryTranslated || !protectedClear(translated) || !waterClear(translated)
              || !clear(translated, otherRoofs) || !clear(translated, [{ outer: roof, holes: [] }])
              || !clear(translated, otherBlocks) || !clear(translated, otherQuarters)) continue;
            shifts.push({ index: peer.index, old, poly: translated });
          }
          if (!shifts.length) continue;
        }
        const oldLand = mergeTransferLand(parcel.poly, donor.poly), newLand = mergeTransferLand(newOwner, newDonor);
        const expected = oldLand && mergeTransferLand(oldLand, roof);
        if (!newLand || !expected) continue;
        const lost = tryDifference(expected, newLand), added = tryDifference(newLand, expected);
        if (lost.failed || added.failed || mpArea(lost.pieces) > 1e-6 || mpArea(added.pieces) > 1e-6
          || Math.abs(mpArea(expected) - mpArea(newLand)) > 0.01) continue;
        const simpleRawMerge = (poly: Polygon): Polygon | null => {
          const merged = mergeTransferLand(poly, roof);
          return merged?.length === 1 && !merged[0].holes.length && isSimple(merged[0].outer) ? merged[0].outer : null;
        };
        const newBlock = simpleRawMerge(input.blocks[bi].poly), newQuarter = simpleRawMerge(quarter.lp.pts);
        const footprint = mergeTransferLand(input.footprint, roof), space = tryDifference(input.streetSpace[qi] ?? [], roof);
        const phases = (input.phases ?? []).map((p) => ({ p,
          region: p.id >= quarter.phase ? mergeTransferLand(p.region, roof) : p.region,
          band: p.id === quarter.phase ? mergeTransferLand(p.band, roof) : p.band }));
        if (!newBlock || !newQuarter || !footprint || space.failed || phases.some((p) => !p.region || !p.band)) continue;
        // A geometrically valid translation is not accepted until access and the complete garden
        // transaction pass too. A rejected candidate leaves every subsequent translation available.
        for (const moved of shifts) {
          const reached = blockReach(newBlock, peers.map((p) => p.index === index ? roof
            : moved && p.index === moved.index ? moved.poly : p.b.poly), streetAt);
          if (!reached.every((v, j) => v || (!beforeReach[j] && peers[j].index !== index && peers[j].index !== moved?.index))) continue;
          const occupied: MultiPoly = [{ outer: roof, holes: [] }, ...(moved ? [{ outer: moved.poly, holes: [] }] : [])];
          const gardens = input.gardens.map((p) => occupied.some((s) => meets(s.outer, p)) ? tryDifference(p, occupied)
            : { pieces: [{ outer: p, holes: [] }], failed: false });
          if (gardens.some((g) => g.failed)) continue;
          const freed = moved ? tryDifference(moved.old, moved.poly,
            roofs.query(moved.old, true).filter((j) => j !== moved.index && j !== index)
              .map((j) => ({ outer: input.buildings[j].poly, holes: [] })), roof,
            gardens.flatMap((g) => g.pieces)) : { pieces: [], failed: false };
          if (freed.failed) continue;
          const opened = openedGardens([...gardens.flatMap((g) => g.pieces), ...freed.pieces]);
          if (!opened) continue;
          // Publish all ownership levels and the whole translated peer together after every proof.
          parcel.poly = newOwner; donor.poly = newDonor; b.poly = roof;
          input.blocks[bi].poly = newBlock;
          quarter.lp = { pts: newQuarter, lab: newQuarter.map((a, i) => {
            const z = newQuarter[(i + 1) % newQuarter.length], m = { x: (a.x + z.x) / 2, y: (a.y + z.y) / 2 };
            return currentBoundary.find((e) => [a, z, m].every((p) => distToSeg(p, e.a, e.b) < 0.01))?.lab ?? LAB_OPEN;
          }) };
          input.streetSpace[qi] = space.pieces; input.footprint = footprint;
          for (const p of phases) { p.p.region = p.region!; p.p.band = p.band!; }
          input.gardens.splice(0, input.gardens.length, ...opened);
          if (moved) { input.buildings[moved.index].poly = moved.poly; roofs.set(moved.index, moved.poly); }
          roofs.set(index, roof); parcels.set(owner, newOwner); parcels.set(donorIndex, newDonor);
          blocks.set(bi, newBlock); quarters.set(qi, newQuarter); reachByBlock.delete(bi);
          grown++; constrained--; changedBlocks.add(bi); accepted = true;
          growth.set(quarter.phase, [...(growth.get(quarter.phase) ?? []), ...extra.pieces.map((p) => p.outer)]);
          break;
        }
        if (accepted) break;
      }
      if (accepted) break;
    }
  }
  return { grown, fitted, constrained, changedBlocks, growth };
}
