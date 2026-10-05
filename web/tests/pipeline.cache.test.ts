import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGenerationCache, generate } from '../src/gen/pipeline';
import { makeOptions, type Options } from '../src/gen/options';
import type { World } from '../src/gen/types';

/** Every generated value except timings; typed arrays by content. */
function worldHash(world: World): string {
  const json = JSON.stringify(world, (key, value) => {
    if (ArrayBuffer.isView(value)) return createHash('sha1').update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).digest('hex');
    if (key === 'stats') return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !k.startsWith('ms.') && !k.includes('.ms.') && !/slowest/i.test(k)));
    return value;
  });
  return createHash('sha1').update(json).digest('hex');
}
const fresh = (o: Options): string => worldHash(generate(o, undefined, { lazy: false }));

describe('generation cache', () => {
  it('reuses the terrain across a biome change with an identical World', () => {
    const cache = createGenerationCache();
    const base = makeOptions({ seed: 'cache-biome', size: 'village', workflow: 'automatic', mapSize: 2400, river: 'river' });
    generate(base, undefined, { cache, lazy: false });
    for (const biome of ['desert', 'forest', 'underdark-caverns', 'temperate'] as const) {
      // an applied form writes seaLevel 0 where a link left it unset: the same terrain
      const o = { ...base, biome, ...(biome === 'forest' ? { seaLevel: 0 } : {}) };
      const cached = worldHash(generate(o, undefined, { cache, lazy: false }));
      expect(cache.hits?.terrain, biome).toBe(true);
      expect(cached, biome).toBe(fresh(o));
    }
    generate({ ...base, relief: 'mountains' }, undefined, { cache, lazy: false });
    expect(cache.hits?.terrain).toBe(false);
  }, 240000);

  it('reuses the main town when only a secondary settlement changes, with an identical World', () => {
    const cache = createGenerationCache();
    const list = (second: { population: number; culture?: string; position?: { x: number; y: number } }): Options => makeOptions({
      seed: 'cache-list', workflow: 'list', settlementMode: 'list', mapSize: 3000, culture: 'european-organic',
      settlements: { list: [{ population: 2500 }, second] },
    });
    generate(list({ population: 300 }), undefined, { cache, lazy: false });
    for (const second of [{ population: 600 }, { population: 600, culture: 'barbarian' }, { population: 300, position: { x: 600, y: 700 } }]) {
      const o = list(second);
      const cached = worldHash(generate(o, undefined, { cache, lazy: false }));
      expect(cache.hits, JSON.stringify(second)).toEqual({ terrain: true, main: true });
      expect(cached, JSON.stringify(second)).toBe(fresh(o));
    }
    // the main settlement itself changes: its stage is recomputed
    generate({ ...list({ population: 300 }), settlements: { list: [{ population: 4000 }, { population: 300 }] } }, undefined, { cache, lazy: false });
    expect(cache.hits).toEqual({ terrain: true, main: false });
  }, 480000);
});
