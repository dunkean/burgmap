import type { Polygon, Vec2 } from '../../core/geom';
import { dist } from '../../core/geom';
import { area, distToRing, isSimple, pointInRing } from '../../geo/poly';
import { mpArea, tryDifference, type MultiPoly } from '../../geo/bool';
import type { LPoly } from '../../geo/split';
import type { StreetGraph, GEdge } from '../../geo/graph';
import type { NucleusSpec } from '../culture';
import { shapePolygon } from '../phases';
import { clipMarketToLand } from '../primary';
import { LAB_WATER } from '../streets';

/** Road fans can have all their approach samples on one side of the actual nucleus. */
export function centredMegaNucleus(candidate: Polygon, center: Vec2, core: MultiPoly, water: MultiPoly, target: number, spec: NucleusSpec, angle: number): { poly: Polygon; available: boolean } {
  // Keep the established geometry and random sequence for a healthy road fan.
  if (pointInRing(candidate, center)) return { poly: candidate, available: true };
  const shape = spec.shape === 'hull' ? 'circle' : spec.shape;
  // Three deterministic attempts, each fitted to the actual dry core before any streets are inserted.
  for (const scale of [1, 0.7, 0.45]) {
    const targetArea = target * scale;
    const figure = shapePolygon(shape, center, angle, targetArea, shape === 'rect' ? 1.3 : 1);
    const poly = clipMarketToLand(figure, core, water, targetArea);
    if (poly && isSimple(poly) && pointInRing(poly, center)) return { poly, available: true };
  }
  // An unavailable programme is reported by the caller; never claim a neighbouring residential face instead.
  return { poly: candidate, available: false };
}

/** Graph vertices and Boolean intersections each round to centimetres. */
const SUBJECT_BOUND = Math.SQRT2 * 0.01 + 1e-9;

/** Terminal graph cleanup: a near-corner T-junction can duplicate a piece of the repaired market ring. */
export function coalesceMegaNucleusEdges(g: StreetGraph, marketId: number): number {
  const key = (e: GEdge): string => {
    const points = e.pts.map((p) => [p.x, p.y]);
    const forward = JSON.stringify(points), reverse = JSON.stringify(points.slice().reverse());
    // Geometric aliases with different node ids do not prove a shared topological edge.
    return `${Math.min(e.a, e.b)}:${Math.max(e.a, e.b)}:${forward < reverse ? forward : reverse}`;
  };
  const market = new Map<string, number>();
  for (const e of g.edges) if (e.alive && e.street === marketId) {
    const k = key(e);
    if (!market.has(k)) market.set(k, e.id);
  }
  const removed = new Set<number>(), touched = new Set<number>();
  for (const e of g.edges) {
    if (!e.alive) continue;
    const keep = market.get(key(e));
    if (keep === undefined || e.id === keep) continue;
    e.alive = false;
    removed.add(e.id); touched.add(e.a); touched.add(e.b);
  }
  for (const id of touched) g.nodes[id].edges = g.nodes[id].edges.filter((e) => !removed.has(e));
  // No coordinates, ids, street paths or spatial indexes are rewritten. Call only after all insertions.
  return removed.size;
}

/** Select one real reserved face, keeping its identity when the water clip adds bank edges. */
export function megaNucleusFace(cells: LPoly[], subject: Polygon, label: number, center: Vec2, available = true): LPoly | undefined {
  if (!available) return undefined;
  const old = cells.find((f) => f.lab.every((l) => l === label) && pointInRing(f.pts, center));
  if (old) return old;
  let best: LPoly | undefined, bestArea = -Infinity, bestContains = false;
  for (const f of cells) {
    if (!f.lab.includes(label) || !f.lab.every((l) => l === label || l === LAB_WATER)) continue;
    const frontage = f.pts.reduce((sum, p, i) => sum + (f.lab[i] === label ? dist(p, f.pts[(i + 1) % f.pts.length]) : 0), 0);
    if (frontage < 3) continue;
    const inside = (p: Vec2) => pointInRing(subject, p) || distToRing(subject, p) <= SUBJECT_BOUND;
    if (!f.pts.every((p, i) => {
      const q = f.pts[(i + 1) % f.pts.length];
      return inside(p) && inside({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
    })) continue;
    const outside = tryDifference(f.pts, subject);
    const perimeter = f.pts.reduce((sum, p, i) => sum + dist(p, f.pts[(i + 1) % f.pts.length]), 0);
    if (outside.failed || mpArea(outside.pieces) > perimeter * SUBJECT_BOUND) continue;
    const A = area(f.pts), contains = pointInRing(f.pts, center);
    if (A < 150) continue;
    if ((contains && !bestContains) || (contains === bestContains && A > bestArea)) {
      best = f; bestArea = A; bestContains = contains;
    }
  }
  return best;
}
