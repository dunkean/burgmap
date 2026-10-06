import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/gen/core/rng';
import { area, interiorAngle, isSimple } from '../src/gen/geo/poly';
import { difference, intersection, mpArea } from '../src/gen/geo/bool';
import { burgageHouseExperimental as burgageHouse } from '../src/gen/urban/housesExperimental';
import { buildPlot, buildPlotExperimental } from '../src/gen/urban/buildings';
import { blockReach, makeStreetAt } from '../src/gen/urban/access';
import { effectiveHouseVariation } from '../src/gen/urban/morphology';
import { MORPHOLOGIES } from '../src/gen/urban/morphology';
import { houseBoundarySides } from '../src/gen/urban/houseFrames';
import type { Plot } from '../src/gen/urban/plots';
import { benchLayout, benchParcels, benchBuildings, type BenchOptions } from '../src/gen/urban/testbench';

function plot(width: number, depth: number, angle = 0): Plot {
  const t = { x: Math.cos(angle), y: Math.sin(angle) }, n = { x: -t.y, y: t.x };
  const at = (x: number, y: number) => ({ x: 200 + t.x * x + n.x * y, y: 300 + t.y * x + n.y * y });
  const poly = [at(0, 0), at(width, 0), at(width, depth), at(0, depth)];
  return { poly, front: [poly[0], poly[1]], nrm: n, axis: n,
    sideA: { p: poly[0], d: n }, sideB: { p: poly[1], d: n },
    boundarySides: houseBoundarySides(poly, poly, [poly[0], poly[1]]),
    block: 0, zone: 'core', rank: 0, depth, wide: true, sideFronts: [], run: 0, order: 0, wealth: 0.5 };
}
const params = { ...MORPHOLOGIES['european-organic'], bigCourtChance: 0, houseVariation: 0 };
const digest = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');

describe('restrained street-aligned house dimensions', () => {
  it('defaults to disabled variation and preserves the experimental implementation', () => {
    expect(effectiveHouseVariation(MORPHOLOGIES['european-organic'])).toBe(0);
    for (const P of Object.values(MORPHOLOGIES)) {
      if (P.streetOp !== 'organic' || P.arch.typology !== 'gabled-row-house' || P.buildingOp !== 'streetFrontRow') {
        expect(effectiveHouseVariation({ ...P, houseVariation: undefined })).toBe(0);
      }
    }
    expect(effectiveHouseVariation({ ...MORPHOLOGIES['european-organic'], houseVariation: 0 })).toBe(0);
  });
  it('ignores saved experimental overrides in production buildPlot', () => {
    const pl = plot(70, 45);
    expect(buildPlot(pl, 0.7, { ...params, houseVariation: 1 }, new Rng('disabled')))
      .toEqual(buildPlot(pl, 0.7, params, new Rng('disabled')));
  });
  it('retains zero-variation footprints and the legacy RNG stream', () => {
    const data: unknown[] = [];
    for (const width of [8, 16, 70]) for (const cov of [0.3, 0.7, 0.9]) {
      const a = new Rng('house-variation-control'), b = new Rng('house-variation-control');
      const original = burgageHouse(plot(width, 45), cov, params, a);
      expect(burgageHouse(plot(width, 45), cov, params, b)).toEqual(original);
      expect(b.float()).toBe(a.float());
      data.push(original);
    }
    expect(digest(data)).toBe('8eb5fefbb82a7f30cfe5783a5bf7da68601572a985ba9a482e19236a897213aa');
  });

  it('varies shared frontage widths without gaps, rotations or loss of street contact', () => {
    const pl = plot(90, 11);
    const a = burgageHouse(pl, 0.9, { ...params, houseVariation: 1 }, new Rng('row-variation'));
    const b = burgageHouse(plot(90, 11), 0.9, params, new Rng('row-variation'));
    expect(a).not.toEqual(b);
    expect(a.length).toBe(b.length);
    const widths = a.map(h => Math.max(...h.poly.map(p => p.x)) - Math.min(...h.poly.map(p => p.x)));
    expect(Math.max(...widths) - Math.min(...widths)).toBeGreaterThan(1);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(90, 5);
    for (const h of a) expect(Math.min(...h.poly.map(p => p.y))).toBeCloseTo(Math.min(...b[0].poly.map(p => p.y)), 5);
  });

  it('permits broad/shallow and narrow/deep silhouettes on a compatible street frontage', () => {
    const ratios: number[] = [];
    for (let seed = 0; seed < 40; seed++) {
      const h = burgageHouse(plot(12, 24), 0.3, { ...params, houseVariation: 1 }, new Rng('proportions:' + seed))
        .find(b => b.kind === 'house')!;
      const width = Math.max(...h.poly.map(p => p.x)) - Math.min(...h.poly.map(p => p.x));
      const depth = Math.max(...h.poly.map(p => p.y)) - Math.min(...h.poly.map(p => p.y));
      ratios.push(width / depth);
      expect(width).toBeCloseTo(12, 5);
    }
    expect(ratios.some(ratio => ratio > 1.1)).toBe(true);
    expect(ratios.some(ratio => ratio < 0.95)).toBe(true);
  });

  it('bounds changes on narrow, wide and oblique parcels and preserves room geometry', () => {
    for (const width of [8, 16, 70]) for (const cov of [0.3, 0.7, 0.9]) for (const angle of [0, 0.63]) {
      const pl = plot(width, 45, angle), seed = `${width}:${cov}:${angle}`;
      const result = burgageHouse(pl, cov, { ...params, houseVariation: 1 }, new Rng(seed));
      expect(burgageHouse(plot(width, 45, angle), cov, { ...params, houseVariation: 1 }, new Rng(seed))).toEqual(result);
      const roofs = result.filter(b => b.kind !== 'garden');
      const legacy = burgageHouse(plot(width, 45, angle), cov, params, new Rng(seed)).filter(b => b.kind !== 'garden');
      const originalArea = legacy.reduce((sum, b) => sum + area(b.poly), 0);
      const changedArea = roofs.reduce((sum, b) => sum + area(b.poly), 0);
      expect(changedArea).toBeGreaterThan(originalArea * 0.8);
      expect(changedArea).toBeLessThan(originalArea * 1.2);
      for (const h of roofs) {
        expect(isSimple(h.poly)).toBe(true);
        expect(mpArea(difference(h.poly, pl.poly))).toBeLessThan(0.001);
        h.poly.forEach((_, i) => {
          const degrees = interiorAngle(h.poly, i) * 180 / Math.PI;
          expect(Math.min(Math.abs(degrees - 90), Math.abs(degrees - 270))).toBeLessThan(0.01);
        });
      }
      for (let i = 0; i < roofs.length; i++) for (let j = i + 1; j < roofs.length; j++) {
        expect(mpArea(intersection(roofs[i].poly, roofs[j].poly))).toBeLessThan(0.001);
      }
    }
  });

  it('keeps shared party cuts disjoint after native normalization', () => {
    for (const width of [8, 16, 70, 90]) for (const angle of [0, 0.63]) for (let seed = 0; seed < 8; seed++) {
      const pl = plot(width, 45, angle);
      const roofs = buildPlotExperimental(pl, 0.9, { ...params, houseVariation: 1 }, new Rng('normalized-variation:' + seed))
        .filter(b => b.kind !== 'garden');
      const streetAt = makeStreetAt([{ path: pl.front, width: 4 }], []);
      const original = buildPlotExperimental(plot(width, 45, angle), 0.9, params, new Rng('normalized-variation:' + seed)).filter(b => b.kind !== 'garden');
      const unreachable = blockReach(pl.poly, roofs.map(b => b.poly), streetAt).filter(reached => !reached).length;
      const originalUnreachable = blockReach(pl.poly, original.map(b => b.poly), streetAt).filter(reached => !reached).length;
      expect(unreachable, `width ${width}, angle ${angle}, seed ${seed}`).toBeLessThanOrEqual(originalUnreachable);
      for (const h of roofs) expect(mpArea(difference(h.poly, pl.poly))).toBeLessThan(0.001);
      for (let i = 0; i < roofs.length; i++) for (let j = i + 1; j < roofs.length; j++) {
        expect(mpArea(intersection(roofs[i].poly, roofs[j].poly))).toBeLessThan(0.001);
      }
    }
  });

  it.each(['courtyard', 'burgage'] as const)('keeps the reported large %s fixture disjoint and served', plotOp => {
    const options: BenchOptions = { culture: 'european-organic', zone: 'core', placement: 'skew', rings: 2,
      density: 1, count: 8, radius: 160, monument: 'none', recipe: 'core', relief: 'hill', reliefSlope: 18,
      river: 'none', riverWidth: 14, mode: 'micro', microScale: 2.5, microFrontage: 'perimeter',
      stages: { streets: { preset: 'morph/european-organic' }, plots: { preset: 'morph/european-organic', params: { plotOp } },
        buildings: { preset: 'culture', params: { buildingOp: 'streetFrontRowExperimental', houseVariation: 1 } } } };
    const layout = benchLayout(options, 'gja3b8');
    const partition = benchParcels(layout, plotOp === 'burgage' ? 'uvz24c' : '1tup5tm');
    const partitionBefore = digest(partition.parcels);
    const roofs = benchBuildings(layout, partition, '186rtb7').buildings.filter(b => b.kind !== 'garden');
    expect(digest(partition.parcels)).toBe(partitionBefore);
    const streetAt = makeStreetAt(layout.streets.list.filter(s => s.ribbon).map(s => ({ path: s.path, widths: s.widths, width: s.widths[0] })), []);
    for (const [i, block] of layout.blocks.entries()) {
      const peers = roofs.filter(b => partition.parcels[b.parcel!].block === i);
      expect(blockReach(block.poly, peers.map(b => b.poly), streetAt).every(Boolean)).toBe(true);
      for (const h of peers) expect(mpArea(difference(h.poly, partition.parcels[h.parcel!].poly))).toBeLessThan(0.001);
      for (let a = 0; a < peers.length; a++) for (let b = a + 1; b < peers.length; b++) {
        expect(mpArea(intersection(peers[a].poly, peers[b].poly))).toBeLessThan(0.001);
      }
    }
  });
});
