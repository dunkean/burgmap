/** Local, deterministic recovery of an ordinary room after the final footprint checks. */
import type { Polygon, Vec2 } from '../core/geom';
import { polygonCentroid } from '../core/geom';
import { area, cleanRing, convexHull, isSimple, obb } from '../geo/poly';
import { polyInside } from '../geo/split';
import { mpArea, tryDifference, tryIntersection } from '../geo/bool';

export type RoomClearance = Polygon[] | ((candidate: Polygon) => boolean);
export type RoomValidator = (candidate: Polygon) => boolean;

const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export function reconstructRoom(poly: Polygon, owner: Polygon, occupied: Polygon[], validate: RoomValidator): Polygon | null;
export function reconstructRoom(poly: Polygon, owner: Polygon, occupied: Polygon[], clear: RoomClearance, validate: RoomValidator): Polygon | null;
export function reconstructRoom(poly: Polygon, owner: Polygon, occupied: Polygon[], clearOrValidate: RoomClearance | RoomValidator,
  validateMaybe?: RoomValidator): Polygon | null {
  const clear: RoomClearance = validateMaybe ? clearOrValidate as RoomClearance : [];
  const validate = validateMaybe ?? clearOrValidate as RoomValidator;
  if (poly.length < 3 || owner.length < 3 || !poly.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
  const oldArea = area(poly), originalCenter = polygonCentroid(poly);
  if (!Number.isFinite(oldArea) || oldArea < 12) return null;
  const oldContact = occupied.map((other) => tryIntersection(poly, other));
  if (oldContact.some((hit) => hit.failed)) return null;

  const accept = (candidate0: Polygon): Polygon | null => {
    const candidate = cleanRing(candidate0, 1e-6, 0.0001, 1e-9, false);
    const a = area(candidate);
    if (candidate.length < 3 || !isSimple(candidate) || !Number.isFinite(a)
      || a < 0.95 * oldArea - 1e-6 || a > 1.08 * oldArea + 1e-6
      || distance(polygonCentroid(candidate), originalCenter) > 18 + 1e-6
      || !polyInside(owner, candidate)) return null;
    const escaped = tryDifference(candidate, owner), added = tryDifference(candidate, poly);
    if (escaped.failed || added.failed || mpArea(escaped.pieces) > 1e-6) return null;
    for (let i = 0; i < occupied.length; i++) {
      const contact = tryIntersection(candidate, occupied[i]);
      const newContact = added.pieces.length ? tryIntersection(added.pieces, occupied[i]) : { pieces: [], failed: false };
      if (contact.failed || newContact.failed || mpArea(newContact.pieces) > 1e-6
        || mpArea(contact.pieces) > mpArea(oldContact[i].pieces) + 1e-6) return null;
    }
    if (Array.isArray(clear)) {
      for (const obstacle of clear) {
        const hit = tryIntersection(candidate, obstacle);
        if (hit.failed || mpArea(hit.pieces) > 1e-6) return null;
      }
    } else if (!clear(candidate)) return null;
    return validate(candidate) ? candidate : null;
  };

  // Minimal repairs preserve the original wall language and roof direction.
  const normalized = accept(poly);
  if (normalized) return normalized;
  for (let i = 0; i < poly.length; i++) {
    const shortened = accept(poly.filter((_, j) => j !== i));
    if (shortened) return shortened;
  }
  const hull = accept(convexHull(poly));
  if (hull) return hull;

  // Final ordinary-house fallback: a room of equal area in the original OBB orientation, searched only in-owner.
  const box = obb(poly), originalAspect = Math.max(1, Math.min(3, box.hu / Math.max(0.1, box.hv)));
  let longest = { x: box.u.x, y: box.u.y }, longestLength = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const length = distance(a, b);
    if (length > longestLength) {
      longest = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
      longestLength = length;
    }
  }
  const axes = [box.u, longest];
  const offsets: [number, number][] = [[0, 0]];
  for (const d of [3, 6, 9, 12, 15, 18]) offsets.push([d, 0], [-d, 0], [0, d], [0, -d]);
  // First retain the historical OBB candidate order. Only unresolved rooms
  // need varied wall ratios, a longest-wall axis and diagonal shifts.
  const tryRooms = (axis: Vec2, aspect: number, targetArea: number, positions: [number, number][]): Polygon | null => {
    const v = { x: -axis.y, y: axis.x };
    const halfU = Math.sqrt(targetArea * aspect) / 2, halfV = targetArea / (4 * halfU);
    for (const [du, dv] of positions) {
      const cx = box.c.x + axis.x * du + v.x * dv;
      const cy = box.c.y + axis.y * du + v.y * dv;
      const c: Polygon = [
        { x: cx - axis.x * halfU - v.x * halfV, y: cy - axis.y * halfU - v.y * halfV },
        { x: cx + axis.x * halfU - v.x * halfV, y: cy + axis.y * halfU - v.y * halfV },
        { x: cx + axis.x * halfU + v.x * halfV, y: cy + axis.y * halfU + v.y * halfV },
        { x: cx - axis.x * halfU + v.x * halfV, y: cy - axis.y * halfU + v.y * halfV },
      ];
      const room = accept(c);
      if (room) return room;
    }
    return null;
  };
  const original = tryRooms(box.u, originalAspect, oldArea, offsets);
  if (original) return original;
  const localOffsets: [number, number][] = [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3],
    [6, 0], [-6, 0], [0, 6], [0, -6], [3, 3], [3, -3], [-3, 3], [-3, -3]];
  for (const axis of axes) {
    for (const aspect of [1, 1.5, 2, 3]) {
      for (const size of [1, 0.95]) {
        const room = tryRooms(axis, aspect, oldArea * size, localOffsets);
        if (room) return room;
      }
    }
  }
  return null;
}
