/**
 * Level-1 reservation of the M4 landmark lots (URBAN_LANDMARKS.md §1): called by buildPrimary once the radials,
 * rings and market are registered and before the quarters are formed. Each lot is sited by its score function,
 * given its access street (front or ring) and a connector to the network, and returned as an exact piece.
 */
import type { Vec2, Polygon, Polyline } from '../../core/geom';
import { dist, polygonCentroid } from '../../core/geom';
import type { Rng } from '../../core/rng';
import type { UrbanCtx } from '../context';
import type { ReserveApi, ReservedLot } from '../primary';
import type { Zone, MorphologyParams } from '../morphology';
import type { UrbanSite } from '../../types';
import type { Streets } from '../streets';
import { pointInRing, distToRing, orientPos } from '../../geo/poly';
import { edgeRuns, findConnectorX, inMP, nearestOnPl, insertAt, plLen } from './lots';
import type { CastlePlan } from './castle';

/** Debug hook (scripts): receives a message when a lot cannot be given access. */
export const M4_DBG: { log: ((s: string) => void) | null } = { log: null };

export interface M4State {
  ctx: UrbanCtx;
  rng: Rng;
  pop: number;
  P: MorphologyParams;
  /** Builder data per lot id. */
  lotData: Map<string, unknown>;
  sites: UrbanSite[];
  culture: string;
  /** Width of the lists of a double enceinte (0 = none): outside lots keep clear of the outer wall. */
  listsW?: number;
  /** Stone quay edges planned by the port. */
  quays?: Polyline[];
}

export interface Access {
  /** Lot edges that get a street (`front`), all edges (`ring`) or none (connector only). */
  mode: 'front' | 'ring' | 'none';
  /** Edge predicate for `front` mode. */
  front?: (a: Vec2, b: Vec2) => boolean;
  /** Entrance target: the access point is the lot boundary point nearest to it. */
  toward: Vec2;
  width: number;
  rank: number;
  /** Connector width / rank (approach street). */
  cWidth?: number;
  cRank?: number;
  maxLen?: number;
  /** Preferred connector directions. */
  dirs?: Vec2[];
}

/** Phase and zone of the band holding p (outermost phase last; faubourg beyond). */
export function phaseAt(api: ReserveApi, p: Vec2): { phase: number; zone: Zone } {
  for (const ph of api.phases) if (inMP(ph.region, p)) return { phase: ph.id, zone: ph.zone };
  return { phase: api.phases.length + 1, zone: 'faubourg' };
}

/**
 * Gives a lot its street access: a street along its front edges (or all round it) and a connector from the
 * entrance to the connected network. Returns the cuts (connectors), the entrance point, or null if no connection.
 */
export function giveAccess(s: M4State, api: ReserveApi, lot: Polygon, a: Access, avoid: Polygon[]): { cuts: Polyline[]; entrance: Vec2; streets: number[] } | null {
  const streets = api.streets;
  const ids: number[] = [];
  let entrance: Vec2 | null = null;
  let chain: Polyline | null = null;
  if (a.mode !== 'none') {
    const runs = edgeRuns(orientPos(lot), a.mode === 'ring' ? () => true : (p, q) => a.front!(p, q));
    // the run nearest the entrance target
    let best: { pl: Polyline; closed: boolean } | null = null, bd = Infinity;
    for (const r of runs) {
      if (!r.closed && plLen(r.pl) < 12) continue;
      const d = nearestOnPl(r.pl, a.toward).d;
      if (d < bd) { bd = d; best = r; }
    }
    if (best) {
      const nr = nearestOnPl(best.pl, a.toward);
      const ins = insertAt(best.pl, nr.q, nr.i);
      chain = ins.pl;
      entrance = chain[ins.k];
    }
  }
  if (!entrance) {
    const P = orientPos(lot);
    let bd = Infinity;
    for (let i = 0; i < P.length; i++) {
      const n = nearestOnPl([P[i], P[(i + 1) % P.length]], a.toward);
      if (n.d < bd) { bd = n.d; entrance = n.q; }
    }
  }
  if (!entrance) return null;
  // the connector (unless the entrance already lies on a connected street)
  const onNet = streets.nearest(entrance, 0.6, (st) => streets.connected.has(st.id));
  let conn: Polyline | null = null;
  let met: number[] = [];
  if (!onNet) {
    const r = findConnectorX(s.ctx, streets, entrance, { avoid: [lot, ...avoid], noCross: api.enclosure.map((ph) => ph.outer), gates: api.gates, maxLen: a.maxLen ?? 260, preferRank: 1, dirs: a.dirs });
    if (!r) { M4_DBG.log?.(`no connector from ${entrance.x.toFixed(0)},${entrance.y.toFixed(0)} (mode ${a.mode}, chain ${chain?.length ?? 0})`); return null; }
    conn = r.path; met = r.met;
  }
  if (chain) {
    const id = streets.add(chain, a.width, a.rank, a.mode === 'ring' ? 'ring' : 'street', 1);
    streets.connected.add(id);
    ids.push(id);
  }
  const cuts: Polyline[] = [];
  if (conn) {
    const id = streets.add(conn, a.cWidth ?? a.width, a.cRank ?? a.rank, 'street', 1);
    streets.connected.add(id);
    // the streets crossed or met by the connector join the network
    for (const m of met) streets.connected.add(m);
    ids.push(id);
    cuts.push(conn);
  }
  return { cuts, entrance, streets: ids };
}

/** True when p is on (within d of) one of the rings. */
export const onRings = (rings: Polygon[], p: Vec2, d: number): boolean => rings.some((r) => distToRing(r, p) < d);

export function reserveCastle(s: M4State, api: ReserveApi, plan: CastlePlan, id = 'castle'): ReservedLot | null {
  const rings = api.enclosure.map((ph) => ph.outer);
  const g = plan.gate;
  const toward = { x: g.p.x + g.n.x * (plan.ditch + plan.espl + 2), y: g.p.y + g.n.y * (plan.ditch + plan.espl + 2) };
  const w = s.P.widthByRank[2] * s.P.widthScale;
  const acc = giveAccess(s, api, plan.lot, {
    mode: 'front',
    front: (a, b) => { const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; return !onRings(rings, m, 1.2) && !s.ctx.isWater(m); },
    toward, width: w, rank: 2, cWidth: s.P.widthByRank[1] * s.P.widthScale * 0.9, cRank: 1, maxLen: 900, dirs: [g.n],
  }, []);
  if (!acc) return null;
  s.lotData.set(id, plan);
  const c = polygonCentroid(plan.C);
  const ph = phaseAt(api, c);
  s.sites.push({ id, kind: plan.variant === 'kasbah' ? 'kasbah' : plan.variant === 'motte' ? 'motte' : 'castle', role: 'power', lot: plan.lot, entrance: acc.entrance, anchor: c, culture: s.culture });
  return { id, kind: 'm4-castle', poly: plan.lot, phase: ph.phase, zone: ph.zone, cuts: acc.cuts };
}

export { pointInRing, dist };
export type { Streets };
