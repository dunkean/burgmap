import type { Polygon } from '../core/geom';
import { dist } from '../core/geom';
import { area, interiorAngle, isSimple, orientPos } from '../geo/poly';
import { mpArea, tryDifference } from '../geo/bool';
import { MAX_ASPECT, MIN_BW, shapeOf } from './buildings';

const MIN_ANGLE = 12 * Math.PI / 180;

/** Bevel the tiny convex tips left where a Persian courtyard/passage cut meets an oblique lot wall.
 * Keep the house and all its metadata: only remove local corner triangles, never grow into a court or a lane.
 * At most 50 cm along either adjacent edge, and at most a quarter of its length, so neighbouring bevels
 * cannot consume their shared edge. A failed geometry proof returns the complete original footprint.
 */
export function chamferPersianHouse(poly: Polygon): Polygon {
  const ring = orientPos(poly);
  const acute = ring.map((_, i) => interiorAngle(ring, i) < MIN_ANGLE);
  const count = acute.filter(Boolean).length;
  if (!count || !isSimple(ring)) return poly;
  const result: Polygon = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    if (!acute[i]) { result.push(p); continue; }
    const a = ring[(i + ring.length - 1) % ring.length], b = ring[(i + 1) % ring.length];
    const la = dist(a, p), lb = dist(b, p), setback = Math.min(0.5, 0.25 * la, 0.25 * lb);
    if (setback < 1e-6) return poly;
    result.push({ x: p.x + (a.x - p.x) * setback / la, y: p.y + (a.y - p.y) * setback / la });
    result.push({ x: p.x + (b.x - p.x) * setback / lb, y: p.y + (b.y - p.y) * setback / lb });
  }
  if (!isSimple(result) || result.some((_, i) => interiorAngle(result, i) < MIN_ANGLE)) return poly;
  const loss = area(poly) - area(result), shape = shapeOf(result);
  // Triangle area = .5 * setback² * sin(angle), with setback <= .5 m and angle < 12°.
  if (loss < -1e-6 || loss > count * 0.125 * Math.sin(MIN_ANGLE) + 1e-6 || shape.w < MIN_BW || shape.asp > MAX_ASPECT) return poly;
  const outside = tryDifference(result, poly);
  return outside.failed || mpArea(outside.pieces) > 1e-6 ? poly : result;
}
