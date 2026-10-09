import { refreshCavernMask } from './terrain/caverns';
import { Rng } from './core/rng';
import { Options, cleanSettlementName, mapSizeOf, effectiveSize, MAP_SIZE_MAX, optionsForMainSettlement, generationUid } from './options';
import type { World, Settlement } from './types';
import { terrainForExtent } from './terrain/hydrology';
import { chooseSite } from './site/site';
import { getCulture, populationCulture } from './urban/culture';
import { routeRoads } from './roads/regional';
import { generateRural } from './landuse/rural';
import { generateNaturalCover } from './landuse/natural';
import { generateUrban } from './urban';
import { generateNames, settlementNames } from './names';
import { planSettlements } from './settlements/planner';
import { routeNetwork } from './settlements/network';
import { generateSettlementUrban } from './settlements/urban';
import { choosePopulation } from './urban/phases';
import { scaleMinPop, scaleMaxPop } from './urban/culture';
import { generateMega, megaRadius } from './urban/mega/plan';
import { EAGER_MAIN_POP } from './urban/mega/types';
import { requiredMegaExtent } from './urban/mega/extent';

/** Above this total population, secondary settlements are generated lazily (on demand, URBAN_MORPHOLOGY §3d). */
export const EAGER_POP = 50000;
/** The urban engine's ceiling for the main settlement (megacity detail is not generated). */
export const MAIN_POP_CAP = 250000;
export { EAGER_MAIN_POP };

/** The main settlement's population as the urban stage draws it (size preset range, culture scale bounds). */
export function mainPopulation(o: Options, root: Rng): number {
  const culture = getCulture(o.culture);
  let pop = choosePopulation(o.size, o.population, root.fork('urban').fork('pop'));
  if (culture.scale) pop = Math.round(Math.max(scaleMinPop(culture.scale.min), Math.min(pop, scaleMaxPop(culture.scale.max) * 1.5)));
  return pop;
}

/** Explicit extents, imported rasters and automatic-population links keep their scale. */
export function generationMapSize(o: Options, root = new Rng('magna-urbis:' + o.seed)): number {
  const preset = mapSizeOf(o);
  if (o.workflow === 'environment') return preset;
  if (o.mapSize !== undefined || o.importedHeight || o.population <= 0) return preset;
  const pop = mainPopulation(o, root);
  if (populationCulture(o.culture, pop).camp || pop <= (o.eagerPop ?? EAGER_MAIN_POP)) return preset;
  return Math.min(MAP_SIZE_MAX, Math.max(preset, requiredMegaExtent(megaRadius(pop, o))));
}

export interface GenerateOptions {
  /** Force every secondary settlement lazy (true) or eager (false); default: by total population. */
  lazy?: boolean;
  /**
   * Reuse of the previous run's expensive stages (a generation worker keeps one): the terrain when only
   * non-terrain options changed (biome, culture, settlements...), and the main settlement (site, regional roads,
   * town plan) when only secondary settlements changed. Every stage derives its randomness with `fork`, so a
   * reused stage is identical to a recomputed one; entries are cloned in and out, never shared.
   */
  cache?: GenerationCache;
}

type TerrainStage = ReturnType<typeof terrainForExtent>;
interface MainStage { site: World['site']; roads: World['roads']; bridges: World['bridges']; urban: World['urban']; debug: World['debug']; stats: Record<string, number | string>; warnings: string[] }
export interface GenerationCache {
  terrain?: { key: string; value: TerrainStage };
  main?: { key: string; value: MainStage };
  /** Which stages the last run reused (diagnostics). */
  hits?: { terrain: boolean; main: boolean };
}
export const createGenerationCache = (): GenerationCache => ({});

/** Every option the terrain stage reads (gen/terrain), plus the extent; null for imported rasters (not cached). */
function terrainKey(o: Options, mapSize: number): string | null {
  if (o.importedHeight) return null;
  const extra = o as unknown as Record<string, unknown>;
  // (heightfield reads `seaLevel ?? 0`; the import scalars only matter with an imported raster, which is not cached)
  return JSON.stringify([o.seed, o.relief, o.coast, o.river, o.seaLevel ?? 0, mapSize, extra.lakes ?? 'auto']);
}
/** Display controls never reach the generation; the secondary list only matters through its `none` marker. */
function mainKey(tk: string, main: Options, mega: boolean): string {
  const { style: _s, contours: _c, landuse: _l, labels: _b, legend: _g, settlements, ...rest } = main;
  return tk + '|' + mega + '|' + JSON.stringify({ ...rest, settlements: settlements === 'none' ? 'none' : 'other' });
}

/** `onStage` (optional) is told which stage is about to run, for progress display. */
export function generate(options: Options, onStage?: (stage: string, partial?: World) => void, gopts: GenerateOptions = {}): World {
  if (options.biome === 'underdark-caverns') {
    const world = generate({ ...options, biome: 'underdark' }, (stage, partial) => onStage?.(stage, partial ? { ...partial, options: { ...partial.options, biome: 'underdark-caverns' } } : undefined), gopts);
    world.options = { ...world.options, biome: 'underdark-caverns' };
    if (world.uid) world.uid = generationUid(options);
    onStage?.('cavern walls', world);
    refreshCavernMask(world);
    world.stats['ms.total'] = Number(world.stats['ms.total'] ?? 0) + Number(world.stats['ms.caverns'] ?? 0);
    return world;
  }
  const requestedOptions = options;
  const mainInput = optionsForMainSettlement(options);
  const t0 = performance.now();
  onStage?.('terrain');
  const root = new Rng('magna-urbis:' + options.seed);
  const mapSize = generationMapSize(mainInput, root);
  const cache = gopts.cache;
  const tk = cache ? terrainKey(options, mapSize) : null;
  const terrainHit = !!tk && cache?.terrain?.key === tk;
  let terrainStage: TerrainStage;
  if (terrainHit) {
    const t = performance.now();
    terrainStage = { terrain: structuredClone(cache!.terrain!.value.terrain), timings: { height: performance.now() - t, hydrology: 0, rivers: 0, polygons: 0 } };
  } else {
    terrainStage = terrainForExtent(options, mapSize, root);
    if (cache) cache.terrain = tk ? { key: tk, value: structuredClone(terrainStage) } : undefined;
  }
  const { terrain, timings } = terrainStage;
  if (cache) cache.hits = { terrain: terrainHit, main: false };
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

  const worldOptions = mapSize !== mapSizeOf(options) ? { ...options, mapSize } : options;
  const world: World = { seed: options.seed, options: worldOptions, mapSize, terrain, stats };
  if (options.workflow) world.uid = generationUid(requestedOptions);
  if (options.workflow === 'environment') {
    onStage?.('natural cover', world);
    const tn = performance.now();
    world.landuse = generateNaturalCover(terrain, options.biome, root);
    stats['ms.natural'] = r(performance.now() - tn);
    stats['ms.total'] = r(performance.now() - t0);
    return world;
  }
  // the main settlement is generated with its effective size class (custom maps: from the population)
  const mainConfigured = optionsForMainSettlement(worldOptions);
  const mainSpec = worldOptions.workflow === 'list' && worldOptions.settlements &&
    typeof worldOptions.settlements === 'object' && 'list' in worldOptions.settlements
    ? worldOptions.settlements.list[0] : undefined;
  const size = mainSpec?.options?.size ?? effectiveSize(mainConfigured);
  const warnings: string[] = [];
  let mainOpts: Options = size !== mainConfigured.size ? { ...mainConfigured, size } : mainConfigured;
  const eagerPop = options.eagerPop ?? EAGER_MAIN_POP;
  const mainPop = mainPopulation(mainOpts, root);
  const megaPop = populationCulture(mainOpts.culture, mainPop).camp ? 0 : mainPop;
  const mega = megaPop > eagerPop;
  if (!mega && mainOpts.population > MAIN_POP_CAP) {
    warnings.push(`main settlement: ${mainOpts.population} inhabitants requested, plan generated for ${MAIN_POP_CAP} (megacity detail is not available)`);
    mainOpts = { ...mainOpts, population: MAIN_POP_CAP };
  }
  /** The World as the main-settlement stages see it (same object when the options are unchanged). */
  const mainView = (): World => (mainOpts === worldOptions ? world : { ...world, options: mainOpts });

  let t3 = performance.now();
  const mk = tk ? mainKey(tk, mainOpts, mega) : null;
  const mainHit = !!mk && cache?.main?.key === mk;
  if (mainHit) {
    onStage?.('town', world);
    const v = structuredClone(cache!.main!.value);
    world.site = v.site; world.roads = v.roads; world.bridges = v.bridges; world.urban = v.urban;
    if (v.debug) world.debug = v.debug;
    Object.assign(stats, v.stats);
    warnings.push(...v.warnings);
    cache!.hits!.main = true;
  } else {
    const statsBefore = new Set(Object.keys(stats)), warningsBefore = warnings.length;
    const t1 = performance.now();
    onStage?.('site & roads', world);
    // the culture's site preferences apply unless the options set their own
    const cprefs = getCulture(mainOpts.culture).sitePrefs;
    let siteOpts = mainOpts.sitePrefs || !cprefs ? mainOpts : { ...mainOpts, sitePrefs: cprefs };
    // a megacity needs its built-up radius free around the site (kept off the map edge as far as the map allows)
    if (mega) {
      const clearance = 1.3 * megaRadius(megaPop, mainOpts) + 600;
      siteOpts = { ...siteOpts, sitePrefs: { ...(siteOpts.sitePrefs ?? {}), margin: clearance / mapSize, centerInset: clearance } };
    }
    world.site = chooseSite(terrain, siteOpts, mapSize, root);
    if (world.site.warning) warnings.push(world.site.warning);
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
    t3 = performance.now();
    stats['ms.roads'] = r(t3 - t2);
    stats['roads'] = rr.roads.length;
    stats['bridges'] = rr.bridges.length;

    onStage?.('town', world);
    {
      const mv = mainView();
      if (mega) {
        const mr = generateMega(mv, root, megaPop, eagerPop);
        warnings.push(...mr.warnings);
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
    if (cache) {
      cache.main = mk ? { key: mk, value: structuredClone({
        site: world.site, roads: world.roads, bridges: world.bridges, urban: world.urban, debug: world.debug,
        stats: Object.fromEntries(Object.entries(stats).filter(([k]) => !statsBefore.has(k))), warnings: warnings.slice(warningsBefore),
      }) } : undefined;
    }
  }
  const t3b = performance.now();
  stats['ms.urbanTotal'] = r(t3b - t3);

  // ---- settlement system (M3c): planner, road network, secondary plans
  onStage?.('settlements', world);
  const mainRoads = world.roads!.length;
  const plan = planSettlements(world, worldOptions, root, mainOpts);
  warnings.push(...plan.warnings);
  const settlements: Settlement[] = plan.settlements;
  world.settlements = settlements;
  const t4a = performance.now();
  stats['ms.planner'] = r(t4a - t3b);
  for (const [k, v] of Object.entries(plan.ms ?? {})) stats['planner.ms.' + k] = v;
  if (settlements.length > 1) {
    const net = routeNetwork(world, settlements, root);
    world.roads = [...world.roads!, ...net.roads];
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
    world.names = generateNames(mainView(), root);
    settlementNames(world, root);
    applyNameOverrides(world);
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
  const base = world.options.biome === 'underdark-caverns' ? { ...world, options: { ...world.options, biome: 'underdark' as const } } : world;
  return generateSettlementUrban(base, s);
}

/**
 * Names typed by the user (list mode) replace the generated toponyms in the labels, the cartouche and the derived
 * landmark names ("<town> Castle"). Applied after naming, so no other name or random stream moves.
 */
export function applyNameOverrides(world: World): void {
  const o = world.options, names = world.names;
  if (o.workflow !== 'list' || !names || !world.settlements || !o.settlements || typeof o.settlements !== 'object' || !('list' in o.settlements)) return;
  const specs = o.settlements.list;
  // the same keys as the planner: the first entry is the main settlement, then `key` or the list index
  const byKey = new Map(specs.map((spec, k) => [k === 0 ? 'main' : spec.key ?? String(k), spec]));
  for (const s of world.settlements) {
    const name = cleanSettlementName(byKey.get(s.main ? 'main' : s.key)?.name);
    if (!name) continue;
    if (s.main) {
      const old = names.town;
      for (const e of names.entries) if (old && e.text.includes(old)) e.text = e.text === old ? name : e.text.split(old).join(name);
      names.town = name;
    } else {
      for (const e of names.entries) if (e.sub === 'settlement:' + s.key) e.text = name;
    }
    s.name = name;
  }
}
