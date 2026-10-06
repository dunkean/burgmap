/** Native-coordinate urban geometry audit. Never round the World before calling this module. */
import type { Polygon } from '../core/geom';
import type { UrbanLayer, World } from '../types';
import { area, bboxOf, inscribed, isSimple } from '../geo/poly';
import { mpArea, tryIntersection } from '../geo/bool';

export interface AuditOverlap {
  layerA: string; layerB: string; kind: 'building' | 'parcel' | 'block' | 'quarter';
  a: number; b: number; relation: string; area: number; thickness: number; failed: boolean;
}
export interface AuditRing { layer: string; building: number; duplicate: boolean; backtrack: boolean; crossing: boolean }
export interface AuditReport { counts: Record<string, number>; overlaps: AuditOverlap[]; malformed: AuditRing[]; failed: number }

function ringFault(p: Polygon): Omit<AuditRing, 'layer' | 'building'> {
  let duplicate = false, backtrack = false;
  for (let i = 0; i < p.length; i++) {
    const a = p[(i - 1 + p.length) % p.length], b = p[i], c = p[(i + 1) % p.length];
    if (Math.hypot(b.x - c.x, b.y - c.y) < 1e-6) duplicate = true;
    const ab = Math.hypot(a.x - b.x, a.y - b.y), bc = Math.hypot(c.x - b.x, c.y - b.y);
    if (ab > 1e-8 && bc > 1e-8) {
      const dot = ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (ab * bc);
      const cross = Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x));
      if (dot < -0.99 && cross < 0.05) backtrack = true;
    }
  }
  return { duplicate, backtrack, crossing: !isSimple(p) };
}

function layersOf(w: World): { id: string; u: UrbanLayer }[] {
  const out: { id: string; u: UrbanLayer }[] = [];
  if (w.urban) out.push({ id: 'main', u: w.urban });
  w.settlements?.forEach((s, i) => { if (!s.main && s.urban && s.urban !== w.urban) out.push({ id: `settlement:${i}`, u: s.urban }); });
  for (const [id, u] of Object.entries(w.megaDetail ?? {})) out.push({ id: `detail:${id}`, u });
  return out;
}

export function auditUrban(world: World): AuditReport {
  const layers = layersOf(world);
  const overlaps: AuditOverlap[] = [], malformed: AuditRing[] = [];
  const counts: Record<string, number> = {};
  type Item = { layer: string; u: UrbanLayer; poly: Polygon; i: number; box: ReturnType<typeof bboxOf> };
  for (const kind of ['building', 'parcel', 'block', 'quarter'] as const) {
    const items: Item[] = [];
    for (const { id, u } of layers) {
      const polys = kind === 'building' ? u.buildings.map((b) => b.poly)
        : kind === 'parcel' ? u.parcels.map((p) => p.poly)
          : kind === 'block' ? u.blocks : u.quarters.map((q) => q.poly.outer);
      counts[`${id}.${kind}`] = polys.length;
      polys.forEach((poly, i) => {
        if (poly.length >= 3) items.push({ layer: id, u, poly, i, box: bboxOf(poly) });
        if (kind === 'building') {
          const faults = ringFault(poly);
          if (faults.duplicate || faults.backtrack || faults.crossing) malformed.push({ layer: id, building: i, ...faults });
        }
      });
    }
    // Local x sweep: a dense block only compares nearby polygons, not the whole town.
    items.sort((a, b) => a.box.x0 - b.box.x0);
    for (let ai = 0; ai < items.length; ai++) {
      const a = items[ai];
      for (let bi = ai + 1; bi < items.length && items[bi].box.x0 < a.box.x1; bi++) {
        const b = items[bi];
        if (b.box.y0 >= a.box.y1 || b.box.y1 <= a.box.y0) continue;
        const hit = tryIntersection(a.poly, b.poly);
        const hitArea = mpArea(hit.pieces);
        if (!hit.failed && hitArea <= 1e-7) continue;
        const thickness = hit.failed ? NaN : Math.max(0, ...hit.pieces.map((p) => 2 * inscribed(p.outer, p.holes, 0.002).r));
        let relation = a.layer !== b.layer ? 'cross-layer' : 'same-layer';
        if (a.layer === b.layer && kind === 'building') {
          const pa = a.u.buildings[a.i].parcel, pb = b.u.buildings[b.i].parcel;
          const ba = pa === undefined ? undefined : a.u.parcels[pa]?.block;
          const bb = pb === undefined ? undefined : b.u.parcels[pb]?.block;
          relation = pa !== undefined && pa === pb ? 'same-parcel' : ba !== undefined && ba === bb ? 'same-block' : 'different-block';
        } else if (a.layer === b.layer && kind === 'parcel') relation = a.u.parcels[a.i].block === b.u.parcels[b.i].block ? 'same-block' : 'different-block';
        overlaps.push({ layerA: a.layer, layerB: b.layer, kind, a: a.i, b: b.i, relation, area: hitArea, thickness, failed: hit.failed });
      }
    }
  }
  return { counts, overlaps, malformed, failed: overlaps.filter((x) => x.failed).length };
}
