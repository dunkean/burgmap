/**
 * Landmark lots claimed at level 1 (LandmarkSpec.level1): a large compound sited inside the enclosure before the
 * quarters are split (a palace precinct at the north end of the axis), given a street round it, filled later by its
 * builder. Blocks are too small for such precincts; claiming them first keeps the partition exact.
 */
import type { Vec2, Polygon } from '../core/geom';
import { dist } from '../core/geom';
import type { LandmarkSpec } from './culture';
import type { ReserveApi, ReservedLot } from './primary';
import { Mask, siteLot, gridAround } from './m4/site';
import { giveAccess, phaseAt, type M4State } from './m4/reserve';
import { rectAt } from './m4/lots';
import { mpArea } from '../geo/bool';

export function reserveLevel1(s: M4State, api: ReserveApi, avoid: Polygon[], nucleus: Vec2, lm: LandmarkSpec & { culture: string }, k: number): ReservedLot | null {
  const r = s.rng.fork('l1:' + lm.kind + k);
  const t = Math.max(0, Math.min(1, (s.pop - lm.minPop) / 40000));
  const A = (lm.area[0] + (lm.area[1] - lm.area[0]) * t) * r.range(0.9, 1.1);
  const L = Math.sqrt(A * 1.3), W = A / L;
  const encM = new Mask(s.ctx.mapSize, api.enclosure, 5);
  const encR = Math.sqrt(mpArea(api.enclosure) / Math.PI);
  const north = lm.place === 'axis-north';
  const res = siteLot(s.ctx, api.streets, {
    // (a south-facing precinct: its long side north–south)
    shape: (c, _ang, sc) => (north ? rectAt(c, -Math.PI / 2, -L * sc / 2, L * sc / 2, -W * sc / 2, W * sc / 2) : rectAt(c, _ang, -L * sc / 2, L * sc / 2, -W * sc / 2, W * sc / 2)),
    centers: gridAround(s.ctx, nucleus, encR, 24).filter((c) => (north ? c.y < nucleus.y - 40 : true) && dist(c, nucleus) > Math.sqrt(A) * 0.6 + 30),
    angles: north ? [0] : [0, Math.PI / 4, Math.PI / 2, -Math.PI / 4], scales: [1, 0.85, 0.7], refine: 8,
    within: encM, margin: 5, avoid, gap: 18,
    score: (_poly, c) => (north
      ? -Math.abs(c.x - nucleus.x) / Math.max(60, encR * 0.3) - Math.abs(dist(c, nucleus) - encR * 0.5) / encR + s.ctx.heightAt(c) / 40
      : dist(c, nucleus) / encR),
  }, r);
  if (!res) return null;
  const acc = giveAccess(s, api, res.poly, { mode: 'ring', toward: nucleus, width: s.P.widthByRank[1] * s.P.widthScale, rank: 1, maxLen: 300 }, avoid);
  if (!acc) return null;
  const ph = phaseAt(api, res.c);
  const id = lm.kind + (k ? ':' + k : '');
  return { id, kind: lm.kind, poly: res.poly, phase: ph.phase, zone: ph.zone, cuts: acc.cuts };
}
