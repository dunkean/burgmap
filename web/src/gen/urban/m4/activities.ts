/**
 * Activities (URBAN_LANDMARKS.md §2): sited by terrain, water and network rules, each an exact lot.
 *
 * watermill   on a river near the town, away from bridges: a weir across the river, a mill race cut parallel
 *             to the bank (intake upstream, tail race downstream) and the mill straddling the race; the land
 *             between race and river is the mill island
 * windmill    on exposed knolls outside the walls (local height maxima), a mound and a post mill
 * tannery     downstream of the town along the river, at its edge: long sheds perpendicular to the water with
 *             drying yards between them
 * gallows     on high ground beside a road outside the walls
 * lazar house on a road well outside the town, a chapel and a ward round a garden
 * cemetery    outside a gate along the road
 * arena       (roman-core, or rare) an ellipse of 60–120 m at the edge of the core, fossilized as an oval of
 *             houses built into the cavea around an open piazza, a ring street following the ellipse
 * Rural lots reach the road by a track when no street is near.
 */
import type { Vec2, Polygon, Polyline } from '../../core/geom';
import { dist, polygonCentroid } from '../../core/geom';
import type { ReserveApi, ReservedLot } from '../primary';
import type { CompoundCtx } from '../compounds';
import type { UrbanLine } from '../../types';
import { mpArea, differenceS, intersectionS } from '../../geo/bool';
import { area, orientPos, pointInRing, distToRing, inscribed, obb, segSegT } from '../../geo/poly';
import { ribbon, disk } from '../../geo/offset';
import { dilate } from '../phases';
import { rectAt, frameAt, ellipseAt, LineIndex, nearestOnPl, TAU, inMP } from './lots';
import { Mask, siteLot, gridAround } from './site';
import { giveAccess, phaseAt, type M4State } from './reserve';
import { emptyOut, pieces, largest, fits, placeRect, minus, inter, splitLine, type Out } from './kit';

export interface ActIn {
  avoid: Polygon[];
  nucleus: Vec2;
  roads: Polyline[];
  bridges: { a: Vec2; b: Vec2 }[];
  /** Plan lines added by the siting (tracks, weirs). */
  lines: UrbanLine[];
}
export interface MillData { kind: 'watermill'; c: Vec2; ang: number; side: number; w: number; d: number; Lr: number }
export interface ActData { kind: string; ang: number; c?: Vec2; a?: number; b?: number }

/** Access by street when one is near, else a track to the nearest road. */
function accessOrTrack(s: M4State, api: ReserveApi, lot: Polygon, toward: Vec2, ai: ActIn, roads: LineIndex, roadLines: Polyline[]): { cuts: Polyline[]; entrance: Vec2 } | null {
  const near = api.streets.nearest(toward, 140, (st) => api.streets.connected.has(st.id));
  if (near) {
    const acc = giveAccess(s, api, lot, { mode: 'none', toward, width: 4, rank: 3, maxLen: 160 }, ai.avoid);
    if (acc) return { cuts: acc.cuts, entrance: acc.entrance };
  }
  // a track to the road, outside the walls (it may not cross the enclosure)
  const P = orientPos(lot);
  const rings = api.enclosure.map((ph) => ph.outer);
  const crosses = (a: Vec2, b: Vec2) => rings.some((rg) => rg.some((q, k) => segSegT(a, b, q, rg[(k + 1) % rg.length])));
  let bp: Vec2 | null = null, e = P[0], bd = 220;
  for (const pl of roadLines) for (let i = 0; i < pl.length; i += 1) {
    const q = pl[i];
    if (dist(q, toward) > bd + 30 || api.enclosure.some((ph) => pointInRing(ph.outer, q))) continue;
    let ee = P[0], ed = Infinity;
    for (let k = 0; k < P.length; k++) { const nn = nearestOnPl([P[k], P[(k + 1) % P.length]], q); if (nn.d < ed) { ed = nn.d; ee = nn.q; } }
    if (ed < bd && !crosses(ee, q)) { bd = ed; bp = q; e = ee; }
  }
  if (!bp) return null;
  if (dist(e, bp) > 2) ai.lines.push({ kind: 'track', path: [e, bp], width: 3 });
  void roads;
  return { cuts: [], entrance: e };
}

/** Watermills on the rivers near the town. */
export function reserveMills(s: M4State, api: ReserveApi, ai: ActIn, n: number): ReservedLot[] {
  const ctx = s.ctx, r = s.rng.fork('mills');
  const out: ReservedLot[] = [];
  const near = new Mask(ctx.mapSize, dilate(api.footprint, 260), 6);
  const roadIdx = new LineIndex(ai.roads.map((path) => ({ path, hw: 5 })));
  const bridgeIdx = new LineIndex(ai.bridges.map((b) => ({ path: [b.a, b.b], hw: 0 })));
  const cands: { c: Vec2; ang: number; w: number; side: number; s: number }[] = [];
  for (const rv of ctx.terrain.rivers) {
    for (let i = 4; i < rv.path.length - 4; i += 3) {
      const p = rv.path[i], w = rv.width[i];
      if (w < 2.5 || w > 26 || !near.has(p) || bridgeIdx.dist(p, 70) < 60) continue;
      const a = rv.path[i - 4], b = rv.path[i + 4];
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      // locally straight river (the race runs parallel to it)
      let dev = 0;
      for (let k = i - 4; k <= i + 4; k++) { const q = rv.path[k]; dev = Math.max(dev, Math.abs(-(q.x - p.x) * Math.sin(ang) + (q.y - p.y) * Math.cos(ang))); }
      if (dev > 7) continue;
      for (const side of [1, -1]) cands.push({ c: p, ang, w, side, s: r.float() });
    }
  }
  const placed: Vec2[] = [];
  const all = () => [...ai.avoid, ...out.map((o) => o.poly)];
  cands.sort((x, y) => x.s - y.s);
  for (const cd of cands) {
    if (out.length >= n) break;
    if (placed.some((q) => dist(q, cd.c) < 260)) continue;
    const Lr = r.range(70, 105), d = cd.w / 2 + r.range(13, 17), yard = 16;
    const sgn = cd.side;
    const rect = rectAt(cd.c, cd.ang, -Lr / 2 - 6, Lr / 2 + 6, sgn > 0 ? 0 : -(d + 2 + yard), sgn > 0 ? d + 2 + yard : 0);
    // cheap tests first (dry beyond the bank, clear of roads, streets and the other lots), the boolean last
    let wet = false;
    for (let u = -Lr / 2; u <= Lr / 2 && !wet; u += 8) for (let v = cd.w / 2 + 4; v <= d + 2 + yard - 1; v += 5) if (ctx.isWater(frameAt(cd.c, cd.ang, u, sgn * v))) { wet = true; break; }
    const rc = frameAt(cd.c, cd.ang, 0, sgn * (d + yard) / 2);
    if (wet || !roadIdx.clear(rect, 3) || all().some((o) => distToRing(o, rc) < 40 || pointInRing(o, rc)) || !clearStreets(api, rect, 3) || inLists(s, api, rect)) continue;
    const landM = differenceS(rect, ctx.water);
    const lot = landM.filter((ph) => !ph.holes.length).map((ph) => ph.outer).sort((x, y) => area(y) - area(x))[0];
    if (!lot || area(lot) < 0.55 * area(rect)) continue;
    const toward = frameAt(cd.c, cd.ang, 0, sgn * (d + 2 + yard + 6));
    const acc = accessOrTrack(s, api, lot, toward, { ...ai, avoid: all() }, roadIdx, ai.roads);
    if (!acc) continue;
    const id = 'mill:' + out.length;
    s.lotData.set(id, { kind: 'watermill', c: cd.c, ang: cd.ang, side: sgn, w: cd.w, d, Lr } as MillData);
    const ph = phaseAt(api, polygonCentroid(lot));
    out.push({ id, kind: 'm4-watermill', poly: lot, phase: ph.phase, zone: ph.zone, cuts: acc.cuts });
    s.sites.push({ id, kind: 'watermill', role: 'activity', lot, entrance: acc.entrance, anchor: polygonCentroid(lot), culture: s.culture });
    // the weir across the river at the intake (oblique)
    const wa = frameAt(cd.c, cd.ang, -Lr / 2 - 2, sgn * (cd.w / 2 + 1.5)), wb = frameAt(cd.c, cd.ang, -Lr / 2 - 2 + cd.w * 0.7, -sgn * (cd.w / 2 + 1.5));
    ai.lines.push({ kind: 'weir', path: [wa, wb], width: 1.6 });
    placed.push(cd.c);
  }
  return out;
}

/** A lot outside the enclosure but within the lists of a double enceinte would sit on the outer wall. */
export function inLists(s: M4State, api: ReserveApi, poly: Polygon): boolean {
  if (!s.listsW) return false;
  const rings = api.enclosure.map((ph) => ph.outer);
  return poly.some((q) => !inMP(api.enclosure, q) && Math.min(...rings.map((r) => distToRing(r, q))) < s.listsW! + 8);
}

const clearStreets = (api: ReserveApi, poly: Polygon, m: number): boolean => {
  let ok = true;
  const bb = { x0: Math.min(...poly.map((q) => q.x)), y0: Math.min(...poly.map((q) => q.y)), x1: Math.max(...poly.map((q) => q.x)), y1: Math.max(...poly.map((q) => q.y)) };
  api.streets.forEachSeg(bb.x0 - 12, bb.y0 - 12, bb.x1 + 12, bb.y1 + 12, (st, i) => {
    if (!ok || !st.ribbon) return;
    const a = st.path[i], b = st.path[i + 1];
    const hw = Math.max(st.widths[i], st.widths[i + 1]) / 2 + m;
    for (let k = 0; k <= 4; k++) { const q = { x: a.x + ((b.x - a.x) * k) / 4, y: a.y + ((b.y - a.y) * k) / 4 }; if (pointInRing(poly, q) || distToRing(poly, q) < hw) { ok = false; return; } }
  });
  return ok;
};

/** Windmills on exposed knolls outside the walls. */
export function reserveWindmills(s: M4State, api: ReserveApi, ai: ActIn, n: number): ReservedLot[] {
  const ctx = s.ctx, r = s.rng.fork('windmills');
  const out: ReservedLot[] = [];
  const encR = Math.sqrt(mpArea(api.enclosure) / Math.PI);
  const c0 = ai.nucleus;
  const foot = new Mask(ctx.mapSize, dilate(api.footprint, 25 + (s.listsW ?? 0)), 5);
  const roadIdx = new LineIndex(ai.roads.map((path) => ({ path, hw: 5 })));
  const ringH = (p: Vec2, R: number) => { let t = 0; for (let k = 0; k < 10; k++) t += ctx.heightAt({ x: p.x + Math.cos((k / 10) * TAU) * R, y: p.y + Math.sin((k / 10) * TAU) * R }); return t / 10; };
  const cands = gridAround(ctx, c0, encR + 650, 30).filter((p) => !foot.has(p) && dist(p, c0) > encR + 60 && ctx.slopeAt(p) < 0.22)
    .map((p) => ({ p, s: ctx.heightAt(p) - ringH(p, 110) + 0.3 * r.float() }))
    .filter((c) => c.s > 1.2).sort((a, b) => b.s - a.s);
  for (const cd of cands) {
    if (out.length >= n) break;
    if (out.some((o) => dist(polygonCentroid(o.poly), cd.p) < 140)) continue;
    const lot = orientPos(disk(cd.p, 12, 16));
    if (!roadIdx.clear(lot, 4) || [...ai.avoid, ...out.map((o) => o.poly)].some((o) => distToRing(o, cd.p) < 30 || pointInRing(o, cd.p)) || !clearStreets(api, lot, 4)) continue;
    let wet = false;
    for (const q of lot) if (ctx.isWater(q)) wet = true;
    if (wet) continue;
    const acc = accessOrTrack(s, api, lot, cd.p, ai, roadIdx, ai.roads);
    if (!acc) continue;
    const id = 'windmill:' + out.length;
    s.lotData.set(id, { kind: 'windmill', ang: r.range(0, TAU), c: cd.p } as ActData);
    const ph = phaseAt(api, cd.p);
    out.push({ id, kind: 'm4-windmill', poly: lot, phase: ph.phase, zone: ph.zone, cuts: acc.cuts });
    s.sites.push({ id, kind: 'windmill', role: 'activity', lot, entrance: acc.entrance, anchor: cd.p, culture: s.culture });
  }
  return out;
}

/** Tanneries and dyers downstream of the town along the river, at its edge. */
export function reserveTanneries(s: M4State, api: ReserveApi, ai: ActIn): ReservedLot[] {
  const ctx = s.ctx, r = s.rng.fork('tannery');
  const rings = new LineIndex(api.enclosure.map((ph) => ({ path: ph.outer.concat([ph.outer[0]]), hw: 0 })));
  const roadIdx = new LineIndex(ai.roads.map((path) => ({ path, hw: 5 })));
  // the river nearest the nucleus, and the vertex nearest to it: downstream = larger index
  let best: { pl: Polyline; w: number[]; i0: number; d: number } | null = null;
  for (const rv of ctx.terrain.rivers) {
    if (rv.path.length < 10) continue;
    const nn = nearestOnPl(rv.path, ai.nucleus);
    if (!best || nn.d < best.d) best = { pl: rv.path, w: rv.width, i0: nn.i, d: nn.d };
  }
  if (!best || best.d > 700) return [];
  const { pl, w, i0 } = best;
  for (let i = i0 + 4; i < pl.length - 4; i += 2) {
    const p = pl[i], wi = w[i];
    const dEdge = rings.dist(p, 400);
    if (dEdge > 260 || dist(p, ai.nucleus) < 120) continue;
    const a = pl[i - 3], b = pl[i + 3], ang = Math.atan2(b.y - a.y, b.x - a.x);
    for (const side of [1, -1]) {
      const L = r.range(70, 110), D = r.range(30, 38);
      const v0 = wi / 2 - 1;
      const rect = rectAt(p, ang, -L / 2, L / 2, side > 0 ? 0 : -(v0 + D + 2), side > 0 ? v0 + D + 2 : 0);
      // cheap tests first, the boolean with the water last
      let wet = false;
      for (let u = -L / 2 + 4; u <= L / 2 - 4 && !wet; u += 8) if (ctx.isWater(frameAt(p, ang, u, side * (v0 + D)))) wet = true;
      const rc = frameAt(p, ang, 0, side * (v0 + D / 2));
      if (wet || !roadIdx.clear(rect, 3) || ai.avoid.some((o) => distToRing(o, rc) < 30 || pointInRing(o, rc)) || !clearStreets(api, rect, 4) || inLists(s, api, rect)) continue;
      const lot = differenceS(rect, ctx.water).filter((ph) => !ph.holes.length).map((ph) => ph.outer).sort((x, y) => area(y) - area(x))[0];
      if (!lot || area(lot) < 0.5 * area(rect)) continue;
      const toward = frameAt(p, ang, 0, side * (v0 + D + 8));
      const acc = accessOrTrack(s, api, lot, toward, ai, roadIdx, ai.roads);
      if (!acc) continue;
      const id = 'tannery';
      s.lotData.set(id, { kind: 'tannery', ang } as ActData);
      const ph = phaseAt(api, polygonCentroid(lot));
      s.sites.push({ id, kind: 'tannery', role: 'activity', lot, entrance: acc.entrance, anchor: polygonCentroid(lot), culture: s.culture, tags: { trade: 'tanners and dyers' } });
      return [{ id, kind: 'm4-tannery', poly: lot, phase: ph.phase, zone: ph.zone, cuts: acc.cuts }];
    }
  }
  return [];
}

/** Lots beside the roads outside the walls: gallows (high ground), lazar house (far), cemetery (by a gate). */
export function reserveRoadside(s: M4State, api: ReserveApi, ai: ActIn, which: { kind: 'gallows' | 'lazar-house' | 'cemetery'; size: [number, number]; dmin: number; dmax: number }[]): ReservedLot[] {
  const ctx = s.ctx, r = s.rng.fork('roadside');
  const out: ReservedLot[] = [];
  const foot = new Mask(ctx.mapSize, dilate(api.footprint, 12 + (s.listsW ? s.listsW + 6 : 0)), 5);
  const rings = new LineIndex(api.enclosure.map((ph) => ({ path: ph.outer.concat([ph.outer[0]]), hw: 0 })));
  const roadIdx = new LineIndex(ai.roads.map((path) => ({ path, hw: 5 })));
  for (const wch of which) {
    let best: { lot: Polygon; c: Vec2; s: number; ang: number; road: Vec2 } | null = null;
    for (const pl of ai.roads) for (let i = 1; i < pl.length; i += 2) {
      const a = pl[i - 1], b = pl[i], l = dist(a, b) || 1;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const de = rings.dist(a, wch.dmax + 10);
      if (de < wch.dmin || de > wch.dmax) continue;
      for (const side of [1, -1]) {
        const [L, W] = wch.size;
        const off = 9 + W / 2;
        const c = { x: a.x + (-(b.y - a.y) / l) * off * side, y: a.y + ((b.x - a.x) / l) * off * side };
        const lot = rectAt(c, ang, -L / 2, L / 2, -W / 2, W / 2);
        if (lot.some((q) => foot.has(q) || ctx.isWater(q)) || foot.has(c) || ctx.isWater(c) || ctx.slopeAt(c) > 0.25) continue;
        if (!roadIdx.clear(lot, 2) || [...ai.avoid, ...out.map((o) => o.poly)].some((o) => distToRing(o, c) < 25 + L / 2 || pointInRing(o, c))) continue;
        const sc = (wch.kind === 'gallows' ? ctx.heightAt(c) / 3 : 0) - (wch.kind === 'cemetery' ? de / 60 : 0) + r.float() * 0.5;
        if (!best || sc > best.s) best = { lot, c, s: sc, ang, road: a };
      }
    }
    if (!best || !clearStreets(api, best.lot, 3)) continue;
    const id = wch.kind;
    const track = nearestOnPl(orientPos(best.lot), best.road);
    if (dist(track.q, best.road) > 1.5) ai.lines.push({ kind: 'track', path: [track.q, best.road], width: 3 });
    s.lotData.set(id, { kind: wch.kind, ang: best.ang } as ActData);
    const ph = phaseAt(api, best.c);
    out.push({ id, kind: 'm4-' + wch.kind, poly: best.lot, phase: ph.phase, zone: ph.zone, cuts: [] });
    s.sites.push({ id, kind: wch.kind, role: 'activity', lot: best.lot, entrance: track.q, anchor: best.c, culture: s.culture });
  }
  return out;
}

/** Arena: an ellipse at the edge of the core with a ring street round it. */
export function reserveArena(s: M4State, api: ReserveApi, ai: ActIn): ReservedLot | null {
  const r = s.rng.fork('arena');
  const a = r.range(48, 62), b = a * r.range(0.78, 0.86);
  const core = api.phases[0].region;
  const coreM = new Mask(s.ctx.mapSize, dilate(core, 4), 5);
  const encM = new Mask(s.ctx.mapSize, api.enclosure, 5);
  const coreR = Math.sqrt(mpArea(core) / Math.PI);
  const res = siteLot(s.ctx, api.streets, {
    shape: (c, ang) => ellipseAt(c, ang, a, b, 36),
    centers: gridAround(s.ctx, ai.nucleus, coreR + 2.6 * a, 22).filter((p) => !coreM.has(p)),
    angles: [0, Math.PI / 4, Math.PI / 2, -Math.PI / 4], scales: [1], refine: 8,
    outside: coreM, margin: 9, avoid: ai.avoid, gap: 30,
    score: (poly, c) => -Math.abs(dist(c, ai.nucleus) - coreR - a - 12) / 40 + (encM.has(c) ? 2 : 0),
  }, r);
  if (!res) return null;
  const lot = res.poly;
  const acc = giveAccess(s, api, lot, { mode: 'ring', toward: ai.nucleus, width: s.P.widthByRank[2] * s.P.widthScale, rank: 2, maxLen: 220 }, ai.avoid);
  if (!acc) return null;
  s.lotData.set('arena', { kind: 'arena', ang: res.ang, c: res.c, a, b } as ActData);
  const ph = phaseAt(api, res.c);
  s.sites.push({ id: 'arena', kind: 'arena', role: 'civic', lot, entrance: acc.entrance, anchor: res.c, culture: s.culture });
  return { id: 'arena', kind: 'm4-arena', poly: lot, phase: ph.phase, zone: ph.zone, cuts: acc.cuts };
}

// ---------------------------------------------------------------- builders

export function buildWatermill(B: Polygon, cx: CompoundCtx): Out {
  const d = cx.data as MillData | undefined;
  const out = emptyOut();
  if (!d) { out.parcels.push({ poly: B, use: 'mill-yard' }); return out; }
  const { c, ang, side: sg, w, d: dd, Lr } = d;
  const race: Polyline = [
    frameAt(c, ang, -Lr / 2 - 3, sg * (w / 2 - 1)), frameAt(c, ang, -Lr / 2 + 12, sg * dd),
    frameAt(c, ang, Lr / 2 - 12, sg * dd), frameAt(c, ang, Lr / 2 + 3, sg * (w / 2 - 1)),
  ];
  const band = ribbon(race, 4.5);
  const M = rectAt(c, ang, -6.5, 6.5, sg > 0 ? dd - 8.5 : -dd - 8.5, sg > 0 ? dd + 8.5 : -dd + 8.5);
  const mill = inter(M, B);
  const millP = largest(mill);
  if (!millP) { out.parcels.push({ poly: B, use: 'mill-yard' }); return out; }
  for (const q of mill) out.parcels.push({ poly: q, use: 'mill' });
  const raceP = pieces(differenceS(intersectionS(band, B), ...mill.map((q) => [{ outer: q, holes: [] }])));
  for (const q of raceP) { out.parcels.push({ poly: q, use: 'mill-race' }); out.water.push(q); }
  // the rest is B minus exactly the pieces above (one boolean against the same polygons: no slivers)
  for (const q of pieces(differenceS(B, ...[...mill, ...raceP].map((x) => [{ outer: x, holes: [] }])))) {
    const cc = polygonCentroid(q);
    const v = -(cc.x - c.x) * Math.sin(ang) + (cc.y - c.y) * Math.cos(ang);
    out.parcels.push({ poly: q, use: v * sg < dd ? 'mill-island' : 'mill-yard' });
  }
  const mi = out.parcels.findIndex((p) => p.poly === millP);
  const bld = rectAt(c, ang, -5.5, 5.5, sg > 0 ? dd - 7 : -dd - 7, sg > 0 ? dd + 7 : -dd + 7);
  if (fits(millP, bld, 0.2)) out.buildings.push({ poly: bld, kind: 'landmark', parcel: mi, arch: 'watermill', roof: 'gable', material: 'stone', storeys: 2, orientation: ang });
  // the miller's house in the yard
  const yi = out.parcels.findIndex((p) => p.use === 'mill-yard' && area(p.poly) > 150);
  if (yi >= 0) {
    const h = placeRect(out.parcels[yi].poly, frameAt(c, ang, Lr * 0.25, sg * (dd + 10)), ang, 6, 4.5, 1);
    if (h) out.buildings.push({ poly: h, kind: 'landmark', parcel: yi, arch: 'millers-house', roof: 'gable', material: 'timber', storeys: 2, orientation: ang });
  }
  out.landmarks.push({ kind: 'watermill', poly: bld });
  return out;
}

export function buildWindmill(B: Polygon, cx: CompoundCtx): Out {
  const d = cx.data as ActData | undefined;
  const out = emptyOut();
  out.parcels.push({ poly: B, use: 'windmill-mound' });
  const c = d?.c ?? inscribed(B, [], 1).c;
  const tower = orientPos(disk(c, 4.2, 12));
  if (fits(B, tower, 0.5)) out.buildings.push({ poly: tower, kind: 'landmark', parcel: 0, arch: 'windmill', roof: 'dome', material: 'stone', storeys: 3 });
  const a0 = d?.ang ?? 0;
  for (let k = 0; k < 4; k++) {
    const a = a0 + (k * Math.PI) / 2;
    out.lines.push({ kind: 'sail', path: [{ x: c.x + Math.cos(a) * 4.5, y: c.y + Math.sin(a) * 4.5 }, { x: c.x + Math.cos(a) * 11, y: c.y + Math.sin(a) * 11 }], width: 1.1 });
  }
  out.landmarks.push({ kind: 'windmill', poly: tower });
  return out;
}

export function buildTannery(B: Polygon, cx: CompoundCtx): Out {
  const d = cx.data as ActData | undefined;
  const out = emptyOut();
  out.parcels.push({ poly: B, use: 'tannery-yard' });
  const ang = d?.ang ?? 0;
  const o = obb(B);
  const c = o.c;
  // sheds perpendicular to the river (along v), every 12–13 m along u, drying yards between
  const pitch = cx.rng.range(12, 13.5);
  for (let u = -o.hu + 6; u <= o.hu - 6; u += pitch) {
    const shed = placeRect(B, frameAt(c, ang, u, 0), ang + Math.PI / 2, Math.min(12, o.hv - 4), 3.2, 1);
    if (shed && !out.buildings.some((b) => intersectionS(b.poly, shed).some((ph) => area(ph.outer) > 0.05))) out.buildings.push({ poly: shed, kind: 'landmark', parcel: 0, arch: 'tannery-shed', roof: 'gable', material: 'timber', storeys: 1, orientation: ang + Math.PI / 2 });
  }
  return out;
}

export function buildGallows(B: Polygon, cx: CompoundCtx): Out {
  const out = emptyOut();
  out.parcels.push({ poly: B, use: 'gallows-hill' });
  const c = inscribed(B, [], 1).c;
  const R = 3.2;
  const pts = [0, 1, 2].map((k) => ({ x: c.x + Math.cos(-Math.PI / 2 + (k * TAU) / 3) * R, y: c.y + Math.sin(-Math.PI / 2 + (k * TAU) / 3) * R }));
  out.lines.push({ kind: 'gallows', path: pts, closed: true, width: 0.9 });
  out.landmarks.push({ kind: 'gallows', poly: orientPos(disk(c, 5, 10)) });
  void cx;
  return out;
}

export function buildLazarHouse(B: Polygon, cx: CompoundCtx): Out {
  const d = cx.data as ActData | undefined;
  const out = emptyOut();
  out.parcels.push({ poly: B, use: 'compound:lazar-house' });
  const ang = d?.ang ?? 0;
  const o = obb(B);
  let east = ang;
  while (east > Math.PI / 4) east -= Math.PI / 2;
  while (east < -Math.PI / 4) east += Math.PI / 2;
  const ch = placeRect(B, frameAt(o.c, ang, -o.hu * 0.4, -o.hv * 0.3), east, 8, 3.8, 2);
  if (ch) out.buildings.push({ poly: ch, kind: 'church', parcel: 0, arch: 'lazar-chapel', roof: 'gable', material: 'stone', storeys: 1, orientation: east });
  const ward = placeRect(B, frameAt(o.c, ang, o.hu * 0.25, o.hv * 0.25), ang, 11, 4, 2);
  if (ward && !(ch && intersectionS(ch, ward).length)) out.buildings.push({ poly: ward, kind: 'landmark', parcel: 0, arch: 'lazar-ward', roof: 'gable', material: 'timber', storeys: 1, orientation: ang });
  out.lines.push({ kind: 'compound-wall', path: orientPos(B), closed: true, width: 0.9 });
  out.landmarks.push({ kind: 'lazar-house', poly: B });
  void cx;
  return out;
}

export function buildCemetery(B: Polygon, cx: CompoundCtx): Out {
  const d = cx.data as ActData | undefined;
  const out = emptyOut();
  out.parcels.push({ poly: B, use: 'cemetery' });
  out.landmarks.push({ kind: 'cemetery', poly: B });
  const o = obb(B);
  const ch = placeRect(B, o.c, d?.ang ?? 0, 4.5, 3.5, 2);
  if (ch) out.buildings.push({ poly: ch, kind: 'church', parcel: 0, arch: 'cemetery-chapel', roof: 'gable', material: 'stone', storeys: 1 });
  out.lines.push({ kind: 'compound-wall', path: orientPos(B), closed: true, width: 0.9 });
  void cx;
  return out;
}

/** Arena fossilized as an oval of houses (Lucca, Arles): piazza inside, cavea cut radially into house plots. */
export function buildArena(B: Polygon, cx: CompoundCtx): Out {
  const d = cx.data as ActData | undefined;
  const out = emptyOut();
  if (!d || !d.c || !d.a || !d.b) { out.parcels.push({ poly: B, use: 'place' }); return out; }
  const { c, ang } = d;
  const a = d.a, b = d.b;
  const k = 0.58;
  const piazza = ellipseAt(c, ang, a * k, b * k, 36);
  const pz = inter(piazza, B);
  // the cavea is an annulus (one polygon with the piazza as its hole); the radial wedges cut it into simple plots
  const cavea = differenceS(B, piazza);
  if (cavea.length !== 1 || !pz.length) { out.parcels.push({ poly: B, use: 'place' }); return out; }
  for (const p of pz) out.parcels.push({ poly: p, use: 'place' });
  out.landmarks.push({ kind: 'arena-piazza', poly: piazza });
  // radial cuts: n plots round the cavea (frontage ~ 9–12 m on the ring street)
  const per = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  const n = Math.max(12, Math.round(per / cx.rng.range(9.5, 12)));
  const a0 = cx.rng.range(0, TAU);
  // a gateway (vomitorium) left open on the axis: one plot is a passage
  for (let i = 0; i < n; i++) {
    const t0 = a0 + (i / n) * TAU, t1 = a0 + ((i + 1) / n) * TAU;
    const p0 = frameAt(c, ang, a * 1.6 * Math.cos(t0), b * 1.6 * Math.sin(t0)), p1 = frameAt(c, ang, a * 1.6 * Math.cos(t1), b * 1.6 * Math.sin(t1));
    const wedge = orientPos([c, p0, p1]);
    for (const q of pieces(intersectionS(cavea, wedge))) {
      const pi = out.parcels.length;
      const passage = i === 0 || i === Math.floor(n / 2);
      // frontage: the outer arc chord
      const f0 = frameAt(c, ang, a * Math.cos(t0), b * Math.sin(t0)), f1 = frameAt(c, ang, a * Math.cos(t1), b * Math.sin(t1));
      out.parcels.push({ poly: q, use: passage ? 'place' : 'arena-plot' });
      if (passage) continue;
      // the house fills the outer part of the plot (depth 12–15 m), the inner part is its yard on the piazza side
      const dep = cx.rng.range(12, 15);
      const band = differenceS(q, ellipseAt(c, ang, Math.max(a * k + 1, a - dep), Math.max(b * k + 1, b - dep), 48));
      const h = largest(pieces(band));
      if (h && area(h) > 25) out.buildings.push({ poly: h, kind: 'house', parcel: pi, arch: 'arena-house', roof: 'gable', material: 'stone', storeys: 3, orientation: Math.atan2(f1.y - f0.y, f1.x - f0.x) });
    }
  }
  out.landmarks.push({ kind: 'arena', poly: ellipseAt(c, ang, a, b, 36) });
  return out;
}

export { splitLine, minus };
