import { describe, expect, it } from 'vitest';
import type { Plot } from '../src/gen/urban/plots';
import { refreshPlotFrame } from '../src/gen/urban/plots';

describe('merged plot frame', () => {
  it('rebuilds a stale frontage and side anchors from the merged boundary', () => {
    const pl = {
      poly: [{ x: 20000, y: 20000 }, { x: 20012, y: 20000 }, { x: 20012, y: 20020 }, { x: 20000, y: 20020 }],
      front: [{ x: 20000, y: 20001 }, { x: 20012, y: 20001 }], nrm: { x: 0, y: 1 },
      sideA: { p: { x: 20000, y: 20001 }, d: { x: 0, y: 1 } },
      sideB: { p: { x: 20012, y: 20001 }, d: { x: 0, y: 1 } }, depth: 12,
    } as Plot;
    refreshPlotFrame(pl);
    expect(pl.front).toEqual([{ x: 20000, y: 20000 }, { x: 20012, y: 20000 }]);
    expect(pl.sideA.p).toEqual(pl.front[0]);
    expect(pl.sideB.p).toEqual(pl.front[1]);
    expect(pl.depth).toBeCloseTo(20);
  });

  it('leaves a valid generated frame unchanged', () => {
    const pl = {
      poly: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 10 }, { x: 0, y: 10 }],
      front: [{ x: 0, y: 0 }, { x: 8, y: 0 }], nrm: { x: 0, y: 1 },
      sideA: { p: { x: 0, y: 0 }, d: { x: 0, y: 1 } },
      sideB: { p: { x: 8, y: 0 }, d: { x: 0, y: 1 } }, depth: 10,
    } as Plot;
    const before = JSON.stringify(pl);
    refreshPlotFrame(pl);
    expect(JSON.stringify(pl)).toBe(before);
  });
});
