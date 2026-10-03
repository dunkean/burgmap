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
import { resolveMorph } from '../morphology';
import { makeCtx, type UrbanCtx } from '../context';
import { differenceS, unionS, unionMany, intersectionS, mpArea, MultiPoly } from '../../geo/bool';
import { area, pointInRing, bboxOf, distToRing } from '../../geo/poly';
import { disk } from '../../geo/offset';
import { CampOut, blockInfo } from './kit';
import { ringCamp, RING_VARIANTS } from './ring';
import { yardsVillage, YARD_VARIANTS } from './yards';
import { longhouseVillage } from './longhouses';
import { puebloSettlement } from './pueblo';
import { ringFort } from './ringfort';
import { khmerCity } from './khmer';
import { stiltTown } from './stilts';
import { warCamp } from './warcamp';
import { germanicVillage } from './germanic';
import { norseFarms } from './norse';
import { celticVillage } from './celtic';
import { satellite } from './satellites';

export interface CampSpec {
  layout: 'ring' | 'yards' | 'longhouses' | 'pueblo' | 'ringfort' | 'khmer' | 'stilts' | 'warcamp';
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
  /** Ground already taken by the other parts of a cluster (their quarters): dispersed farms keep off it. */
  avoid?: Polygon[];
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
    case 'stilts': return Math.max(42, Math.sqrt((pop * 36) / Math.PI)) * 1.3;
    case 'warcamp': return Math.sqrt(((pop / 26) * 330) / Math.PI + 900) * 1.35;
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

/** Sites of the satellite camps of a cluster: dry discs around the main one, preferably near the roads, the nearer
 * the larger; the search widens ring by ring (large clusters spread over the map). */
function clusterSites(ctx: UrbanCtx, c: Vec2, roads: Polyline[], r0: number, radii: number[], rng: Rng, dryMin = 0.8): Vec2[] {
  const placed: { p: Vec2; r: number }[] = [{ p: c, r: r0 }];
  const roadPts: Vec2[] = [];
  for (const pl of roads) for (let i = 0; i < pl.length; i += 3) roadPts.push(pl[i]);
  for (const r of radii) {
    let best: Vec2 | null = null, bs = -Infinity;
    const far = placed.reduce((m, q) => Math.max(m, dist(q.p, c) + q.r), r0);
    const nRing = Math.ceil((far + r + 200) / 70);
    for (let ring = 0; ring < nRing; ring++) for (let k = 0; k < 24; k++) {
      const a = (k / 24) * 2 * Math.PI + rng.range(-0.12, 0.12);
      const d = r0 + r + 45 + ring * 70 + rng.range(0, 30);
      const p = { x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d };
      if (p.x < r + 20 || p.y < r + 20 || p.x > ctx.mapSize - r - 20 || p.y > ctx.mapSize - r - 20) continue;
      if (placed.some((q) => dist(q.p, p) < q.r + r + 50)) continue;
      const dry = dryShare(ctx, p, r);
      if (dry < dryMin) continue;
      let dRoad = 1e9;
      for (const q of roadPts) dRoad = Math.min(dRoad, dist(q, p));
      // (close to the cluster: the distance to the nearest part counts, not only to the main one)
      let dn = Infinity;
      for (const q of placed) dn = Math.min(dn, dist(q.p, p) - q.r - r);
      const s = dry * 2 - d / 1400 - Math.max(0, dn - 60) / 260 - Math.max(0, dRoad - r - 30) / 400 + rng.float() * 0.25;
      if (s > bs) { bs = s; best = p; }
    }
    if (!best) continue;
    placed.push({ p: best, r });
  }
  return placed.slice(1).map((x) => x.p);
}

/**
 * Natural size of one settlement of a culture's plan (inhabitants). Above it the settlement becomes a cluster: the
 * main plan at about this size and outlying settlements of the culture's own outlying form (a confederation of
 * villages, a gathering of camp circles along the river, a royal kraal and its homesteads, a hillfort and its raths).
 */
export const CAMP_NAT_MAX: Record<string, number> = {
  barbarian: 1300, 'barbarian-celtic': 1500, 'barbarian-norse': 1400, 'norse-ringfort': 1100, kraal: 3000, 'native-plains': 2600,
  'nomad-camp': 3500, 'native-iroquoian': 2200, 'native-pueblo': 3000, maya: 120000, khmer: 120000, 'celtic-oppidum': 12000,
  orcish: 30000, halfling: 900, 'stilt-town': 6000,
};

/** Outlying settlements never exceed this many (the rest of the population lives in the larger ones). */
const MAX_PARTS = 36;

/**
 * True for a secondary settlement of the settlement system (planned by `generateSettlementUrban`): it runs with
 * `settlements: 'none'` on a site without archetype offers. (Hook for the planner: an explicit flag on the options
 * would be cleaner, see the report.)
 */
export function isSecondary(world: World): boolean {
  return world.options.settlements === 'none' && !!world.site && Object.keys(world.site.offers ?? {}).length === 0;
}

/** Populations of the parts of a settlement of `pop` (the main one first). */
function partPops(pop: number, natMax: number, rng: Rng): number[] {
  if (pop <= natMax) return [pop];
  const n = Math.min(MAX_PARTS + 1, Math.ceil(pop / (natMax * 0.7)));
  const main = Math.min(natMax, Math.round((pop / n) * 1.7));
  const w = Array.from({ length: n - 1 }, (_, k) => rng.fork('w' + k).range(0.3, 1));
  const tw = w.reduce((a, b) => a + b, 0);
  return [main, ...w.map((x) => Math.min(natMax, Math.max(40, Math.round(((pop - main) * x) / tw))))];
}

/** Approximate outer radius (m) of one part (main plan or outlying form). */
function partRadius(culture: string, spec: CampSpec, pop: number, satelliteForm: boolean): number {
  if (satelliteForm) return 60 + Math.sqrt(pop) * 7;
  switch (culture) {
    case 'barbarian': return 40 + Math.sqrt(((pop / 12) * 1900) / Math.PI) * 1.25;
    case 'barbarian-norse': return 120 + Math.sqrt(pop / 14) * 95;
    case 'barbarian-celtic': return pop < 150 ? 70 + Math.sqrt(pop / 16) * 90 : Math.sqrt((pop * 105) / Math.PI) + 40;
    default: return campRadius(spec, pop);
  }
}

function plan(cc: CampCtx, spec: CampSpec, c: Vec2, pop: number, rng: Rng): CampOut {
  switch (spec.layout) {
    case 'ring': return ringCamp(cc, c, pop, RING_VARIANTS[spec.variant] ?? RING_VARIANTS.kraal, rng);
    case 'yards': if (spec.variant === 'germanic') return germanicVillage(cc, c, pop, rng);
      if (spec.variant === 'norse') return norseFarms(cc, c, pop, rng);
      if (spec.variant === 'celtic') return celticVillage(cc, c, pop, rng);
      return yardsVillage(cc, c, pop, YARD_VARIANTS[spec.variant] ?? YARD_VARIANTS.germanic, rng);
    case 'longhouses': return longhouseVillage(cc, c, pop, rng);
    case 'pueblo': return puebloSettlement(cc, c, pop, rng);
    case 'ringfort': return ringFort(cc, c, pop, rng);
    case 'khmer': return khmerCity(cc, c, pop, rng);
    case 'stilts': return stiltTown(cc, c, pop, rng);
    case 'warcamp': return warCamp(cc, c, pop, rng);
    default: return ringCamp(cc, c, pop, RING_VARIANTS.kraal, rng);
  }
}

export interface CampResult { layer: UrbanLayer; stats: Record<string, number | string> }

/** Plans a camp-culture settlement (one camp or village, or a cluster with its outlying settlements) as an UrbanLayer. */
export function generateCamp(world: World, root: Rng, culture: Culture, pop0: number): CampResult {
  const t0 = performance.now();
  const spec = culture.camp as CampSpec;
  const sprawl = Math.max(0.5, Math.min(2, world.options.sprawl ?? 1));
  const rng = root.fork('camp');
  const morph = resolveMorph(culture.core.morphology);
  const natMax = CAMP_NAT_MAX[culture.id] ?? 1500;
  const secondary = isSecondary(world);
  let pops = partPops(pop0, natMax, rng.fork('parts'));
  // a secondary settlement takes its culture's outlying form (when it has one) unless it is a large one
  const satMain = secondary && pop0 < natMax * 0.6;
  const rk = Math.sqrt(sprawl);
  const r0 = partRadius(culture.id, spec, pops[0], satMain) * rk;
  const ctx = makeCtx(world, morph, Math.min(world.mapSize / 2, 2.2 * r0 + 600 + (pops.length > 1 ? 900 + pops.length * 60 : 0)));
  const roads = (world.roads ?? []).filter((r) => r.kind !== 'track').map((r) => r.path);
  const roadAngle = mainRoadAngleOf(world);
  // the main camp stands on dry ground: beside the stream rather than astride it (a short way leads from the road)
  let main = ctx.center;
  const rDry = culture.id === 'barbarian-celtic' && !satMain && pops[0] >= 150 ? r0 : spec.variant === 'germanic' || spec.variant === 'norse' || satMain ? Math.min(r0 * 0.5, 90) : r0 * (spec.layout === 'yards' || spec.layout === 'longhouses' ? 1.3 : spec.layout === 'khmer' ? 1.15 : 1.05);
  // (a stilt town wants the water: it is sited on the shore by its layout)
  // (a hillfort or an oppidum: the whole enclosure dry, on the highest ground near the site)
  const fort = !satMain && ((culture.id === 'barbarian-celtic' && pops[0] >= 150) || culture.id === 'celtic-oppidum');
  const hc = ctx.heightAt(ctx.center);
  if (!culture.waterBuild && (fort || dryShare(ctx, main, rDry) < 0.97)) {
    let bs = fort && dryShare(ctx, main, rDry) >= 0.97 ? 2 : -Infinity;
    const sr = rng.fork('dry');
    for (let ring = 1; ring <= (fort ? 14 : 10); ring++) for (let k = 0; k < 20; k++) {
      const a = (k / 20) * 2 * Math.PI + sr.range(-0.1, 0.1);
      const d = ring * Math.max(25, r0 * 0.22);
      const p = { x: ctx.center.x + Math.cos(a) * d, y: ctx.center.y + Math.sin(a) * d };
      if (p.x < r0 + 20 || p.y < r0 + 20 || p.x > ctx.mapSize - r0 - 20 || p.y > ctx.mapSize - r0 - 20) continue;
      const dry = dryShare(ctx, p, rDry);
      const s = (dry >= 0.97 ? 2 : dry) - d / (4 * r0 + 400) + (fort ? Math.max(-0.5, Math.min(0.8, (ctx.heightAt(p) - hc) / 30)) : 0);
      if (s > bs) { bs = s; main = p; }
    }
  }
  const radii = pops.map((p, k) => partRadius(culture.id, spec, p, k > 0 || satMain) * rk);
  const centers: Vec2[] = [main];
  if (pops.length > 1) centers.push(...clusterSites(ctx, main, roads, r0 * 1.15, radii.slice(1).map((r) => r * 1.1), rng.fork('cluster'), spec.variant === 'norse' || spec.layout === 'yards' ? 0.5 : 0.75));
  pops = pops.slice(0, centers.length);
  // (each part keeps off the ground of the parts made before it; a quarter that still overlaps one is dropped)
  const taken: { poly: Polygon; bb: ReturnType<typeof bboxOf> }[] = [];
  const parts: CampOut[] = centers.map((c, k) => {
    const cc: CampCtx = { ctx, world, culture, roads, main: k === 0, roadAngle, sprawl, avoid: taken.map((t) => t.poly) };
    const r = rng.fork('part:' + k);
    const sat = k > 0 || satMain ? satellite(culture.id, cc, c, pops[k], r) : null;
    let part = sat ?? plan(cc, spec, c, pops[k], r);
    if (taken.length) part = dropOverlapping(part, taken);
    for (const q of part.quarters) taken.push({ poly: q, bb: bboxOf(q) });
    return part;
  });
  // tracks from each satellite to the nearest part placed before it (a trampled way, drawn as a plan line), and
  // from the road's end to the main camp
  const extraLines: UrbanLine[] = [];
  if (dist(main, ctx.center) > r0 * 0.6) {
    const L = dist(main, ctx.center);
    const ux = (main.x - ctx.center.x) / L, uy = (main.y - ctx.center.y) / L;
    if (L > r0 + 4) extraLines.push({ kind: 'track', path: [ctx.center, { x: main.x - ux * (r0 - 2), y: main.y - uy * (r0 - 2) }], width: 3 });
  }
  for (let k = 1; k < centers.length; k++) {
    const a = centers[k];
    let j = 0;
    for (let i = 1; i < k; i++) if (dist(centers[i], a) - radii[i] < dist(centers[j], a) - radii[j]) j = i;
    const b = centers[j];
    const L = dist(a, b);
    const ra = radii[k] * 0.8, rb = radii[j] * 0.8;
    if (L <= ra + rb + 10) continue;
    const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
    extraLines.push({ kind: 'track', path: [{ x: a.x + ux * ra, y: a.y + uy * ra }, { x: b.x - ux * rb, y: b.y - uy * rb }], width: 2.6 });
  }
  const pop = pops.reduce((s, p) => s + p, 0);
  const archetype: Archetype = pop < 200 ? 'hamlet' : (spec.layout === 'pueblo' || spec.layout === 'khmer' || spec.layout === 'stilts' || spec.variant === 'maya' || spec.variant === 'oppidum' || spec.layout === 'warcamp') && pops[0] >= 1200 ? 'town' : 'nucleated-village';
  const layer = assemble(world, parts, culture, morph.id, pop, archetype, ctx.water);
  layer.lines = [...extraLines, ...(layer.lines ?? [])];
  const stats: Record<string, number | string> = {
    pop, archetype, walled: layer.walls?.length ? 1 : 0, morphology: morph.id, culture: culture.id, camps: parts.length,
    blocks: layer.blocks.length, plots: layer.parcels.filter((p) => p.use === 'plot').length, buildings: layer.buildings.length,
  };
  if (pop !== pop0) stats['scale.requested'] = pop0;
  if (secondary) stats['camp.outlying'] = satMain ? 1 : 0;
  stats['ms.urban'] = Math.round(performance.now() - t0);
  return { layer, stats };
}

/** A part without its quarters that overlap the ground already taken (with their blocks, plots, buildings and the
 * plan lines, landmarks, trees and sites lying on them). */
function dropOverlapping(part: CampOut, taken: { poly: Polygon; bb: ReturnType<typeof bboxOf> }[]): CampOut {
  const drop = part.quarters.map((q) => {
    const bb = bboxOf(q);
    return taken.some((t) => !(t.bb.x0 > bb.x1 || t.bb.x1 < bb.x0 || t.bb.y0 > bb.y1 || t.bb.y1 < bb.y0) && mpArea(intersectionS(q, t.poly)) > 1);
  });
  if (!drop.some((d) => d)) return part;
  const dq = part.quarters.filter((_, i) => drop[i]);
  const inDropped = (p: Vec2): boolean => dq.some((q) => pointInRing(q, p) || distToRing(q, p) < 4);
  const qMap: number[] = [];
  let nq = 0;
  drop.forEach((d, i) => { qMap[i] = d ? -1 : nq++; });
  const bMap: number[] = [];
  let nb = 0;
  part.blocks.forEach((b, i) => { bMap[i] = qMap[b.quarter] < 0 ? -1 : nb++; });
  const pMap: number[] = [];
  let np = 0;
  part.parcels.forEach((p, i) => { pMap[i] = bMap[p.block] < 0 ? -1 : np++; });
  const mid = (pl: Vec2[]): Vec2 => pl[Math.floor(pl.length / 2)];
  return {
    ...part,
    quarters: part.quarters.filter((_, i) => !drop[i]),
    outline: part.outline.filter((o) => !inDropped(polygonCentroid(o))),
    blocks: part.blocks.filter((_, i) => bMap[i] >= 0).map((b) => ({ ...b, quarter: qMap[b.quarter] })),
    parcels: part.parcels.filter((_, i) => pMap[i] >= 0).map((p) => ({ ...p, block: bMap[p.block] })),
    buildings: part.buildings.filter((b) => pMap[b.parcel] >= 0).map((b) => ({ ...b, parcel: pMap[b.parcel] })),
    // (a street serving kept plots stays: only a street lying wholly on dropped ground goes)
    streets: part.streets.filter((st) => !st.path.every((p) => dq.some((q) => pointInRing(q, p)))),
    lines: part.lines.filter((l) => !inDropped(mid(l.path))),
    landmarks: part.landmarks.filter((l) => !inDropped(polygonCentroid(l.poly))),
    squares: part.squares.filter((sq) => !inDropped(polygonCentroid(sq))),
    sites: part.sites.filter((st) => !inDropped(st.anchor)),
    trees: part.trees?.filter((t) => !inDropped(t)),
    walls: part.walls.filter((w) => !inDropped(w.path[0])),
  };
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
