/**
 * Megacity quarter detail queue (URBAN_MORPHOLOGY §3d): runs where the World lives (generation worker, or the page
 * in main-thread mode). A view request queues the quarters meeting the view (nearest its centre first, replacing the
 * previous queue); quarters are generated in slices of ~150 ms so new requests are handled between them, and each
 * slice is emitted as a batch. An LRU cache keeps at most `cap` quarters (the visible ones are never evicted).
 */
import type { World, UrbanLayer } from '../gen/types';
import { megaQuarterDetail } from '../gen/urban/mega/detail';

export type Rect = { x0: number; y0: number; x1: number; y1: number };
export interface QueueStats { done: number; queued: number; total: number; ms: number }

export class QuarterQueue {
  /** Generated quarters, least recently used first. */
  readonly cache = new Map<number, UrbanLayer>();
  private queue: number[] = [];
  /** Background work when the view's quarters are done: the old core's quarters (seen first when zooming in). */
  private idle: number[] = [];
  private keep = new Set<number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private world: World,
    private emit: (layers: Record<number, UrbanLayer>, drop: number[], st: QueueStats) => void,
    private cap = 420,
    private slice = 150,
  ) {}

  get total(): number { return this.world.urban?.macro?.quarters.length ?? 0; }

  /** Quarters meeting the rectangle, nearest its centre first. */
  visible(r: Rect): number[] {
    const M = this.world.urban?.macro;
    if (!M) return [];
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
    const out: { id: number; d: number }[] = [];
    for (const q of M.quarters) {
      const [x0, y0, x1, y1] = q.bb;
      if (x0 > r.x1 || x1 < r.x0 || y0 > r.y1 || y1 < r.y0) continue;
      out.push({ id: q.id, d: Math.hypot((x0 + x1) / 2 - cx, (y0 + y1) / 2 - cy) });
    }
    return out.sort((a, b) => a.d - b.d || a.id - b.id).map((x) => x.id);
  }

  request(r: Rect): void {
    const vis = this.visible(r);
    for (const id of vis) { const l = this.cache.get(id); if (l) { this.cache.delete(id); this.cache.set(id, l); } }
    this.keep = new Set(vis);
    this.queue = vis.filter((id) => !this.cache.has(id));
    this.schedule();
  }

  /**
   * Pre-details the oldest quarters (the main core, the fused towns' cores, nearest the centre first) in the
   * background, after any view request, so zooming in on the heart of the city finds them ready.
   */
  prefetch(max = 140): void {
    const M = this.world.urban?.macro;
    if (!M) return;
    const c = M.center;
    this.idle = M.quarters
      .filter((q) => (q.phase === 1 && q.nucleus === 0) || q.district === 'satellite' || q.kind === 'market')
      .map((q) => ({ id: q.id, d: Math.hypot((q.bb[0] + q.bb[2]) / 2 - c.x, (q.bb[1] + q.bb[3]) / 2 - c.y) + (q.nucleus === 0 ? 0 : 1500) }))
      .sort((a, b) => a.d - b.d || a.id - b.id).slice(0, Math.min(max, Math.floor(this.cap * 0.6))).map((x) => x.id);
    this.schedule();
  }

  /** Generates every quarter (synchronously, with progress), e.g. for a full-detail export. Bypasses the cap. */
  all(progress?: (done: number, total: number) => void): Record<number, UrbanLayer> {
    const M = this.world.urban?.macro;
    const out: Record<number, UrbanLayer> = {};
    if (!M) return out;
    M.quarters.forEach((q, i) => {
      const l = this.cache.get(q.id) ?? megaQuarterDetail(this.world, q.id);
      if (l) out[q.id] = l;
      if (progress && (i % 10 === 0 || i === M.quarters.length - 1)) progress(i + 1, M.quarters.length);
    });
    return out;
  }

  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; this.queue = []; }

  private schedule(): void {
    if (this.timer || this.stopped || (!this.queue.length && !this.idle.length)) return;
    this.timer = setTimeout(() => { this.timer = null; this.pump(); }, 0);
  }

  private pump(): void {
    if (this.stopped) return;
    const t0 = performance.now();
    const out: Record<number, UrbanLayer> = {};
    let n = 0;
    while ((this.queue.length || (this.idle.length && this.cache.size < this.cap * 0.7)) && performance.now() - t0 < this.slice) {
      const id = this.queue.length ? this.queue.shift()! : this.idle.shift()!;
      if (this.cache.has(id)) continue;
      const l = megaQuarterDetail(this.world, id);
      if (!l) continue;
      this.cache.set(id, l);
      out[id] = l;
      n++;
    }
    const drop: number[] = [];
    if (this.cache.size > this.cap) {
      for (const id of this.cache.keys()) {
        if (this.cache.size - drop.length <= this.cap) break;
        if (!this.keep.has(id) && !(id in out)) drop.push(id);
      }
      for (const id of drop) this.cache.delete(id);
    }
    if (n || drop.length) this.emit(out, drop, { done: this.cache.size, queued: this.queue.length, total: this.total, ms: Math.round(performance.now() - t0) });
    if (!this.queue.length && this.cache.size >= this.cap * 0.7) this.idle = [];
    this.schedule();
  }
}
