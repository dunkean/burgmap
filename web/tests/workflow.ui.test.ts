import { describe, expect, it } from 'vitest';
import { fromQuery, generationUid, makeOptions, optionsForMainSettlement, optionsForSettlement, toQuery } from '../src/gen/options';
import { Rng } from '../src/gen/core/rng';
import { mainPopulation } from '../src/gen/pipeline';
import { appendSettlementDraft, freshMapOptions, generatedSettlementSize, initialMapOptions, mainSettlementSpec, newSettlementSpec, regionAsList, settlementComposition } from '../src/ui/workflowDraft';

describe('map creation actions', () => {
  it('keeps the displayed automatic type identical when its editor takes over the region', () => {
    for (const population of [180, 1000, 8000, 20000, 40000]) {
      const theme = makeOptions({ seed: 'type-boundaries', workflow: 'automatic', mapSize: 6000, population });
      const places = [{ key: 'main', population, center: { x: 3000, y: 3000 } },
        { key: 'village:0', population, center: { x: 1000, y: 1000 } }];
      const listed = fromQuery(toQuery(regionAsList(theme, places)));
      if (!listed.settlements || typeof listed.settlements !== 'object' || !('list' in listed.settlements)) throw new Error('missing list');
      for (let i = 0; i < places.length; i++) expect(generatedSettlementSize(theme, places[i])).toBe(optionsForSettlement(listed, listed.settlements.list[i]).size);
    }
    const legacy = makeOptions({ seed: 'type-boundaries', workflow: 'automatic', size: 'town', population: 300 });
    expect(generatedSettlementSize(legacy, { key: 'main', population: 300 })).toBe('town');
    const explicit = makeOptions({ workflow: 'list', mapSize: 6000, settlements: { list: [{ population: 300, options: { size: 'city' } }] } });
    expect(generatedSettlementSize(explicit, { key: 'main', population: 300 })).toBe('city');
    expect(optionsForMainSettlement(explicit).size).toBe('city');
  });

  it('starts with an automatic populated region and keeps old URL parsing separate', () => {
    const firstVisit = initialMapOptions();
    expect(firstVisit.workflow).toBe('automatic');
    expect(firstVisit.population).toBe(3000);
    expect(firstVisit.mapSize).toBe(6000);
    expect(toQuery(fromQuery(toQuery(firstVisit)))).toBe(toQuery(firstVisit));
    expect(toQuery(fromQuery('?seed=42&size=village&culture=roman-core'))).toBe('seed=42&size=village&culture=roman-core');
    expect(fromQuery('?seed=42&size=village&culture=roman-core').workflow).toBeUndefined();
  });

  it('rerolls applied settings without applying or aliasing an unfinished instance edit', () => {
    const applied = makeOptions({ workflow: 'list', seed: 'original', culture: 'roman-core', mapSize: 6000,
      settlements: { list: [{ population: 3000 }, { population: 300, culture: 'barbarian' }] } });
    const pending = structuredClone(applied);
    if (pending.settlements && typeof pending.settlements === 'object' && 'list' in pending.settlements) pending.settlements.list[1].population = 600;
    const previousUid = generationUid(applied);
    const fresh = freshMapOptions(applied, 'new-seed');
    expect(fresh.seed).toBe('new-seed');
    expect(fresh.settlements).toEqual(applied.settlements);
    expect(fresh.settlements).not.toBe(applied.settlements);
    expect(fresh.settlements).not.toEqual(pending.settlements);
    expect(generationUid(fresh)).not.toBe(previousUid);
    expect(generationUid(applied)).toBe(previousUid);
  });

  it('adds a Germanic village beside a Roman city without transferring their cultures or historical mix', () => {
    const theme = makeOptions({ workflow: 'list', culture: 'roman-core', population: 20000, walls: 'single',
      cultureMix: { id: 'european-organic', t: 0.4, mode: 'phases' }, plan: { nucleus: { kind: 'forum' } },
      settlements: { list: [{ population: 20000 }] } });
    const before = structuredClone(theme);
    const village = newSettlementSpec(theme, 300, 'barbarian');
    const composed = { ...theme, settlements: { list: [{ population: 20000 }, village] } };
    const citySettings = optionsForSettlement(composed, composed.settlements.list[0]);
    const villageSettings = optionsForSettlement(composed, village);
    expect(citySettings.culture).toBe('roman-core');
    expect(citySettings.cultureMix).toEqual(theme.cultureMix);
    expect(citySettings.plan).toEqual(theme.plan);
    expect(villageSettings.culture).toBe('barbarian');
    expect(villageSettings.population).toBe(300);
    expect(villageSettings.cultureMix).toBeNull();
    expect(villageSettings.plan).toBeNull();
    expect(villageSettings.walls).toBe('single');
    expect(theme).toEqual(before);
    const loaded = fromQuery(toQuery(composed));
    expect(loaded.settlements).toEqual(composed.settlements);
    expect(generationUid(loaded)).toBe(generationUid(composed));
  });

  it('distinguishes choosing a culture explicitly from inheriting the general theme', () => {
    const theme = makeOptions({ culture: 'roman-core' });
    const inherited = newSettlementSpec(theme, 300, '');
    const explicit = newSettlementSpec(theme, 300, 'roman-core');
    const changedTheme = { ...theme, culture: 'barbarian' };
    expect(optionsForSettlement(changedTheme, inherited).culture).toBe('barbarian');
    expect(optionsForSettlement(changedTheme, explicit).culture).toBe('roman-core');
  });

  it('keeps the automatic main city and position when adding the first independent village', () => {
    const applied = makeOptions({ workflow: 'automatic', culture: 'roman-core', population: 20000,
      center: { x: 2400, y: 2200 }, cultureMix: { id: 'european-organic', mode: 'phases', t: 0.4 } });
    const uid = generationUid(applied);
    const pending = appendSettlementDraft(applied, false, 300, 'barbarian');
    expect(pending.workflow).toBe('automatic');
    expect(pending.settlementMode).toBe('list');
    if (!pending.settlements || typeof pending.settlements !== 'object' || !('list' in pending.settlements)) throw new Error('missing list');
    const [city, village] = pending.settlements.list;
    expect(city).toEqual({ population: 20000, position: applied.center, options: { size: applied.size } });
    expect(optionsForSettlement(pending, city).cultureMix).toEqual(applied.cultureMix);
    expect(optionsForSettlement(pending, village).culture).toBe('barbarian');
    expect(optionsForSettlement(pending, village).cultureMix).toBeNull();
    expect(generationUid(applied)).toBe(uid);
    const composed = { ...pending, workflow: 'list' as const };
    expect(generationUid(composed)).not.toBe(uid);
    expect(toQuery(fromQuery(toQuery(composed)))).toBe(toQuery(composed));
  });

  it('keeps a legacy implicit village population and type when Add switches to individual settlements', () => {
    const applied = fromQuery('?seed=42&size=village&culture=roman-core');
    const expected = mainPopulation(applied, new Rng('burgmap:42'));
    const pending = appendSettlementDraft(applied, false, 300, 'barbarian');
    const composed = settlementComposition(pending, true);
    const main = optionsForMainSettlement(fromQuery(toQuery(composed)));
    expect(applied.population).toBe(0);
    expect(expected).toBeGreaterThanOrEqual(320);
    expect(expected).toBeLessThanOrEqual(900);
    expect(main.population).toBe(expected);
    expect(main.size).toBe('village');
    expect(main.culture).toBe('roman-core');
    expect(mainSettlementSpec(applied).population).toBe(expected);
  });

  it('retains an automatic village without explicit population through Apply and Add', () => {
    const applied = fromQuery('?seed=42&size=village&culture=roman-core&mode=a');
    const expected = mainPopulation(applied, new Rng('burgmap:42'));
    const automatic = settlementComposition(applied, false);
    expect(automatic.population).toBe(0);
    expect(automatic.size).toBe('village');
    expect(generationUid(automatic)).toBe(generationUid(applied));
    const pending = appendSettlementDraft(automatic, false, 300, 'barbarian');
    const composed = settlementComposition(pending, true);
    const main = optionsForMainSettlement(fromQuery(toQuery(composed)));
    expect(main.population).toBe(expected);
    expect(main.size).toBe('village');
    expect(applied.population).toBe(0);
    expect(applied.size).toBe('village');
  });

  it('keeps existing legacy secondaries after the main village when adding a new settlement', () => {
    const applied = fromQuery('?seed=42&size=village&culture=roman-core&settl=L80~barbarian~hilltop~1500~1200');
    const before = structuredClone(applied);
    const pending = appendSettlementDraft(applied, false, 300, 'barbarian');
    const composed = settlementComposition(pending, true);
    if (!composed.settlements || typeof composed.settlements !== 'object' || !('list' in composed.settlements)) throw new Error('missing list');
    const [main, existing, added] = composed.settlements.list;
    expect(composed.settlements.list).toHaveLength(3);
    expect(main.population).toBe(mainPopulation(applied, new Rng('burgmap:42')));
    expect(optionsForSettlement(composed, main).size).toBe('village');
    expect(existing).toEqual({ population: 80, culture: 'barbarian', siteType: 'hilltop', position: { x: 1500, y: 1200 } });
    expect(added.population).toBe(300);
    expect(added.culture).toBe('barbarian');
    expect(applied).toEqual(before);
    expect(toQuery(fromQuery(toQuery(composed)))).toBe(toQuery(composed));
  });
});
