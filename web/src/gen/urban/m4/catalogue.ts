/**
 * Siting of the European landmark catalogue at level 1 (URBAN_LANDMARKS.md §2): cathedral close, palace,
 * monasteries. Each lot is placed by its rule, then given its street effect (parvis street, forecourt avenue,
 * precinct front) and connected to the network.
 */
import type { Vec2, Polygon, Polyline } from '../../core/geom';
import { dist, polygonCentroid } from '../../core/geom';
import type { ReserveApi, ReservedLot } from '../primary';
import { mpArea, differenceS, unionS } from '../../geo/bool';
import { area, pointInRing, distToRing, orientPos, cleanRing } from '../../geo/poly';
import { rectAt, inMP, LineIndex, fracInside, TAU } from './lots';
import { siteLot, gridAround, Mask } from './site';
import { samplePoly } from './lots';
import { giveAccess, phaseAt, type M4State } from './reserve';
import { dilate } from '../phases';

export interface CloseData { kind: 'cathedral-close'; ang: number; Lc: number }
export interface PalaceData { kind: 'palace'; ang: number }
export interface MonasteryData { kind: string; ang: number; order: string }

const unitV = (a: Vec2, b: Vec2): Vec2 => { const l = dist(a, b) || 1; return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }; };
const outN = (a: Vec2, b: Vec2): Vec2 => { const l = dist(a, b) || 1; return { x: (b.y - a.y) / l, y: -(b.x - a.x) / l }; }; // outward normal of a CCW ring edge

export interface CatalogueIn {
  avoid: Polygon[];
  /** Raster masks of the enclosure and of the enclosure dilated by 14 m (built once). */
  encMask?: Mask; outMask?: Mask;
  nucleus: Vec2;
  castle: Polygon | null;
  roads: Polyline[];
}

/** Cathedral close: in the oldest phase, by the market (west front on the parvis) or on the highest ground. */
export function reserveCathedral(s: M4State, api: ReserveApi, ci: CatalogueIn): ReservedLot | null {
  const r = s.rng.fork('cathedral');
  const Lc = Math.max(90, Math.min(140, 72 + s.pop * 0.0012)) * r.range(0.97, 1.05);
  const uL = 1.45 * Lc, vW = 1.0 * Lc;
  const encR = Math.sqrt(mpArea(api.enclosure) / Math.PI);
  const market = api.market;
  const mc = market ? polygonCentroid(market) : ci.nucleus;
  const core = api.phases[0].region;
  const h0 = s.ctx.heightAt(mc);
  const ignore = new Set<number>(api.marketStreet >= 0 ? [api.marketStreet] : []);
  const res = siteLot(s.ctx, api.streets, {
    shape: (c, ang, k) => rectAt(c, ang, (-uL / 2) * k, (uL / 2) * k, (-vW / 2) * k, (vW / 2) * k),
    centers: gridAround(s.ctx, mc, Math.max(180, 0.55 * encR), 24),
    angles: [0, -0.2, 0.2, -0.35, 0.35],
    scales: [1, 0.93], refine: 10,
    within: encMask(s, api, ci), margin: 8, ignore, avoid: ci.avoid, gap: 30,
    score: (poly, c, ang) => {
      let sc = 0;
      if (market) {
        const touch = poly.some((q) => pointInRing(market, q)) || market.some((q) => pointInRing(poly, q));
        if (touch) {
          const smp = samplePoly(poly, 8);
          if (smp.filter((q) => pointInRing(market, q)).length > 0.22 * smp.length) return -1e9;
        }
        sc += touch ? 3 : -Math.min(...poly.map((q) => distToRing(market, q))) / 40;
        const toM = unitV(c, mc);
        sc += 1.2 * -(Math.cos(ang) * toM.x + Math.sin(ang) * toM.y); // the market lies west: the west front faces it
      } else sc -= dist(c, mc) / 80;
      sc += (s.ctx.heightAt(c) - h0) / 4 + (inMP(core, c) ? 1 : 0) - Math.abs(ang) * 0.8;
      return sc;
    },
  }, r);
  if (!res) return null;
  let lot = res.poly;
  if (market) {
    const d = differenceS(lot, market);
    const big = d.reduce<Polygon | null>((b, ph) => (!b || area(ph.outer) > area(b) ? ph.outer : b), null);
    if (!big || d.length > 1 && d.some((ph) => ph.outer !== big && area(ph.outer) > 30)) return null;
    lot = orientPos(cleanRing(big, 0.3, 1, Infinity, false));
  }
  const ang = res.ang, west = { x: -Math.cos(ang), y: -Math.sin(ang) };
  const wm = lotSideMid(lot, west);
  const acc = giveAccess(s, api, lot, {
    mode: 'front',
    front: (a, b) => { const n = outN(a, b); return n.x * west.x + n.y * west.y > 0.6 && !(market && distToRing(market, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }) < 1); },
    toward: wm, width: s.P.widthByRank[2] * s.P.widthScale, rank: 2, cWidth: s.P.widthByRank[1] * s.P.widthScale * 0.85, cRank: 1, maxLen: 300, dirs: [west],
  }, ci.avoid);
  if (!acc) return null;
  const id = 'cathedral';
  s.lotData.set(id, { kind: 'cathedral-close', ang, Lc: Lc * res.k } as CloseData);
  const c = polygonCentroid(lot);
  const ph = phaseAt(api, c);
  s.sites.push({ id, kind: 'cathedral-close', role: 'worship', lot, entrance: acc.entrance, anchor: c, culture: s.culture });
  return { id, kind: 'm4-cathedral-close', poly: lot, phase: ph.phase, zone: ph.zone, cuts: acc.cuts };
}

function encMask(s: M4State, api: ReserveApi, ci: CatalogueIn): Mask {
  if (!ci.encMask) ci.encMask = new Mask(s.ctx.mapSize, api.enclosure);
  return ci.encMask;
}

/** Midpoint of the polygon side facing direction d (the extreme point along d, averaged over that side). */
function lotSideMid(p: Polygon, d: Vec2): Vec2 {
  let best = -Infinity;
  for (const q of p) best = Math.max(best, q.x * d.x + q.y * d.y);
  const side = p.filter((q) => q.x * d.x + q.y * d.y > best - 3);
  return { x: side.reduce((t, q) => t + q.x, 0) / side.length, y: side.reduce((t, q) => t + q.y, 0) / side.length };
}

/** Palace: near the nucleus or the castle, on a high or central site; forecourt toward the town, approach avenue. */
export function reservePalace(s: M4State, api: ReserveApi, ci: CatalogueIn): ReservedLot | null {
  const r = s.rng.fork('palace');
  const A = Math.max(5000, Math.min(16000, 3500 + s.pop * 0.2)) * r.range(0.9, 1.1);
  const asp = r.range(1.2, 1.45);
  const L = Math.sqrt(A * asp), W = A / L;
  const encR = Math.sqrt(mpArea(api.enclosure) / Math.PI);
  const facing = (c: Vec2) => Math.atan2(ci.nucleus.y - c.y, ci.nucleus.x - c.x);
  const h0 = s.ctx.heightAt(ci.nucleus);
  const cc = ci.castle ? polygonCentroid(ci.castle) : null;
  const centers = gridAround(s.ctx, ci.nucleus, Math.max(160, 0.6 * encR), 26);
  if (cc) centers.push(...gridAround(s.ctx, cc, 260, 26));
  const res = siteLot(s.ctx, api.streets, {
    // the forecourt side (+u) faces the nucleus
    shape: (c, a, k) => rectAt(c, facing(c) + a, (-L / 2) * k, (L / 2) * k, (-W / 2) * k, (W / 2) * k),
    centers, angles: [0, 0.3, -0.3, Math.PI / 2, -Math.PI / 2], scales: [1, 0.88, 0.78], refine: 10,
    within: encMask(s, api, ci), margin: 9, avoid: ci.avoid, gap: 25,
    score: (poly, c) => {
      const d = dist(c, ci.nucleus);
      let sc = (s.ctx.heightAt(c) - h0) / 5 - Math.abs(d - 0.3 * encR) / 120;
      if (cc) sc += 1.2 * Math.exp(-dist(c, cc) / 180);
      return sc - (api.market && poly.some((q) => pointInRing(api.market!, q)) ? 1e9 : 0);
    },
  }, r);
  if (!res) return null;
  const lot = res.poly;
  const fwd = { x: Math.cos(facing(res.c) + res.ang), y: Math.sin(facing(res.c) + res.ang) };
  const toN = unitV(res.c, ci.nucleus);
  const acc = giveAccess(s, api, lot, {
    mode: 'front',
    front: (a, b) => { const n = outN(a, b); return n.x * fwd.x + n.y * fwd.y > 0.6; },
    toward: lotSideMid(lot, fwd), width: s.P.widthByRank[2] * s.P.widthScale, rank: 2, cWidth: s.P.widthByRank[1] * s.P.widthScale, cRank: 1, maxLen: 320, dirs: [fwd, toN],
  }, ci.avoid);
  if (!acc) return null;
  const id = 'palace';
  s.lotData.set(id, { kind: 'palace', ang: Math.atan2(fwd.y, fwd.x) } as PalaceData);
  const c = polygonCentroid(lot);
  const ph = phaseAt(api, c);
  s.sites.push({ id, kind: 'palace', role: 'power', lot, entrance: acc.entrance, anchor: c, culture: s.culture });
  return { id, kind: 'm4-palace', poly: lot, phase: ph.phase, zone: ph.zone, cuts: acc.cuts };
}

const ORDERS = ['benedictine abbey', 'franciscan friary', 'dominican priory', 'augustinian priory', 'carmelite friary', 'cistercian grange', 'poor clares convent'];

/**
 * Monasteries: at the edge of the walled town or outside it near a gate (mendicant friaries by the gates), walled
 * precincts kept apart from each other; streets bend around the precinct front.
 */
export function reserveMonasteries(s: M4State, api: ReserveApi, ci: CatalogueIn, n: number, builder: string): ReservedLot[] {
  const out: ReservedLot[] = [];
  const encR = Math.sqrt(mpArea(api.enclosure) / Math.PI);
  const ringIdx = new LineIndex(api.enclosure.map((ph) => ({ path: ph.outer.concat([ph.outer[0]]), hw: 0 })));
  const walled = api.gates.length > 0;
  const outsideReg = dilate(api.enclosure, 14 + (s.listsW ? s.listsW + 6 : 0));
  if (!ci.outMask) ci.outMask = new Mask(s.ctx.mapSize, outsideReg);
  const inM = encMask(s, api, ci), outM = ci.outMask;
  const roadIdx = new LineIndex(ci.roads.map((path) => ({ path, hw: 5 })));
  const placed: Vec2[] = [];
  for (let k = 0; k < n; k++) {
    const r = s.rng.fork('monastery:' + k);
    const big = k === 0;
    const A = (s.pop < 6000 ? r.range(5000, 9000) : s.pop < 25000 ? r.range(8000, 15000) : r.range(11000, 22000)) * (big ? 1.15 : 0.85);
    const asp = r.range(1.15, 1.5);
    const L = Math.sqrt(A * asp), W = A / L;
    // mendicant orders outside, by the gates (the second one in a walled town, every other one in a city)
    const outside = walled && (k % 2 === 1) && api.gates.length > 0;
    const order = ORDERS[(k + (outside ? 1 : 0)) % ORDERS.length];
    const avoid = [...ci.avoid, ...out.map((o) => o.poly)];
    const centers = outside
      ? api.gates.flatMap((g) => gridAround(s.ctx, g, 280, 40)).filter((p) => !outM.has(p) && roadIdx.dist(p, 30) > 22)
      : gridAround(s.ctx, ci.nucleus, encR * 1.05, 32).filter((p) => inM.has(p) && ringIdx.dist(p, Math.max(140, 0.35 * encR)) < Math.max(140, 0.35 * encR));
    const res = siteLot(s.ctx, api.streets, {
      shape: (c, a, kk) => rectAt(c, a, (-L / 2) * kk, (L / 2) * kk, (-W / 2) * kk, (W / 2) * kk),
      centers, angles: outside ? [0, Math.PI / 2] : [0, -0.22, 0.22, Math.PI / 2], scales: [1, 0.8], refine: 12,
      within: outside ? undefined : inM, outside: outside ? outM : undefined,
      margin: 8, avoid, gap: 30,
      score: (poly, c) => {
        if (placed.some((p) => dist(p, c) < 230)) return -1e9;
        if (outside && !roadIdx.clear(poly, 6)) return -1e9;
        const sl = s.ctx.slopeAt(c);
        let sc = -sl * 8 + 0.3 * Math.min(1, dist(c, ci.nucleus) / encR);
        if (outside) sc -= Math.min(...api.gates.map((g) => dist(g, c))) / 120;
        else sc -= Math.min(300, ringIdx.dist(c, 300)) / 70;
        if (ci.castle && dist(c, polygonCentroid(ci.castle)) < 200) sc -= 1;
        return sc;
      },
    }, r);
    if (!res) continue;
    const lot = res.poly;
    const c = polygonCentroid(lot);
    // the precinct front faces the nearest connected street
    let toward = ci.nucleus;
    {
      let bd = Infinity;
      for (const st of api.streets.list) {
        if (!st.ribbon || !api.streets.connected.has(st.id)) continue;
        for (const q of st.path) { const d = dist(q, c); if (d < bd) { bd = d; toward = q; } }
      }
    }
    const fwd = unitV(c, toward);
    const acc = giveAccess(s, api, lot, {
      mode: 'front',
      front: (a, b) => { const nn = outN(a, b); return nn.x * fwd.x + nn.y * fwd.y > 0.55; },
      toward: lotSideMid(lot, fwd), width: s.P.widthByRank[2] * s.P.widthScale, rank: 2, maxLen: 280, dirs: [fwd],
    }, avoid);
    if (!acc) continue;
    const id = 'monastery:' + k;
    // the church is oriented east whatever the lot orientation (mod 90°)
    let east = res.ang;
    while (east > Math.PI / 4) east -= Math.PI / 2;
    while (east < -Math.PI / 4) east += Math.PI / 2;
    s.lotData.set(id, { kind: builder, ang: east, order } as MonasteryData);
    const ph = phaseAt(api, c);
    s.sites.push({ id, kind: builder, role: 'worship', lot, entrance: acc.entrance, anchor: c, culture: s.culture, tags: { order } });
    out.push({ id, kind: 'm4-' + builder, poly: lot, phase: ph.phase, zone: ph.zone, cuts: acc.cuts });
    placed.push(c);
  }
  return out;
}

export { unionS, fracInside, TAU };
