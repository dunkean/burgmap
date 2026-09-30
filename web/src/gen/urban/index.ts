/**
 * Urban stage orchestrator: partition, never place (URBAN_GEOMETRY.md).
 * region → quarters (level 1) → blocks (level 2) → plots (level 3) → built / unbuilt (level 4).
 */
import type { Vec2, Polygon } from '../core/geom';
import { dist } from '../core/geom';
import type { Rng } from '../core/rng';
import type { World, UrbanLayer, UrbanStreet, PolyH as PolyHT } from '../types';
import { MORPHOLOGIES, MorphologyParams, Zone } from './morphology';
import { planRibbonVillage } from './villages';
import { makeCtx } from './context';
import { choosePopulation, chooseArchetype, planServedPhases, planFaubourgs, EnclosurePlan } from './phases';
import { buildPrimary } from './primary';
import { Streets, LAB_OPEN } from './streets';
import { mpArea, MultiPoly } from '../geo/bool';
import { GuidanceField } from './field';
import { splitQuarter, addCloses, carveBlocks, buildRibbonIndex, Piece, CarvedBlock } from './blocks';
import { ribbon } from '../geo/offset';
import { polygonCentroid } from '../core/geom';
import { cutPlots, Plot } from './plots';
import { buildPlot } from './buildings';
import { wallFeatures } from './walls';
import { pickChurchBlock, churchFootprint } from './landmarks';
import { distToRing, pointInRing, area as areaOf, inscribed } from '../geo/poly';
import { unionMany } from '../geo/bool';
import type { UrbanBuilding, PolyH } from '../types';
import type { UrbanParcel } from '../types';

export interface UrbanResult { layer: UrbanLayer; stats: Record<string, number | string>; debug: UrbanDebug }
export interface UrbanDebug { quarters: { poly: Polygon; phase: number; lab: number[] }[] }

const MARKET_AREA = (pop: number): number => (pop < 1200 ? 0 : Math.min(7000, 1300 + pop * 0.22));

/** A point strictly inside a polygon (centroid when inside, else the inscribed-circle center). */
export function interiorPoint(p: Polygon): Vec2 {
  const c = polygonCentroid(p);
  return pointInRing(p, c) ? c : inscribed(p, [], 1).c;
}

export function mainRoadAngle(world: World): number {
  const c = world.site!.center;
  let best = 0, bl = -1;
  for (const rd of world.roads ?? []) {
    if (rd.kind === 'track') continue;
    const pl = rd.path;
    if (dist(pl[pl.length - 1], c) > 10) continue;
    const q = pl[Math.max(0, pl.length - 12)];
    const l = pl.length;
    if (l > bl) { bl = l; best = Math.atan2(q.y - c.y, q.x - c.x); }
  }
  return best;
}

export function generateUrban(world: World, root: Rng): UrbanResult {
  const t0 = performance.now();
  const rng = root.fork('urban');
  const opts = world.options;
  const base = MORPHOLOGIES[opts.culture] ?? MORPHOLOGIES['european-organic'];
  const pop = choosePopulation(opts.size, opts.population, rng.fork('pop'));
  const roads = (world.roads ?? []).filter((r) => r.kind !== 'track').map((r) => ({ path: r.path, major: r.kind === 'major' }));
  const reaching = roads.filter((r) => dist(r.path[r.path.length - 1], world.site!.center) < 10).length;
  let archetype = chooseArchetype(pop, reaching, rng.fork('arch'));
  // hamlets: wide farm plots and no block splitting; street villages: long blocks between field lanes
  const params: MorphologyParams = archetype === 'hamlet'
    ? { ...base, frontage: { ...base.frontage, village: [26, 55] }, blockSize: { ...base.blockSize, village: [60000, 90000] } }
    : archetype === 'street-village' ? { ...base, blockSize: { ...base.blockSize, village: [9000, 26000] } } : base;
  const walled = opts.walls === 'yes' ? archetype === 'town' || archetype === 'nucleated-village' : opts.walls === 'no' ? false : archetype === 'town' && (pop >= 2500 || rng.fork('walls').chance(0.6));
  const estArea = (pop / params.density.middle) * 1e4;
  const ctx = makeCtx(world, params, 2.6 * Math.sqrt(estArea / Math.PI) + 450);
  const mainAngle = mainRoadAngle(world);
  const streets = new Streets();

  let plan: EnclosurePlan | null = null;
  let faub: { region: MultiPoly } = { region: [] };
  let marketArea = 0, extraRadials = false;
  let faubZone: Zone = 'faubourg';
  if (archetype === 'hamlet' || archetype === 'street-village') {
    const rv = planRibbonVillage(ctx, roads, pop, archetype, rng.fork('village'));
    if (rv) {
      plan = { phases: rv.phases, enclosure: rv.enclosure, walled: false };
      marketArea = archetype === 'street-village' ? 500 + pop * 0.6 : 0;
    } else archetype = 'nucleated-village';
  }
  if (!plan && archetype === 'nucleated-village') {
    plan = planServedPhases(ctx, pop, walled, mainAngle, rng.fork('phases'), roads, { nPh: 1, zones: ['village'], faubShare: 0.3 });
    faub = planFaubourgs(ctx, plan.enclosure, roads, ((pop * 0.3) / params.density.village) * 1e4, 0, rng.fork('faubourg'));
    marketArea = 500 + pop * 0.8;
    faubZone = 'village';
  }
  if (!plan) {
    plan = planServedPhases(ctx, pop, walled, mainAngle, rng.fork('phases'), roads);
    const faubPop = pop * (walled ? 0.17 : 0.1);
    // scarce land: what the enclosure could not hold grows along the roads instead
    const encTarget = plan.phases.reduce((s2, ph) => s2 + (ph.pop / (params.density[ph.zone] * (plan!.densityScale ?? 1))) * 1e4, 0);
    const short = (plan.shortfall ?? 0) > 0.05 * encTarget ? ((plan.shortfall ?? 0) * params.density.middle) / params.density.faubourg : 0;
    faub = planFaubourgs(ctx, plan.enclosure, roads, (faubPop / params.density.faubourg) * 1e4 + short, walled ? 22 : 0, rng.fork('faubourg'));
    marketArea = MARKET_AREA(pop);
    extraRadials = params.streetOp !== 'grid';
  }
  const stats: Record<string, number | string> = { pop, archetype, walled: walled ? 1 : 0, morphology: params.id };
  const t1 = performance.now();
  const prim = buildPrimary(ctx, {
    phases: plan.phases, enclosure: plan.enclosure, walled: plan.walled, faubourg: faub.region, roads,
    marketArea, mainAngle, extraRadials, faubZone,
  }, streets, rng.fork('primary'));
  const t2 = performance.now();
  stats['ms.phases'] = Math.round(t1 - t0);
  stats['ms.primary'] = Math.round(t2 - t1);
  stats['quarters'] = prim.quarters.length;
  stats['ha.enclosed'] = Math.round(mpArea(plan.enclosure) / 1e3) / 10;
  stats['ha.faubourg'] = Math.round(mpArea(faub.region) / 1e3) / 10;
  stats['ha.shortfall'] = Math.round((plan.shortfall ?? 0) / 1e3) / 10;

  // ---- level 2: blocks
  const nucleus = prim.market ? polygonCentroid(prim.market) : ctx.center;
  const field = new GuidanceField(ctx, nucleus, streets, mainAngle, rng.fork('field'));
  // quarters are split in rounds: a quarter is processed once one of its streets is connected to the network
  // (its splits may connect further rings); quarters that never connect are not urbanized
  const pieces: Piece[][] = prim.quarters.map(() => []);
  const done = prim.quarters.map(() => false);
  for (let round = 0; round < 6; round++) {
    let progress = false;
    prim.quarters.forEach((q, qi) => {
      if (done[qi]) return;
      if (q.kind !== 'market' && !q.lp.lab.some((l) => l >= 0 && streets.connected.has(l))) return;
      pieces[qi] = splitQuarter(ctx, q, qi, streets, field, { nucleus, gridAngle: mainAngle }, rng.fork('q:' + qi));
      done[qi] = true;
      progress = true;
    });
    if (!progress) break;
  }
  const t3 = performance.now();
  // streets that never joined the network (a ring no cut reached, a lane opening a hole) are demoted to plain
  // boundaries, so the street graph stays connected
  let demoted = 0;
  for (const st of streets.list) if (!streets.connected.has(st.id) && st.ribbon) { streets.demote(st.id); demoted++; }
  if (demoted) for (const list of pieces) for (const pc of list) pc.lp.lab = pc.lp.lab.map((l) => (l >= 0 && !streets.list[l].ribbon ? LAB_OPEN : l));
  stats['demotedStreets'] = demoted;
  const closes = addCloses(ctx, pieces.flat(), streets, rng.fork('closes'));
  const carved: CarvedBlock[] = [];
  const streetSpace: MultiPoly[] = [];
  const ribIdx = buildRibbonIndex(streets, prim.walls.map((w) => ({ path: w.ring.concat([w.ring[0]]), width: 2.6 + 3 })));
  prim.quarters.forEach((q, qi) => {
    const r = carveBlocks(q, pieces[qi], ribIdx, streets, (2.6 + 3) / 2);
    carved.push(...r.blocks);
    streetSpace.push(r.streetSpace);
  });
  // enclosure pieces, phase-region pieces and footprint pieces that received no block (no street access, cut off
  // by water) are not urbanized: no wall around empty land
  const blockPts = carved.map((b) => interiorPoint(b.poly));
  const holdsBlock = (ph: { outer: Polygon; holes: Polygon[] }) => blockPts.some((p) => pointInRing(ph.outer, p) && !ph.holes.some((h) => pointInRing(h, p)));
  prim.walls = prim.walls.filter((w) => holdsBlock({ outer: w.ring, holes: [] }));
  prim.footprint = prim.footprint.filter(holdsBlock);
  for (const ph of plan.phases) ph.region = ph.region.filter(holdsBlock);
  // capacity: planned gross density over the urbanized quarters
  const urbanized = new Set(carved.map((b) => b.quarter));
  let capacity = 0;
  const dScale = plan.densityScale ?? 1;
  prim.quarters.forEach((q, qi) => { if (urbanized.has(qi) && q.kind !== 'market') capacity += (areaOf(q.lp.pts) * params.density[q.zone] * (q.zone === 'faubourg' ? 1 : dScale)) / 1e4; });
  stats['capacity'] = Math.round(capacity);
  const t4 = performance.now();
  stats['ms.split'] = Math.round(t3 - t2);
  stats['ms.carve'] = Math.round(t4 - t3);
  stats['blocks'] = carved.length;

  // ---- landmarks claimed before plots: the parish church (cathedral in cities) next to the market
  const landmarks: UrbanLayer['landmarks'] = [];
  const churchBuildings: Polygon[] = [];
  if (prim.market) landmarks.push({ kind: archetype === 'town' ? 'market' : 'green', poly: prim.market });
  if (archetype !== 'hamlet') {
    const cb = pickChurchBlock(carved, prim.marketStreet, streets, nucleus, pop);
    if (cb >= 0) {
      const fp = churchFootprint(carved[cb].poly, pop, rng.fork('church'));
      if (fp) {
        carved[cb].kind = 'church';
        landmarks.push({ kind: fp.kind + '-yard', poly: carved[cb].poly });
        for (const part of fp.parts) { landmarks.push({ kind: fp.kind, poly: part }); churchBuildings.push(part); }
      }
    }
  }

  // ---- level 3: plots
  const plots: Plot[] = [];
  const parcels: UrbanParcel[] = [];
  const blockInfill: number[] = [];
  const slowest = { ms: 0, bi: -1, n: 0 };
  carved.forEach((b, bi) => {
    const br = rng.fork('blk:' + bi);
    const [c0, c1] = params.coverage[b.zone];
    const infill = c0 + (c1 - c0) * br.float();
    blockInfill.push(infill);
    if (b.kind !== 'block') {
      const use = b.kind === 'market' ? (archetype === 'town' ? 'market' : 'green') : b.kind === 'church' ? 'church' : 'place';
      parcels.push({ poly: b.poly, use, block: bi, zone: b.zone });
      return;
    }
    const tb0 = performance.now();
    const r = cutPlots(b.poly, bi, b.zone, infill, params, streets, br);
    const tb1 = performance.now() - tb0;
    if (tb1 > slowest.ms) { slowest.ms = tb1; slowest.bi = bi; slowest.n = b.poly.length; }
    for (const p of r.plots) { plots.push(p); parcels.push({ poly: p.poly, use: 'plot', block: bi, front: p.front, zone: b.zone }); }
    for (const g of r.back) parcels.push({ poly: g, use: 'garden', block: bi, zone: b.zone });
  });
  const t5 = performance.now();
  stats['ms.plots'] = Math.round(t5 - t4);
  stats['plots'] = plots.length;
  stats['ms.slowestBlock'] = Math.round(slowest.ms);
  stats['slowestBlockVerts'] = slowest.n;

  // ---- level 4: buildings, unioned into masses per block
  const buildings: UrbanBuilding[] = [];
  const plotGardens: Polygon[] = [];
  const perBlock: Polygon[][] = carved.map(() => []);
  let pi = 0;
  const parcelIndexOfPlot: number[] = [];
  parcels.forEach((pc, i) => { if (pc.use === 'plot') parcelIndexOfPlot.push(i); });
  // courts come in neighbouring pairs, about 2 plots in 9 along a frontage run, at a depth shared by the run
  const courtHint = (pl: Plot) => {
    const cr = rng.fork('court:' + pl.block + ':' + pl.run);
    const phase = cr.int(0, 8), f = cr.range(0.35, 0.65);
    return { court: (pl.order + phase) % 9 < 2, f };
  };
  for (const pl of plots) {
    const pr = rng.fork('pl:' + pi);
    const cov = Math.max(0, Math.min(1, blockInfill[pl.block] + pr.range(-0.03, 0.03)));
    const bl = buildPlot(pl, cov, params, pr, courtHint(pl));
    for (const b of bl) {
      if (b.kind === 'garden') { plotGardens.push(b.poly); continue; }
      buildings.push({ poly: b.poly, kind: b.kind, parcel: parcelIndexOfPlot[pi] }); perBlock[pl.block].push(b.poly);
    }
    pi++;
  }
  // the church stands on its lot (the churchyard parcel)
  const churchParcel = parcels.findIndex((p) => p.use === 'church');
  for (const cbp of churchBuildings) buildings.push({ poly: cbp, kind: 'church', parcel: churchParcel >= 0 ? churchParcel : undefined });
  const t6 = performance.now();
  const masses: PolyH[] = [];
  perBlock.forEach((list) => { if (list.length) for (const ph of unionMany(list, 24, true)) masses.push({ outer: ph.outer, holes: ph.holes }); });
  const t7 = performance.now();
  stats['ms.buildings'] = Math.round(t6 - t5);
  stats['ms.masses'] = Math.round(t7 - t6);
  stats['buildings'] = buildings.length;
  stats['closes'] = closes;

  // quarters that received no block (never joined the street network) are not part of the town
  const keptQ = prim.quarters.map((_, qi) => qi).filter((qi) => urbanized.has(qi));
  const qMap: number[] = [];
  keptQ.forEach((qi, k) => { qMap[qi] = k; });
  const toPH = (m: { outer: Polygon; holes: Polygon[] }[]): PolyHT[] => m.map((p) => ({ outer: p.outer, holes: p.holes }));
  const layerStreets: UrbanStreet[] = streets.list.filter((s) => s.ribbon).map((s) => ({
    path: s.path, width: s.widths.reduce((a, b) => a + b, 0) / s.widths.length, widths: s.widths,
    kind: s.rank <= 1 ? 'main' : s.rank <= 2 ? 'street' : 'alley', rank: s.rank, role: s.role, phase: s.phase,
  }));
  const layer: UrbanLayer = {
    footprint: prim.footprint.map((p) => p.outer),
    footprintH: toPH(prim.footprint),
    streets: layerStreets,
    blocks: carved.map((b) => b.poly), parcels, buildings,
    walls: prim.walls.map((w, wi) => {
      const nearW = (q: Vec2) => ctx.water.some((ph) => distToRing(ph.outer, q) < 4 || pointInRing(ph.outer, q));
      const wf = wallFeatures(w.ring, w.gates, rng.fork('wall:' + wi), ctx.isWater, nearW);
      return { path: w.ring, closed: true, towers: wf.towers, gates: w.gates.map((g) => g.p), thickness: pop > 12000 ? 3.2 : 2.6, gateInfo: w.gates.map((g) => ({ p: g.p, dir: g.dir, width: g.width })), pieces: wf.pieces, gateTowers: wf.gateTowers, towerScale: wf.towerScale, curtains: wf.curtains, towerShape: 'round' as const };
    }),
    landmarks, squares: prim.market ? [prim.market] : [],
    archetype, population: pop, morphology: params.id,
    phases: plan.phases.map((p) => ({ id: p.id, kind: p.kind, zone: p.zone, region: toPH(p.region), walled: p.walled, fossil: p.fossil })),
    quarters: keptQ.map((qi) => { const q = prim.quarters[qi]; return { poly: { outer: q.lp.pts, holes: [] }, phase: q.phase, zone: q.zone, streetSpace: toPH(streetSpace[qi]) }; }),
    blockInfo: carved.map((b) => ({ quarter: qMap[b.quarter], phase: b.phase, zone: b.zone, kind: b.kind === 'market' && archetype !== 'town' ? 'green' : b.kind })), masses,
    backLand: parcels.filter((p) => p.use === 'garden').map((p) => p.poly).concat(plotGardens).map((p) => ({ outer: p, holes: [] })),
  };
  const debug: UrbanDebug = { quarters: prim.quarters.map((q) => ({ poly: q.lp.pts, phase: q.phase, lab: q.lp.lab })) };
  stats['ms.urban'] = Math.round(performance.now() - t0);
  void ({} as Vec2);
  return { layer, stats, debug };
}
