import QuarterWorker from './quarterWorker?worker&inline';
import type { World } from '../gen/types';
import type { QuarterExecutor } from './megaQueue';
import { QuarterPool, quarterWorkerCount } from './quarterPoolCore';

/** Inline workers keep the single-file/file:// build self-contained; refusal uses the sliced fallback. */
export function createQuarterExecutor(world: World): QuarterExecutor | undefined {
  if (typeof Worker === 'undefined') return undefined;
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 1;
  const memory = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined;
  return new QuarterPool(world, () => new QuarterWorker(), quarterWorkerCount(cores, memory));
}
