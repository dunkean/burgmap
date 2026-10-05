import { describe, expect, it } from 'vitest';
import type { World } from '../src/gen/types';
import { worldForRender } from '../src/ui/renderWorld';
import { fakeWorld } from '../scripts/fakeworld';
import { worldToJson } from '../src/ui/exportWorld';

describe('render worker World projection', () => {
  it('keeps the cavern floor, holes and rock domain through worker cloning and vector export', () => {
    const world = fakeWorld({ buildings: 0, streets: 0, landAreas: 0 });
    world.options.biome = 'underdark-caverns';
    const ring = (x: number, y: number, size: number) => [
      { x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size },
    ];
    world.terrain.caverns = {
      floor: [{ outer: ring(10, 10, 100), holes: [ring(40, 40, 10)] }],
      solid: [{ outer: ring(0, 0, 120), holes: [ring(10, 10, 100)] },
        { outer: ring(40, 40, 10), holes: [] }],
      mask: new Uint8Array([0, 1, 0, 1]),
      clearance: new Float32Array([0, 30, 0, 12]),
      chambers: [{ center: { x: 60, y: 60 }, radius: 50 }],
    };
    const before = worldToJson(world);
    const projected = worldForRender(world);
    const received = structuredClone(projected);
    expect(received.terrain.caverns).toEqual(world.terrain.caverns);
    expect(received.terrain.caverns).not.toBe(world.terrain.caverns);
    expect(received.terrain.caverns!.mask).toBeInstanceOf(Uint8Array);
    const exported = JSON.parse(worldToJson(received));
    expect(exported.world.terrain.caverns.floor).toEqual(world.terrain.caverns.floor);
    expect(exported.world.terrain.caverns.solid).toEqual(world.terrain.caverns.solid);
    expect(exported.world.terrain.caverns.mask).toEqual({ omitted: 'Uint8Array', length: 4 });
    expect(worldToJson(world)).toBe(before);
    expect(worldForRender({ ...world, options: { ...world.options, biome: 'underdark' } })
      .options.biome).toBe('underdark');
  });

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
