/** Ordered conservative broad phase for an urban pass that replaces polygon references. */
import type { Polygon } from '../core/geom';
import { bboxOf } from '../geo/poly';
import { GridIndex } from '../geo/spatial';

type Bounds = ReturnType<typeof bboxOf>;
export const boundsMeet = (a: Bounds, b: Bounds): boolean =>
  !(a.x0 >= b.x1 || b.x0 >= a.x1 || a.y0 >= b.y1 || b.y0 >= a.y1);

export class PolygonIndex {
  private readonly grid = new GridIndex<number>(64);
  private readonly large = new Set<number>();
  private readonly boxes: Bounds[] = [];
  constructor(polygons: Polygon[]) { polygons.forEach((p, i) => this.set(i, p)); }
  /** Old buckets remain conservative; an accepted replacement adds its new bounds. */
  set(index: number, polygon: Polygon): void {
    const b = bboxOf(polygon); this.boxes[index] = b;
    const cells = (Math.floor(b.x1 / 64) - Math.floor(b.x0 / 64) + 1)
      * (Math.floor(b.y1 / 64) - Math.floor(b.y0 / 64) + 1);
    // Wide waterways/quarter envelopes must not allocate a map-sized grid of buckets.
    if (!Number.isFinite(cells) || cells > 256) this.large.add(index);
    else this.grid.insertBox(b.x0, b.y0, b.x1, b.y1, index);
  }
  query(polygon: Polygon, touching = false): number[] {
    return this.queryBounds(bboxOf(polygon), touching);
  }
  queryBounds(b: Bounds, touching = false, margin = 0): number[] {
    const candidates = new Set(this.grid.query(b.x0 - margin, b.y0 - margin, b.x1 + margin, b.y1 + margin));
    for (const i of this.large) candidates.add(i);
    // Preserve the original full-array predicate/boolean order, including numeric contact strictness.
    return [...candidates].filter((i) => touching ? !(this.boxes[i].x0 > b.x1 + margin || this.boxes[i].x1 < b.x0 - margin
      || this.boxes[i].y0 > b.y1 + margin || this.boxes[i].y1 < b.y0 - margin) : boundsMeet(b, this.boxes[i])).sort((a, z) => a - z);
  }
}
