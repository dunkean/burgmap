import { describe, expect, it } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { fromQuery, makeOptions, sizeForPop, toQuery } from '../src/gen/options';

describe('Kraal population through the settlement editor options', () => {
  it('keeps round huts at 600 and grows into a connected town at 3000', () => {
    const worlds = [80, 600, 3000].map((population) => {
      const draft = makeOptions({ seed: 'kraal-size', workflow: 'list', culture: 'kraal', mapSize: 3000,
        settlements: { list: [{ population, options: { size: sizeForPop(population) } }] } });
      return generate(fromQuery(toQuery(draft)));
    });
    expect(worlds.map((w) => w.urban!.population)).toEqual([80, 600, 3000]);
    expect(worlds.map((w) => w.urban!.archetype)).toEqual(['hamlet', 'nucleated-village', 'town']);
    expect(worlds.map((w) => w.urban!.morphology)).toEqual(['kraal', 'kraal', 'kraal-town']);
    expect(worlds[1].urban!.buildings.length).toBeGreaterThan(worlds[0].urban!.buildings.length);
    for (const world of worlds) {
      const buildings = world.urban!.buildings;
      expect(buildings.some((b) => b.arch === 'beehive-hut')).toBe(true);
      expect(buildings.some((b) => ['tipi', 'ger', 'store-tent'].includes(b.arch ?? ''))).toBe(false);
    }
    expect(worlds[2].urban!.streets.some((s) => s.role === 'radial')).toBe(true);
  }, 120000);
});
