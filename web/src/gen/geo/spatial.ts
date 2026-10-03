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
   * Minimum of `f` over the entries of the cells overlapping the box (as forEachIn would visit them), searched in
   * rings of cells around (px, py) and stopped once no unvisited entry can be closer: `f` must be a distance from
   * (px, py) to the entry's box content (the entries farther out are ≥ (k)·cell away after ring k). Infinity if none.
   */
  minOver(x0: number, y0: number, x1: number, y1: number, px: number, py: number, f: (it: T) => number): number {
    const c = this.cell;
    if (++this.tick === 0xffffffff) { this.stamp.fill(0); this.tick = 1; }
    const tk = this.tick, st = this.stamp, items = this.items;
    const ix0 = Math.floor(x0 / c), ix1 = Math.floor(x1 / c), iy0 = Math.floor(y0 / c), iy1 = Math.floor(y1 / c);
    const cx = Math.floor(px / c), cy = Math.floor(py / c);
    const K = Math.max(cx - ix0, ix1 - cx, cy - iy0, iy1 - cy);
    let best = Infinity;
    const R = Math.min(px - x0, x1 - px, py - y0, y1 - py);
    const visit = (ix: number, iy: number): void => {
      if (ix < ix0 || ix > ix1 || iy < iy0 || iy > iy1) return;
      const l = this.cells.get(this.key(ix, iy));
      if (l) for (let k = 0; k < l.length; k++) { const id = l[k]; if (st[id] !== tk) { st[id] = tk; const d = f(items[id]); if (d < best) best = d; } }
    };
    for (let k = 0; k <= K; k++) {
      if (k === 0) visit(cx, cy);
      else {
        for (let ix = cx - k; ix <= cx + k; ix++) { visit(ix, cy - k); visit(ix, cy + k); }
        for (let iy = cy - k + 1; iy <= cy + k - 1; iy++) { visit(cx - k, iy); visit(cx + k, iy); }
      }
      // every entry not visited yet lies only in cells of ring ≥ k + 1 (at least k·cell from (px, py)) or reaches
      // the box only with points outside it (farther than R)
      if (best <= k * c && best <= R) break;
    }
    return best;
  }
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
