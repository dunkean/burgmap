import type { Polygon, Vec2 } from '../../core/geom';
import type { StreetGraph } from '../../geo/graph';
import { distToSeg, snapPt } from '../../geo/poly';
import type { MacroStreet } from './types';

const key = (p: Vec2): string => p.x + ',' + p.y;
const project = (p: Vec2, a: Vec2, b: Vec2): Vec2 => {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
};

/**
 * Finish the macro graph on its original outer supports before extracting any faces. A centimetre-rounded
 * intersection can move its parent edge; recursively splitting that edge accumulates the rounding error.
 * Only ring segments originally on the outer boundary are eligible, within the graph's 5 cm crossing radius.
 * Correct every occurrence of a shared coordinate together, keeping edge ids, incidence and street labels.
 * Terminal operation: the graph's spatial indices are not rebuilt; do not insert/query it afterwards.
 */
export function restoreMacroBoundary(graph: StreetGraph, outer: Polygon, streets: readonly MacroStreet[]): void {
  const sources = new Map<number, { a: Vec2; b: Vec2; outer: boolean }[]>();
  const corners = new Map(outer.map((p) => [key(snapPt(p)), p]));
  streets.forEach((street, id) => {
    if (street.role !== 'boundary' && street.role !== 'ring' && street.role !== 'wall-lane') return;
    const segments = street.path.slice(1).map((b, i) => {
      const a = street.path[i];
      const onOuter = outer.some((c, j) => distToSeg(a, c, outer[(j + 1) % outer.length]) < 1e-7 &&
        distToSeg(b, c, outer[(j + 1) % outer.length]) < 1e-7);
      return { a, b, outer: onOuter };
    });
    if (segments.some((s) => s.outer)) sources.set(id, segments);
  });
  const corrected = new Map<string, Vec2>();
  for (const edge of graph.edges) {
    if (!edge.alive) continue;
    const segments = sources.get(edge.street);
    if (!segments) continue;
    for (const p of edge.pts) {
      const k = key(p);
      if (corrected.has(k)) continue;
      const corner = corners.get(k);
      if (corner && segments.some((s) => s.outer && distToSeg(corner, s.a, s.b) < 1e-7)) {
        corrected.set(k, { ...corner });
        continue;
      }
      // Include non-boundary source segments in the nearest test: a nearby inner ring is not an outer edge.
      let nearest: typeof segments[number] | undefined, distance = 0.05;
      for (const segment of segments) {
        const d = distToSeg(p, segment.a, segment.b);
        if (d < distance) { distance = d; nearest = segment; }
      }
      if (!nearest?.outer) continue;
      corrected.set(k, project(p, nearest.a, nearest.b));
    }
  }
  if (!corrected.size) return;
  for (const node of graph.nodes) node.p = corrected.get(key(node.p)) ?? node.p;
  for (const edge of graph.edges) if (edge.alive) edge.pts = edge.pts.map((p) => corrected.get(key(p)) ?? p);
}
