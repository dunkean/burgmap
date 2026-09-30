import { generate } from '../gen/pipeline';
import type { Options } from '../gen/options';
import type { World } from '../gen/types';

export interface WorkerRequest { id: number; options: Options }
// CANVAS-VIEWER: the worker returns the World (structured clone); SVG is rendered on demand for export.
export interface WorkerResponse { id: number; world?: World; stats?: Record<string, number | string>; error?: string; ms?: number }

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, options } = e.data;
  try {
    const t0 = performance.now();
    const world = generate(options);
    const res: WorkerResponse = { id, world, stats: world.stats, ms: Math.round(performance.now() - t0) };
    (self as unknown as Worker).postMessage(res);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.stack ?? err) } satisfies WorkerResponse);
  }
};
