import { describe, expect, it } from 'vitest';
import { BIOME_NAMES } from '../src/gen/biomes';
import { fromQuery, makeOptions, sizeForPop, toQuery } from '../src/gen/options';
import { CULTURE_LIST } from '../src/gen/urban/cultures';
import { Rng } from '../src/gen/core/rng';
import { styleSwatch } from '../src/ui/dock';
import { STYLE_LIST } from '../src/render/styles';
import { BIOME_CULTURES, surprisePatch } from '../src/ui/randomMap';

const known = new Set(CULTURE_LIST.map((c) => c.id));
const randomFor = (seed: string) => { const rng = new Rng(seed); return () => rng.float(); };

describe('surprise map', () => {
  it('only suggests cultures that exist, for every biome', () => {
    for (const biome of BIOME_NAMES) {
      expect(BIOME_CULTURES[biome].length, biome).toBeGreaterThan(0);
      for (const id of BIOME_CULTURES[biome]) expect(known.has(id), `${biome}: ${id}`).toBe(true);
    }
  });

  it('is deterministic for a given random stream and always coherent', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const patch = surprisePatch(randomFor('surprise-' + i), known);
      expect(surprisePatch(randomFor('surprise-' + i), known)).toEqual(patch);
      seen.add(patch.biome!);
      expect(BIOME_NAMES).toContain(patch.biome);
      expect(BIOME_CULTURES[patch.biome!]).toContain(patch.culture);
      expect(patch.population).toBeGreaterThanOrEqual(40);
      expect(patch.size).toBe(sizeForPop(patch.population));
      if (patch.biome!.startsWith('underdark')) expect(patch.coast).toBe('none');
      expect(patch.workflow).toBe('automatic');
      expect(patch.settlements).toBe('auto');
      expect(patch.cultureMix).toBeNull();
      expect(patch.plan).toBeNull();
    }
    expect(seen.size).toBe(BIOME_NAMES.length);
  });

  it('survives a shared link round trip', () => {
    const applied = makeOptions({ workflow: 'list', mapSize: 6000, seed: 'abc', settlements: { list: [{ population: 500 }, { population: 90 }] } });
    for (let i = 0; i < 40; i++) {
      const next = { ...applied, ...surprisePatch(randomFor('link-' + i), known), seed: 'new' + i };
      expect(next.settlements).toBe('auto');
      expect(toQuery(fromQuery(toQuery(next)))).toBe(toQuery(next));
    }
  });
});

describe('style dock', () => {
  it('draws a distinct swatch for every style', () => {
    const swatches = STYLE_LIST.map((s) => styleSwatch(s.id));
    expect(new Set(swatches).size).toBe(STYLE_LIST.length);
    for (const swatch of swatches) expect(swatch).toMatch(/^conic-gradient\(/);
  });
});
