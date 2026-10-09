import { describe, it, expect, beforeAll } from 'vitest';
import { biomeLandKind, BIOME_NAMES, type BiomeGround } from '../src/gen/biomes';
import { makeOptions, fromQuery, toQuery, applyOverride } from '../src/gen/options';
import { generate } from '../src/gen/pipeline';
import { generateRural } from '../src/gen/landuse/rural';
import { Rng } from '../src/gen/core/rng';
import { area } from '../src/gen/geo/poly';
import type { World, LandUseLayer, LandKind } from '../src/gen/types';
import { biomePalette } from '../src/render/biomes';
import { PALETTES, STYLE_LIST } from '../src/render/styles';
import { createCanvasRenderer, type CanvasLike } from '../src/render/canvas';
import { renderSvg } from '../src/render/svg';
import { fakeWorld, mockCanvas, MockPath2D } from '../scripts/fakeworld';

const dry: BiomeGround = { water: 900, hab: 40, slope: 0.03, soil: 0, settlement: 250, arableRadius: 700 };
describe('biomes', () => {
  it('round-trips every biome and handles invalid links and preview overrides', () => {
    for (const biome of BIOME_NAMES.filter((b) => b !== 'temperate')) {
      expect(fromQuery(toQuery(makeOptions({ biome }))).biome).toBe(biome);
    }
    expect(fromQuery('biome=unknown').biome).toBe('temperate');
    expect(fromQuery('seed=42').biome).toBeUndefined();
    expect(toQuery(makeOptions({ biome: 'temperate' }))).not.toContain('biome=');
    const o = makeOptions(); applyOverride(o, 'biome', 'desert'); expect(o.biome).toBe('desert');
  });
  it('keeps desert cultivation near water, woods outside clearings and tundra treeless', () => {
    expect(biomeLandKind('field', 'desert', dry)).toBe('commons');
    expect(biomeLandKind('field', 'desert', { ...dry, water: 90, hab: 5 })).toBe('field');
    expect(biomeLandKind('pasture', 'forest', { ...dry, settlement: 1200 })).toBe('forest');
    expect(biomeLandKind('field', 'tropical', { ...dry, settlement: 1200 })).toBe('forest');
    expect(biomeLandKind('forest', 'steppe', dry)).toBe('pasture');
    expect(biomeLandKind('forest', 'tundra', dry)).toBe('pasture');
    expect(biomeLandKind('orchard', 'tundra', dry)).not.toBe('orchard');
  });
  it('uses the same biome palette in SVG and Canvas without changing registered styles', () => {
    for (const { id } of STYLE_LIST) {
      expect(biomePalette(id)).toBe(PALETTES[id]);
      expect(biomePalette(id, 'temperate')).toBe(PALETTES[id]);
      const before = JSON.stringify(PALETTES[id]);
      const w = fakeWorld(); w.options.biome = 'desert';
      w.landuse!.areas.push({ kind: 'commons', poly: [{ x: 50, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 100 }, { x: 50, y: 100 }] });
      const p = biomePalette(id, 'desert');
      const r = createCanvasRenderer(mockCanvas(800, 800).canvas as unknown as CanvasLike, w, id, { Path2D: MockPath2D as unknown as typeof Path2D });
      expect(r.palette).toBe(p);
      expect(renderSvg(w, { style: id, raster: false })).toContain(`fill="${p.land.commons}"`);
      expect(JSON.stringify(PALETTES[id])).toBe(before);
      r.dispose();
    }
  });
});

describe('biome landscapes', () => {
  let world: World;
  const layers = new Map<string, LandUseLayer>();
  beforeAll(() => {
    world = generate(makeOptions({ seed: '42', size: 'village', settlements: 'none' }));
    for (const biome of BIOME_NAMES) {
      const w = { ...world, options: { ...world.options, biome } };
      layers.set(biome, generateRural(w, new Rng('magna-urbis:' + world.seed), world.roads!.length).layer);
    }
  }, 60000);
  const hectares = (layer: LandUseLayer, kind: LandKind) => layer.areas.filter((a) => a.kind === kind)
    .reduce((sum, a) => sum + area(a.poly) - (a.holes ?? []).reduce((s, h) => s + area(h), 0), 0) / 1e4;
  it('preserves temperate generation and produces deterministic distinct land cover', () => {
    expect(layers.get('temperate')).toEqual(world.landuse);
    const again = generateRural({ ...world, options: { ...world.options, biome: 'desert' } },
      new Rng('magna-urbis:' + world.seed), world.roads!.length).layer;
    expect(again).toEqual(layers.get('desert'));
    expect(hectares(layers.get('forest')!, 'forest')).toBeGreaterThan(hectares(layers.get('temperate')!, 'forest'));
    expect(hectares(layers.get('desert')!, 'field')).toBeLessThan(hectares(layers.get('temperate')!, 'field'));
    expect(hectares(layers.get('tundra')!, 'forest')).toBe(0);
    expect(hectares(layers.get('steppe')!, 'forest')).toBeLessThan(hectares(layers.get('temperate')!, 'forest'));
  });
});
