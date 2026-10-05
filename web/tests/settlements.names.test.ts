import { describe, expect, it } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { cleanSettlementName, fromQuery, makeOptions, mapId, toQuery, type Options } from '../src/gen/options';

const composed = (names: (string | undefined)[]): Options => makeOptions({
  seed: 'names-ui', workflow: 'list', settlementMode: 'list', mapSize: 2600,
  settlements: { list: [{ population: 1500, name: names[0] }, { population: 200, name: names[1] }] },
});

describe('user settlement names', () => {
  it('cleans names and keeps unnamed links unchanged', () => {
    expect(cleanSettlementName('  Old\n  Harbour ')).toBe('Old Harbour');
    expect(cleanSettlementName('   ')).toBeUndefined();
    expect(cleanSettlementName('x'.repeat(200))).toHaveLength(60);
    const plain = composed([undefined, undefined]);
    expect(toQuery(plain)).not.toContain('Harbour');
    const named = composed(['Port Royal', 'Little Harbour']);
    expect(fromQuery(toQuery(named)).settlements).toEqual(named.settlements);
    expect(fromQuery('?id=' + mapId(named)).settlements).toEqual(named.settlements);
  });

  it('renames the labels and the cartouche without moving the plan', () => {
    const plain = generate(composed([undefined, undefined]), undefined, { lazy: false });
    const named = generate(composed(['Port Royal', 'Little Harbour']), undefined, { lazy: false });
    const oldTown = plain.names!.town;
    expect(named.names!.town).toBe('Port Royal');
    expect(named.settlements![0].name).toBe('Port Royal');
    expect(named.settlements![1].name).toBe('Little Harbour');
    const texts = named.names!.entries.map((e) => e.text);
    expect(texts).toContain('Port Royal');
    expect(texts).toContain('Little Harbour');
    expect(texts.some((t) => t.includes(oldTown))).toBe(false);
    expect(JSON.stringify(named.urban)).toBe(JSON.stringify(plain.urban));
    expect(JSON.stringify(named.roads)).toBe(JSON.stringify(plain.roads));
    expect(named.names!.entries.map((e) => e.anchor)).toEqual(plain.names!.entries.map((e) => e.anchor));
  }, 120000);
});
