import { describe, expect, it } from 'vitest';
import type { Plot } from '../src/gen/urban/plots';
import { plotFrontOnStreet, refreshPlotFrame } from '../src/gen/urban/plots';
import { Streets } from '../src/gen/urban/streets';

describe('merged plot frame', () => {
  it('recognizes a wide street boundary behind a nearer unserved narrow lane', () => {
    const streets = new Streets();
    const radial = streets.add([{ x: 7, y: -30 }, { x: 7, y: 30 }], 14, 0, 'radial', 0);
    streets.add([{ x: 1.42, y: 5.614 }, { x: 7.02, y: 5.614 }], 3, 4, 'close', 0);
    const a = { x: 0, y: -8.122 }, b = { x: 0, y: 8.122 };
    expect(streets.nearest({ x: 0, y: 0 }, 14)?.s).toBe(1);
    expect(plotFrontOnStreet(streets, a, b)).toBe(true);
    // The lane is nearby, but it does not itself provide ribbon contact.
    streets.demote(radial);
    expect(plotFrontOnStreet(streets, a, b)).toBe(false);
  });

  it('uses interpolated ribbon width rather than the first vertex width', () => {
    const streets = new Streets();
    streets.add([{ x: 0, y: 0 }, { x: 20, y: 0 }], [2, 14], 0, 'radial', 0);
    expect(plotFrontOnStreet(streets, { x: 9, y: 4 }, { x: 11, y: 4 })).toBe(true);
    expect(plotFrontOnStreet(streets, { x: 9, y: 8 }, { x: 11, y: 8 })).toBe(false);
  });

  it('does not preserve a frontage merely near a wide street terminal', () => {
    const streets = new Streets();
    streets.add([{ x: 7, y: -1 }, { x: 7, y: 1 }], 14, 0, 'radial', 0);
    streets.add([{ x: 1.42, y: 5.614 }, { x: 7.02, y: 5.614 }], 3, 4, 'close', 0);
    expect(plotFrontOnStreet(streets, { x: 0, y: -20 }, { x: 0, y: 20 })).toBe(false);
  });

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

  it('walks fragmented frontage to inward sides instead of choosing tangent side planes', () => {
    const pl = {
      poly: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 8, y: 0 }, { x: 12, y: 0 },
        { x: 12, y: 20 }, { x: 0, y: 20 }],
      front: [{ x: 3, y: 1 }, { x: 8, y: 1 }], nrm: { x: 0, y: 1 },
      sideA: { p: { x: 3, y: 1 }, d: { x: -1, y: 0 } },
      sideB: { p: { x: 8, y: 1 }, d: { x: 1, y: 0 } }, depth: 12,
    } as Plot;
    refreshPlotFrame(pl);
    expect(pl.front).toEqual([{ x: 3, y: 0 }, { x: 8, y: 0 }]);
    for (const s of [pl.sideA, pl.sideB]) {
      expect(s.d).toEqual({ x: 0, y: 1 });
      expect(s.p).toEqual(s === pl.sideA ? pl.front[0] : pl.front[1]);
    }
    expect(pl.depth).toBe(20);
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
