/** Uniform grid hash over axis-aligned boxes (segments, polygons). */
import type { Vec2 } from '../core/geom';

export class GridIndex<T> {
  private cells = new Map<number, T[]>();
  constructor(readonly cell: number) {}
  private key(ix: number, iy: number): number { return (ix + 32768) * 65536 + (iy + 32768); }
  insertBox(x0: number, y0: number, x1: number, y1: number, item: T): void {
    const c = this.cell;
    for (let ix = Math.floor(x0 / c); ix <= Math.floor(x1 / c); ix++) {
      for (let iy = Math.floor(y0 / c); iy <= Math.floor(y1 / c); iy++) {
        const k = this.key(ix, iy);
        let l = this.cells.get(k);
        if (!l) { l = []; this.cells.set(k, l); }
        l.push(item);
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
        for (const it of l) if (!seen.has(it)) { seen.add(it); out.push(it); }
      }
    }
    return out;
  }
  queryPt(p: Vec2, r: number): T[] { return this.query(p.x - r, p.y - r, p.x + r, p.y + r); }
  /** Visits items of the overlapped cells WITHOUT de-duplication (fast; fine for min-distance searches). */
  forEachIn(x0: number, y0: number, x1: number, y1: number, fn: (it: T) => void): void {
    const c = this.cell;
    for (let ix = Math.floor(x0 / c); ix <= Math.floor(x1 / c); ix++) {
      for (let iy = Math.floor(y0 / c); iy <= Math.floor(y1 / c); iy++) {
        const l = this.cells.get(this.key(ix, iy));
        if (l) for (let k = 0; k < l.length; k++) fn(l[k]);
      }
    }
  }
}
