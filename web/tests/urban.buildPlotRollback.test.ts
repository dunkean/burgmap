import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/gen/core/rng';
import { buildPlot, buildPlotExperimental } from '../src/gen/urban/buildings';
import { buildOn } from '../src/gen/urban/bops';
import { benchLayout, benchParcels, type BenchOptions } from '../src/gen/urban/testbench';
import { MORPHOLOGIES } from '../src/gen/urban/morphology';

const P = MORPHOLOGIES['european-organic'];
const options: BenchOptions = {
  culture: 'european-organic', zone: 'core', mode: 'micro', microScale: 2.5,
  microFrontage: 'perimeter', recipe: 'core', placement: 'skew', rings: 2,
  density: 1, count: 8, radius: 160, monument: 'none', relief: 'hill',
  reliefSlope: 18, river: 'none', riverWidth: 14,
};

describe('legacy buildPlot with the retained parcel cuts', () => {
  // Captured by replaying HEAD e34f667's unmodified buildings.ts/houses.ts
  // on the current parcel partition, including curved and concave micro shapes.
  it.each([
    ['burgage', 150, '60c122a7ecf11abc45b59d818a2fb82a741e76b025d1c8d00f2eed1c82cd89a1'],
    ['courtyard', 189, '5dd9553ebf014cc1bca371f42314b76b975ac371c6cbc8c92afe57037f4b195f'],
  ] as const)('replays the old programme on new %s parcels', (plotOp, count, hash) => {
    const o: BenchOptions = { ...options, stages: { plots: { preset: 'morph/european-organic', params: { plotOp } } } };
    const layout = benchLayout(o, 'gja3b8'), partition = benchParcels(layout, '1tup5tm', o);
    const before = JSON.stringify(partition);
    const data = partition.plots.map(({ plot }, i) => buildPlot(structuredClone(plot), 0.9, P, new Rng('rollback:' + i)));
    expect(partition.plots).toHaveLength(count);
    expect(createHash('sha256').update(JSON.stringify(data)).digest('hex')).toBe(hash);
    expect(JSON.stringify(partition)).toBe(before);
    let differences = 0;
    for (const [{ plot }, i] of partition.plots.map((entry, i) => [entry, i] as const)) {
      const original = buildPlot(structuredClone(plot), 0.9, P, new Rng('rollback:' + i));
      for (const buildingOp of ['streetFrontRow', 'detached', 'longhouse'] as const) {
        const roofs = buildOn(structuredClone(plot), 0.9, { ...P, buildingOp }, new Rng('rollback:' + i));
        expect(roofs.map(({ poly, kind }) => ({ poly, kind }))).toEqual(original);
        roofs.filter(b => b.kind !== 'garden').forEach(b => expect(b.orientation).toBe(Math.atan2(plot.nrm.y, plot.nrm.x)));
      }
      const experimental = buildPlotExperimental(structuredClone(plot), 0.9, P, new Rng('rollback:' + i));
      if (JSON.stringify(experimental) !== JSON.stringify(original)) differences++;
      const selected = buildOn(structuredClone(plot), 0.9, { ...P, buildingOp: 'streetFrontRowExperimental' }, new Rng('rollback:' + i));
      expect(selected.map(({ poly, kind }) => ({ poly, kind }))).toEqual(experimental);
    }
    expect(differences).toBeGreaterThan(0);
  });
});
