/** Exact-scale raster tiles; only camera-visible tiles are created, and storage is bounded in bytes. */
import type { Rect } from './tileindex';

export interface RasterTile<T> { value: T; bounds: Rect; bytes: number; release(): void }

const hits = (a: Rect, b: Rect): boolean => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

export class RasterTileCache<T> {
  private entries = new Map<string, RasterTile<T>>();
  private used = 0;
  constructor(readonly maxBytes = 64 * 1024 * 1024) {}
  get bytes(): number { return this.used; }
  get size(): number { return this.entries.size; }

  get(key: string): T | undefined {
    const tile = this.entries.get(key);
    if (!tile) return undefined;
    this.entries.delete(key); this.entries.set(key, tile);
    return tile.value;
  }

  put(key: string, tile: RasterTile<T>): void {
    this.drop(key);
    this.entries.set(key, tile); this.used += tile.bytes;
    while (this.used > this.maxBytes && this.entries.size > 1) this.drop(this.entries.keys().next().value!);
  }

  private drop(key: string): void {
    const tile = this.entries.get(key);
    if (!tile) return;
    this.entries.delete(key); this.used -= tile.bytes; tile.release();
  }

  invalidate(rects?: Rect[], padding = 0): void {
    if (!rects) { this.clear(); return; }
    const expanded = rects.map((r) => ({ minX: r.minX - padding, minY: r.minY - padding, maxX: r.maxX + padding, maxY: r.maxY + padding }));
    for (const [key, tile] of this.entries) if (expanded.some((r) => hits(r, tile.bounds))) this.drop(key);
  }

  clear(): void { for (const key of this.entries.keys()) this.drop(key); }
}
