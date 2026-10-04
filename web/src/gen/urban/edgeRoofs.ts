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
    const outside = tryDifference(r, poly);
    if (outside.failed || mpArea(outside.pieces) > 1e-6 || !polyInside(poly, r) || area(r) < 0.65 * area(poly)) continue;
    if (!best || area(r) > area(best)) best = r;
  }
  return best;
}

/** Try nearby whole rectangles inside the same lot before shrinking a clipped wall-side corner. */
function relocatedRoofs(poly: Polygon, plot: Polygon, front: [Vec2, Vec2], sizes?: { width: number; depth: number }[]): Polygon[] {
  const f = frame(poly, front), u0 = Math.min(...f.us), u1 = Math.max(...f.us), d0 = Math.min(...f.ds), d1 = Math.max(...f.ds);
  const candidates: { poly: Polygon; move: number }[] = [];
  for (const { width, depth } of sizes ?? [1, 0.9, 0.8].map((scale) => ({ width: (u1 - u0) * scale, depth: (d1 - d0) * scale }))) {
    if (Math.min(width, depth) < MIN_BW || Math.max(width, depth) / Math.min(width, depth) > MAX_ASPECT || width * depth < 0.65 * area(poly) || width * depth > 1.3 * area(poly)) continue;
    for (const du of [0, -2, 2, -4, 4, -6, 6, -8, 8]) for (const dd of [0, -2, 2, -4, 4, -6, 6, -8, 8]) {
      const r = rectangle(f, (u0 + u1 - width) / 2 + du, (u0 + u1 + width) / 2 + du, (d0 + d1 - depth) / 2 + dd, (d0 + d1 + depth) / 2 + dd);
      if (!polyInside(plot, r)) continue;
      const outside = tryDifference(r, plot), retained = tryIntersection(r, poly);
      if (outside.failed || retained.failed || mpArea(outside.pieces) > 1e-6 || mpArea(retained.pieces) < 0.5 * area(poly)) continue;
      candidates.push({ poly: r, move: Math.hypot(du, dd) });
    }
  }
  candidates.sort((a, b) => area(b.poly) - area(a.poly) || a.move - b.move);
  return candidates.map((c) => c.poly);
}

/** Critical placements touch real parcel edges instead of depending on a coarse translation grid. */
function criticalRoofs(poly: Polygon, plot: Polygon, axis: [Vec2, Vec2], mode: 'regular' | 'supplement' | 'rare' | 'transfer' = 'regular', holes: Polygon[] = []): Polygon[] {
  const f = frame(poly, axis), pf = frame(orientPos(plot), axis);
  const cu = (Math.min(...f.us) + Math.max(...f.us)) / 2, cd = (Math.min(...f.ds) + Math.max(...f.ds)) / 2;
  const oldArea = area(poly), oldRatio = (Math.max(...f.us) - Math.min(...f.us)) / (Math.max(...f.ds) - Math.min(...f.ds));
  const rare = mode === 'rare' || mode === 'transfer';
  const oldCenter = mode === 'transfer' ? obb(poly).c : undefined;
  const minimumArea = (rare ? 0.5 : 0.65) * oldArea;
  // A previously clipped, undersized dwelling still needs room for the minimum useful whole roof.
  const maximumArea = rare ? Math.max(1.3 * oldArea, MIN_BW * MIN_BW) : 1.3 * oldArea;
  const candidates: { poly: Polygon; move: number }[] = [];
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
  for (const { width, depth } of sizes) {
    if (Math.min(width, depth) < MIN_BW || Math.max(width, depth) / Math.min(width, depth) > MAX_ASPECT) continue;
    const rings = mode === 'transfer' ? [pf, ...holes.map((p) => frame(p, axis))] : [pf];
    const lines = rings.flatMap((ring) => ring.us.flatMap((u, i) => {
      const j = (i + 1) % ring.us.length, du = ring.us[j] - u, dd = ring.ds[j] - ring.ds[i], length = Math.hypot(du, dd);
      if (length < 1e-8) return [];
      const nu = -dd / length, nd = du / length;
      const support = Math.abs(nu) * width / 2 + Math.abs(nd) * depth / 2 + 1e-7;
      return (mode === 'transfer' ? [-1, 1] : [1]).map((sign) => ({ nu, nd, k: nu * u + nd * ring.ds[i] + sign * support }));
    }));
    // Same eight-metre movement limit as the ordinary search; its four bounds are also useful critical edges.
    lines.push({ nu: 1, nd: 0, k: cu - 8 }, { nu: -1, nd: 0, k: -cu - 8 },
      { nu: 0, nd: 1, k: cd - 8 }, { nu: 0, nd: -1, k: -cd - 8 });
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
    const contained = centers.filter((c, i) => Math.abs(c.u - cu) <= 8 + 1e-8 && Math.abs(c.d - cd) <= 8 + 1e-8
      && !centers.slice(0, i).some((p) => Math.hypot(p.u - c.u, p.d - c.d) < 1e-6)
      && polyInside(plot, rectangle(f, c.u - width / 2, c.u + width / 2, c.d - depth / 2, c.d + depth / 2)));
    if (contained.length) {
      const center = { u: contained.reduce((sum, p) => sum + p.u, 0) / contained.length,
        d: contained.reduce((sum, p) => sum + p.d, 0) / contained.length };
      // Interior placements can preserve access where every boundary-touching placement blocks a yard.
      centers.push(center, ...contained.map((p) => ({ u: (p.u + center.u) / 2, d: (p.d + center.d) / 2 })));
    }
    for (const c of centers) {
      if (!Number.isFinite(c.u + c.d) || Math.abs(c.u - cu) > 8 + 1e-8 || Math.abs(c.d - cd) > 8 + 1e-8) continue;
      const r = rectangle(f, c.u - width / 2, c.u + width / 2, c.d - depth / 2, c.d + depth / 2);
      if (mode === 'transfer') {
        const newCenter = f.at(c.u, c.d);
        if (Math.hypot(newCenter.x - oldCenter!.x, newCenter.y - oldCenter!.y) > 8 + 1e-8) continue;
      }
      if (!polyInside(plot, r)) continue;
      const outside = tryDifference(r, plot), retained = tryIntersection(r, poly);
      if (outside.failed || retained.failed || mpArea(outside.pieces) > 1e-6 || mpArea(retained.pieces) < 0.5 * oldArea
        || area(r) < minimumArea || area(r) > maximumArea) continue;
      candidates.push({ poly: r, move: Math.hypot(c.u - cu, c.d - cd) });
    }
  }
  candidates.sort((a, b) => area(b.poly) - area(a.poly) || a.move - b.move);
  return candidates.map((c) => c.poly);
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

/** A garden opening is accepted only when its simple pieces conserve the checked difference. */
function openedGardens(pieces: MultiPoly): Polygon[] | null {
  const result: Polygon[] = [];
  for (const piece of pieces) {
    const opened = openHoles(piece, 0, true);
    if (opened.some((p) => p.holes.length || !isSimple(p.outer))) return null;
    const lost = tryDifference([piece], opened), added = tryDifference(opened, [piece]);
    if (lost.failed || added.failed || mpArea(lost.pieces) > 1e-6 || mpArea(added.pieces) > 1e-6
      || Math.abs(mpArea([piece]) - mpArea(opened)) > 0.01) return null;
    result.push(...opened.map((p) => p.outer));
  }
  return result;
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
    const peers = input.buildings.flatMap((other, j) => other.parcel !== undefined && input.parcels[other.parcel].block === bi ? [{ b: other, index: j }] : []);
    const beforeReach = blockReach(input.blocks[bi].poly, peers.map((p) => p.b.poly), streetAt);
    const accessible = (poly: Polygon, block: Polygon): boolean => {
      const reached = blockReach(block, peers.map((p) => p.index === index ? poly : p.b.poly), streetAt);
      return reached.every((v, j) => v || (!beforeReach[j] && peers[j].index !== index));
    };
    const roofClear = (poly: Polygon): boolean => input.buildings.every((other, j) => j === index || !meets(poly, other.poly) || clear(poly, [{ outer: other.poly, holes: [] }]));
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
        const parcelPeers = input.parcels.flatMap((p, j) => j !== b.parcel && meets(env, p.poly) ? [{ outer: p.poly, holes: [] }] : []);
        const blockPeers = input.blocks.flatMap((p, j) => j !== bi && meets(env, p.poly) ? [{ outer: p.poly, holes: [] }] : []);
        const quarterPeers = input.quarters.flatMap((q, j) => j !== qi && meets(env, q.lp.pts) ? [{ outer: q.lp.pts, holes: [] }] : []);
        if (!claim.failed && dry && clear(env, input.protectedLand) && clear(claim.pieces, parcelPeers) && clear(env, blockPeers) && clear(env, quarterPeers) && roofClear(env)) {
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
            b.poly = env; grown++; expanded = true; changedBlocks.add(bi);
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
      if (added.failed || !clear(added.pieces, input.protectedLand)) continue;
      if (!roofClear(fittedRoof) || !accessible(fittedRoof, input.blocks[bi].poly)) continue;
      const gardens = input.gardens.map((p) => meets(fittedRoof, p) ? tryDifference(p, fittedRoof) : { pieces: [{ outer: p, holes: [] }], failed: false });
      const freed = tryDifference(b.poly, fittedRoof);
      if (freed.failed || gardens.some((g) => g.failed)) continue;
      input.gardens.splice(0, input.gardens.length, ...[...gardens.flatMap((g) => g.pieces), ...freed.pieces].flatMap((p) => openHoles(p, 0, true).map((s) => s.outer)));
      b.poly = fittedRoof; fitted++; fittedHere = true; changedBlocks.add(bi); break;
    }
    if (!fittedHere && parcel.use === 'plot' && !peers.some((p) => p.b.courtyards?.length)) {
      // An artificial lot interface can prevent a useful whole dwelling despite free garden immediately
      // next door. Transfer only the new roof's claim, with both owners proved before changing either.
      const candidates: { roof: Polygon; donor: number }[] = [];
      const maximumArea = Math.max(1.3 * area(b.poly), MIN_BW * MIN_BW);
      const radius = 8 + Math.sqrt(maximumArea * (MAX_ASPECT + 1 / MAX_ASPECT)) / 2;
      const localWindow: Polygon = [
        { x: ownFrame.c.x - radius, y: ownFrame.c.y - radius }, { x: ownFrame.c.x + radius, y: ownFrame.c.y - radius },
        { x: ownFrame.c.x + radius, y: ownFrame.c.y + radius }, { x: ownFrame.c.x - radius, y: ownFrame.c.y + radius },
      ];
      for (const [donorIndex, donor] of input.parcels.entries()) {
        if (donorIndex === b.parcel || donor.block !== bi || donor.use !== 'plot' || !donor.front
          || donor.zone !== parcel.zone || !input.eligible(donorIndex) || !adjacentBounds(parcel.poly, donor.poly)
          || ![...donor.poly.map((p) => distToRing(parcel.poly, p)), ...parcel.poly.map((p) => distToRing(donor.poly, p))].some((d) => d <= 0.01)) continue;
        const occupied = input.buildings.flatMap((other, j) => j !== index && meets(donor.poly, other.poly) ? [{ outer: other.poly, holes: [] }] : []);
        const free = tryDifference(donor.poly, occupied, input.protectedLand);
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
          for (const roof of criticalRoofs(b.poly, piece.outer, axis, 'transfer', piece.holes)) candidates.push({ roof, donor: donorIndex });
        }
      }
      // Preserve built area first across all donors and orientations, then consider the existing rare floor.
      candidates.sort((a, z) => area(z.roof) - area(a.roof));
      for (const { roof, donor: donorIndex } of candidates) {
        const donor = input.parcels[donorIndex];
        const claim = tryDifference(roof, parcel.poly), insideDonor = tryDifference(claim.pieces, donor.poly);
        const insideBlock = tryDifference(roof, input.blocks[bi].poly);
        if (claim.failed || insideDonor.failed || insideBlock.failed || mpArea(claim.pieces) <= 1e-6
          || mpArea(insideDonor.pieces) > 1e-6 || mpArea(insideBlock.pieces) > 1e-6) continue;
        const safe = (p: Vec2) => p.x >= Math.max(3, input.ctx.win.x0) && p.y >= Math.max(3, input.ctx.win.y0)
          && p.x <= Math.min(input.ctx.mapSize - 3, input.ctx.win.x1) && p.y <= Math.min(input.ctx.mapSize - 3, input.ctx.win.y1)
          && !input.ctx.isWater(p) && input.ctx.slopeAt(p) <= 0.28;
        let dry = roof.every(safe);
        const bounds = bboxOf(roof);
        for (let y = bounds.y0; y <= bounds.y1 && dry; y += 2) for (let x = bounds.x0; x <= bounds.x1; x += 2) {
          if (pointInRing(roof, { x, y }) && !safe({ x, y })) { dry = false; break; }
        }
        const parcelPeers = input.parcels.flatMap((p, j) => j !== b.parcel && j !== donorIndex && meets(roof, p.poly) ? [{ outer: p.poly, holes: [] }] : []);
        const blockPeers = input.blocks.flatMap((p, j) => j !== bi && meets(roof, p.poly) ? [{ outer: p.poly, holes: [] }] : []);
        const quarterPeers = input.quarters.flatMap((q, j) => j !== qi && meets(roof, q.lp.pts) ? [{ outer: q.lp.pts, holes: [] }] : []);
        if (!dry || !clear(roof, input.protectedLand) || !clear(roof, input.ctx.water)
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
        input.gardens.splice(0, input.gardens.length, ...opened);
        fitted++; fittedHere = true; changedBlocks.add(bi); break;
      }
    }
    if (!fittedHere) constrained++;
  }
  return { grown, fitted, constrained, changedBlocks, growth };
}
