/**
 * Exact union of two adjacent polygons that share one boundary chain (pieces of the same partition), without a
 * general boolean: T-vertices of each ring lying on the other's edges are inserted, the shared chain is found by
 * matching vertices, and the two remaining chains are concatenated. Returns null when the pieces do not share
 * exactly one contiguous chain (callers then fall back to a boolean union).
 */
import type { Vec2, Polygon } from '../core/geom';
import { polygonArea } from '../core/geom';
import { isSimple } from './poly';

const TOL = 0.01;

function withTVertices(A: Polygon, B: Polygon): Polygon {
  const out: Vec2[] = [];
  const n = A.length;
  for (let i = 0; i < n; i++) {
    const a = A[i], b = A[(i + 1) % n];
    out.push(a);
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    if (l2 < 1e-12) continue;
    const ins: { t: number; p: Vec2 }[] = [];
    for (const q of B) {
      const t = ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2;
      if (t <= 1e-9 || t >= 1 - 1e-9) continue;
      const px = a.x + t * dx, py = a.y + t * dy;
      if (Math.hypot(q.x - px, q.y - py) > TOL) continue;
      if (Math.hypot(q.x - a.x, q.y - a.y) < TOL || Math.hypot(q.x - b.x, q.y - b.y) < TOL) continue;
      ins.push({ t, p: q });
    }
    ins.sort((u, v) => u.t - v.t);
    for (const it of ins) out.push(it.p);
  }
  return out;
}

export function stitchUnion(A0: Polygon, B0: Polygon): Polygon | null {
  const A = withTVertices(A0, B0), B = withTVertices(B0, A0);
  const n = A.length, m = B.length;
  const match = (p: Vec2): number => {
    for (let j = 0; j < m; j++) if (Math.abs(B[j].x - p.x) < TOL && Math.abs(B[j].y - p.y) < TOL) return j;
    return -1;
  };
  const mi = A.map(match);
  // shared edge i: A[i]→A[i+1] runs along B reversed (B[j+1]→B[j])
  const sharedE = A.map((_, i) => {
    const j0 = mi[i], j1 = mi[(i + 1) % n];
    return j0 >= 0 && j1 >= 0 && (j1 + 1) % m === j0;
  });
  const cnt = sharedE.filter(Boolean).length;
  if (!cnt || cnt >= n) return null;
  // exactly one contiguous run of shared edges
  let runs = 0;
  for (let i = 0; i < n; i++) if (sharedE[i] && !sharedE[(i - 1 + n) % n]) runs++;
  if (runs !== 1) return null;
  let s = 0;
  while (!(sharedE[s] && !sharedE[(s - 1 + n) % n])) s++;
  let e = s;
  while (sharedE[e % n]) e++;
  e %= n; // A[s] … A[e] is the shared chain (vertices)
  const ring: Vec2[] = [];
  for (let k = e; ; k = (k + 1) % n) { ring.push(A[k]); if (k === s) break; }
  // B: from match(A[s]) forward to match(A[e]), exclusive of both ends
  const js = mi[s], je = mi[e];
  for (let k = (js + 1) % m; k !== je; k = (k + 1) % m) ring.push(B[k]);
  if (ring.length < 3) return null;
  const aU = polygonArea(ring), aA = polygonArea(A0), aB = polygonArea(B0);
  if (Math.abs(aU - (aA + aB)) > 0.02 + 1e-6 * (aA + aB) || !isSimple(ring)) return null;
  return ring;
}
