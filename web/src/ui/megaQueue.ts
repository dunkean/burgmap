/**
 * View-prioritized megacity detail. Exact quarters keep their independent seeded generator;
 * a bounded cache and optional worker executor change only when they are requested.
 * Views larger than the cache retain stand-in fabric outside their nearest `cap` quarters.
 */
import type { World, UrbanLayer } from '../gen/types';
import { megaQuarterDetail, megaHosts, megaKey } from '../gen/urban/mega/detail';

export type Rect = { x0: number; y0: number; x1: number; y1: number };
export interface QueueStats { done: number; queued: number; total: number; ms: number; failed: number }
/** Implementations own their workers. A failed executor is stopped and retried synchronously. */
export interface QuarterExecutor {
  readonly concurrency: number;
  setWorld(world: World): void;
  run(key: number): Promise<UrbanLayer | null>;
  stop(): void;
}

export class QuarterQueue {
  /** Generated quarters, least recently used first; never larger than `cap`. */
  readonly cache = new Map<number, UrbanLayer>();
  private queue: number[] = [];
  private idle: number[] = [];
  private keep = new Set<number>();
  private background = new Set<number>();
  private active = new Map<number, { started: number }>();
  private failed = new Set<number>();
  private retries = new Set<number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: Record<number, UrbanLayer> = {};
  private dropped = new Set<number>();
  private batchMs = 0;
  private stopped = false;
  private executorFailed = false;

  constructor(
    private world: World,
    private emit: (layers: Record<number, UrbanLayer>, drop: number[], st: QueueStats) => void,
    private cap = 420,
    private slice = 150,
    private executor?: QuarterExecutor,
  ) {
    this.cap = Math.max(1, Number.isFinite(cap) ? Math.floor(cap) : 420);
    this.slice = Math.max(1, Number.isFinite(slice) ? slice : 150);
  }

  /** Only additive secondary plans change here. A new generation creates a new queue. */
  setWorld(w: World): void {
    this.world = w;
    this.failed.clear();
    if (!this.executorFailed) this.executor?.setWorld(w);
  }

  get total(): number { return megaHosts(this.world).reduce((s, h) => s + h.M.quarters.length, 0); }

  /** Quarters meeting the rectangle, nearest its centre first (stable ties). */
  visible(r: Rect): number[] {
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
    const out: { id: number; d: number }[] = [];
    for (const h of megaHosts(this.world)) for (const q of h.M.quarters) {
      const [x0, y0, x1, y1] = q.bb;
      if (x0 > r.x1 || x1 < r.x0 || y0 > r.y1 || y1 < r.y0) continue;
      out.push({ id: megaKey(h.si, q.id), d: Math.hypot((x0 + x1) / 2 - cx, (y0 + y1) / 2 - cy) });
    }
    return out.sort((a, b) => a.d - b.d || a.id - b.id).map((x) => x.id);
  }

  request(r: Rect): void {
    if (this.stopped) return;
    const vis = this.visible(r).slice(0, this.cap);
    for (const id of vis) {
      const l = this.cache.get(id);
      if (l) { this.cache.delete(id); this.cache.set(id, l); }
    }
    this.keep = new Set(vis);
    this.queue = vis.filter((id) => !this.cache.has(id) && !this.active.has(id) && !this.failed.has(id) && !this.retries.has(id));
    this.schedule();
    this.scheduleFlush();
  }

  /** Old cores load opportunistically; visible requests always have priority. */
  prefetch(max = 140): void {
    if (this.stopped) return;
    const M = this.world.urban?.macro;
    if (!M) return;
    const c = M.center;
    this.idle = M.quarters
      .filter((q) => (q.phase === 1 && q.nucleus === 0) || q.district === 'satellite' || q.kind === 'market')
      .map((q) => ({ id: q.id, d: Math.hypot((q.bb[0] + q.bb[2]) / 2 - c.x, (q.bb[1] + q.bb[3]) / 2 - c.y) + (q.nucleus === 0 ? 0 : 1500) }))
      .sort((a, b) => a.d - b.d || a.id - b.id)
      .slice(0, Math.max(0, Math.min(max, Math.floor(this.cap * 0.6)))).map((x) => x.id);
    this.background = new Set(this.idle);
    this.schedule();
  }

  /** Full-detail export deliberately bypasses the interactive cache cap. */
  all(progress?: (done: number, total: number) => void): Record<number, UrbanLayer> {
    const out: Record<number, UrbanLayer> = {};
    const keys = megaHosts(this.world).flatMap((h) => h.M.quarters.map((q) => megaKey(h.si, q.id)));
    keys.forEach((k, i) => {
      const l = this.cache.get(k) ?? megaQuarterDetail(this.world, k);
      if (l) out[k] = l;
      if (progress && (i % 10 === 0 || i === keys.length - 1)) progress(i + 1, keys.length);
    });
    return out;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.timer = this.flushTimer = null;
    this.queue = []; this.idle = []; this.active.clear(); this.retries.clear();
    this.pending = {}; this.dropped.clear();
    this.executor?.stop();
  }

  private wants(id: number): boolean { return this.keep.has(id) || this.background.has(id); }
  private canPrefetch(): boolean { return this.cache.size < this.cap * 0.7; }
  private next(): number | undefined {
    while (this.queue.length || (this.idle.length && this.canPrefetch())) {
      const id = this.queue.length ? this.queue.shift()! : this.idle.shift()!;
      if (!this.cache.has(id) && !this.active.has(id) && !this.failed.has(id) && !this.retries.has(id)) return id;
    }
    return undefined;
  }

  private schedule(): void {
    if (this.timer !== null || this.stopped) return;
    if (!this.queue.length && (!this.idle.length || !this.canPrefetch()) && !this.retries.size) return;
    if (this.executor && !this.executorFailed && this.active.size >= Math.max(1, this.executor.concurrency) && !this.retries.size) return;
    this.timer = setTimeout(() => { this.timer = null; this.pump(); }, 0);
  }

  private accept(id: number, layer: UrbanLayer | null): void {
    if (!layer) { this.failed.add(id); return; }
    if (!this.wants(id)) return; // An old viewport cannot displace the new view's cache.
    this.cache.delete(id); this.cache.set(id, layer);
    this.pending[id] = layer;
    this.dropped.delete(id);
    while (this.cache.size > this.cap) {
      const victim = [...this.cache.keys()].find((k) => !this.keep.has(k));
      // keep contains at most cap keys, so an overfull cache always has a victim.
      if (victim === undefined) break;
      this.cache.delete(victim); delete this.pending[victim]; this.dropped.add(victim);
    }
  }

  private pump(): void {
    if (this.stopped) return;
    // A reduced snapshot or worker-local failure must not leave a valid quarter unavailable.
    // Yield before the single retry and use the original World; deterministic failures remain final.
    if (this.retries.size) {
      const retryStart = performance.now();
      for (const id of this.retries) {
        this.retries.delete(id);
        if (this.wants(id) && !this.cache.has(id) && !this.failed.has(id)) {
          try { this.accept(id, megaQuarterDetail(this.world, id)); }
          catch { this.failed.add(id); }
        }
        if (performance.now() - retryStart >= this.slice) break;
      }
      this.batchMs += performance.now() - retryStart;
      this.scheduleFlush();
      if (this.retries.size) { this.schedule(); return; }
    }
    if (this.executor && !this.executorFailed) {
      const executor = this.executor;
      while (this.active.size < Math.max(1, executor.concurrency)) {
        const id = this.next();
        if (id === undefined) break;
        const job = { started: performance.now() };
        this.active.set(id, job);
        // Promise resolution also catches a synchronous executor-construction/clone error.
        void Promise.resolve().then(() => executor.run(id)).then((layer) => {
          if (this.stopped || this.active.get(id) !== job) return;
          this.active.delete(id);
          this.batchMs = Math.max(this.batchMs, performance.now() - job.started);
          if (this.wants(id)) {
            if (layer) this.accept(id, layer); else this.retries.add(id);
          }
          this.scheduleFlush(); this.schedule();
        }, () => {
          if (this.stopped || this.active.get(id) !== job) return;
          this.executorFailed = true;
          this.active.clear();
          executor.stop();
          this.queue = [...this.keep].filter((k) => !this.cache.has(k) && !this.failed.has(k));
          this.idle = [...this.background].filter((k) => !this.cache.has(k) && !this.failed.has(k));
          this.schedule();
        });
      }
      return;
    }
    const t0 = performance.now();
    while (performance.now() - t0 < this.slice) {
      const id = this.next();
      if (id === undefined) break;
      try { this.accept(id, megaQuarterDetail(this.world, id)); }
      catch { this.failed.add(id); }
    }
    this.batchMs += performance.now() - t0;
    this.scheduleFlush(); this.schedule();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null || this.stopped) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const layers = this.pending, drop = [...this.dropped];
      this.pending = {}; this.dropped.clear();
      const active = [...this.active.keys()].filter((id) => this.wants(id)).length;
      const retries = [...this.retries].filter((id) => this.wants(id)).length;
      const queued = this.queue.length + active + retries + (this.canPrefetch() ? this.idle.filter((id) => !this.cache.has(id) && !this.active.has(id) && !this.failed.has(id) && !this.retries.has(id)).length : 0);
      const failed = [...this.failed].filter((id) => this.keep.has(id)).length;
      this.emit(layers, drop, { done: this.cache.size, queued, total: this.total, ms: Math.round(this.batchMs), failed });
      this.batchMs = 0;
    }, Math.min(150, this.slice));
  }
}
