/**
 * Urban stage orchestrator: partition, never place (URBAN_GEOMETRY.md).
 * region → quarters (level 1) → blocks (level 2) → plots (level 3) → built / unbuilt (level 4).
 */
import type { Vec2, Polygon } from '../core/geom';
import { dist } from '../core/geom';
import type { Rng } from '../core/rng';
import type { World, UrbanLayer, UrbanStreet, PolyH as PolyHT } from '../types';
import { MORPHOLOGIES } from './morphology';
import { makeCtx } from './context';
import { choosePopulation, chooseArchetype, planTownPhases, planFaubourgs } from './phases';
import { buildPrimary } from './primary';
import { Streets } from './streets';
import { mpArea, MultiPoly } from '../geo/bool';
import { GuidanceField } from './field';
import { splitQuarter, addCloses, carveBlocks, buildRibbonIndex, Piece, CarvedBlock } from './blocks';
import { ribbon } from '../geo/offset';
import { polygonCentroid } from '../core/geom';

export interface UrbanResult { layer: UrbanLayer; stats: Record<string, number | string>; debug: UrbanDebug }
export interface UrbanDebug { quarters: { poly: Polygon; phase: number; lab: number[] }[] }

const MARKET_AREA = (pop: number): number => (pop < 1200 ? 0 : Math.min(7000, 1300 + pop * 0.22));

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
  const params = MORPHOLOGIES[opts.culture] ?? MORPHOLOGIES['european-organic'];
  const pop = choosePopulation(opts.size, opts.population, rng.fork('pop'));
  const roads = (world.roads ?? []).filter((r) => r.kind !== 'track').map((r) => ({ path: r.path, major: r.kind === 'major' }));
  const reaching = roads.filter((r) => dist(r.path[r.path.length - 1], world.site!.center) < 10).length;
  const archetype = chooseArchetype(pop, reaching, rng.fork('arch'));
  const walled = opts.walls === 'yes' ? true : opts.walls === 'no' ? false : archetype === 'town' && (pop >= 2500 || rng.fork('walls').chance(0.6));
  const estArea = (pop / params.density.middle) * 1e4;
  const ctx = makeCtx(world, params, 2.6 * Math.sqrt(estArea / Math.PI) + 450);
  const stats: Record<string, number | string> = { pop, archetype, walled: walled ? 1 : 0, morphology: params.id };
  const mainAngle = mainRoadAngle(world);
  const streets = new Streets();

  const plan = planTownPhases(ctx, pop, walled, mainAngle, rng.fork('phases'));
  const faubPop = pop * (walled ? 0.17 : 0.1);
  const faub = planFaubourgs(ctx, plan.enclosure, roads, (faubPop / params.density.faubourg) * 1e4, walled ? 22 : 0, rng.fork('faubourg'));
  const t1 = performance.now();
  const prim = buildPrimary(ctx, {
    phases: plan.phases, enclosure: plan.enclosure, walled, faubourg: faub.region, roads,
    marketArea: MARKET_AREA(pop), mainAngle, extraRadials: true,
  }, streets, rng.fork('primary'));
  const t2 = performance.now();
  stats['ms.phases'] = Math.round(t1 - t0);
  stats['ms.primary'] = Math.round(t2 - t1);
  stats['quarters'] = prim.quarters.length;
  stats['ha.enclosed'] = Math.round(mpArea(plan.enclosure) / 1e3) / 10;

  // ---- level 2: blocks
  const nucleus = prim.market ? polygonCentroid(prim.market) : ctx.center;
  const field = new GuidanceField(ctx, nucleus, streets, mainAngle, rng.fork('field'));
  const pieces: Piece[][] = prim.quarters.map((q, qi) => splitQuarter(ctx, q, qi, streets, field, { nucleus, gridAngle: mainAngle }, rng.fork('q:' + qi)));
  const t3 = performance.now();
  const closes = addCloses(ctx, pieces.flat(), streets, rng.fork('closes'));
  const carved: CarvedBlock[] = [];
  const streetSpace: MultiPoly[] = [];
  const ribIdx = buildRibbonIndex(streets, prim.walls.map((w) => ({ path: w.ring.concat([w.ring[0]]), width: 2.6 + 3 })));
  prim.quarters.forEach((q, qi) => {
    const r = carveBlocks(q, pieces[qi], ribIdx, []);
    carved.push(...r.blocks);
    streetSpace.push(r.streetSpace);
  });
  const t4 = performance.now();
  stats['ms.split'] = Math.round(t3 - t2);
  stats['ms.carve'] = Math.round(t4 - t3);
  stats['blocks'] = carved.length;
  stats['closes'] = closes;

  const toPH = (m: { outer: Polygon; holes: Polygon[] }[]): PolyHT[] => m.map((p) => ({ outer: p.outer, holes: p.holes }));
  const layerStreets: UrbanStreet[] = streets.list.map((s) => ({
    path: s.path, width: s.widths.reduce((a, b) => a + b, 0) / s.widths.length, widths: s.widths,
    kind: s.rank <= 1 ? 'main' : s.rank <= 2 ? 'street' : 'alley', rank: s.rank, role: s.role, phase: s.phase,
  }));
  const layer: UrbanLayer = {
    footprint: prim.footprint.map((p) => p.outer),
    footprintH: toPH(prim.footprint),
    streets: layerStreets,
    blocks: carved.map((b) => b.poly), parcels: [], buildings: [],
    walls: prim.walls.map((w) => ({ path: w.ring, closed: true, towers: [], gates: w.gates.map((g) => g.p), thickness: 2.6, gateInfo: w.gates.map((g) => ({ p: g.p, dir: g.dir, width: g.width })) })),
    landmarks: [], squares: prim.market ? [prim.market] : [],
    archetype, population: pop, morphology: params.id,
    phases: plan.phases.map((p) => ({ id: p.id, kind: p.kind, zone: p.zone, region: toPH(p.region), walled: p.walled, fossil: p.fossil })),
    quarters: prim.quarters.map((q, qi) => ({ poly: { outer: q.lp.pts, holes: [] }, phase: q.phase, zone: q.zone, streetSpace: toPH(streetSpace[qi]) })),
    blockInfo: carved.map((b) => ({ quarter: b.quarter, phase: b.phase, zone: b.zone, kind: b.kind })), masses: [], backLand: [],
  };
  const debug: UrbanDebug = { quarters: prim.quarters.map((q) => ({ poly: q.lp.pts, phase: q.phase, lab: q.lp.lab })) };
  stats['ms.urban'] = Math.round(performance.now() - t0);
  void ({} as Vec2);
  return { layer, stats, debug };
}
