/**
 * Generation worker (G).
 *
 * - `run` (offscreen mode): generates the world, sends its final snapshot to the render worker over `port`
 *   (the World never goes to the main thread), keeps the final World for exports, tells the page only stats + a tiny meta.
 * - `export`: builds the SVG / JSON of the kept World here, so the page never blocks on it.
 * - legacy request `{ id, options }`: returns the whole World by structured clone (used when there is no render worker).
 */
import { generate, generateSettlementDetail } from '../gen/pipeline';
import type { Options } from '../gen/options';
import type { World } from '../gen/types';
import { renderSvg } from '../render/svg';
import { FONT_STACKS, fontString } from '../render/labelStyles';
import { worldToJson } from './exportWorld';
import type { GRequest, GResponse, GExport, GRun, WorldMsg, GDetail, SettlementMsg, GQuarters, QuarterMsg } from './protocol';
import { QuarterQueue } from './megaQueue';
import { exportMeasure } from './exportMeasure';
import { worldMeta } from './worldMeta';

export interface WorkerRequest { id: number; options: Options }
export interface WorkerResponse {
  id: number; world?: World; stats?: Record<string, number | string>; error?: string; ms?: number; /** progress message: the stage about to run */ stage?: string;
  /** legacy mode, lazy detail (M3c): the plan of one secondary settlement */
  detail?: { index: number; urban: NonNullable<World['urban']>; bridges: NonNullable<World['bridges']> };
  /** legacy mode, megacity: detailed quarters and quarters evicted from the cache */
  quarters?: { layers: Record<number, NonNullable<World['urban']>>; drop: number[]; done: number; queued: number; total: number };
}

const ctx = self as unknown as Worker;
const textMeasure = exportMeasure();
ctx.postMessage({ type: 'capabilities', textMeasure: !!textMeasure } satisfies GResponse);
let lastWorld: World | null = null;
let lastId = -1;
let lastPort: MessagePort | null = null;
/** Megacity: the quarter detail queue of the kept World. */
let quarters: QuarterQueue | null = null;

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

function doRun(m: GRun): void {
  const { id, options, port } = m;
  const post = (r: GResponse): void => ctx.postMessage(r);
  try {
    const t0 = performance.now();
    quarters?.stop(); quarters = null;
    lastWorld = null; lastId = id; lastPort = port;
    const world = generate(options, (stage: string) => {
      post({ type: 'stage', id, stage });
      // Keep the preceding map until the final scene, without cloning and preparing discarded stage snapshots.
    });
    lastWorld = world;
    port.postMessage({ type: 'world', gen: id, world: forRender(world), final: true, stage: 'done' } satisfies WorldMsg);
    post({
      type: 'done', id, ms: Math.round(performance.now() - t0), stats: world.stats,
      meta: worldMeta(world),
    });
    // megacity: the old core's quarters are detailed in the background right away
    if (world.urban?.macro) quarterQueue(id)?.prefetch();
  } catch (err) {
    post({ type: 'error', id, error: String((err as Error)?.stack ?? err) });
  }
}

/**
 * Megacity: the quarter queue of the kept World (created on first use), emitting to the render worker / page. (The
 * plans of big secondary settlements join it when their lazy detail arrives.)
 */
function quarterQueue(id: number): QuarterQueue | null {
  if (!lastWorld || lastId !== id) return null;
  if (!quarters) {
    const port = lastPort;
    quarters = new QuarterQueue(lastWorld, (layers, drop, st) => {
      if (port) {
        port.postMessage({ type: 'quarters', gen: id, layers, drop } satisfies QuarterMsg);
        ctx.postMessage({ type: 'quartersDone', id, done: st.done, queued: st.queued, total: st.total, ms: st.ms } satisfies GResponse);
      } else ctx.postMessage({ id, quarters: { layers, drop, done: st.done, queued: st.queued, total: st.total } } satisfies WorkerResponse);
    });
  }
  return quarters;
}

function doQuarters(m: GQuarters): void {
  quarterQueue(m.id)?.request(m.rect);
}

function doExport(m: GExport): void {
  const post = (r: GResponse): void => ctx.postMessage(r);
  const t0 = performance.now();
  try {
    if (!lastWorld || m.gen !== lastId) throw new Error('the requested map is no longer available');
    // megacity: the export shows the quarters generated so far, or (full) every quarter
    const q = quarterQueue(lastId);
    if (q && q.total > 0) {
      const det: Record<number, NonNullable<World['urban']>> = m.full ? q.all((d, n) => post({ type: 'quartersDone', id: lastId, done: d, queued: n - d, total: n, ms: 0 })) : Object.fromEntries(q.cache);
      lastWorld = { ...lastWorld, megaDetail: det };
    }
    let blob: Blob;
    if (m.kind === 'json') blob = new Blob([worldToJson(lastWorld)], { type: 'application/json' });
    else {
      const d = m.display;
      const mctx = textMeasure;
      const measure = (t: string, s: number, st: Parameters<typeof fontString>[0]): number => {
        if (!mctx) return t.length * s * 0.5;
        mctx.font = fontString(st, s, FONT_STACKS[d.style]);
        return mctx.measureText(t).width;
      };
      const svg = renderSvg(lastWorld, { width: m.width, style: d.style, contours: d.contours, landuse: d.landuse, labels: d.labels !== false, legend: !!d.legend, measure });
      blob = new Blob([svg], { type: 'image/svg+xml' });
    }
    post({ type: 'exported', id: m.id, kind: m.kind, blob, ms: performance.now() - t0 });
  } catch (err) {
    post({ type: 'exported', id: m.id, kind: m.kind, error: String((err as Error)?.message ?? err), ms: performance.now() - t0 });
  }
}

/** Lazy detail: generate one settlement of the kept World (deterministic seeds), hand it to the renderer / page. */
function doDetail(m: GDetail): void {
  const t0 = performance.now();
  try {
    if (!lastWorld || lastId !== m.id) return;
    const s = lastWorld.settlements?.[m.index];
    if (!s || s.urban) return;
    const res = generateSettlementDetail(lastWorld, m.index);
    if (!res) return;
    s.urban = res.urban;
    if (res.bridges.length) lastWorld.bridges = [...(lastWorld.bridges ?? []), ...res.bridges];
    if (lastPort) {
      lastPort.postMessage({ type: 'settlement', gen: m.id, index: m.index, urban: res.urban, bridges: res.bridges } satisfies SettlementMsg);
      ctx.postMessage({ type: 'detailDone', id: m.id, index: m.index, ms: Math.round(performance.now() - t0) } satisfies GResponse);
    } else ctx.postMessage({ id: m.id, detail: { index: m.index, urban: res.urban, bridges: res.bridges }, ms: Math.round(performance.now() - t0) } satisfies WorkerResponse);
  } catch (err) {
    if (lastPort) ctx.postMessage({ type: 'detailDone', id: m.id, index: m.index, ms: 0, error: String((err as Error)?.message ?? err) } satisfies GResponse);
  }
}

self.onmessage = (e: MessageEvent<GRequest | WorkerRequest>) => {
  const m = e.data as GRequest & Partial<WorkerRequest>;
  if (m.type === 'run') return doRun(m);
  if (m.type === 'export') return doExport(m);
  if (m.type === 'detail') return doDetail(m);
  if (m.type === 'quarters') return doQuarters(m);
  // legacy: whole World back by structured clone
  const { id, options } = e.data as WorkerRequest;
  const post = (r: WorkerResponse): void => ctx.postMessage(r);
  try {
    const t0 = performance.now();
    quarters?.stop(); quarters = null;
    const world = generate(options, (stage) => post({ id, stage }));
    lastWorld = world; lastId = id; lastPort = null;
    post({ id, world, stats: world.stats, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    post({ id, error: String((err as Error)?.stack ?? err) });
  }
};
void lastId;
