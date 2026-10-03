/**
 * Venetian lagoon town (Venice, Chioggia, Murano): islands separated by canals (rii), each island a parish with
 * its campo (the paved square with the parish church, its campanile and the well-head, vera da pozzo), the calli
 * (narrow lanes) inside the islands, fondamenta (quays) along most canals, footbridges where the calli cross the
 * canals, palazzi with their water gates and courts (cortile) lining the canals, the piazza with the domed basilica
 * and the doge's palace, and the arsenal (a walled basin with its covered slips) at the edge.
 *
 * The canals are cuts of the partition like every street: the first cuts of each quarter (rank 2) are dug as canals.
 * Their street space holds the water down the middle and the fondamenta along its sides (or none: houses on the
 * water), so plots keep their frontage on a canal (the water gate) exactly as on a street.
 */
import type { Vec2, Polygon, Polyline } from '../core/geom';
import { dist } from '../core/geom';
import type { Rng } from '../core/rng';
import type { UrbanLine } from '../types';
import type { Streets, StreetRec } from './streets';
import type { CompoundCtx, CompoundOut } from './compounds';
import { registerBuilders } from './compounds';
import { orientPos, pointInRing, inscribed, obb } from '../geo/poly';
import { disk } from '../geo/offset';
import { fits, alongEdge, longestEdge, minus, largest } from './m4/kit';
import { rectAt } from './m4/lots';
import { crossInSquare } from './byzantine';
import type { ReserveApi, ReservedLot } from './primary';
import { Mask, siteLot, gridAround } from './m4/site';
import { giveAccess, phaseAt, type M4State } from './m4/reserve';
import { mpArea } from '../geo/bool';
import { connectedWaterways } from './waterways';
import { lockedWaterways } from './lockwater';

const overlap = (A: Polygon, B: Polygon): boolean => A.some((q) => pointInRing(B, q)) || B.some((q) => pointInRing(A, q));
const meanW = (s: StreetRec): number => s.widths.reduce((a, b) => a + b, 0) / s.widths.length;

/** The streets dug as canals: the rank-2 cuts of the quarters (level 2, ids from `l2`: not the primary streets). */
const isCanal = (s: StreetRec, l2First: number): boolean => s.id >= l2First && s.ribbon && s.rank === 2 && s.role === 'street' && s.path.length >= 2;

/** Nearest point of a polyline: the point, its tangent and the distance. */
function onPath(pl: Polyline, p: Vec2): { q: Vec2; t: Vec2; d: number } {
  let best = { q: pl[0], t: { x: 1, y: 0 }, d: Infinity };
  for (let i = 1; i < pl.length; i++) {
    const a = pl[i - 1], b = pl[i];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    const q = { x: a.x + dx * u, y: a.y + dy * u };
    const d = dist(p, q);
    if (d < best.d) { const l = Math.sqrt(l2); best = { q, t: { x: dx / l, y: dy / l }, d }; }
  }
  return best;
}

/**
 * Canals and footbridges: the water down every canal (with fondamenta 1.2–2 m wide on most, houses straight on the
 * water on some), extended across a land street where the canal goes on beyond it (a bridge carries the street),
 * and a footbridge wherever a calle ends on a canal with a fondamenta (or another calle) across.
 */
export function lagoonWaterways(streets: Streets, rng: Rng, isWater: (p: Vec2) => boolean, l2First: number, locks = false,
  canOutlet?: (path: Polyline, width: number) => boolean): UrbanLine[] {
  if (locks) return lockedWaterways(streets, rng, isWater, l2First, true);
  const out: UrbanLine[] = [];
  const network = connectedWaterways(streets, streets.list.filter((s) => isCanal(s, l2First)), isWater, canOutlet);
  const canals = network.canals;
  if (!canals.length) return out;
  const land = streets.list.filter((s) => s.ribbon && !canals.includes(s) && s.path.length >= 2);
  const fond = new Map<number, number>();
  for (const c of canals) {
    const desired = rng.chance(0.72) ? Math.min(2, Math.max(1.2, meanW(c) * 0.18)) : 1.2;
    fond.set(c.id, Math.min(desired, (Math.min(...c.widths) - 2.2) / 2));
  }
  const water = (c: StreetRec) => Math.max(2.2, Math.min(...c.widths) - 2 * (fond.get(c.id) ?? 0));
  const wetPaths = [...canals.map((c) => ({ path: c.path, width: water(c), street: c.id })), ...network.connectors];
  const submerged = (p: Vec2) => isWater(p) || wetPaths.some((c) => onPath(c.path, p).d < c.width / 2 + 0.1);
  const bridges: { a: Vec2; b: Vec2; w: number }[] = [];
  const addBridge = (at: Vec2, channel: typeof wetPaths[number], w: number) => {
    const r = onPath(channel.path, at), d = { x: -r.t.y, y: r.t.x }, len = channel.width + 2.4;
    // At a wet T junction the old crossing direction lands inside the new outlet. Move a few
    // metres along the same canal to join real dry quays, without covering occupied blocks.
    for (const offset of [0, 3, -3, 6, -6, 9, -9, 12, -12]) {
      const c = { x: r.q.x + r.t.x * offset, y: r.q.y + r.t.y * offset };
      if (onPath(channel.path, c).d > 0.1) continue;
      const a = { x: c.x - d.x * len / 2, y: c.y - d.y * len / 2 }, b = { x: c.x + d.x * len / 2, y: c.y + d.y * len / 2 };
      const landings = [a, b].flatMap((p) => [-0.5, 0, 0.5].map((t) => ({ x: p.x + r.t.x * w * t, y: p.y + r.t.y * w * t })));
      if (landings.some(submerged) || (canOutlet && !canOutlet([a, b], w))) continue;
      if (bridges.some((b) => dist({ x: (b.a.x + b.b.x) / 2, y: (b.a.y + b.b.y) / 2 }, c) < 6)) return;
      bridges.push({ a, b, w }); return;
    }
  };
  for (const c of canals) {
    const cw = water(c);
    const pl = c.path.slice();
    // An arterial crossing a canal's mouth needs a bridge even when the mouth is between its vertices.
    for (const e of [pl[0], pl[pl.length - 1]]) {
      if (isWater(e)) continue;
      for (const host of land) {
        const r = onPath(host.path, e);
        if (r.d < 1.2) { addBridge(e, { path: pl, width: cw, street: c.id }, Math.max(2.2, Math.min(4, meanW(host) - 0.4))); break; }
      }
    }
    out.push({ kind: 'canal', path: pl, width: cw });
  }
  for (const channel of network.connectors) out.push({ kind: 'canal', path: channel.path, width: channel.width });
  // Cross the entire final wet network, including narrow calli ending midway along an outlet.
  // A channel's own street follows its quays; its bends alone do not require bridges.
  for (const s of land) {
    for (let i = 0; i < s.path.length; i++) {
      const e = s.path[i];
      if (isWater(e)) continue;
      const next = s.path[i ? i - 1 : 1], length = dist(e, next);
      if (length < 0.01) continue;
      const direction = { x: (next.x - e.x) / length, y: (next.y - e.y) / length };
      for (const channel of wetPaths) {
        if (channel.street === s.id) continue;
        const r = onPath(channel.path, e);
        if (r.d >= 1.2 || Math.abs(direction.x * r.t.y - direction.y * r.t.x) < 0.2) continue;
        addBridge(r.q, channel, Math.max(2.2, Math.min(4, meanW(s) - 0.4)));
      }
    }
  }
  for (const b of bridges) out.push({ kind: 'footbridge', path: [b.a, b.b], width: b.w });
  return out;
}

// ---------------------------------------------------------------- landmark plans
/** Campanile: a square brick bell tower. */
const campanile = (c: Vec2, ang: number, s: number): Polygon => rectAt(c, ang, -s / 2, s / 2, -s / 2, s / 2);

/**
 * The campo of an island parish: a paved square; the church on its longest side (its front on the campo), the
 * campanile beside it, the well-head in the middle of the square.
 */
function campo(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'place' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const e = longestEdge(P);
  const placed: Polygon[] = [];
  if (e >= 0) {
    const a = P[e], b = P[(e + 1) % P.length];
    const L = dist(a, b);
    const ch = alongEdge(P, e, cx.rng.range(13, 17), Math.min(L * 0.6, cx.rng.range(28, 40)), 0.6);
    if (ch) {
      placed.push(ch);
      out.buildings.push({ poly: ch, kind: 'landmark', parcel: 0, arch: 'parish-church', roof: 'gable', material: 'brick', storeys: 2, orientation: Math.atan2(b.y - a.y, b.x - a.x) });
      out.landmarks.push({ kind: 'parish-church', poly: ch });
      const o = obb(ch);
      const s = cx.rng.range(5, 7);
      const t = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
      for (const sg of [1, -1]) {
        const c = { x: o.c.x + t.x * sg * (o.hu + s / 2 + 0.6), y: o.c.y + t.y * sg * (o.hu + s / 2 + 0.6) };
        const cp = campanile(c, Math.atan2(t.y, t.x), s);
        if (fits(P, cp, 0.5) && !placed.some((q) => overlap(q, cp))) { placed.push(cp); out.buildings.push({ poly: cp, kind: 'landmark', parcel: 0, arch: 'campanile', roof: 'pyramidal', material: 'brick', storeys: 8 }); break; }
      }
    }
  }
  // the well-head at the open middle of the campo
  const free = largest(minus(P, ...placed.map((q) => rectAt(obb(q).c, Math.atan2(obb(q).u.y, obb(q).u.x), -obb(q).hu - 3, obb(q).hu + 3, -obb(q).hv - 3, obb(q).hv + 3)))) ?? P;
  const ins = inscribed(free, [], 0.5);
  const well = orientPos(disk(ins.c, 1.1, 10));
  if (fits(P, well, 1) && !placed.some((q) => overlap(q, well))) { out.buildings.push({ poly: well, kind: 'landmark', parcel: 0, arch: 'vera-da-pozzo', roof: 'none', material: 'stone', storeys: 1 }); out.landmarks.push({ kind: 'well', poly: well }); }
  out.landmarks.push({ kind: 'campo', poly: P });
  return out;
}

/** The basilica (San Marco): a Greek-cross church with five domes, the campanile standing free before it. */
function dogeBasilica(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'place' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const ins = inscribed(P, [], 1);
  for (let s = Math.min(48, ins.r * 1.1); s >= 12; s *= 0.88) {
    const ch = crossInSquare(ins.c, s, 0, true);
    if (!ch.parts.every((p) => fits(P, p, 1.5))) continue;
    for (const p of ch.parts) out.buildings.push({ poly: p, kind: 'landmark', parcel: 0, arch: 'domed-basilica', roof: 'dome', material: 'brick', storeys: 2 });
    for (const d of ch.domes) out.lines.push({ kind: 'dome', path: d.concat([d[0]]), width: 0.6 });
    out.landmarks.push({ kind: 'basilica', poly: ch.parts[0] });
    const cs = Math.max(6, s * 0.24);
    for (const c of [{ x: ins.c.x - s * 0.95, y: ins.c.y + s * 0.62 }, { x: ins.c.x - s * 0.95, y: ins.c.y - s * 0.62 }, { x: ins.c.x + s * 0.2, y: ins.c.y + s * 0.95 }]) {
      const cp = campanile(c, 0, cs);
      if (fits(P, cp, 1) && !out.buildings.some((b) => overlap(b.poly, cp))) { out.buildings.push({ poly: cp, kind: 'landmark', parcel: 0, arch: 'campanile', roof: 'pyramidal', material: 'brick', storeys: 10 }); break; }
    }
    break;
  }
  void cx;
  return out;
}

/** The doge's palace: four ranges round a great court (the long arcaded fronts), a well-head in the court. */
function dogePalace(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [{ poly: lot, use: 'compound:doge-palace' }], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const o = obb(P);
  const ang = Math.atan2(o.u.y, o.u.x);
  for (let k = 0.95; k > 0.4; k -= 0.08) {
    const hu = o.hu * k - 1, hv = o.hv * k - 1, d = Math.min(14, Math.max(8, hv * 0.3));
    if (hu < 14 || hv < 12) break;
    const parts = [rectAt(o.c, ang, -hu, hu, -hv, -hv + d), rectAt(o.c, ang, -hu, hu, hv - d, hv), rectAt(o.c, ang, -hu, -hu + d, -hv + d + 0.01, hv - d - 0.01), rectAt(o.c, ang, hu - d, hu, -hv + d + 0.01, hv - d - 0.01)];
    if (!parts.every((p) => fits(P, p, 0.8))) continue;
    for (const p of parts) out.buildings.push({ poly: p, kind: 'landmark', parcel: 0, arch: 'doge-palace', roof: 'tiled-hip', material: 'stone', storeys: 3, courtyards: [] });
    out.buildings.push({ poly: orientPos(disk(o.c, 1.3, 10)), kind: 'landmark', parcel: 0, arch: 'vera-da-pozzo', roof: 'none', material: 'stone', storeys: 1 });
    out.landmarks.push({ kind: 'doge-palace', poly: parts[0] });
    break;
  }
  void cx;
  return out;
}

/**
 * The arsenal: a walled yard round a wet basin (the darsena), long covered slips (tese) along its sides, the
 * ropewalk (corderie) along one wall, the land gate with its twin towers.
 */
function arsenal(lot: Polygon, cx: CompoundCtx): CompoundOut {
  const out: CompoundOut = { parcels: [], buildings: [], lines: [], water: [], landmarks: [] };
  const P = orientPos(lot);
  const o = obb(P);
  const ang = Math.atan2(o.u.y, o.u.x);
  let basin: Polygon | null = null;
  for (let k = 0.62; k > 0.3 && !basin; k -= 0.05) {
    const b = rectAt(o.c, ang, -o.hu * k, o.hu * k, -o.hv * k * 0.8, o.hv * k * 0.8);
    if (fits(P, b, 12)) basin = b;
  }
  if (!basin) return { ...out, parcels: [{ poly: lot, use: 'compound:arsenal' }] };
  // the yard round the basin (cut open by a thin slit: parcels have no holes)
  const slit = rectAt(o.c, ang, -4 * o.hu, 0, -0.01, 0.01);
  for (const y of minus(P, basin, slit)) out.parcels.push({ poly: y, use: 'compound:arsenal' });
  const iB = out.parcels.length;
  out.parcels.push({ poly: basin, use: 'darsena' });
  out.water.push(basin);
  // covered slips perpendicular to the basin's long sides
  const bo = obb(basin);
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const placed: Polygon[] = [];
  for (const sg of [-1, 1]) {
    const depth = Math.min(36, (o.hv - bo.hv) * 0.8);
    if (depth < 12) continue;
    for (let u = -bo.hu + 4; u + 9 <= bo.hu - 4; u += 11) {
      const c = { x: o.c.x + ca * (u + 4.5) - sa * sg * (bo.hv + 1 + depth / 2), y: o.c.y + sa * (u + 4.5) + ca * sg * (bo.hv + 1 + depth / 2) };
      const r = rectAt(c, ang, -4.5, 4.5, -depth / 2, depth / 2);
      const pi = out.parcels.findIndex((pp, i) => i !== iB && fits(pp.poly, r, 0.4));
      if (pi < 0 || placed.some((q) => overlap(q, r))) continue;
      placed.push(r);
      out.buildings.push({ poly: r, kind: 'landmark', parcel: pi, arch: 'tesa-shipshed', roof: 'gable', material: 'brick', storeys: 1, orientation: ang + Math.PI / 2 });
    }
  }
  out.landmarks.push({ kind: 'arsenal', poly: P });
  out.lines.push({ kind: 'stone-wall', path: P, closed: true, width: 1.8 });
  void cx;
  return out;
}

/**
 * Sites the arsenal at level 1: a large rectangle inside the town by the open water (the lagoon side), away from
 * the piazza, given a street round it.
 */
export function reserveArsenal(s: M4State, api: ReserveApi, avoid: Polygon[], nucleus: Vec2): ReservedLot | null {
  const r = s.rng.fork('arsenal');
  const L = r.range(110, 150) * Math.max(0.8, Math.min(1.5, Math.sqrt(s.pop / 15000))), W = L * r.range(0.62, 0.75);
  const encM = new Mask(s.ctx.mapSize, api.enclosure, 5);
  const encR = Math.sqrt(mpArea(api.enclosure) / Math.PI);
  const wetNear = (c: Vec2): number => { let k = 0; for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; if (s.ctx.isWater({ x: c.x + Math.cos(a) * L * 0.85, y: c.y + Math.sin(a) * L * 0.85 })) k++; } return k; };
  const res = siteLot(s.ctx, api.streets, {
    shape: (c, ang) => rectAt(c, ang, -L / 2, L / 2, -W / 2, W / 2),
    centers: gridAround(s.ctx, nucleus, encR, 30).filter((c) => dist(c, nucleus) > Math.max(200, encR * 0.45)),
    angles: [0, Math.PI / 4, Math.PI / 2, -Math.PI / 4], scales: [1, 0.8], refine: 8,
    within: encM, margin: 5, avoid, gap: 24,
    score: (_poly, c) => Math.min(4, wetNear(c)) / 2 + dist(c, nucleus) / encR,
  }, r);
  if (!res) return null;
  const acc = giveAccess(s, api, res.poly, { mode: 'ring', toward: nucleus, width: s.P.widthByRank[2] * s.P.widthScale, rank: 2, maxLen: 220 }, avoid);
  if (!acc) return null;
  const ph = phaseAt(api, res.c);
  s.sites.push({ id: 'arsenal', kind: 'arsenal', role: 'civic', lot: res.poly, entrance: acc.entrance, anchor: res.c, culture: s.culture });
  return { id: 'arsenal', kind: 'arsenal', poly: res.poly, phase: ph.phase, zone: ph.zone, cuts: acc.cuts };
}

let registered = false;
export function registerVenice(): void {
  if (registered) return;
  registered = true;
  registerBuilders({ campo, 'doge-basilica': dogeBasilica, 'doge-palace': dogePalace, arsenal });
}
