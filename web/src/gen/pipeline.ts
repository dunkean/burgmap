import { Rng } from './core/rng';
import { Options, SIZE_PRESETS } from './options';
import type { World } from './types';
import { generateTerrain } from './terrain/hydrology';

export function generate(options: Options): World {
  const t0 = performance.now();
  const root = new Rng('burgmap:' + options.seed);
  const { terrain, timings } = generateTerrain(options, root);
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
  stats['ms.total'] = r(performance.now() - t0);
  return { seed: options.seed, options, mapSize: SIZE_PRESETS[options.size].mapSize, terrain, stats };
}
