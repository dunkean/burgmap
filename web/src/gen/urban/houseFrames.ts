import type { Polygon, Vec2 } from '../core/geom';
import { area, orientPos, distToSeg, distToRing } from '../geo/poly';
import { polyInside } from '../geo/split';
import type { Plot } from './plots';
import { plotDirection } from './plotAxes';

export interface HouseFrame { o: Vec2; t: Vec2; n: Vec2 }

/** Parcel subdivisions retain this frame even when their street frontage is oblique. */
export function housePlotNormal(plot: Plot): Vec2 {
  return plot.axis ? plotDirection(plot.nrm, plot.axis) : plot.nrm;
}

/** Real block borders, distinguished from private parcel cuts. */
export function houseBoundarySides(block: Polygon, poly: Polygon, front: [Vec2, Vec2]): [Vec2, Vec2][] {
  const dx = front[1].x - front[0].x, dy = front[1].y - front[0].y, length = Math.hypot(dx, dy);
  if (length < 1e-6) return [];
  const out: [Vec2, Vec2][] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], ex = b.x - a.x, ey = b.y - a.y, el = Math.hypot(ex, ey);
    if (el < 0.3) continue;
    // Cleaning may combine several almost collinear curve facets. Follow the
    // border chain rather than requiring both ends on one original segment.
    if ([0, 0.25, 0.5, 0.75, 1].every(t => distToRing(block, { x: a.x + ex * t, y: a.y + ey * t }) < 0.02)) out.push([a, b]);
  }
  return out;
}

/** Exterior crops may follow the block; private walls must keep the parcel frame. */
export function needsHouseFrameRepair(poly: Polygon, frame: HouseFrame, borders: [Vec2, Vec2][]): boolean {
  const { t, n } = frame;
  return poly.some((a, i) => {
    const b = poly[(i + 1) % poly.length], dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    if (length < 0.3 || Math.max(Math.abs(dx * t.x + dy * t.y), Math.abs(dx * n.x + dy * n.y)) / length >= Math.cos(Math.PI / 180)) return false;
    return !borders.some(([p, q]) => distToSeg(a, p, q) < 0.02 && distToSeg(b, p, q) < 0.02);
  });
}

/** Shorten or translate a whole room in the parcel frame, without creating tiny steps. */
export function fitParcelRectangle(poly: Polygon, frame: HouseFrame, minWidth = 4.5): Polygon | null {
  const { o, t, n } = frame;
  const points = poly.map(p => ({ x: (p.x - o.x) * t.x + (p.y - o.y) * t.y, y: (p.x - o.x) * n.x + (p.y - o.y) * n.y }));
  const d0 = Math.min(...points.map(p => p.y)), d1 = Math.max(...points.map(p => p.y));
  const at = (x: number, y: number): Vec2 => ({ x: o.x + t.x * x + n.x * y, y: o.y + t.y * x + n.y * y });
  const section = (depth: number): [number, number][] => {
    const xs: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      if ((a.y <= depth && b.y > depth) || (b.y <= depth && a.y > depth)) xs.push(a.x + (b.x - a.x) * (depth - a.y) / (b.y - a.y));
    }
    xs.sort((a, b) => a - b);
    const intervals: [number, number][] = [];
    for (let i = 0; i + 1 < xs.length; i += 2) intervals.push([xs[i], xs[i + 1]]);
    return intervals;
  };
  let best: Polygon | null = null, bestArea = 0;
  const levels = [...new Set([d0, d1, d0 + minWidth, d1 - minWidth,
    ...points.map(p => p.y), ...Array.from({ length: 7 }, (_, i) => d0 + (d1 - d0) * (i + 1) / 8)])]
    .filter(d => d >= d0 && d <= d1).sort((a, b) => a - b);
  for (let i = 0; i < levels.length; i++) for (let j = i + 1; j < levels.length; j++) {
    const lo = levels[i], hi = levels[j], height = hi - lo;
    if (height < minWidth - 1e-6) continue;
    // Check both sides of every vertex event, including concave notches.
    const depths = [lo + 1e-7, hi - 1e-7, ...points.filter(p => p.y > lo + 1e-7 && p.y < hi - 1e-7).flatMap(p => [p.y - 1e-7, p.y + 1e-7])];
    let spans: [number, number][] = [[-Infinity, Infinity]];
    for (const d of depths) {
      const next: [number, number][] = [];
      for (const [a, b] of spans) for (const [c, e] of section(d)) if (Math.min(b, e) > Math.max(a, c)) next.push([Math.max(a, c), Math.min(b, e)]);
      spans = next;
      if (!spans.length) break;
    }
    for (const [x0, end] of spans) {
      const width = Math.min(end - x0, height * 3);
      if (width < minWidth - 1e-6 || height > width * 3 || width * height <= bestArea) continue;
      const shape = orientPos([at(x0, lo), at(x0 + width, lo), at(x0 + width, hi), at(x0, hi)]);
      if (polyInside(poly, shape)) { best = shape; bestArea = width * height; }
    }
  }
  return bestArea >= 0.35 * area(poly) ? best : null;
}
