import type { World, Vec2 } from '../gen/types';
import type { GDone } from './protocol';

/** Tiny identity/interaction data travels with the renderer's real World, even if GDone was superseded. */
export function worldMeta(world: World): GDone['meta'] {
  const anchors: Record<string, Vec2[]> = {};
  for (const e of world.names?.entries ?? []) (anchors[e.kind] ??= []).push(e.anchor);
  const macro = world.urban?.macro;
  return {
    center: world.site?.center ?? { x: world.mapSize / 2, y: world.mapSize / 2 }, anchors, mapSize: world.mapSize,
    settlements: (world.settlements ?? []).map((s) => ({ index: s.index, key: s.key, name: s.name, cls: s.cls, population: s.population, center: s.center, radius: s.radius, detail: s.detail, hasUrban: !!s.urban || !!s.main })),
    mega: macro ? { quarters: macro.quarters.length, cityR: macro.cityR } : undefined,
  };
}
