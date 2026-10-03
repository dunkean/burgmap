/** Uniform grid hash over axis-aligned boxes (segments, polygons). */
import type { Vec2 } from '../core/geom';

export class GridIndex<T> {
  // cells hold insertion ids; `stamp` marks the ids already visited by the current forEachIn
  private cells = new Map<number, number[]>();
  private items: T[] = [];
  private stamp = new Uint32Array(64);
  private tick = 0;
  constructor(readonly cell: number) {}
  private key(ix: number, iy: number): number { return (ix + 32768) * 65536 + (iy + 32768); }
  insertBox(x0: number, y0: number, x1: number, y1: number, item: T): void {
    const c = this.cell;
    const id = this.items.length;
    this.items.push(item);
    if (id >= this.stamp.length) { const st = new Uint32Array(this.stamp.length * 2); st.set(this.stamp); this.stamp = st; }
    for (let ix = Math.floor(x0 / c); ix <= Math.floor(x1 / c); ix++) {
      for (let iy = Math.floor(y0 / c); iy <= Math.floor(y1 / c); iy++) {
        const k = this.key(ix, iy);
        let l = this.cells.get(k);
        if (!l) { l = []; this.cells.set(k, l); }
        l.push(id);
      }
    }
  }
  insertSeg(a: Vec2, b: Vec2, item: T): void {
    this.insertBox(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y), item);
  }
  insertPts(pts: Vec2[], item: T): void {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
    this.insertBox(x0, y0, x1, y1, item);
  }
  /** Unique items whose cells overlap the box. */
  query(x0: number, y0: number, x1: number, y1: number): T[] {
    const c = this.cell;
    const seen = new Set<T>();
    const out: T[] = [];
    for (let ix = Math.floor(x0 / c); ix <= Math.floor(x1 / c); ix++) {
      for (let iy = Math.floor(y0 / c); iy <= Math.floor(y1 / c); iy++) {
        const l = this.cells.get(this.key(ix, iy));
        if (!l) continue;
        for (const id of l) { const it = this.items[id]; if (!seen.has(it)) { seen.add(it); out.push(it); } }
      }
    }
    return out;
  }
  queryPt(p: Vec2, r: number): T[] { return this.query(p.x - r, p.y - r, p.x + r, p.y + r); }
  /**
   * Visits the entries of the overlapped cells, each insertion once, in first-seen cell order (fast; for
   * idempotent visitors: flags, minimum distances).
   */
  forEachIn(x0: number, y0: number, x1: number, y1: number, fn: (it: T) => void): void {
    const c = this.cell;
    if (++this.tick === 0xffffffff) { this.stamp.fill(0); this.tick = 1; }
    const tk = this.tick, st = this.stamp, items = this.items;
    for (let ix = Math.floor(x0 / c); ix <= Math.floor(x1 / c); ix++) {
      for (let iy = Math.floor(y0 / c); iy <= Math.floor(y1 / c); iy++) {
        const l = this.cells.get(this.key(ix, iy));
        if (l) for (let k = 0; k < l.length; k++) { const id = l[k]; if (st[id] !== tk) { st[id] = tk; fn(items[id]); } }
      }
    }
  }
}
