/**
 * Invariant: settlement streets, roads, tracks, field ways and farm drives never run in sea, lake or river water,
 * except over bridges (and the quays / boardwalks of cultures that build on the water: stilt towns, Venice).
 */
import type { World, Polyline, Vec2 } from '../src/gen/types';
import { seaWithIslands } from '../src/render/util';
import { pointInRing } from '../src/gen/geo/poly';
import { distToPolyline, dist } from '../src/gen/core/geom';

export interface WaterHit { cat: string; water: 'sea' | 'lake' | 'river'; x: number; y: number; len: number }

function ringDist(r: Vec2[], p: Vec2): number { return distToPolyline(p, [...r, r[0]]); }

export function waterViolations(w: World, opts: { tol?: number; riverTol?: number } = {}): { summary: Record<string, number>; samples: WaterHit[] } {
  const t = w.terrain;
  const tol = opts.tol ?? 3;
  const { sea, holes } = seaWithIslands(t.coastline, t.islands);
  const lakes = t.lakes;
  const bridges = w.bridges ?? [];
  const onBridge = (p: Vec2): boolean => bridges.some((b) => {
    const L = dist(b.a, b.b);
    return distToPolyline(p, [b.a, b.b]) < Math.max(8, b.width) && dist(p, { x: (b.a.x + b.b.x) / 2, y: (b.a.y + b.b.y) / 2 }) < L / 2 + 25;
  });
  const inSea = (p: Vec2): boolean => sea.some((r, i) => pointInRing(r, p) && !holes[i].some((h) => pointInRing(h, p)) && ringDist(r, p) > tol && !holes[i].some((h) => ringDist(h, p) <= tol));
  const inLake = (p: Vec2): boolean => lakes.some((r) => r.length >= 3 && pointInRing(r, p) && ringDist(r, p) > tol);
  const riverTol = opts.riverTol ?? 1;
  const inRiver = (p: Vec2): boolean => t.rivers.some((rv) => {
    for (let i = 1; i < rv.path.length; i++) {
      const a = rv.path[i - 1], b = rv.path[i];
      const hw = Math.max(rv.width[i - 1], rv.width[i]) / 2;
      if (hw < 2) continue; // brooks are forded
      if (Math.abs(p.x - a.x) > hw + 60 && Math.abs(p.x - b.x) > hw + 60) continue;
      if (distToPolyline(p, [a, b]) < hw - riverTol) return true;
    }
    return false;
  });
  const summary: Record<string, number> = {};
  const samples: WaterHit[] = [];
  const check = (cat: string, pl: Polyline): void => {
    if (pl.length < 2) return;
    let hit: WaterHit | null = null;
    for (let i = 1; i < pl.length && !hit; i++) {
      const a = pl[i - 1], b = pl[i];
      const L = dist(a, b), n = Math.max(1, Math.ceil(L / 6));
      for (let k = 0; k <= n; k++) {
        const p = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
        const wtr = inSea(p) ? 'sea' : inLake(p) ? 'lake' : inRiver(p) ? 'river' : null;
        if (wtr && !onBridge(p)) { hit = { cat, water: wtr, x: Math.round(p.x), y: Math.round(p.y), len: Math.round(L) }; break; }
      }
    }
    if (hit) { summary[cat + ':' + hit.water] = (summary[cat + ':' + hit.water] ?? 0) + 1; samples.push(hit); }
    summary[cat] = (summary[cat] ?? 0) + 1;
  };
  for (const r of w.roads ?? []) check('road-' + r.kind, r.path);
  const waterTown = (c: string): boolean => /stilt|venice|venetian/.test(c);
  if (w.urban && !waterTown(w.options.culture)) for (const s of w.urban.streets) if (s.role !== 'quay') check('street-main', s.path);
  for (const s of w.settlements ?? []) {
    if (s.main || !s.urban || waterTown(s.culture)) continue;
    for (const st of s.urban.streets) if (st.role !== 'quay') check('street-settl', st.path);
  }
  const lu = w.landuse as (World['landuse'] & { ways?: Polyline[]; headlands?: Polyline[] }) | undefined;
  for (const p of lu?.ways ?? []) check('way', p);
  for (const p of lu?.headlands ?? []) check('headland', p);
  for (const f of lu?.farmsteads ?? []) check('drive', f.drive);
  return { summary, samples };
}
