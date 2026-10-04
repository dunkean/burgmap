import { describe, expect, it } from 'vitest';
import { classOfPop, fromQuery, makeOptions, POP_MAX, POP_MIN, toQuery } from '../src/gen/options';
import type { SettlementSpec } from '../src/gen/options';
import { SETTLEMENT_KINDS, withSettlementKind } from '../src/ui/settlementKinds';

describe('settlement type shortcuts', () => {
  it('offers all existing classes with populations that the unchanged generator recognises', () => {
    expect(SETTLEMENT_KINDS.map((choice) => choice.kind)).toEqual(['farmstead', 'hamlet', 'village', 'town', 'city', 'metropolis', 'megacity']);
    for (const choice of SETTLEMENT_KINDS) {
      expect(choice.population).toBeGreaterThanOrEqual(POP_MIN);
      expect(choice.population).toBeLessThanOrEqual(POP_MAX);
      expect(classOfPop(choice.population)).toBe(choice.kind);
    }
  });

  it('changes kind without losing a fixed position, culture or preferred site', () => {
    const spec: SettlementSpec = { population: 350, position: { x: 1200, y: 3400 }, culture: 'medina', siteType: 'plain' };
    for (const choice of SETTLEMENT_KINDS) {
      const changed = withSettlementKind(spec, choice.kind);
      expect(classOfPop(changed.population)).toBe(choice.kind);
      expect(changed.position).toBe(spec.position);
      expect(changed.culture).toBe(spec.culture);
      expect(changed.siteType).toBe(spec.siteType);
    }
    expect(spec.population).toBe(350);
    expect(withSettlementKind(spec, 'village')).toBe(spec);
  });

  it('shares placed farms, hamlets and villages with the existing population/list schema', () => {
    const base: SettlementSpec = { population: 350, position: { x: 1200, y: 3400 }, culture: 'medina' };
    const list = SETTLEMENT_KINDS.map((choice) => withSettlementKind(base, choice.kind));
    const options = makeOptions({ settlements: { list } });
    const query = toQuery(options), back = fromQuery(query);
    expect(back.settlements).toEqual(options.settlements);
    expect(toQuery(back)).toBe(query);
    expect(query).not.toMatch(/kind=/);
  });
});
