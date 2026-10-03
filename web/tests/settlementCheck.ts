/** Invariants of a settlement system (M3c): reachability by road, extents, spacing. */
import type { World, Settlement, Polygon } from '../src/gen/types';
import { distToPolyline, dist } from '../src/gen/core/geom';
import { intersection } from '../src/gen/geo/bool';
import { pairSpacing } from '../src/gen/settlements/planner';

/** Indices of settlements not connected to the main settlement through the road network. */
export function unreachable(w: World): number[] {
  const roads = w.roads ?? [];
  const S = w.settlements ?? [];
  const tolJ = 4;
  const tolS = Math.max(25, 2.5 * w.terrain.height.cell);
  // road graph: two roads touch when an end of one lies on the other (junction) or their ends meet
  const adj: number[][] = roads.map(() => []);
  for (let i = 0; i < roads.length; i++) {
    const a = roads[i].path;
    for (let j = 0; j < roads.length; j++) {
      if (i === j) continue;
      const b = roads[j].path;
      if (distToPolyline(a[0], b) < tolJ || distToPolyline(a[a.length - 1], b) < tolJ) { adj[i].push(j); adj[j].push(i); }
    }
  }
  const at = S.map((s) => roads.map((r, i) => (distToPolyline(s.center, r.path) < Math.max(tolS, s.main ? s.radius : 0) ? i : -1)).filter((i) => i >= 0));
  const seen = new Uint8Array(roads.length);
  const stack = [...at[0]];
  for (const i of stack) seen[i] = 1;
  while (stack.length) { const i = stack.pop()!; for (const j of adj[i]) if (!seen[j]) { seen[j] = 1; stack.push(j); } }
  const out: number[] = [];
  for (let k = 1; k < S.length; k++) if (!at[k].some((i) => seen[i])) out.push(k);
  return out;
}

const outlines = (s: Settlement, w: World): Polygon[] => {
  if (s.main) return (w.urban?.footprintH ?? []).map((ph) => ph.outer);
  if (s.urban?.footprintH.length) return s.urban.footprintH.map((ph) => ph.outer);
  return s.extent.length >= 3 ? [s.extent] : [];
};

/** Pairs of settlements whose built extents overlap (footprints when generated, projected extents otherwise). */
export function overlaps(w: World): [number, number][] {
  const S = w.settlements ?? [];
  const out: [number, number][] = [];
  for (let a = 0; a < S.length; a++) for (let b = a + 1; b < S.length; b++) {
    if (S[a].detail === 'farmstead' || S[b].detail === 'farmstead') {
      if (dist(S[a].center, S[b].center) < S[a].radius + S[b].radius) out.push([a, b]);
      continue;
    }
    const A = outlines(S[a], w), B = outlines(S[b], w);
    if (!A.length || !B.length) continue;
    let hit = false;
    for (const pa of A) { for (const pb of B) { if (intersection(pa, pb).some((ph) => Math.abs(area(ph.outer)) > 1)) { hit = true; break; } } if (hit) break; }
    if (hit) out.push([a, b]);
  }
  return out;
}
function area(p: Polygon): number { let s = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += (p[j].x + p[i].x) * (p[j].y - p[i].y); return s / 2; }

/** Pairs of secondary settlements closer than the central-place spacing (times `relax`). */
export function spacingViolations(w: World, relax = 1): [number, number, number, number][] {
  const S = (w.settlements ?? []);
  const out: [number, number, number, number][] = [];
  for (let a = 1; a < S.length; a++) for (let b = a + 1; b < S.length; b++) {
    const d = dist(S[a].center, S[b].center), need = relax * pairSpacing(S[a].population, S[b].population);
    if (d < need - 1e-6) out.push([a, b, Math.round(d), Math.round(need)]);
  }
  return out;
}
