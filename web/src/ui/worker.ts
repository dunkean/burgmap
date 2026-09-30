import { generate } from '../gen/pipeline';
import { renderSvg } from '../render/svg';
import type { Options } from '../gen/options';

export interface WorkerRequest { id: number; options: Options }
export interface WorkerResponse { id: number; svg?: string; stats?: Record<string, number | string>; error?: string; ms?: number }

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, options } = e.data;
  try {
    const t0 = performance.now();
    const world = generate(options);
    const svg = renderSvg(world, { style: options.style });
    const res: WorkerResponse = { id, svg, stats: world.stats, ms: Math.round(performance.now() - t0) };
    (self as unknown as Worker).postMessage(res);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.stack ?? err) } satisfies WorkerResponse);
  }
};
