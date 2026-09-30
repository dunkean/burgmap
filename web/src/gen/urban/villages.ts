/**
 * Villages and hamlets (URBAN_GEOMETRY.md §5): same kernel, different top level.
 * - hamlet: farmsteads cut as wide plots from a strip along the track through the site;
 * - street village (Strassendorf): one axis street with deep farm plots on both sides (and field lanes);
 * - nucleated village: handled by the town planner with one 'village' phase and short ribbons.
 */
import type { Vec2, Polyline } from '../core/geom';
import { dist, polylineLength } from '../core/geom';
import type { Rng } from '../core/rng';
import type { UrbanCtx } from './context';
import type { PhasePlan } from './phases';
import { MultiPoly, differenceS as difference } from '../geo/bool';
import { ribbon } from '../geo/offset';
import { pointInRing, area } from '../geo/poly';

export interface RoadIn { path: Polyline; major: boolean }

/** The through-route at the site: the two roads reaching the center that are most opposite, joined. */
export function throughRoute(center: Vec2, roads: RoadIn[]): { route: Polyline; sc: number } | null {
  const reach = roads.filter((r) => dist(r.path[r.path.length - 1], center) < 10 && r.path.length >= 2);
  if (!reach.length) return null;
  const dirOf = (pl: Polyline) => {
    let q = pl[0];
    let acc = 0;
    for (let i = pl.length - 1; i > 0; i--) { acc += dist(pl[i], pl[i - 1]); q = pl[i - 1]; if (acc > 120) break; }
    return Math.atan2(q.y - center.y, q.x - center.x);
  };
  let best: [RoadIn, RoadIn | null] = [reach[0], null], bs = -1;
  for (let i = 0; i < reach.length; i++) for (let j = i + 1; j < reach.length; j++) {
    let d = Math.abs(dirOf(reach[i].path) - dirOf(reach[j].path)) % (2 * Math.PI);
    if (d > Math.PI) d = 2 * Math.PI - d;
    const sc = d + (reach[i].major ? 0.3 : 0) + (reach[j].major ? 0.3 : 0);
    if (sc > bs) { bs = sc; best = [reach[i], reach[j]]; }
  }
  const a = best[0].path;
  const route = best[1] ? a.concat(best[1].path.slice(0, -1).reverse()) : a.slice();
  return { route, sc: polylineLength(a) };
}

function sliceByLength(pl: Polyline, s0: number, s1: number): Polyline {
  const out: Vec2[] = [];
  let acc = 0;
  for (let i = 1; i < pl.length; i++) {
    const a = pl[i - 1], b = pl[i];
    const l = dist(a, b);
    const lerp = (s: number) => ({ x: a.x + ((b.x - a.x) * (s - acc)) / (l || 1), y: a.y + ((b.y - a.y) * (s - acc)) / (l || 1) });
    if (acc + l >= s0 && acc <= s1) {
      if (!out.length) out.push(lerp(Math.max(s0, acc)));
      if (acc + l <= s1) out.push(b);
      else { out.push(lerp(s1)); break; }
    }
    acc += l;
  }
  return out;
}

export function planRibbonVillage(ctx: UrbanCtx, roads: RoadIn[], pop: number, kind: 'hamlet' | 'street-village', rng: Rng): { phases: PhasePlan[]; enclosure: MultiPoly } | null {
  const tr = throughRoute(ctx.center, roads);
  if (!tr) return null;
  const farms = kind === 'hamlet' ? Math.max(3, Math.min(15, Math.round(pop / 9))) : Math.max(12, Math.round(pop / 6.5));
  const front = kind === 'hamlet' ? 40 : 26;
  const L = Math.min(kind === 'hamlet' ? 420 : 1100, (farms * front) / 2 + 30);
  const f = rng.range(0.75, 1.25);
  let s0 = Math.max(0, tr.sc - (L / 2) * f), s1 = Math.min(polylineLength(tr.route), tr.sc + (L / 2) * (2 - f));
  let seg = sliceByLength(tr.route, s0, s1);
  // stay on dry, not too steep ground: shorten from the center outward
  const cidx = seg.reduce((bi, p, i) => (dist(p, ctx.center) < dist(seg[bi], ctx.center) ? i : bi), 0);
  let lo = cidx, hi = cidx;
  while (lo > 0 && !ctx.isWater(seg[lo - 1]) && ctx.slopeAt(seg[lo - 1]) < 0.25) lo--;
  while (hi < seg.length - 1 && !ctx.isWater(seg[hi + 1]) && ctx.slopeAt(seg[hi + 1]) < 0.25) hi++;
  seg = seg.slice(lo, hi + 1);
  if (seg.length < 2 || polylineLength(seg) < 60) return null;
  void s0; void s1;
  const depth = kind === 'hamlet' ? rng.range(55, 75) : rng.range(62, 90);
  const rb = ribbon(seg, 2 * depth);
  let region: MultiPoly = [{ outer: rb, holes: [] }];
  if (ctx.water.length) region = difference(region, ctx.water);
  // keep the component at the center (plus large ones across a brook)
  const main = region.find((ph) => pointInRing(ph.outer, ctx.center)) ?? region[0];
  region = region.filter((ph) => ph === main || area(ph.outer) > 0.25 * area(main.outer));
  if (!region.length) return null;
  const phases: PhasePlan[] = [{ id: 1, kind: 'village', zone: 'village', region, band: region, age: 0.5, fossil: false, walled: false, pop }];
  return { phases, enclosure: region };
}
