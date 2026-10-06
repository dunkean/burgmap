/** Bounded last resort for an unusable narrow ordinary roof in its own plot. */
import type { Polygon, Vec2 } from '../core/geom';
import { polygonCentroid } from '../core/geom';
import { area, bboxOf, inscribed, isSimple, obb } from '../geo/poly';
import { polyInside } from '../geo/split';
import { mpArea, tryDifference, tryIntersection } from '../geo/bool';

const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** The caller supplies physical-clearance, all-owner-land and whole-block-access checks. */
export function reconstructCompactRoom(poly: Polygon, owner: Polygon, occupied: Polygon[],
  front: [Vec2, Vec2] | undefined, clear: (candidate: Polygon) => boolean,
  validate: (candidate: Polygon) => boolean): Polygon | null {
  if (poly.length < 3 || owner.length < 3) return null;
  const oldArea = area(poly), oldCenter = polygonCentroid(poly);
  if (oldArea < 12 || !Number.isFinite(oldArea)) return null;
  const oldContacts = occupied.map((other) => tryIntersection(poly, other));
  if (oldContacts.some((hit) => hit.failed)) return null;
  const bounds = bboxOf(owner), box = obb(poly);
  const axes: Vec2[] = [];
  const addAxis = (axis: Vec2): void => {
    const length = Math.hypot(axis.x, axis.y);
    if (length < 1e-6) return;
    const u = { x: axis.x / length, y: axis.y / length };
    if (axes.every((v) => Math.abs(v.x * u.x + v.y * u.y) < 0.995)) axes.push(u);
  };
  if (front) addAxis({ x: front[1].x - front[0].x, y: front[1].y - front[0].y });
  let longest = 0, wall = box.u;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], length = distance(a, b);
    if (length > longest) { longest = length; wall = { x: b.x - a.x, y: b.y - a.y }; }
  }
  addAxis(wall);
  addAxis(box.u);
  const centers = [inscribed(poly, [], 0.2).c, oldCenter, box.c, inscribed(owner, [], 0.5).c];
  const offsets: [number, number][] = [[0, 0]];
  for (const d of [1, 2, 3, 4, 6, 8]) offsets.push([d, 0], [-d, 0], [0, d], [0, -d]);
  offsets.push([1, 1], [1, -1], [-1, 1], [-1, -1], [2, 2], [2, -2], [-2, 2], [-2, -2]);
  const accept = (candidate: Polygon, minimum: number): boolean => {
    const a = area(candidate);
    if (a < minimum * oldArea - 1e-6 || a >= 0.95 * oldArea || !isSimple(candidate)
      || distance(polygonCentroid(candidate), oldCenter) > 18 + 1e-6) return false;
    const bb = bboxOf(candidate);
    if (bb.x0 < bounds.x0 - 1e-6 || bb.y0 < bounds.y0 - 1e-6
      || bb.x1 > bounds.x1 + 1e-6 || bb.y1 > bounds.y1 + 1e-6
      || !polyInside(owner, candidate)) return false;
    const added = tryDifference(candidate, poly);
    if (added.failed) return false;
    for (let i = 0; i < occupied.length; i++) {
      const newContact = added.pieces.length ? tryIntersection(added.pieces, occupied[i]) : { pieces: [], failed: false };
      if (newContact.failed || mpArea(newContact.pieces) > 1e-6) return false;
    }
    return clear(candidate) && validate(candidate);
  };
  // The 95% room search ran first. Try 85% before the finalizer's existing
  // 70% lower bound, while keeping the owner's full access contract.
  for (const retained of [0.85, 0.70]) {
    let trials = 0;
    for (const centre of centers) for (const axis of axes) for (const aspect of [1.5, 1, 2, 3]) {
      const v = { x: -axis.y, y: axis.x };
      const halfU = Math.sqrt(oldArea * retained * aspect) / 2;
      const halfV = oldArea * retained / (4 * halfU);
      for (const [du, dv] of offsets) {
        if (++trials > 640) break;
        const cx = centre.x + axis.x * du + v.x * dv;
        const cy = centre.y + axis.y * du + v.y * dv;
        const candidate: Polygon = [
          { x: cx - axis.x * halfU - v.x * halfV, y: cy - axis.y * halfU - v.y * halfV },
          { x: cx + axis.x * halfU - v.x * halfV, y: cy + axis.y * halfU - v.y * halfV },
          { x: cx + axis.x * halfU + v.x * halfV, y: cy + axis.y * halfU + v.y * halfV },
          { x: cx - axis.x * halfU + v.x * halfV, y: cy - axis.y * halfU + v.y * halfV },
        ];
        if (accept(candidate, retained)) return candidate;
      }
    }
  }
  return null;
}
