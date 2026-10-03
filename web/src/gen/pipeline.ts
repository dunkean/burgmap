import { Rng } from './core/rng';
import { Options, mapSizeOf, effectiveSize } from './options';
import type { World, Settlement } from './types';
import { terrainForExtent } from './terrain/hydrology';
import { chooseSite } from './site/site';
import { getCulture } from './urban/culture';
import { routeRoads } from './roads/regional';
import { generateRural } from './landuse/rural';
import { generateUrban } from './urban';
import { generateNames, settlementNames } from './names';
import { planSettlements } from './settlements/planner';
import { routeNetwork } from './settlements/network';
import { generateSettlementUrban } from './settlements/urban';
import { choosePopulation } from './urban/phases';
import { scaleMinPop, scaleMaxPop } from './urban/culture';
import { generateMega } from './urban/mega/plan';

/** Above this total population, secondary settlements are generated lazily (on demand, URBAN_MORPHOLOGY §3d). */
export const EAGER_POP = 50000;
/** The urban engine's ceiling for the main settlement (megacity detail is not generated). */
export const MAIN_POP_CAP = 250000;
/**
 * Main settlements above this population get the megacity path (URBAN_MORPHOLOGY §3d): an eager macro plan, the
 * quarters' detail generated lazily. At or below it everything is generated eagerly (unchanged output).
 * Option `eagerPop` (URL `eager=`) overrides it.
 */
export const EAGER_MAIN_POP = 40000;

/** The main settlement's population as the urban stage draws it (size preset range, culture scale bounds). */
export function mainPopulation(o: Options, root: Rng): number {
  const culture = getCulture(o.culture);
  let pop = choosePopulation(o.size, o.population, root.fork('urban').fork('pop'));
  if (culture.scale) pop = Math.round(Math.max(scaleMinPop(culture.scale.min), Math.min(pop, scaleMaxPop(culture.scale.max) * 1.5)));
  return pop;
}

export interface GenerateOptions {
  /** Force every secondary settlement lazy (true) or eager (false); default: by total population. */
  lazy?: boolean;
}

/** `onStage` (optional) is told which stage is about to run, for progress display. */
export function generate(options: Options, onStage?: (stage: string, partial?: World) => void, gopts: GenerateOptions = {}): World {
  const t0 = performance.now();
  onStage?.('terrain');
  const root = new Rng('burgmap:' + options.seed);
  const mapSize = mapSizeOf(options);
  const { terrain, timings } = terrainForExtent(options, mapSize, root);
  const stats: Record<string, number | string> = {};
  const r = (v: number) => Math.round(v);
  stats['ms.height'] = r(timings.height);
  stats['ms.hydrology'] = r(timings.hydrology);
  stats['ms.rivers'] = r(timings.rivers);
  stats['ms.polygons'] = r(timings.polygons);
  stats['ms.terrain'] = r(timings.height + timings.hydrology + timings.rivers + timings.polygons);
  stats['seaFraction'] = Math.round(terrain.seaFraction * 1000) / 1000;
  stats['rivers'] = terrain.rivers.length;
  stats['lakes'] = terrain.lakes.length;

  const world: World = { seed: options.seed, options, mapSize, terrain, stats };
  // the main settlement is generated with its effective size class (custom maps: from the population)
  const size = effectiveSize(options);
  const warnings: string[] = [];
  let mainOpts: Options = size !== options.size ? { ...options, size } : options;
  const eagerPop = options.eagerPop ?? EAGER_MAIN_POP;
  const megaPop = getCulture(options.culture).camp ? 0 : mainPopulation(mainOpts, root);
  const mega = megaPop > eagerPop;
  if (!mega && mainOpts.population > MAIN_POP_CAP) {
    warnings.push(`main settlement: ${options.population} inhabitants requested, plan generated for ${MAIN_POP_CAP} (megacity detail is not available)`);
    mainOpts = { ...mainOpts, population: MAIN_POP_CAP };
  }
  /** The World as the main-settlement stages see it (same object when the options are unchanged). */
  const mainView = (): World => (mainOpts === options ? world : { ...world, options: mainOpts });

  const t1 = performance.now();
  onStage?.('site & roads', world);
  // the culture's site preferences apply unless the options set their own
  const cprefs = getCulture(options.culture).sitePrefs;
  world.site = chooseSite(terrain, mainOpts.sitePrefs || !cprefs ? mainOpts : { ...mainOpts, sitePrefs: cprefs }, mapSize, root);
  const t2 = performance.now();
  stats['ms.site'] = r(t2 - t1);
  stats['site.x'] = r(world.site.center.x);
  stats['site.y'] = r(world.site.center.y);
  stats['site.archetype'] = world.site.archetype;
  stats['site.offers'] = Object.entries(world.site.offers).map(([k, v]) => `${k}:${v}`).join(' ');
  stats['site.crossing'] = world.site.crossing ? 1 : 0;
  stats['site.harbor'] = world.site.harbor ? 1 : 0;
  stats['site.citadel'] = world.site.citadelSpot ? 1 : 0;

  const rr = routeRoads(terrain, world.site, mainOpts, mapSize, root);
  world.roads = rr.roads;
  world.bridges = rr.bridges;
  const t3 = performance.now();
  stats['ms.roads'] = r(t3 - t2);
  stats['roads'] = rr.roads.length;
  stats['bridges'] = rr.bridges.length;

  onStage?.('town', world);
  {
    const mv = mainView();
    if (mega) {
      const mr = generateMega(mv, root, megaPop, eagerPop);
      world.urban = mr.layer;
      if (mr.bridges.length) world.bridges = [...(world.bridges ?? []), ...mr.bridges];
      for (const [k, v] of Object.entries(mr.stats)) stats[k.startsWith('ms.') ? k : 'urban.' + k] = v;
    } else {
      const ur = generateUrban(mv, root);
      if (mv !== world) world.bridges = mv.bridges;
      world.urban = ur.layer;
      world.debug = { urban: ur.debug };
      for (const [k, v] of Object.entries(ur.stats)) stats[k.startsWith('ms.') ? k : 'urban.' + k] = v;
    }
  }
  const t3b = performance.now();
  stats['ms.urbanTotal'] = r(t3b - t3);

  // ---- settlement system (M3c): planner, road network, secondary plans
  onStage?.('settlements', world);
  const mainRoads = world.roads.length;
  const plan = planSettlements(world, options, root);
  warnings.push(...plan.warnings);
  const settlements: Settlement[] = plan.settlements;
  world.settlements = settlements;
  const t4a = performance.now();
  stats['ms.planner'] = r(t4a - t3b);
  for (const [k, v] of Object.entries(plan.ms ?? {})) stats['planner.ms.' + k] = v;
  if (settlements.length > 1) {
    const net = routeNetwork(world, settlements, root);
    world.roads = [...world.roads, ...net.roads];
    world.bridges = [...(world.bridges ?? []), ...net.bridges];
    warnings.push(...net.warnings);
    for (const [k, v] of Object.entries(net.stats)) stats['network.' + k] = v;
    stats['network.unreachable'] = net.unreachable.length;
  }
  const t4b = performance.now();
  stats['ms.network'] = r(t4b - t4a);
  const totalPop = settlements.reduce((s, x) => s + x.population, 0);
  const lazy = gopts.lazy ?? totalPop > EAGER_POP;
  if (settlements.length > 1) {
    onStage?.('villages', world);
    let built = 0;
    // new town bridges are added after all plans: every plan sees the same inputs as its lazy twin
    const newBridges: NonNullable<World['bridges']> = [];
    for (const s of settlements) {
      if (s.main || s.detail === 'farmstead') continue;
      if (lazy) { s.detail = 'lazy'; continue; }
      const res = generateSettlementUrban(world, s);
      if (!res) continue;
      s.urban = res.urban;
      newBridges.push(...res.bridges);
      built++;
    }
    if (newBridges.length) world.bridges = [...(world.bridges ?? []), ...newBridges];
    stats['settlements.built'] = built;
  }
  const t4c = performance.now();
  stats['ms.settlements'] = r(t4c - t4b);
  stats['settlements'] = settlements.length;
  stats['settlements.requested'] = plan.requested;
  stats['settlements.pop'] = totalPop;
  stats['settlements.lazy'] = lazy ? settlements.filter((s) => s.detail === 'lazy').length : 0;
  for (const cls of ['city', 'town', 'village', 'hamlet', 'farmstead'] as const) {
    const c = settlements.filter((s) => !s.main && s.cls === cls).length;
    if (c) stats['settlements.' + cls] = c;
  }

  onStage?.('fields & woods', world);
  {
    const mv = mainView();
    if (mv !== world) mv.settlements = world.settlements;
    // big lazy maps: furlong strips only around the main town (level of detail; fields elsewhere stay plain)
    const lod = lazy ? { center: world.site!.center, radius: 4000 } : undefined;
    const lu = generateRural(mv, root, mainRoads, lod);
    world.landuse = lu.layer;
    for (const [k, v] of Object.entries(lu.stats)) stats['landuse.' + k] = v;
  }
  const t4 = performance.now();
  stats['ms.landuse'] = r(t4 - t4c);

  onStage?.('names');
  {
    world.names = generateNames(world, root);
    settlementNames(world, root);
  }
  stats['ms.names'] = r(performance.now() - t4);
  stats['names.town'] = world.names.town;
  if (warnings.length) stats['settlements.warning'] = warnings.join(' | ');

  stats['ms.total'] = r(performance.now() - t0);
  return world;
}

/**
 * Lazy detail: the plan of secondary settlement `index` of a generated World (same result as eager generation).
 * Returns the urban layer and the new town bridges; the World is not modified.
 */
export function generateSettlementDetail(world: World, index: number): ReturnType<typeof generateSettlementUrban> {
  const s = world.settlements?.[index];
  if (!s) return null;
  return generateSettlementUrban(world, s);
}
