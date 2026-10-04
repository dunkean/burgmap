/**
 * Main-thread side of the 'offscreen' pipeline: a generation worker (G) and a render worker (R) wired by a
 * MessageChannel per run. `OffscreenBackend.create()` returns null when the environment cannot do it
 * (no workers, blob workers refused on file://, no OffscreenCanvas/Path2D/ImageBitmap in workers): the page then
 * uses its original main-thread path.
 */
import type { Options } from '../gen/options';
import GenWorker from './worker?worker&inline';
import RenderWorker from './renderWorker?worker&inline';
import type { GResponse, GDone, RResponse, RContent, RFrame, DisplayOpts, GDetailDone, GQuartersDone } from './protocol';
import type { FrameRequest } from './viewer';

export interface BackendEvents {
  onStage(id: number, stage: string): void;
  onDone(d: GDone): void;
  onError(id: number, error: string): void;
  onRenderError?(id: number, error: string): void;
  onContent(c: RContent): void;
  onFrame(f: RFrame): void;
  /** A worker died after startup. */
  onFatal(msg: string): void;
  /** A lazily requested settlement plan was generated (M3c). */
  onDetail?(d: GDetailDone): void;
  /** Megacity: progress of the quarter detail queue. */
  onQuarters?(d: GQuartersDone): void;
}

export class OffscreenBackend {
  private gen: Worker | null = null;
  private busy = false;
  private exportId = 0;
  private currentRun = 0;
  private pending = new Map<number, { resolve(b: Blob): void; reject(e: Error): void }>();

  private constructor(private render: Worker, private ev: BackendEvents) {
    render.onmessage = (e: MessageEvent<RResponse>): void => {
      const r = e.data;
      if (r.type === 'content') ev.onContent(r);
      else if (r.type === 'frame') ev.onFrame(r);
      else if (r.type === 'error') { console.error('render worker:', r.error); ev.onRenderError?.(r.gen, r.error); }
    };
    render.onerror = (e): void => { ev.onFatal(e.message || 'render worker error'); };
  }

  /** Start the render worker and check that it can draw; null if not. */
  static create(ev: BackendEvents, dpr: number): Promise<OffscreenBackend | null> {
    return new Promise((resolve) => {
      let r: Worker;
      try { r = new RenderWorker(); } catch { resolve(null); return; }
      let done = false;
      const fail = (why: string): void => {
        if (done) return;
        done = true; clearTimeout(timer);
        console.info('Offscreen rendering unavailable (' + why + '), drawing on the main thread');
        r.terminate(); resolve(null);
      };
      const timer = window.setTimeout(() => fail('timeout'), 5000);
      r.onerror = (e): void => fail(e.message || 'worker error');
      r.onmessage = (e: MessageEvent<RResponse>): void => {
        if (e.data.type !== 'ready' || done) return;
        if (!e.data.ok) { fail(e.data.reason ?? 'unsupported'); return; }
        done = true; clearTimeout(timer);
        resolve(new OffscreenBackend(r, ev));
      };
      r.postMessage({ type: 'init', dpr });
    });
  }

  private spawnGen(): Worker {
    const g = new GenWorker();
    g.onmessage = (e: MessageEvent<GResponse>): void => {
      const m = e.data;
      switch (m.type) {
        case 'stage': this.ev.onStage(m.id, m.stage); break;
        case 'done': this.busy = false; this.ev.onDone(m); break;
        case 'detailDone': this.ev.onDetail?.(m); break;
        case 'quartersDone': this.ev.onQuarters?.(m); break;
        case 'error': this.busy = false; this.ev.onError(m.id, m.error); break;
        case 'exported': {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (p) { if (m.blob) p.resolve(m.blob); else p.reject(new Error(m.error ?? 'export failed')); }
          break;
        }
      }
    };
    g.onerror = (e): void => {
      this.busy = false; this.gen = null;
      for (const p of this.pending.values()) p.reject(new Error('generation worker unavailable'));
      this.pending.clear(); g.terminate();
      this.ev.onFatal(e.message || 'generation worker error');
    };
    return g;
  }

  get generating(): boolean { return this.busy; }

  /** Generate `options` as run `id`; a running generation is superseded (its worker is restarted, as generation cannot be interrupted). */
  run(id: number, options: Options): void {
    this.currentRun = id;
    if (this.gen && this.busy) { this.gen.terminate(); this.gen = null; }
    this.gen ??= this.spawnGen();
    for (const [, p] of this.pending) p.reject(new Error('superseded'));
    this.pending.clear();
    const ch = new MessageChannel();
    this.render.postMessage({ type: 'attach', gen: id, port: ch.port1 }, [ch.port1]);
    this.busy = true;
    this.gen.postMessage({ type: 'run', id, options, port: ch.port2 }, [ch.port2]);
  }

  /** Lazy detail (M3c): generate settlement `index` of run `id` in the generation worker. */
  detail(id: number, index: number): void {
    if (!this.gen || this.busy) return;
    this.gen.postMessage({ type: 'detail', id, index });
  }

  /** Megacity: detail the quarters meeting the view rectangle of run `id` (replaces the previous request). */
  quarters(id: number, rect: { x0: number; y0: number; x1: number; y1: number }): void {
    if (!this.gen || this.busy) return;
    this.gen.postMessage({ type: 'quarters', id, rect });
  }

  setDisplay(display: DisplayOpts): void { this.render.postMessage({ type: 'display', display }); }

  request(r: FrameRequest): void { this.render.postMessage({ type: 'view', ...r }); }

  /** Build the SVG / JSON of the current world in the generation worker. */
  export(gen: number, kind: 'svg' | 'json', display: DisplayOpts, full = false, width?: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!this.gen || this.busy || gen !== this.currentRun) { reject(new Error('the requested map is unavailable')); return; }
      const id = ++this.exportId;
      this.pending.set(id, { resolve, reject });
      try { this.gen.postMessage({ type: 'export', id, gen, kind, display, full, width }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
}
