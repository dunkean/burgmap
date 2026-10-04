import type { Options } from '../gen/options';
import type { World } from '../gen/types';
import type { MapStyle } from '../render/styles';
import type { DisplayOpts } from './protocol';

export interface ExportSnapshot { name: string; gen: number; display: DisplayOpts; world: World | null }
/** Capture identity and display choices before any await; rerolls cannot rename an earlier image. */
export function exportSnapshot(options: Options, world: World | null, gen: number, presentedGen: number): ExportSnapshot {
  if (gen !== presentedGen || (world && (world.options.seed !== options.seed || world.options.size !== options.size))) {
    throw new Error('the requested map has not been presented');
  }
  return { name: `burgmap-${options.seed}-${options.size}`, gen, world, display: {
    style: options.style as MapStyle, contours: options.contours, landuse: options.landuse, labels: options.labels, legend: options.legend,
  } };
}
