import { Rng } from './core/rng';
import { Options, SIZE_PRESETS } from './options';
import type { World } from './types';
import { generateTerrain } from './terrain/hydrology';
import { chooseSite } from './site/site';
import { getCulture } from './urban/culture';
import { routeRoads } from './roads/regional';
import { generateRural } from './landuse/rural';
import { generateUrban } from './urban';
import { generateNames } from './names';

/** `onStage` (optional) is told which stage is about to run, for progress display. */
export function generate(options: Options, onStage?: (stage: string, partial?: World) => void): World {
  const t0 = performance.now();
  onStage?.('terrain');
  const root = new Rng('burgmap:' + options.seed);
  const { terrain, timings } = generateTerrain(options, root);
  const stats: Record<string, number | string> = {};
  const r = (v: number) => Math.round(v);
  const mapSize = SIZE_PRESETS[options.size].mapSize;
  stats['ms.height'] = r(timings.height);
  stats['ms.hydrology'] = r(timings.hydrology);
  stats['ms.rivers'] = r(timings.rivers);
  stats['ms.polygons'] = r(timings.polygons);
  stats['ms.terrain'] = r(timings.height + timings.hydrology + timings.rivers + timings.polygons);
  stats['seaFraction'] = Math.round(terrain.seaFraction * 1000) / 1000;
  stats['rivers'] = terrain.rivers.length;
  stats['lakes'] = terrain.lakes.length;

  const world: World = { seed: options.seed, options, mapSize, terrain, stats };

  const t1 = performance.now();
  onStage?.('site & roads', world);
  // the culture's site preferences apply unless the options set their own
  const cprefs = getCulture(options.culture).sitePrefs;
  world.site = chooseSite(terrain, options.sitePrefs || !cprefs ? options : { ...options, sitePrefs: cprefs }, mapSize, root);
  const t2 = performance.now();
  stats['ms.site'] = r(t2 - t1);
  stats['site.x'] = r(world.site.center.x);
  stats['site.y'] = r(world.site.center.y);
  stats['site.archetype'] = world.site.archetype;
  stats['site.offers'] = Object.entries(world.site.offers).map(([k, v]) => `${k}:${v}`).join(' ');
  stats['site.crossing'] = world.site.crossing ? 1 : 0;
  stats['site.harbor'] = world.site.harbor ? 1 : 0;
  stats['site.citadel'] = world.site.citadelSpot ? 1 : 0;

  const rr = routeRoads(terrain, world.site, options, mapSize, root);
  world.roads = rr.roads;
  world.bridges = rr.bridges;
  const t3 = performance.now();
  stats['ms.roads'] = r(t3 - t2);
  stats['roads'] = rr.roads.length;
  stats['bridges'] = rr.bridges.length;

  onStage?.('town', world);
  const ur = generateUrban(world, root);
  world.urban = ur.layer;
  world.debug = { urban: ur.debug };
  const t3b = performance.now();
  for (const [k, v] of Object.entries(ur.stats)) stats[k.startsWith('ms.') ? k : 'urban.' + k] = v;
  stats['ms.urbanTotal'] = r(t3b - t3);

  onStage?.('fields & woods', world);
  const lu = generateRural(world, root);
  world.landuse = lu.layer;
  const t4 = performance.now();
  stats['ms.landuse'] = r(t4 - t3b);
  for (const [k, v] of Object.entries(lu.stats)) stats['landuse.' + k] = v;

  onStage?.('names');
  world.names = generateNames(world, root);
  stats['ms.names'] = r(performance.now() - t4);
  stats['names.town'] = world.names.town;

  stats['ms.total'] = r(performance.now() - t0);
  return world;
}
