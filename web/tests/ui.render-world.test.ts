import { describe, expect, it } from 'vitest';
import type { World } from '../src/gen/types';
import { worldForRender } from '../src/ui/renderWorld';
import { fakeWorld } from '../scripts/fakeworld';

describe('render worker World projection', () => {
  it('keeps only desert material rasters and does not mutate the retained export World', () => {
    const world = fakeWorld({ buildings: 0, streets: 0, landAreas: 0 });
    world.options.biome = 'desert';
    const dWater = new Float32Array([100, 1000]), hab = new Float32Array([10, 40]);
    world.site = { cost: new Float32Array([1]), fields: { dWater, hab, slope: new Float32Array([2]) } } as unknown as World['site'];
    const debugWorld = { ...world, debug: { sentinel: true } };
    const before = JSON.stringify(debugWorld), result = worldForRender(debugWorld);
    expect(Object.keys(result.site!.fields).sort()).toEqual(['dWater', 'hab']);
    expect(result.site!.fields.dWater).toBe(dWater);
    expect(result.site!.fields.hab).toBe(hab);
    expect(result.site).not.toHaveProperty('cost');
    for (const key of ['flow', 'receiver', 'filled']) expect(result.terrain).not.toHaveProperty(key);
    expect(result).not.toHaveProperty('debug');
    const received = structuredClone(result);
    expect(received.site!.fields.dWater).toBeInstanceOf(Float32Array);
    expect([...received.site!.fields.dWater]).toEqual([100, 1000]);
    expect(JSON.stringify(debugWorld)).toBe(before);
    expect(worldForRender({ ...world, options: { ...world.options, biome: 'temperate' } }).site).not.toHaveProperty('fields');
  });
});
