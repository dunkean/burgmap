/**
 * Settlements planned without streets (POLISH.md "New cultures"): camps, kraals, barbarian and native villages,
 * pueblos. A culture with a `camp` spec is planned here instead of by the street engine. The layouts share the
 * camp kit (exact partition: quarter → path cuts → blocks → lot cells → footprints inside their lot) and produce
 * an ordinary UrbanLayer, so rendering, rural land use, names and the invariant checks work unchanged.
 *
 * Scale: a culture declares its settlement classes (`scale`). Above its maximum a village-only culture degrades
 * gracefully: up to 1.5 × the class bound it is one large village; beyond, a cluster of villages (a confederation,
 * a gathering of camp circles) placed on dry ground around the site, linked by tracks.
 */
import type { Vec2, Polygon, Polyline } from '../../core/geom';
import { dist, polygonCentroid } from '../../core/geom';
import type { Rng } from '../../core/rng';
import type { World, UrbanLayer, UrbanLine, PolyH, Archetype } from '../../types';
import type { Culture } from '../culture';
import { scaleMaxPop } from '../culture';
import { resolveMorph } from '../morphology';
import { makeCtx, type UrbanCtx } from '../context';
import { differenceS, unionS, unionMany, MultiPoly } from '../../geo/bool';
import { area, pointInRing } from '../../geo/poly';
import { disk } from '../../geo/offset';
import { CampOut, blockInfo } from './kit';
import { ringCamp, RING_VARIANTS } from './ring';
import { yardsVillage, YARD_VARIANTS } from './yards';
import { longhouseVillage } from './longhouses';
import { puebloSettlement } from './pueblo';
import { ringFort } from './ringfort';
import { khmerCity } from './khmer';

export interface CampSpec {
  layout: 'ring' | 'yards' | 'longhouses' | 'pueblo' | 'ringfort' | 'khmer';
  variant: string;
}

/** What a layout receives: the shared context, the site of this camp, its population and the regional roads. */
export interface CampCtx {
  ctx: UrbanCtx;
  world: World;
  culture: Culture;
  roads: Polyline[];
  /** True for the main camp (the others of a cluster are satellites). */
  main: boolean;
  /** Direction (radians) of the main regional road leaving the site. */
  roadAngle: number;
  /** Sprawl factor (0.5 … 2): looser camps, larger yards, houses further apart. */
  sprawl: number;
}

/** Direction of the longest regional road reaching the site centre. */
function mainRoadAngleOf(world: World): number {
  const c = world.site!.center;
  let best = 0, bl = -1;
  for (const rd of world.roads ?? []) {
    if (rd.kind === 'track') continue;
    const pl = rd.path;
    if (dist(pl[pl.length - 1], c) > 10) continue;
    const q = pl[Math.max(0, pl.length - 12)];
    if (pl.length > bl) { bl = pl.length; best = Math.atan2(q.y - c.y, q.x - c.x); }
  }
  return best;
}

/** Approximate outer radius (m) of a camp of `pop` inhabitants (for the cluster placement). */
function campRadius(spec: CampSpec, pop: number): number {
  switch (spec.layout) {
    case 'ring': return RING_VARIANTS[spec.variant]?.radius(pop) ?? 60;
    case 'yards': return YARD_VARIANTS[spec.variant]?.radius(pop) ?? 80;
    case 'longhouses': return 30 + Math.sqrt(pop * 22 / Math.PI) * 1.15;
    case 'pueblo': return 40 + Math.sqrt(pop * 30 / Math.PI) * 1.6;
    case 'khmer': return Math.sqrt((pop / 62) * 1e4) / 2 + 60;
    case 'ringfort': return 50 + Math.sqrt(Math.ceil(Math.min(48, pop / 22) / 4)) * 40;
    default: return 80;
  }
}

/** Downhill direction (radians) at p over radius R, or null on flat ground. */
export function downhill(ctx: UrbanCtx, p: Vec2, R: number): number | null {
  let lo = Infinity, hi = -Infinity, la = 0;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * 2 * Math.PI;
    const h = ctx.heightAt({ x: p.x + Math.cos(a) * R, y: p.y + Math.sin(a) * R });
    if (h < lo) { lo = h; la = a; }
    hi = Math.max(hi, h);
  }
  return hi - lo > 1.2 ? la : null;
}

/** Dry, gentle ground for a disc of radius r around p (share of samples). */
function dryShare(ctx: UrbanCtx, p: Vec2, r: number): number {
  let ok = 0, n = 0;
  for (const f of [0, 0.5, 1]) for (let k = 0; k < (f ? 16 : 1); k++) {
    const a = (k / 16) * 2 * Math.PI;
    const q = { x: p.x + Math.cos(a) * r * f, y: p.y + Math.sin(a) * r * f };
    n++;
    if (q.x < 10 || q.y < 10 || q.x > ctx.mapSize - 10 || q.y > ctx.mapSize - 10) continue;
    if (!ctx.isWater(q) && ctx.slopeAt(q) < 0.22) ok++;
  }
  return ok / n;
}

/** Sites of the satellite camps of a cluster: dry discs around the main one, preferably near the roads. */
function clusterSites(ctx: UrbanCtx, c: Vec2, roads: Polyline[], r0: number, radii: number[], rng: Rng, dryMin = 0.8): Vec2[] {
  const placed: { p: Vec2; r: number }[] = [{ p: c, r: r0 }];
  for (const r of radii) {
    let best: Vec2 | null = null, bs = -Infinity;
    for (let ring = 0; ring < 7; ring++) for (let k = 0; k < 24; k++) {
      const a = (k / 24) * 2 * Math.PI + rng.range(-0.1, 0.1);
      const d = r0 + r + 45 + ring * 70 + rng.range(0, 25);
      const p = { x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d };
      if (p.x < r + 20 || p.y < r + 20 || p.x > ctx.mapSize - r - 20 || p.y > ctx.mapSize - r - 20) continue;
      if (placed.some((q) => dist(q.p, p) < q.r + r + 40)) continue;
      const dry = dryShare(ctx, p, r);
      if (dry < dryMin) continue;
      let dRoad = 1e9;
      for (const pl of roads) for (const q of pl) dRoad = Math.min(dRoad, dist(q, p));
      const s = dry * 2 - d / 600 - Math.max(0, dRoad - r - 30) / 250 + rng.float() * 0.2;
      if (s > bs) { bs = s; best = p; }
    }
    if (!best) break;
    placed.push({ p: best, r });
  }
  return placed.slice(1).map((x) => x.p);
}

function plan(cc: CampCtx, spec: CampSpec, c: Vec2, pop: number, rng: Rng): CampOut {
  switch (spec.layout) {
    case 'ring': return ringCamp(cc, c, pop, RING_VARIANTS[spec.variant] ?? RING_VARIANTS.kraal, rng);
    case 'yards': return yardsVillage(cc, c, pop, YARD_VARIANTS[spec.variant] ?? YARD_VARIANTS.germanic, rng);
    case 'longhouses': return longhouseVillage(cc, c, pop, rng);
    case 'pueblo': return puebloSettlement(cc, c, pop, rng);
    case 'ringfort': return ringFort(cc, c, pop, rng);
    case 'khmer': return khmerCity(cc, c, pop, rng);
    default: return ringCamp(cc, c, pop, RING_VARIANTS.kraal, rng);
  }
}

export interface CampResult { layer: UrbanLayer; stats: Record<string, number | string> }

/** Plans a camp-culture settlement (one camp, a large village, or a cluster of villages) as an UrbanLayer. */
export function generateCamp(world: World, root: Rng, culture: Culture, pop0: number): CampResult {
  const t0 = performance.now();
  const spec = culture.camp as CampSpec;
  const sprawl = Math.max(0.5, Math.min(2, world.options.sprawl ?? 1));
  const rng = root.fork('camp');
  const morph = resolveMorph(culture.core.morphology);
  const maxPop = scaleMaxPop(culture.scale?.max ?? 'megacity');
  // above the culture's class: a large village (≤ 1.5 × the bound), else a cluster of villages
  let pops: number[] = [pop0];
  if (pop0 > maxPop * 1.5) {
    const n = Math.min(6, Math.max(2, Math.ceil(pop0 / (maxPop * 0.75))));
    const each = Math.min(maxPop, Math.round(pop0 / n));
    pops = Array.from({ length: n }, (_, k) => Math.round(each * (k === 0 ? 1.15 : 0.85 + 0.3 * rng.fork('cl:' + k).float())));
  }
  const rk = Math.sqrt(sprawl);
  const r0 = campRadius(spec, pops[0]) * rk;
  const ctx = makeCtx(world, morph, Math.min(world.mapSize / 2, 2.2 * r0 + 600 + (pops.length > 1 ? 900 : 0)));
  const roads = (world.roads ?? []).filter((r) => r.kind !== 'track').map((r) => r.path);
  const roadAngle = mainRoadAngleOf(world);
  // the main camp stands on dry ground: beside the stream rather than astride it (a short way leads from the road)
  let main = ctx.center;
  const rDry = r0 * (spec.layout === 'yards' || spec.layout === 'longhouses' ? 1.3 : spec.layout === 'khmer' ? 1.15 : 1.05);
  if (dryShare(ctx, main, rDry) < 0.97) {
    let bs = -Infinity;
    const sr = rng.fork('dry');
    for (let ring = 1; ring <= 10; ring++) for (let k = 0; k < 20; k++) {
      const a = (k / 20) * 2 * Math.PI + sr.range(-0.1, 0.1);
      const d = ring * Math.max(25, r0 * 0.22);
      const p = { x: ctx.center.x + Math.cos(a) * d, y: ctx.center.y + Math.sin(a) * d };
      if (p.x < r0 + 20 || p.y < r0 + 20 || p.x > ctx.mapSize - r0 - 20 || p.y > ctx.mapSize - r0 - 20) continue;
      const dry = dryShare(ctx, p, rDry);
      const s = (dry >= 0.97 ? 2 : dry) - d / (4 * r0 + 400);
      if (s > bs) { bs = s; main = p; }
    }
  }
  const centers: Vec2[] = [main];
  if (pops.length > 1) centers.push(...clusterSites(ctx, main, roads, r0 * 1.3, pops.slice(1).map((p) => campRadius(spec, p) * rk * 1.3), rng.fork('cluster'), spec.variant === 'norse' ? 0.45 : 0.8));
  pops = pops.slice(0, centers.length);
  const parts: CampOut[] = centers.map((c, k) => plan({ ctx, world, culture, roads, main: k === 0, roadAngle, sprawl }, spec, c, pops[k], rng.fork('part:' + k)));
  // tracks from each satellite to the main camp (a trampled way, drawn as a plan line), and from the road's end
  const extraLines: UrbanLine[] = [];
  if (dist(main, ctx.center) > r0 * 0.6) {
    const L = dist(main, ctx.center);
    const ux = (main.x - ctx.center.x) / L, uy = (main.y - ctx.center.y) / L;
    if (L > r0 + 4) extraLines.push({ kind: 'track', path: [ctx.center, { x: main.x - ux * (r0 - 2), y: main.y - uy * (r0 - 2) }], width: 3 });
  }
  for (let k = 1; k < centers.length; k++) {
    const a = centers[k], b = centers[0];
    const L = dist(a, b);
    const ra = campRadius(spec, pops[k]) * rk, rb = r0;
    if (L <= ra + rb) continue;
    const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
    extraLines.push({ kind: 'track', path: [{ x: a.x + ux * ra, y: a.y + uy * ra }, { x: b.x - ux * rb, y: b.y - uy * rb }], width: 2.6 });
  }
  const pop = pops.reduce((s, p) => s + p, 0);
  const archetype: Archetype = pop < 200 ? 'hamlet' : (spec.layout === 'pueblo' || spec.layout === 'khmer' || spec.variant === 'maya') && pops[0] >= 1200 ? 'town' : 'nucleated-village';
  const layer = assemble(world, parts, culture, morph.id, pop, archetype, ctx.water);
  layer.lines = [...extraLines, ...(layer.lines ?? [])];
  const stats: Record<string, number | string> = {
    pop, archetype, walled: layer.walls?.length ? 1 : 0, morphology: morph.id, culture: culture.id, camps: parts.length,
    blocks: layer.blocks.length, plots: layer.parcels.filter((p) => p.use === 'plot').length, buildings: layer.buildings.length,
  };
  if (pop !== pop0) stats['scale.requested'] = pop0;
  stats['ms.urban'] = Math.round(performance.now() - t0);
  return { layer, stats };
}

/** Merges the camps (local indices) into one urban layer. */
export function assemble(world: World, parts: CampOut[], culture: Culture, morphology: string, pop: number, archetype: Archetype, water: MultiPoly): UrbanLayer {
  const layer: UrbanLayer = {
    footprint: [], footprintH: [], streets: [], blocks: [], parcels: [], buildings: [], walls: [], landmarks: [], squares: [],
    archetype, population: pop, morphology, phases: [], quarters: [], blockInfo: [], masses: [], backLand: [],
    culture: culture.id, cultures: [culture.id], renderHints: { ...culture.render }, lines: [], trees: [], water: [], sites: [], quays: [],
  };
  const regions: PolyH[] = [];
  for (const part of parts) {
    const q0 = layer.quarters.length, b0 = layer.blocks.length, p0 = layer.parcels.length;
    part.quarters.forEach((q, qi) => {
      const mine = part.blocks.filter((b) => b.quarter === qi).map((b) => b.poly);
      let ss: MultiPoly = [{ outer: q, holes: [] }];
      if (mine.length) ss = differenceS(ss, unionMany(mine, 24, true));
      layer.quarters.push({ poly: { outer: q, holes: [] }, phase: 1, zone: 'village', streetSpace: ss.map((p) => ({ outer: p.outer, holes: p.holes })) });
    });
    part.blocks.forEach((b) => {
      layer.blocks.push(b.poly);
      layer.blockInfo.push(blockInfo(b, q0 + b.quarter, culture.id, morphology));
    });
    for (const p of part.parcels) layer.parcels.push({ poly: p.poly, use: p.use, block: b0 + p.block, zone: 'village' });
    for (const b of part.buildings) layer.buildings.push({ ...b, parcel: p0 + b.parcel });
    layer.streets.push(...part.streets);
    layer.lines!.push(...part.lines);
    layer.walls!.push(...part.walls);
    layer.landmarks.push(...part.landmarks);
    layer.water!.push(...part.water);
    layer.sites!.push(...part.sites);
    layer.squares.push(...part.squares);
    if (part.trees) layer.trees!.push(...part.trees);
    for (const o of part.outline) regions.push({ outer: o, holes: [] });
    for (const q of part.quarters) regions.push({ outer: q, holes: [] });
  }
  // building masses per block
  const perBlock = new Map<number, Polygon[]>();
  for (const b of layer.buildings) {
    if (b.parcel === undefined) continue;
    const bk = layer.parcels[b.parcel].block;
    if (!perBlock.has(bk)) perBlock.set(bk, []);
    perBlock.get(bk)!.push(b.poly);
  }
  for (const list of perBlock.values()) for (const ph of unionMany(list, 24, true)) layer.masses.push({ outer: ph.outer, holes: ph.holes });
  layer.backLand = layer.parcels.filter((p) => p.use === 'garden').map((p) => ({ outer: p.poly, holes: [] }));
  let foot: MultiPoly = regions.length ? unionS(regions) : [];
  if (water.length) foot = differenceS(foot, water);
  foot = foot.filter((ph) => area(ph.outer) > 50);
  layer.footprintH = foot.map((p) => ({ outer: p.outer, holes: p.holes }));
  layer.footprint = foot.map((p) => p.outer);
  layer.phases = [{ id: 1, kind: 'village', zone: 'village', region: layer.footprintH, walled: !!layer.walls?.length, fossil: false }];
  void polygonCentroid; void pointInRing; void disk;
  return layer;
}
