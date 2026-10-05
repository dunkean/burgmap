/** Explicit, resumable debug pipeline. The production pipeline keeps its original ordering. */
import { Rng } from './core/rng';
import { effectiveSize, generationUid, mapSizeOf, optionsForMainSettlement, type Options } from './options';
import type { World } from './types';
import { prepareTerrain, emptyTerrain, terrainForExtent, type PreparedTerrain } from './terrain/hydrology';
import { generationMapSize, mainPopulation, EAGER_POP, EAGER_MAIN_POP, MAIN_POP_CAP } from './pipeline';
import { chooseSite } from './site/site';
import { getCulture, populationCulture } from './urban/culture';
import { routeRoads } from './roads/regional';
import { planSettlements } from './settlements/planner';
import { routeNetwork } from './settlements/network';
import { generateUrban } from './urban';
import { generateMega, megaRadius } from './urban/mega/plan';
import { generateSettlementUrban } from './settlements/urban';
import { generateRural } from './landuse/rural';
import { generateNaturalCover } from './landuse/natural';
import { generateNames, settlementNames } from './names';
import { refreshCavernMask } from './terrain/caverns';
import { applyNameOverrides } from './pipeline';

export type DebugStage = 0 | 1 | 2 | 3 | 4;
export const DEBUG_STAGES = ['Empty map', 'Rivers', 'Settlement centroids', 'Roads', 'Quarters & buildings'] as const;
export function debugConfigurationKey(options: Options): string {
  const { style: _style, contours: _contours, landuse: _landuse, labels: _labels, legend: _legend, ...generation } = options;
  return JSON.stringify(generation);
}

/** Retained inside the generation worker. Snapshots are cloned; inspecting one cannot alter later stages. */
export class DebugGeneration {
  readonly options: Options;
  private readonly root: Rng;
  private readonly prepared: PreparedTerrain;
  private readonly world: World;
  private readonly mainOptions: Options;
  private readonly mainPop: number;
  private readonly mega: boolean;
  private readonly eagerPop: number;
  private readonly warnings: string[] = [];
  private stage: DebugStage = 0;
  private mainRoads = 0;
  private mainBridges = 0;

  constructor(options: Options) {
    this.options = structuredClone(options);
    this.root = new Rng('burgmap:' + options.seed);
    const mapSize = generationMapSize(optionsForMainSettlement(options), this.root);
    // Cavern envelopes depend on the occupied geometry and are added at stage 4.
    const worldOptions = { ...options, ...(mapSize !== mapSizeOf(options) ? { mapSize } : {}), ...(options.biome === 'underdark-caverns' ? { biome: 'underdark' as const } : {}) };
    this.prepared = prepareTerrain(worldOptions, mapSize, this.root);
    const terrain = emptyTerrain(this.prepared);
    this.world = { seed: options.seed, options: worldOptions, uid: generationUid(options), mapSize, terrain,
      stats: { 'ms.terrain': Math.round(this.prepared.ms), 'ms.height': Math.round(this.prepared.ms), rivers: 0, lakes: 0, seaFraction: terrain.seaFraction } };
    const configured = optionsForMainSettlement(worldOptions);
    const mainSpec = worldOptions.workflow === 'list' && typeof worldOptions.settlements === 'object' && 'list' in worldOptions.settlements ? worldOptions.settlements.list[0] : undefined;
    this.mainOptions = { ...configured, size: mainSpec?.options?.size ?? effectiveSize(configured) };
    this.mainPop = mainPopulation(this.mainOptions, this.root);
    this.eagerPop = options.eagerPop ?? EAGER_MAIN_POP;
    this.mega = !populationCulture(this.mainOptions.culture, this.mainPop).camp && this.mainPop > this.eagerPop;
    if (!this.mega && this.mainOptions.population > MAIN_POP_CAP) this.mainOptions = { ...this.mainOptions, population: MAIN_POP_CAP };
  }

  /** Advance strictly in order. No stage runs before its explicit request. */
  advance(target: DebugStage, onStage?: (stage: string) => void, displayOptions: Options = this.options): World {
    if (!Number.isInteger(target) || target < 0 || target > 4) throw new Error('Unknown developer stage.');
    if (target < this.stage) throw new Error('Restart with an empty map to return to an earlier stage.');
    while (this.stage < target) {
      const next = (this.stage + 1) as DebugStage;
      onStage?.(DEBUG_STAGES[next]);
      const t = performance.now();
      if (next === 1) this.rivers();
      if (next === 2) this.centroids();
      if (next === 3) this.roads();
      if (next === 4) this.buildings();
      this.world.stats['developer.ms.' + next] = Math.round(performance.now() - t);
      this.stage = next;
    }
    this.world.stats['developer.stage'] = target;
    this.world.stats['developer.pipeline'] = 'centroids before roads; projected settlement reserves';
    if (this.warnings.length) this.world.stats['settlements.warning'] = this.warnings.join(' | ');
    const snapshot = structuredClone(this.world);
    for (const key of ['style', 'contours', 'landuse', 'labels', 'legend'] as const) Object.assign(snapshot.options, { [key]: displayOptions[key] });
    if (this.options.biome === 'underdark-caverns') snapshot.options.biome = 'underdark-caverns';
    return snapshot;
  }

  private rivers(): void {
    const { terrain, timings } = terrainForExtent(this.world.options, this.world.mapSize, this.root, this.prepared);
    this.world.terrain = terrain;
    Object.assign(this.world.stats, { rivers: terrain.rivers.length, lakes: terrain.lakes.length, seaFraction: terrain.seaFraction,
      'ms.hydrology': Math.round(timings.hydrology), 'ms.rivers': Math.round(timings.rivers), 'ms.polygons': Math.round(timings.polygons),
      'ms.terrain': Math.round(this.prepared.ms + timings.hydrology + timings.rivers + timings.polygons) });
  }

  private centroids(): void {
    if (this.options.workflow === 'environment') return;
    const w = this.world, opts = this.mainOptions;
    const prefs = getCulture(opts.culture).sitePrefs;
    let siteOptions = opts.sitePrefs || !prefs ? opts : { ...opts, sitePrefs: prefs };
    if (this.mega) {
      const clearance = 1.3 * megaRadius(this.mainPop, opts) + 600;
      siteOptions = { ...siteOptions, sitePrefs: { ...(siteOptions.sitePrefs ?? {}), margin: clearance / w.mapSize, centerInset: clearance } };
    }
    w.site = chooseSite(w.terrain, siteOptions, w.mapSize, this.root);
    if (w.site.warning) this.warnings.push(w.site.warning);
    // The normal planner uses completed town footprints/roads. Here it uses its explicit projected reserve.
    const plan = planSettlements(w, w.options, this.root, opts, this.mainPop);
    w.settlements = plan.settlements;
    this.warnings.push(...plan.warnings);
    Object.assign(w.stats, { settlements: plan.settlements.length, 'settlements.requested': plan.requested,
      'settlements.pop': plan.settlements.reduce((sum, s) => sum + s.population, 0), 'site.x': Math.round(w.site.center.x), 'site.y': Math.round(w.site.center.y) });
  }

  private roads(): void {
    const w = this.world;
    if (!w.site) return;
    const regional = routeRoads(w.terrain, w.site, this.mainOptions, w.mapSize, this.root);
    w.roads = regional.roads; w.bridges = regional.bridges; this.mainRoads = regional.roads.length; this.mainBridges = regional.bridges.length;
    if ((w.settlements?.length ?? 0) > 1) {
      const net = routeNetwork(w, w.settlements!, this.root);
      w.roads.push(...net.roads); w.bridges.push(...net.bridges);
      this.warnings.push(...net.warnings);
      w.stats['network.unreachable'] = net.unreachable.length;
    }
    Object.assign(w.stats, { roads: w.roads.length, bridges: w.bridges.length });
  }

  private buildings(): void {
    const w = this.world;
    if (this.options.workflow === 'environment') {
      // An environment has no settlements or roads, but can still inspect hydrology and natural cover.
      w.landuse = generateNaturalCover(w.terrain, w.options.biome, this.root);
      return;
    }
    // Keep main-town inputs identical to production: the regional network is connected afterwards there.
    const networkBridges = w.bridges?.slice(this.mainBridges) ?? [];
    const view = { ...w, options: this.mainOptions, roads: w.roads?.slice(0, this.mainRoads), bridges: w.bridges?.slice(0, this.mainBridges), settlements: undefined };
    if (this.mega) {
      const result = generateMega(view, this.root, this.mainPop, this.eagerPop);
      w.urban = result.layer; this.warnings.push(...result.warnings);
      w.bridges = [...(view.bridges ?? []), ...result.bridges, ...networkBridges];
      for (const [k, v] of Object.entries(result.stats)) w.stats[k.startsWith('ms.') ? k : 'urban.' + k] = v;
    } else {
      const result = generateUrban(view, this.root);
      w.urban = result.layer; w.debug = { urban: result.debug }; w.bridges = [...(view.bridges ?? []), ...networkBridges];
      for (const [k, v] of Object.entries(result.stats)) w.stats[k.startsWith('ms.') ? k : 'urban.' + k] = v;
    }
    const main = w.settlements?.find(s => s.main);
    if (main) main.urban = w.urban;
    const lazy = Number(w.stats['settlements.pop']) > EAGER_POP;
    const bridges: NonNullable<World['bridges']> = [];
    let built = 0;
    for (const s of w.settlements ?? []) {
      if (s.main || s.detail === 'farmstead') continue;
      if (lazy) { s.detail = 'lazy'; continue; }
      const result = generateSettlementUrban(w, s);
      if (result) { s.urban = result.urban; bridges.push(...result.bridges); built++; }
    }
    w.bridges = [...(w.bridges ?? []), ...bridges];
    w.stats['settlements.built'] = built;
    w.stats['settlements.lazy'] = (w.settlements ?? []).filter(s => s.detail === 'lazy').length;
    const rural = generateRural({ ...w, options: this.mainOptions }, this.root, this.mainRoads, lazy ? { center: w.site!.center, radius: 4000 } : undefined);
    w.landuse = rural.layer;
    for (const [k, v] of Object.entries(rural.stats)) w.stats['landuse.' + k] = v;
    w.names = generateNames({ ...w, options: this.mainOptions }, this.root);
    settlementNames(w, this.root); applyNameOverrides(w);
    w.stats['names.town'] = w.names.town;
    if (this.options.biome === 'underdark-caverns') { w.options.biome = 'underdark-caverns'; refreshCavernMask(w); }
  }
}
