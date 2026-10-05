import { describe, expect, it } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { fromQuery, makeOptions, toQuery } from '../src/gen/options';
import { regionAsList } from '../src/ui/workflowDraft';
import type { World } from '../src/gen/types';

const places = (w: World) => (w.settlements ?? []).map((s) => ({ key: s.key, name: s.name, population: s.population, center: s.center }));
const summary = (w: World) => (w.settlements ?? []).map((s) => `${s.key}|${s.name}|${s.cls}|${Math.round(s.center.x)},${Math.round(s.center.y)}`);

describe('automatic region taken over as a list', () => {
  for (const seed of ['region-a']) it(`reproduces the region (${seed})`, () => {
    const auto = makeOptions({ seed, workflow: 'automatic', population: 3000, mapSize: 6000 });
    const a = generate(auto, undefined, { lazy: false });
    const listed = regionAsList(auto, places(a));
    // the real path goes through the link (farmsteads under the 10-inhabitant floor are raised to it)
    const b = generate(fromQuery(toQuery(listed)), undefined, { lazy: false });
    expect(summary(b)).toEqual(summary(a));
    expect(b.names!.town).toBe(a.names!.town);
    expect(JSON.stringify(b.urban)).toBe(JSON.stringify(a.urban));
    expect(JSON.stringify((b.settlements ?? []).map((s) => s.urban))).toBe(JSON.stringify((a.settlements ?? []).map((s) => s.urban)));
    expect(JSON.stringify(b.roads)).toBe(JSON.stringify(a.roads));
  }, 240000);
});
