import type { World } from '../gen/types';
import { biomeName } from '../gen/biomes';

/** Keep display inputs while omitting generation-only analysis from worker snapshots. */
export function worldForRender(world: World): World {
  const { debug: _debug, ...rest } = world as World & { debug?: unknown };
  const out: World = { ...rest };
  if (world.site) {
    const { cost: _cost, fields, ...site } = world.site;
    // Desert materials distinguish irrigated gardens from dry residential yards.
    out.site = (biomeName(world.options.biome) === 'desert' && fields
      ? { ...site, fields: { dWater: fields.dWater, hab: fields.hab } }
      : site) as World['site'];
  }
  const { flow: _flow, receiver: _receiver, filled: _filled, ...terrain } = world.terrain;
  out.terrain = terrain as World['terrain'];
  return out;
}
