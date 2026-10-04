/** World-anchored furrow direction and spacing shared by SVG patterns and Canvas paths. */
import type { Polygon, Polyline } from '../gen/types';
import { bboxOf } from '../gen/geo/poly';

export const furrowDegrees = (angle: number): number => Math.round(angle * 180 / Math.PI) % 180;
const rawSpacing = (mapSize: number): number => Math.max(2.4, 1.5 * mapSize / 1600);
// Match the SVG pattern's existing tenth-meter serialization, including its independently rounded offset.
export const furrowSpacing = (mapSize: number): number => Math.round(rawSpacing(mapSize) * 10) / 10;
export const furrowOffset = (mapSize: number): number => Math.round(rawSpacing(mapSize) * 5) / 10;

/** Lines cover the holder's bounds; the renderer clips them to its actual strips and holes. */
export function furrowLines(poly: Polygon, mapSize: number, angle: number): Polyline[] {
  if (poly.length < 3 || !Number.isFinite(angle)) return [];
  const box = bboxOf(poly), theta = furrowDegrees(angle) * Math.PI / 180;
  const dx = Math.cos(theta), dy = Math.sin(theta), nx = -dy, ny = dx;
  const corners = [{ x: box.x0, y: box.y0 }, { x: box.x1, y: box.y0 }, { x: box.x1, y: box.y1 }, { x: box.x0, y: box.y1 }];
  const along = corners.map((p) => p.x * dx + p.y * dy), across = corners.map((p) => p.x * nx + p.y * ny);
  const lo = Math.min(...along), hi = Math.max(...along), sp = furrowSpacing(mapSize), offset = furrowOffset(mapSize);
  const first = Math.ceil((Math.min(...across) - offset) / sp), last = Math.floor((Math.max(...across) - offset) / sp);
  const out: Polyline[] = [];
  for (let i = first; i <= last; i++) {
    const n = i * sp + offset;
    out.push([{ x: dx * lo + nx * n, y: dy * lo + ny * n }, { x: dx * hi + nx * n, y: dy * hi + ny * n }]);
  }
  return out;
}
