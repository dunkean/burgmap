import { describe, it, expect } from 'vitest';
import { Rng } from '../src/gen/core/rng';
import { encodePng } from '../src/render/raster';
import { MinHeap } from '../src/gen/core/pq';
import { toQuery, fromQuery, makeOptions } from '../src/gen/options';

describe('rng', () => {
  it('is deterministic', () => {
    const a = new Rng('x'), b = new Rng('x');
    for (let i = 0; i < 50; i++) expect(a.float()).toBe(b.float());
  });
  it('fork is independent of parent consumption and of sibling forks', () => {
    const a = new Rng('seed'), b = new Rng('seed');
    a.float(); a.float(); a.fork('other').float();
    const fa = a.fork('river'), fb = b.fork('river');
    for (let i = 0; i < 20; i++) expect(fa.float()).toBe(fb.float());
    expect(new Rng('seed').fork('a').float()).not.toBe(new Rng('seed').fork('b').float());
  });
  it('ranges', () => {
    const r = new Rng(1);
    for (let i = 0; i < 500; i++) {
      const v = r.int(3, 6); expect(v >= 3 && v <= 6).toBe(true);
      const f = r.range(-2, 2); expect(f >= -2 && f < 2).toBe(true);
    }
  });
});

describe('heap', () => {
  it('pops in order', () => {
    const h = new MinHeap<number>();
    const r = new Rng(3);
    const keys: number[] = [];
    for (let i = 0; i < 200; i++) { const k = r.float(); keys.push(k); h.push(k, k); }
    keys.sort((a, b) => a - b);
    for (const k of keys) expect(h.pop()).toBe(k);
  });
});

describe('png', () => {
  it('produces a valid signature and IHDR', () => {
    const px = new Uint8Array(4 * 3 * 3).map((_, i) => i * 7);
    const png = encodePng(px, 4, 3, 3);
    expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(png.buffer, png.byteOffset);
    expect(String.fromCharCode(...png.slice(12, 16))).toBe('IHDR');
    expect(dv.getUint32(16)).toBe(4);
    expect(dv.getUint32(20)).toBe(3);
    expect(String.fromCharCode(...png.slice(png.length - 8, png.length - 4))).toBe('IEND');
  });
});

describe('options', () => {
  it('round-trips through the query string', () => {
    const o = makeOptions({ seed: 'abc', size: 'city', relief: 'mountains', coast: 'W', river: 'major', style: 'atlas', contours: false });
    expect(fromQuery(toQuery(o))).toEqual({ ...o, roads: 0 });
  });
});
