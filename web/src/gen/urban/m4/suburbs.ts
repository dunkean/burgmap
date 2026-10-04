/**
 * Suburbs (URBAN_LANDMARKS.md §3): faubourgs thicken into suburbs (deeper, longer ribbons whose quarters get
 * their own secondary streets), get a later outer enclosure of straight curtains for a city (the old wall line
 * fossilizes into a ring street), and absorb the villages that stood on the roads beyond them: an irregular old
 * core around a green, inside the suburban fabric.
 */
import type { Vec2, Polygon, Polyline } from '../../core/geom';
import { dist, polygonCentroid, chaikin } from '../../core/geom';
import type { Rng } from '../../core/rng';
import type { UrbanCtx } from '../context';
import type { EnclosurePlan, RoadIn } from '../phases';
import { dilate } from '../phases';
import { fortifyRegion } from '../fortify';
import { MultiPoly, unionS, intersectionS, differenceS, mpArea, tryIntersection, tryDifference } from '../../geo/bool';
import { area, pointInRing, orientPos, cleanRing, obb, isSimple } from '../../geo/poly';
import { ribbon, sweepLeft } from '../../geo/offset';
import type { ReserveApi, ReservedLot } from '../primary';
import { inMP, plAt, plLen, nearestOnPl, clearOfStreets, polysNear, TAU } from './lots';
import { phaseAt, type M4State } from './reserve';

/** A roadside place uses a length of road, not the number/density of its sampled vertices. */
export function villageGreen(core: Polygon, road: Polyline, center: Vec2, depth: number, side: number): Polygon | null {
  if (road.length < 2) return null;
  const nn = nearestOnPl(road, center);
  let s = dist(road[nn.i - 1], nn.q);
  for (let i = 1; i < nn.i; i++) s += dist(road[i - 1], road[i]);
  const start = Math.max(0, s - 32), end = Math.min(plLen(road), s + 32);
  if (end - start < 40) return null;
  const sub = [plAt(road, start).p];
  let acc = 0;
  for (let i = 1; i < road.length; i++) {
    acc += dist(road[i - 1], road[i]);
    if (acc > start + 1e-6 && acc < end - 1e-6) sub.push(road[i]);
  }
  sub.push(plAt(road, end).p);
  const path = side > 0 ? sub : sub.slice().reverse();
  const swept = sweepLeft(path, path.map(() => depth));
  const clipped = tryIntersection(swept, core);
  if (clipped.failed) return null;
  const pieces = clipped.pieces.filter((p) => !p.holes.length).sort((a, b) => area(b.outer) - area(a.outer));
  for (const p of pieces) {
    const ring = orientPos(cleanRing(p.outer, 0.01, 0.01, Infinity, false));
    const o = obb(ring);
    // Reject clipped tips: an absorbed village needs a usable place rather than a leftover triangle.
    if (ring.length < 4 || !isSimple(ring) || area(ring) < 700 || 2 * o.hv < 18 || o.hu / o.hv > 3) continue;
    // The selected component must retain its road edge after containment clipping.
    const frontage = ring.reduce((sum, a, i) => {
      const b = ring[(i + 1) % ring.length];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      return sum + (nearestOnPl(path, a).d < 0.01 && nearestOnPl(path, b).d < 0.01 && nearestOnPl(path, m).d < 0.01 ? dist(a, b) : 0);
    }, 0);
    const outside = tryDifference(ring, core);
    if (frontage >= 20 && !outside.failed && mpArea(outside.pieces) < 1e-6) return ring;
  }
  return null;
}

/** Wraps the walled town and its nearest suburbs in a later polygonal enclosure; the old line fossilizes. */
export function outerEnclosure(ctx: UrbanCtx, ep: EnclosurePlan, faub: MultiPoly, pop: number): boolean {
  if (!faub.length || !ep.enclosure.length) return false;
  // the new circuit takes in the suburbs and the gardens around them (not long tails along the roads): the
  // suburbs near the old wall, widened by 90 m, within 170 m of the old wall
  const near = intersectionS(faub, dilate(ep.enclosure, 200));
  if (mpArea(near) < 15000) return false;
  const lobes = intersectionS(dilate(near, 90), dilate(ep.enclosure, 170));
  let R = fortifyRegion(ctx, unionS(ep.enclosure, lobes), ep.enclosure);
  const c = ctx.center;
  R = R.filter((ph) => pointInRing(ph.outer, c) || ep.enclosure.some((e) => pointInRing(ph.outer, e.outer[0])));
  if (!R.length) return false;
  R = R.map((ph) => ({ outer: ph.outer, holes: [] }));
  const band = differenceS(R, ep.enclosure).filter((ph) => area(ph.outer) > 400);
  if (mpArea(band) < 10000) return false;
  const n = ep.phases.length;
  const last = ep.phases[n - 1];
  last.walled = false;
  last.fossil = true;
  ep.phases.push({ id: n + 1, kind: 'ring', zone: 'faubourg', region: R, band, age: 0.15, fossil: false, walled: true, pop: pop * 0.12 });
  ep.enclosure = R;
  return true;
}

export interface Village { c: Vec2; core: Polygon; road: Polyline }

/**
 * Villages on the roads just beyond the suburbs (the rural stage's hamlets the town absorbed): an irregular core
 * blob around the road, joined to the suburb by a ribbon along the road. Returns the villages (their cores are
 * added to the faubourg region by the caller).
 */
export function absorbedVillages(ctx: UrbanCtx, enclosure: MultiPoly, faub: MultiPoly, roads: RoadIn[], n: number, rng: Rng): Village[] {
  const out: Village[] = [];
  const inside = (p: Vec2) => inMP(enclosure, p);
  const cands: { pl: Polyline; s: number }[] = [];
  for (const rd of roads) {
    const pl = rd.path; // map edge → centre
    let entry = -1;
    for (let i = 0; i < pl.length; i++) if (inside(pl[i])) { entry = i; break; }
    if (entry <= 0) continue;
    const outward = pl.slice(0, entry + 1).reverse();
    // the end of the faubourg ribbon along this road
    let sEnd = 0;
    const cum = [0];
    for (let i = 1; i < outward.length; i++) cum.push(cum[i - 1] + dist(outward[i - 1], outward[i]));
    for (let i = 0; i < outward.length; i++) if (inMP(faub, outward[i])) sEnd = cum[i];
    cands.push({ pl: outward, s: sEnd + rng.range(70, 150) });
  }
  cands.sort((a, b) => a.s - b.s);
  for (const cd of cands) {
    if (out.length >= n) break;
    if (cd.s > plLen(cd.pl) - 60) continue;
    const c = plAt(cd.pl, cd.s).p;
    if (ctx.isWater(c) || ctx.slopeAt(c) > 0.2 || c.x < 100 || c.y < 100 || c.x > ctx.mapSize - 100 || c.y > ctx.mapSize - 100) continue;
    if (out.some((v) => dist(v.c, c) < 300)) continue;
    // irregular core: a noisy disc of 60–95 m
    const R0 = rng.range(60, 95);
    const a0 = rng.range(0, TAU);
    const pts: Vec2[] = [];
    for (let k = 0; k < 12; k++) {
      const a = a0 + (k / 12) * TAU, r = R0 * rng.range(0.72, 1.2);
      pts.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
    }
    let core = orientPos(cleanRing(chaikin(pts, 2, true), 0.5, 2));
    let m: MultiPoly = [{ outer: core, holes: [] }];
    if (ctx.water.length) m = differenceS(m, ctx.water);
    m = differenceS(m, dilate(enclosure, 20));
    const big = m.filter((ph) => !ph.holes.length && pointInRing(ph.outer, c));
    if (!big.length || area(big[0].outer) < 6000) continue;
    core = big[0].outer;
    // the ribbon that joins it to the suburb
    const sub = cd.pl.filter((_, i) => i === 0 || dist(cd.pl[i], c) < cd.s + 5);
    out.push({ c, core, road: sub });
  }
  return out;
}

/** Joins the village cores to the faubourg region (a 30 m road ribbon between them). */
export function joinVillages(faub: MultiPoly, villages: Village[], enclosure: MultiPoly, ctx: UrbanCtx): MultiPoly {
  if (!villages.length) return faub;
  const parts: MultiPoly = [];
  for (const v of villages) {
    parts.push({ outer: v.core, holes: [] });
    const near = nearestOnPl(v.road, v.c);
    const rb = ribbon(v.road.slice(0, near.i + 1), 60);
    if (rb.length >= 3) parts.push({ outer: rb, holes: [] });
  }
  let m = unionS(faub, parts);
  m = differenceS(m, dilate(enclosure, 20));
  if (ctx.water.length) m = differenceS(m, ctx.water);
  return m.filter((ph) => area(ph.outer) > 1500);
}

/** The village cores as quarters of their own (zone village) and a green on the road at their centre. */
export function reserveVillages(s: M4State, api: ReserveApi, villages: Village[], avoid: Polygon[], cityPlaces = false): ReservedLot[] {
  const out: ReservedLot[] = [];
  villages.forEach((v, k) => {
    const core = v.core;
    if (avoid.some((a) => polysNear(core, a, 0))) return;
    // the green: a one-sided sweep off the radial through the village (its edge is the street centre line)
    let best: { id: number; pl: Polyline } | null = null, bd = 40;
    for (const st of api.streets.list) {
      if (!st.ribbon || st.role !== 'radial') continue;
      const nn = nearestOnPl(st.path, v.c);
      if (nn.d < bd) { bd = nn.d; best = { id: st.id, pl: st.path }; }
    }
    const lots: ReservedLot[] = [];
    if (best) {
      if (cityPlaces) {
        const depth = s.rng.fork('green:' + k).range(26, 36);
        for (const side of [1, -1]) {
          const sw = villageGreen(core, best.pl, v.c, depth, side);
          if (!sw || !clearOfStreets(sw, api.streets, 3, new Set([best.id])) || avoid.some((a) => polysNear(sw, a, 4))) continue;
          // A place must survive the later natural-water clipping as a whole usable component.
          if (s.ctx.water.length && mpArea(intersectionS(sw, s.ctx.water)) > 0.01) continue;
          const ph = phaseAt(api, polygonCentroid(sw));
          lots.push({ id: 'green:' + k, kind: 'm4-green', poly: sw, phase: ph.phase, zone: 'village', cuts: [], piece: 'place' });
          break;
        }
      } else {
        const nn = nearestOnPl(best.pl, v.c);
        const sub: Vec2[] = [];
        for (let i = 0; i < best.pl.length; i++) if (dist(best.pl[i], nn.q) < 38) sub.push(best.pl[i]);
        if (sub.length >= 3 && plLen(sub) > 40) {
          const depth = s.rng.fork('green:' + k).range(26, 36);
          for (const side of [1, -1]) {
            const sw = side > 0 ? sweepLeft(sub, sub.map(() => depth)) : sweepLeft(sub.slice().reverse(), sub.map(() => depth));
            if (sw.length < 3 || !pointInRing(core, polygonCentroid(sw)) || !clearOfStreets(sw, api.streets, 3, new Set([best.id]))) continue;
            if (avoid.some((a) => polysNear(sw, a, 4))) continue;
            const ph = phaseAt(api, polygonCentroid(sw));
            lots.push({ id: 'green:' + k, kind: 'm4-green', poly: orientPos(sw), phase: ph.phase, zone: 'village', cuts: [], piece: 'place' });
            break;
          }
        }
      }
    }
    const ph = phaseAt(api, v.c);
    // the green first: the later lots are cut by the earlier ones
    out.push(...lots);
    out.push({ id: 'village:' + k, kind: 'village', poly: core, phase: ph.phase, zone: 'village', cuts: [], piece: 'quarter' });
    s.sites.push({ id: 'village:' + k, kind: 'absorbed-village', role: 'suburb', lot: core, anchor: v.c, culture: s.culture });
  });
  return out;
}

/** The outline of a set of blocks (their union), as wall lines of a walled quarter (mellah, ward). */
export function quarterWall(blocks: Polygon[]): Polyline[] {
  if (!blocks.length) return [];
  const u = unionS(blocks[0], ...blocks.slice(1).map((b) => [{ outer: b, holes: [] }]));
  const out: Polyline[] = [];
  for (const ph of u) if (area(ph.outer) > 2000) out.push(ph.outer.concat([ph.outer[0]]));
  return out;
}

export { pointInRing };
