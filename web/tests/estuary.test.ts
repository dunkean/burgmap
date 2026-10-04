import { describe, it, expect } from 'vitest';
import { createGrid } from '../src/gen/core/grid';
import { Rng } from '../src/gen/core/rng';
import { carveEstuary, chooseEstuaryShape, type EstuaryShape } from '../src/gen/terrain/estuary';
import { seaMaskOf } from '../src/gen/terrain/hydrology';

function mouth(seed: string, bend = false) {
  const height = createGrid(120, 160, 2);
  height.data.fill(2);
  for (let y = 145; y < height.h; y++) for (let x = 0; x < height.w; x++) height.data[y * height.w + x] = -1;
  const path = bend ? [{ x: 120, y: 20 }, { x: 105, y: 160 }, { x: 120, y: 294 }] : [{ x: 120, y: 20 }, { x: 120, y: 160 }, { x: 120, y: 294 }];
  const shape = carveEstuary(height, path, [12, 12, 12], 220, 0, new Rng(seed));
  return { height, shape, sea: seaMaskOf(height, 0) };
}
function spanAt(m: ReturnType<typeof mouth>, y: number) {
  let count = 0;
  for (let x = 0; x < m.height.w; x++) if (m.sea[Math.floor(y / 2) * m.height.w + x]) count++;
  return count * 2;
}

describe('river-mouth variety', () => {
  it('selects all three deterministic channel shapes from independent seeded streams', () => {
    const shapes = new Set<EstuaryShape>();
    for (let i = 0; i < 40; i++) {
      const rng = new Rng('mouth:' + i);
      const shape = chooseEstuaryShape(rng.fork('shape'));
      expect(chooseEstuaryShape(rng.fork('shape'))).toBe(shape);
      shapes.add(shape);
    }
    expect([...shapes].sort()).toEqual(['funnel', 'tidal', 'widening']);
  });

  it('has genuinely different shore geometry, including a gently widening river', () => {
    const examples = new Map<EstuaryShape, ReturnType<typeof mouth>>();
    for (let i = 0; i < 40; i++) {
      const m = mouth('mouth:' + i);
      if (!examples.has(m.shape)) examples.set(m.shape, m);
    }
    const narrow = examples.get('widening')!, funnel = examples.get('funnel')!;
    expect(spanAt(narrow, 278)).toBeGreaterThan(spanAt(narrow, 190));
    expect(spanAt(narrow, 278)).toBeLessThan(36);
    expect(spanAt(funnel, 278)).toBeGreaterThan(spanAt(narrow, 278) * 1.3);
    expect(Array.from(funnel.height.data)).not.toEqual(Array.from(narrow.height.data));
  });

  it('keeps the tidal reach connected through a bend and leaves the upstream land unchanged', () => {
    for (let i = 0; i < 8; i++) {
      const m = mouth('mouth:' + i, true);
      const submerged = m.height.data.reduce((n, h) => n + (h <= 0 ? 1 : 0), 0);
      expect(m.sea.reduce((n, wet) => n + wet, 0)).toBe(submerged);
      expect(m.sea[Math.floor(190 / 2) * m.height.w + 53]).toBe(1);
      expect(m.height.data[20 * m.height.w + 60]).toBe(2);
      expect(mouth('mouth:' + i, true).height.data).toEqual(m.height.data);
    }
  });

  it('drowns the low floodplain without excavating tall side banks into a broad bay', () => {
    const height = createGrid(120, 160, 2);
    height.data.fill(25);
    for (let y = 0; y < height.h; y++) for (let x = 57; x <= 62; x++) height.data[y * height.w + x] = 0.1;
    for (let y = 145; y < height.h; y++) for (let x = 0; x < height.w; x++) height.data[y * height.w + x] = -1;
    carveEstuary(height, [{ x: 120, y: 20 }, { x: 120, y: 294 }], [12, 12], 220, 0, new Rng('banks'));
    const sea = seaMaskOf(height, 0);
    expect(sea[135 * height.w + 60]).toBe(1);
    expect(sea[135 * height.w + 50]).toBe(0);
    expect(height.data[135 * height.w + 50]).toBeGreaterThan(20);
  });
});
