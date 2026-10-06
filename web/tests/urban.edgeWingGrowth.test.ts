import { expect, it } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { area, minNeck } from '../src/gen/geo/poly';
import { mpArea, tryDifference, tryIntersection } from '../src/gen/geo/bool';
import native from './fixtures/urban-wing-v11.json';

it('keeps the complete xrv97g outer house while thickening only free open-edge land', () => {
  const options = makeOptions({
    seed: 'xrv97g', size: 'town', relief: 'flat', coast: 'none', river: 'major', walls: 'auto',
    workflow: 'list', settlementMode: 'list', mapSize: 1500, biome: 'desert', culture: 'kraal',
    language: 'sanskrit', heightScale: 120, contours: true, landuse: true,
    settlements: { list: [{ population: 2000, culture: 'european-organic',
      position: { x: 578, y: 430 }, options: { size: 'town', cultureMix: null, plan: null }, name: 'Tanavati' }] },
  });
  const urban = generate(options).urban!;
  const old = native.poly;
  const b = urban.buildings[native.id];
  expect(b).toBeDefined();
  const added = tryDifference(b.poly, old), lost = tryDifference(old, b.poly);
  expect(added.failed || lost.failed).toBe(false);
  expect(mpArea(lost.pieces)).toBeLessThanOrEqual(1e-6);
  expect(mpArea(added.pieces)).toBeGreaterThan(45);
  expect(mpArea(added.pieces)).toBeLessThanOrEqual(0.1 * area(old) + 1e-6);
  expect(minNeck(b.poly)?.w ?? 0).toBeGreaterThanOrEqual(3.59);
  const parcel = urban.parcels[b.parcel!];
  expect(mpArea(tryDifference(b.poly, parcel.poly).pieces)).toBeLessThanOrEqual(1e-6);
  expect(mpArea(tryDifference(added.pieces, urban.blocks[parcel.block]).pieces)).toBeLessThanOrEqual(1e-6);
  for (let i = 0; i < urban.buildings.length; i++) if (i !== native.id) {
    const hit = tryIntersection(added.pieces, urban.buildings[i].poly);
    expect(hit.failed).toBe(false);
    expect(mpArea(hit.pieces)).toBeLessThanOrEqual(1e-6);
  }
  for (let i = 0; i < urban.parcels.length; i++) if (i !== b.parcel) {
    const hit = tryIntersection(added.pieces, urban.parcels[i].poly);
    expect(hit.failed).toBe(false);
    expect(mpArea(hit.pieces)).toBeLessThanOrEqual(1e-6);
  }
  const qi = urban.blockInfo[parcel.block].quarter;
  for (let i = 0; i < urban.quarters.length; i++) if (i !== qi) {
    const hit = tryIntersection(added.pieces, urban.quarters[i].poly.outer);
    expect(hit.failed).toBe(false);
    expect(mpArea(hit.pieces)).toBeLessThanOrEqual(1e-6);
  }
}, 120000);
