/**
 * Generation worker (G).
 *
 * - `run` (offscreen mode): generates the world, streams stage snapshots to the render worker over `port`
 *   (the World never goes to the main thread), keeps the final World for exports, tells the page only stats + a tiny meta.
 * - `export`: builds the SVG / JSON of the kept World here, so the page never blocks on it.
 * - legacy request `{ id, options }`: returns the whole World by structured clone (used when there is no render worker).
 */
import { generate } from '../gen/pipeline';
import type { Options } from '../gen/options';
import type { World, Vec2 } from '../gen/types';
import { renderSvg } from '../render/svg';
import { FONT_STACKS, fontString } from '../render/labelStyles';
import { worldToJson } from './exportWorld';
import type { GRequest, GResponse, GExport, GRun, WorldMsg } from './protocol';

export interface WorkerRequest { id: number; options: Options }
export interface WorkerResponse { id: number; world?: World; stats?: Record<string, number | string>; error?: string; ms?: number; /** progress message: the stage about to run */ stage?: string }

const ctx = self as unknown as Worker;
let lastWorld: World | null = null;
let lastId = -1;

/**
 * What the renderer needs of a World: drops `debug` and the big analysis rasters (site cost/fields, flow accumulation,
 * receivers, filled surface) so a snapshot clones in a fraction of the time. The Scene/renderer never read them.
 */
function forRender(w: World): World {
  const { debug: _d, ...rest } = w as World & { debug?: unknown };
  const out: World = { ...rest } as World;
  if (w.site) { const { cost: _c, fields: _f, ...site } = w.site; out.site = site as unknown as World['site']; }
  const { flow: _fl, receiver: _r, filled: _fi, ...terrain } = w.terrain;
  out.terrain = terrain as unknown as World['terrain'];
  return out;
}

/** Stages whose start is worth a snapshot (what exists at that point is drawable). */
const SNAP_STAGES = new Set(['site & roads', 'town', 'fields & woods']);

function doRun(m: GRun): void {
  const { id, options, port } = m;
  const post = (r: GResponse): void => ctx.postMessage(r);
  try {
    const t0 = performance.now();
    lastWorld = null; lastId = id;
    const world = generate(options, (stage: string, partial?: World) => {
      post({ type: 'stage', id, stage });
      // `partial` is the World built so far (pipeline.ts passes it as 2nd argument); older pipelines pass nothing
      if (partial && SNAP_STAGES.has(stage)) port.postMessage({ type: 'world', gen: id, world: forRender(partial), final: false, stage } satisfies WorldMsg);
    });
    lastWorld = world;
    port.postMessage({ type: 'world', gen: id, world: forRender(world), final: true, stage: 'done' } satisfies WorldMsg);
    const anchors: Record<string, Vec2[]> = {};
    for (const e of world.names?.entries ?? []) (anchors[e.kind] ??= []).push(e.anchor);
    post({
      type: 'done', id, ms: Math.round(performance.now() - t0), stats: world.stats,
      meta: { center: world.site?.center ?? { x: world.mapSize / 2, y: world.mapSize / 2 }, anchors, mapSize: world.mapSize },
    });
  } catch (err) {
    post({ type: 'error', id, error: String((err as Error)?.stack ?? err) });
  }
}

function doExport(m: GExport): void {
  const post = (r: GResponse): void => ctx.postMessage(r);
  const t0 = performance.now();
  try {
    if (!lastWorld) throw new Error('no world available (still generating?)');
    let blob: Blob;
    if (m.kind === 'json') blob = new Blob([worldToJson(lastWorld)], { type: 'application/json' });
    else {
      const d = m.display;
      const mctx = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1).getContext('2d') : null;
      const measure = (t: string, s: number, st: Parameters<typeof fontString>[0]): number => {
        if (!mctx) return t.length * s * 0.5;
        mctx.font = fontString(st, s, FONT_STACKS[d.style]);
        return mctx.measureText(t).width;
      };
      const svg = renderSvg(lastWorld, { style: d.style, contours: d.contours, landuse: d.landuse, labels: d.labels !== false, legend: !!d.legend, measure });
      blob = new Blob([svg], { type: 'image/svg+xml' });
    }
    post({ type: 'exported', id: m.id, kind: m.kind, blob, ms: performance.now() - t0 });
  } catch (err) {
    post({ type: 'exported', id: m.id, kind: m.kind, error: String((err as Error)?.message ?? err), ms: performance.now() - t0 });
  }
}

self.onmessage = (e: MessageEvent<GRequest | WorkerRequest>) => {
  const m = e.data as GRequest & Partial<WorkerRequest>;
  if (m.type === 'run') return doRun(m);
  if (m.type === 'export') return doExport(m);
  // legacy: whole World back by structured clone
  const { id, options } = e.data as WorkerRequest;
  const post = (r: WorkerResponse): void => ctx.postMessage(r);
  try {
    const t0 = performance.now();
    const world = generate(options, (stage) => post({ id, stage }));
    post({ id, world, stats: world.stats, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    post({ id, error: String((err as Error)?.stack ?? err) });
  }
};
void lastId;
