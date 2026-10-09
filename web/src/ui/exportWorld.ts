/** JSON export of a generated World for other tools: options plus every vector layer, without the big rasters. */
import type { World } from '../gen/types';

const isTyped = (v: unknown): v is ArrayBufferView => ArrayBuffer.isView(v);

/**
 * Serializes the World. Typed arrays (height / slope / flow / water grids, cost fields, density maps)
 * are replaced by a short descriptor, `debug` data and an imported heightmap's pixels are dropped, and
 * numbers are rounded to centimeters. The result is a single compact JSON document.
 */
export function worldToJson(world: World): string {
  const { debug: _debug, ...rest } = world as World & { debug?: unknown };
  void _debug;
  const options = { ...rest.options } as Record<string, unknown>;
  const ih = options.importedHeight as { name?: string; w?: number; h?: number } | undefined;
  if (ih) options.importedHeight = { name: ih.name, w: ih.w, h: ih.h, pixels: 'omitted' };
  const doc = {
    format: 'magna-urbis-world',
    version: 1,
    note: typeof world.stats['developer.stage'] === 'number'
      ? `Developer pipeline snapshot, stage ${world.stats['developer.stage']}/4. Centroids use projected reserves before roads and buildings. Units are meters, origin top-left, y down. Rasters are omitted; reproduce with DebugGeneration(seed/options).advance(stage). Shared IDs open normal generation.`
      : 'Units are meters, origin top-left, y down. Rasters (terrain grids) are omitted; regenerate from seed + options to get them.',
    world: { ...rest, options },
  };
  return JSON.stringify(doc, (_k, v: unknown) => {
    if (isTyped(v)) return { omitted: v.constructor.name, length: (v as unknown as { length: number }).length };
    if (typeof v === 'number') return Number.isInteger(v) ? v : Math.round(v * 100) / 100;
    return v;
  });
}
