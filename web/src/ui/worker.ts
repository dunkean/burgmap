import { generate } from '../gen/pipeline';
import type { Options } from '../gen/options';
import type { World } from '../gen/types';

export interface WorkerRequest { id: number; options: Options }
// CANVAS-VIEWER: the worker returns the World (structured clone); SVG is rendered on demand for export.
export interface WorkerResponse { id: number; world?: World; stats?: Record<string, number | string>; error?: string; ms?: number; /** progress message: the stage about to run */ stage?: string }

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, options } = e.data;
  const post = (r: WorkerResponse): void => (self as unknown as Worker).postMessage(r);
  try {
    const t0 = performance.now();
    const world = generate(options, (stage) => post({ id, stage }));
    post({ id, world, stats: world.stats, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    post({ id, error: String((err as Error)?.stack ?? err) });
  }
};
