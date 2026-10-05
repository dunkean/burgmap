import { effectiveSize, makeOptions, POP_MIN, POP_MAX, type Options, type SettlementSpec } from '../gen/options';
import { Rng } from '../gen/core/rng';
import { mainPopulation } from '../gen/pipeline';

/** A usable first visit; URL-backed visits still use the existing parser unchanged. */
export function initialMapOptions(): Options {
  return makeOptions({ workflow: 'automatic', population: 3000, size: 'town', mapSize: 6000 });
}

/** A fresh map uses the applied configuration, independently of unfinished edits. */
export function freshMapOptions(applied: Options, seed: string): Options {
  return { ...structuredClone(applied), seed };
}

/** Resolve the existing implicit population before converting the main map into a list item. */
export function mainSettlementSpec(theme: Options): SettlementSpec {
  const size = effectiveSize(theme);
  const population = theme.population > 0 ? theme.population
    : mainPopulation({ ...theme, size }, new Rng('burgmap:' + theme.seed));
  return { population, position: theme.center, options: { size } };
}

/** Culture is local to the new instance; the general theme remains intact. */
export function newSettlementSpec(theme: Options, population: number, culture: string): SettlementSpec {
  const spec: SettlementSpec = { population: Math.max(POP_MIN, Math.min(POP_MAX, Math.round(population))) };
  if (culture) spec.culture = culture;
  if (culture && culture !== theme.culture) {
    spec.options = { cultureMix: null, plan: null };
  }
  return spec;
}

/** Automatic and legacy maps retain their main settlement when an instance is added. */
export function appendSettlementDraft(theme: Options, individual: boolean, population: number, culture: string): Options {
  const previous = theme.settlements && typeof theme.settlements === 'object' && 'list' in theme.settlements
    ? structuredClone(theme.settlements.list) : [];
  const instances = individual || theme.workflow && previous.length
    ? previous : [mainSettlementSpec(theme), ...previous];
  return { ...theme, settlementMode: 'list', settlements: { list: [...instances, newSettlementSpec(theme, population, culture)] } };
}

/** Automatic composition keeps implicit population and its original size preset. */
export function settlementComposition(theme: Options, individual: boolean): Options {
  const list = theme.settlements && typeof theme.settlements === 'object' && 'list' in theme.settlements ? theme.settlements.list : [];
  return individual ? { ...theme, workflow: 'list', settlements: { list: list.length ? list : [mainSettlementSpec(theme)] } }
    : { ...theme, workflow: 'automatic', settlements: list.length ? theme.settlements : 'auto' };
}

/** A settlement of a displayed map, as the page knows it (worker summary or World). */
export interface GeneratedPlace { key: string; name?: string; population: number; center: { x: number; y: number } }

/**
 * Take over an automatic region as an editable list: every place keeps its generation key, population, position and
 * name, so generating the list reproduces the region; afterwards each place is edited like a hand-made one.
 */
export function regionAsList(theme: Options, places: GeneratedPlace[]): Options {
  // exact positions: a rounded main centre would shift its site and redraw its plan
  const at = (p: GeneratedPlace) => ({ x: p.center.x, y: p.center.y });
  const main = places.find((p) => p.key === 'main');
  const auto = { ...theme, workflow: 'automatic' as const };
  const first: SettlementSpec = { ...mainSettlementSpec(auto), ...(main ? { position: at(main) } : {}), ...(main?.name ? { name: main.name } : {}) };
  const rest = places.filter((p) => p.key !== 'main').map((p): SettlementSpec => ({
    population: p.population, position: at(p), key: p.key, ...(p.name ? { name: p.name } : {}),
  }));
  return { ...theme, workflow: 'list', settlementMode: 'list', center: undefined, settlements: { list: [first, ...rest] } };
}
