import { describe, expect, it } from 'vitest';
import { generateNames, NAME_FAMILIES } from '../src/gen/names';
import { VOCAB } from '../src/gen/names/grammar';
import { makeOptions } from '../src/gen/options';
import { Rng } from '../src/gen/core/rng';
import { createGrid } from '../src/gen/core/grid';
import type { World, Polygon } from '../src/gen/types';

function fixture(language: World['options']['language']): World {
  const box = (x: number): Polygon => [{ x, y: 200 }, { x: x + 40, y: 200 }, { x: x + 40, y: 240 }, { x, y: 240 }];
  const lots = [box(200), box(280), box(600)];
  const height = createGrid(4, 4, 250);
  return {
    seed: 'castles', options: makeOptions({ seed: 'castles', language }), mapSize: 1000, stats: {},
    terrain: { height, slope: createGrid(4, 4, 250), flow: createGrid(4, 4, 250), water: new Uint8Array(16),
      filled: new Float32Array(16), receiver: new Int32Array(16).fill(-1), seaLevel: 0, seaFraction: 0,
      coastline: [], lakes: [], rivers: [], downSide: 'S', seaSide: null },
    urban: { footprint: [], streets: [], squares: [], quarters: [], population: 1000,
      blocks: [], parcels: [], buildings: [], archetype: 'town', morphology: 'european-organic',
      phases: [], blockInfo: [], masses: [], backLand: [], footprintH: [],
      landmarks: lots.flatMap((poly) => [{ kind: 'castle', poly }, { kind: 'keep', poly }]),
      sites: lots.map((lot, i) => ({ id: 'castle:' + i, kind: 'castle', role: 'power', lot, anchor: { x: lot[0].x + 20, y: 220 } })),
    },
  };
}

describe('distinct castle names', () => {
  it('names separate nearby castle sites uniquely and shares each label with its site', () => {
    for (const family of NAME_FAMILIES) {
      const world = fixture(family);
      const names = generateNames(world, new Rng('burgmap:castles'));
      const castles = names.entries.filter((e) => e.kind === 'castle');
      expect(castles, family).toHaveLength(3);
      expect(new Set(castles.map((e) => e.text)).size, family).toBe(3);
      expect(castles[0].text).toBe(VOCAB[family].castle(names.town));
      expect(world.urban!.sites!.map((s) => s.name)).toEqual(castles.map((e) => e.text));
      expect(generateNames(world, new Rng('burgmap:castles')).entries).toEqual(names.entries);
    }
  });
  it('keeps a user-provided site name', () => {
    const world = fixture('french');
    world.urban!.sites![1].name = 'Château du joueur';
    const names = generateNames(world, new Rng('burgmap:castles'));
    expect(world.urban!.sites![1].name).toBe('Château du joueur');
    expect(names.entries.find((e) => e.kind === 'castle' && e.anchor.x === 300)?.text).toBe('Château du joueur');
  });
});
