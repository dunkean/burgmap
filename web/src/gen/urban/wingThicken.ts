/** Preserve a whole narrow roof by filling only unused land inside its own plot. */
import type { Polygon } from '../core/geom';
import { area, inscribed, isSimple, minNeck, obb } from '../geo/poly';
import { lpoly, splitByChord } from '../geo/split';
import { mpArea, tryDifference, tryIntersection, union } from '../geo/bool';

/** The caller validates physical reserve, other owners, open land and whole-block access. */
export function thickenNarrowWing(poly: Polygon, owner: Polygon, occupied: Polygon[],
  validate: (candidate: Polygon) => boolean): Polygon | null {
  const originalArea = area(poly);
  if (poly.length < 3 || owner.length < 3 || !isSimple(poly) || !Number.isFinite(originalArea) || originalArea < 12) return null;
  let source = poly;
  let wing: Polygon | null = null;
  for (let pass = 0; pass < 3; pass++) {
    const neck = minNeck(source);
    if (!neck || neck.w >= 3.59) break;
    const cut = splitByChord(lpoly(source, 0), [neck.a, neck.b], 0, 0.02);
    if (!cut) break;
    const parts = cut.map(p => p.pts).sort((a, b) => area(b) - area(a));
    if (Math.abs(area(parts[0]) + area(parts[1]) - area(source)) > 1e-5) break;
    if (area(parts[1]) >= 12 && area(parts[1]) <= 0.15 * originalArea) { wing = parts[1]; break; }
    if (area(parts[1]) > 1) break;
    source = parts[0];
  }
  if (!wing) return null;
  const edges = wing.map((a, i) => ({ a, b: wing![(i + 1) % wing!.length], i }))
    .map(e => ({ ...e, length: Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y) }))
    .filter(e => e.length >= 5).sort((a, b) => b.length - a.length);
  let trials = 0;
  for (const edge of edges) for (const side of [-1, 1]) for (const depth of [2, 2.5, 3, 3.5, 3.6, 4])
    for (const cap of [0, 0.5, 1, 1.5, 2, 2.5, 3, 4]) {
      if (++trials > 400) return null;
      const t = { x: (edge.b.x - edge.a.x) / edge.length, y: (edge.b.y - edge.a.y) / edge.length };
      const n = { x: side * t.y, y: -side * t.x };
      const a = { x: edge.a.x - t.x * cap, y: edge.a.y - t.y * cap };
      const b = { x: edge.b.x + t.x * cap, y: edge.b.y + t.y * cap };
      const slab: Polygon = [a, b, { x: b.x + n.x * depth, y: b.y + n.y * depth },
        { x: a.x + n.x * depth, y: a.y + n.y * depth }];
      const joined = union(poly, slab);
      if (joined.length !== 1 || joined[0].holes.length) continue;
      const candidate = joined[0].outer;
      if (!isSimple(candidate)) continue;
      const neck = minNeck(candidate), box = obb(candidate);
      if ((neck?.w ?? Infinity) < 3.59 || 2 * inscribed(candidate, [], 0.05, 1.8).r < 3.6
        || 2 * box.hv < 4.45 || box.hu / Math.max(1e-6, box.hv) > 3) continue;
      const added = tryDifference(candidate, poly), lost = tryDifference(poly, candidate);
      if (added.failed || lost.failed || mpArea(lost.pieces) > 1e-6
        || mpArea(added.pieces) < 1e-6 || mpArea(added.pieces) > 0.1 * originalArea
        || Math.abs(area(candidate) - originalArea - mpArea(added.pieces)) > 1e-5) continue;
      const escaped = tryDifference(added.pieces, owner);
      if (escaped.failed || mpArea(escaped.pieces) > 1e-6) continue;
      if (occupied.some((other) => {
        const blocked = tryIntersection(added.pieces, other);
        return blocked.failed || mpArea(blocked.pieces) > 1e-6;
      })) continue;
      if (validate(candidate)) return candidate;
    }
  return null;
}
