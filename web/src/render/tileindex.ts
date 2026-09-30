/**
 * Uniform tile grid over the square map [0,mapSize]^2, stored as CSR arrays
 * (counting sort) so that building an index for ~10^6 items takes tens of ms.
 * Pure: no DOM, no Path2D.
 *
 * Two assignment modes:
 *  - 'center':  each item goes into the single tile containing its bbox center.
 *               Items whose bbox is larger than one tile go to `big` (linear,
 *               bbox-culled list). Queries expand the rect by tileSize/2 so an
 *               item overlapping the rect is always found. No duplicates.
 *  - 'overlap': each item is listed in every tile its bbox overlaps (used for
 *               area textures, where per-tile work needs all overlapping areas).
 * Items outside the map are clamped to the border tiles.
 */
export interface Rect { minX: number; minY: number; maxX: number; maxY: number }

export type TileMode = 'center' | 'overlap';

export class TileIndex {
  readonly nx: number;
  readonly ny: number;
  readonly count: number;
  /** CSR: items of tile t are tileItems[tileStart[t] .. tileStart[t+1]). */
  readonly tileStart: Int32Array;
  readonly tileItems: Int32Array;
  /** Oversized items (center mode only). */
  readonly big: Int32Array;

  /** @param boxes 4 floats per item: minX, minY, maxX, maxY. */
  constructor(readonly mapSize: number, readonly tileSize: number, readonly boxes: Float32Array, readonly mode: TileMode = 'center') {
    this.nx = this.ny = Math.max(1, Math.ceil(mapSize / tileSize));
    const n = (this.count = boxes.length >> 2);
    const nt = this.nx * this.ny;
    const start = new Int32Array(nt + 1);
    const bigList: number[] = [];
    if (mode === 'center') {
      const tileOf = new Int32Array(n).fill(-1);
      for (let i = 0; i < n; i++) {
        const b = i * 4;
        if (boxes[b + 2] - boxes[b] > tileSize || boxes[b + 3] - boxes[b + 1] > tileSize) { bigList.push(i); continue; }
        const t = this.tileAt((boxes[b] + boxes[b + 2]) * 0.5, (boxes[b + 1] + boxes[b + 3]) * 0.5);
        tileOf[i] = t; start[t + 1]++;
      }
      for (let t = 0; t < nt; t++) start[t + 1] += start[t];
      const items = new Int32Array(start[nt]);
      const pos = start.slice(0, nt);
      for (let i = 0; i < n; i++) if (tileOf[i] >= 0) items[pos[tileOf[i]]++] = i;
      this.tileItems = items;
    } else {
      // pass 0 counts, pass 1 fills
      let items = new Int32Array(0);
      let pos = new Int32Array(0);
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < n; i++) {
          const b = i * 4;
          const x0 = this.col(boxes[b]), x1 = this.col(boxes[b + 2]), y0 = this.row(boxes[b + 1]), y1 = this.row(boxes[b + 3]);
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const t = y * this.nx + x;
            if (pass) items[pos[t]++] = i; else start[t + 1]++;
          }
        }
        if (!pass) {
          for (let t = 0; t < nt; t++) start[t + 1] += start[t];
          items = new Int32Array(start[nt]);
          pos = start.slice(0, nt);
        }
      }
      this.tileItems = items;
    }
    this.tileStart = start;
    this.big = Int32Array.from(bigList);
  }

  col(x: number): number { const c = Math.floor(x / this.tileSize); return c < 0 ? 0 : c >= this.nx ? this.nx - 1 : c; }
  row(y: number): number { const r = Math.floor(y / this.tileSize); return r < 0 ? 0 : r >= this.ny ? this.ny - 1 : r; }
  tileAt(x: number, y: number): number { return this.row(y) * this.nx + this.col(x); }
  tileRect(t: number): Rect {
    const cx = t % this.nx, cy = (t / this.nx) | 0, s = this.tileSize;
    return { minX: cx * s, minY: cy * s, maxX: (cx + 1) * s, maxY: (cy + 1) * s };
  }
  itemsOf(t: number): Int32Array { return this.tileItems.subarray(this.tileStart[t], this.tileStart[t + 1]); }

  /** Non-empty tile ids whose items may intersect `r` (candidate superset). */
  tilesInRect(r: Rect): number[] {
    const m = this.mode === 'center' ? this.tileSize * 0.5 : 0;
    const x0 = this.col(r.minX - m), x1 = this.col(r.maxX + m), y0 = this.row(r.minY - m), y1 = this.row(r.maxY + m);
    const out: number[] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const t = y * this.nx + x;
      if (this.tileStart[t + 1] > this.tileStart[t]) out.push(t);
    }
    return out;
  }

  /** Big items whose bbox intersects `r`. */
  bigInRect(r: Rect): number[] {
    const out: number[] = [];
    for (const i of this.big) if (this.boxHits(i, r)) out.push(i);
    return out;
  }

  boxHits(i: number, r: Rect): boolean {
    const b = i * 4, bx = this.boxes;
    return bx[b] <= r.maxX && bx[b + 2] >= r.minX && bx[b + 1] <= r.maxY && bx[b + 3] >= r.minY;
  }

  /** Exact query: sorted unique ids of all items whose bbox intersects `r`. */
  query(r: Rect): number[] {
    const set = new Set<number>();
    for (const t of this.tilesInRect(r)) for (const i of this.itemsOf(t)) if (this.boxHits(i, r)) set.add(i);
    for (const i of this.bigInRect(r)) set.add(i);
    return [...set].sort((a, b) => a - b);
  }
}

type Pt = { x: number; y: number };

/** Bounding boxes (4 floats/item) of point lists. */
export function boxesOf(items: ArrayLike<Pt>[]): Float32Array {
  const out = new Float32Array(items.length * 4);
  for (let i = 0; i < items.length; i++) {
    const pts = items[i];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    if (x0 === Infinity) { x0 = y0 = x1 = y1 = 0; }
    const b = i * 4;
    out[b] = x0; out[b + 1] = y0; out[b + 2] = x1; out[b + 3] = y1;
  }
  return out;
}

/** Split a polyline into chunks whose bbox stays <= maxDim (consecutive chunks share a vertex). */
export function chunkPolyline<P extends Pt>(pl: P[], maxDim: number): P[][] {
  if (pl.length < 2) return [];
  const out: P[][] = [];
  let cur: P[] = [pl[0]];
  let x0 = pl[0].x, x1 = x0, y0 = pl[0].y, y1 = y0;
  for (let i = 1; i < pl.length; i++) {
    const p = pl[i];
    const nx0 = Math.min(x0, p.x), nx1 = Math.max(x1, p.x), ny0 = Math.min(y0, p.y), ny1 = Math.max(y1, p.y);
    if (cur.length >= 2 && (nx1 - nx0 > maxDim || ny1 - ny0 > maxDim)) {
      out.push(cur);
      const prev = pl[i - 1];
      cur = [prev];
      x0 = Math.min(prev.x, p.x); x1 = Math.max(prev.x, p.x); y0 = Math.min(prev.y, p.y); y1 = Math.max(prev.y, p.y);
    } else { x0 = nx0; x1 = nx1; y0 = ny0; y1 = ny1; }
    cur.push(p);
  }
  if (cur.length >= 2) out.push(cur);
  return out;
}
