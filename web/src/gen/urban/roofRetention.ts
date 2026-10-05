/** Cheap conservative retained-roof broad phase; acceptance still uses checked booleans. */
import type { Polygon } from '../core/geom';
import { convexHull } from '../geo/poly';

/** A convex hull is a superset even for roofs with small concavities. Coordinates can be a local roof frame. */
export function makeHullRectangleOverlap(polygon: Polygon): (x0: number, y0: number, x1: number, y1: number) => number {
  if (!polygon.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return () => Infinity;
  const hull = convexHull(polygon).flatMap((p) => [p.x, p.y]);
  const a: number[] = [], b: number[] = [];
  const scale = Math.max(1, ...polygon.flatMap((p) => [Math.abs(p.x), Math.abs(p.y)]));
  // Deliberately inflate the clipping result. An uncertain upper bound must retain the exact proof.
  const margin = Math.max(1e-9, 256 * Number.EPSILON * scale * scale * (polygon.length + 8));
  return (x0, y0, x1, y1) => {
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return Infinity;
    if (x0 > x1 || y0 > y1 || hull.length < 6) return margin;
    let input = hull;
    for (let plane = 0; plane < 4; plane++) {
      if (!input.length) return margin;
      const axis = plane < 2 ? 0 : 1, sign = plane % 2 ? -1 : 1;
      const threshold = plane === 0 ? x0 : plane === 1 ? x1 : plane === 2 ? y0 : y1;
      const output = plane % 2 ? b : a;
      output.length = 0;
      for (let i = 0, j = input.length - 2; i < input.length; j = i, i += 2) {
        const da = sign * (input[j + axis] - threshold), db = sign * (input[i + axis] - threshold);
        if ((da >= 0) !== (db >= 0)) {
          const t = da / (da - db);
          output.push(axis === 0 ? threshold : input[j] + t * (input[i] - input[j]),
            axis === 1 ? threshold : input[j + 1] + t * (input[i + 1] - input[j + 1]));
        }
        if (db >= 0) output.push(input[i], input[i + 1]);
      }
      input = output;
    }
    if (input.length < 6) return margin;
    // Translate before the shoelace sum to avoid cancellation at distant world coordinates.
    let twiceArea = 0;
    const ox = input[0], oy = input[1];
    for (let i = 2; i + 3 < input.length; i += 2) {
      twiceArea += (input[i] - ox) * (input[i + 3] - oy) - (input[i + 1] - oy) * (input[i + 2] - ox);
    }
    const bound = Math.abs(twiceArea) / 2 + margin;
    return Number.isFinite(bound) ? bound : Infinity;
  };
}
