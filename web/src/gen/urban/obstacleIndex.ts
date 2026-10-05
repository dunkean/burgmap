/** Exact pre-conversion selection for an immutable checked-boolean obstacle operand. */
import type { Polygon } from '../core/geom';
import type { MultiPoly } from '../geo/bool';
import { bboxOf } from '../geo/poly';
import { PolygonIndex } from './polygonIndex';

export function makeObstacleSelection(obstacles: MultiPoly): (subject: Polygon | MultiPoly) => MultiPoly {
  const usable = obstacles.filter((p) => p.outer.length >= 3);
  // Invalid converted rings must still reach the checked engine's fail-closed path.
  // Inspect once before using any spatial bounds; sub-three-point holes are not converted.
  if (usable.some((piece) => [piece.outer, ...piece.holes.filter((ring) => ring.length >= 3)]
    .some((ring) => ring.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))))) return () => obstacles;
  // bool.run filters only operands with more than one converted polygon.
  if (usable.length <= 1) return () => obstacles;
  const index = new PolygonIndex(usable.map((p) => p.outer));
  return (subject) => {
    const polygons = subject.length && 'x' in subject[0] ? [subject as Polygon] : (subject as MultiPoly).map((p) => p.outer);
    const points = polygons.filter((p) => p.length >= 3).flat();
    if (!points.length || !points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return obstacles;
    const near = index.queryBounds(bboxOf(points), true, 1e-6).map((i) => usable[i]);
    // A nonempty original operand makes difference run the engine even if its later
    // box filter removes everything. Preserve that normalization/failure path: these
    // two original distant polygons are discarded by that same filter, in its order.
    return near.length ? near : usable.slice(0, 2);
  };
}
