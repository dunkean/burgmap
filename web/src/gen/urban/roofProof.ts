/** Conservative convex proofs. Ambiguous geometry keeps the checked Boolean path. */
import type { Polygon } from '../core/geom';
import { area, isSimple, orientPos } from '../geo/poly';
import { isConvex } from '../geo/split';

interface ConvexShape { points: Polygon; coordinates: Float64Array }
const shapes = new WeakMap<Polygon, ConvexShape | null>();
const same = (p: Polygon, values: Float64Array): boolean => values.length === p.length * 2
  && p.every((q, i) => q.x === values[i * 2] && q.y === values[i * 2 + 1]);

function convexShape(poly: Polygon): ConvexShape | null {
  const old = shapes.get(poly);
  if (old && same(poly, old.coordinates)) return old;
  // A failed shape is not memoized: callers may edit a polygon in place.
  const points = orientPos(poly);
  if (points.length < 3 || !points.every((p) => Number.isFinite(p.x + p.y))
    || area(points) <= 0 || !isConvex(points, 0) || !isSimple(points)) return null;
  const shape = { points, coordinates: new Float64Array(poly.flatMap((p) => [p.x, p.y])) };
  shapes.set(poly, shape); return shape;
}

/** Necessary center constraints for a whole rectangle in a truly convex owner, with the legacy 1 cm slack. */
export function convexCenterDomain(us: number[], ds: number[], owner: Polygon, width: number, depth: number, cu: number, cd: number): { possible: boolean; allows: (u: number, d: number) => boolean } | null {
  if (!convexShape(owner) || us.length !== ds.length || us.length !== owner.length
    || ![...us, ...ds, width, depth, cu, cd].every(Number.isFinite)) return null;
  let winding = 0;
  for (let i = 1; i + 1 < us.length; i++) winding += (us[i] - us[0]) * (ds[i + 1] - ds[0])
    - (ds[i] - ds[0]) * (us[i + 1] - us[0]);
  if (!(winding > 0)) return null;
  const scale = Math.max(1, ...owner.flatMap((p) => [Math.abs(p.x), Math.abs(p.y)]));
  const margin = 0.010002 + 1024 * Number.EPSILON * scale;
  const planes = us.flatMap((u, i) => {
    const j = (i + 1) % us.length, du = us[j] - u, dd = ds[j] - ds[i], length = Math.hypot(du, dd);
    if (length < 1e-8) return [];
    const nu = -dd / length, nd = du / length;
    return [{ nu, nd, k: nu * u + nd * ds[i] + Math.abs(nu) * width / 2 + Math.abs(nd) * depth / 2 - margin }];
  });
  if (planes.some((p) => ![p.nu, p.nd, p.k].every(Number.isFinite))) return null;
  // Intersect the relaxed supports in center space. Empty domains skip every line-pair proposal
  // for this size. The 0.1 mm enlarged movement square also keeps boundary-rounding uncertainty.
  let domain: Polygon = [
    { x: cu - 8.0001, y: cd - 8.0001 }, { x: cu + 8.0001, y: cd - 8.0001 },
    { x: cu + 8.0001, y: cd + 8.0001 }, { x: cu - 8.0001, y: cd + 8.0001 },
  ];
  for (const plane of planes) {
    const next: Polygon = [];
    for (let i = 0; i < domain.length; i++) {
      const a = domain[i], b = domain[(i + 1) % domain.length];
      const da = plane.nu * a.x + plane.nd * a.y - plane.k;
      const db = plane.nu * b.x + plane.nd * b.y - plane.k;
      if (!Number.isFinite(da) || !Number.isFinite(db)) return null;
      if (da >= 0) next.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        const p = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
        if (!Number.isFinite(t) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
        next.push(p);
      }
    }
    domain = next;
    if (!domain.length) return { possible: false, allows: () => false };
  }
  return { possible: true, allows: (u, d) => planes.every((p) => p.nu * u + p.nd * d >= p.k) };
}
