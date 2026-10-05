import type { BiomeName } from '../gen/biomes';
import { sizeForPop, type Options, type SizeName } from '../gen/options';
import { POP_RANGE } from '../gen/urban/phases';

/** Cultures that read naturally in each biome; the pick stays free-form, this only keeps the surprise coherent. */
export const BIOME_CULTURES: Record<BiomeName, readonly string[]> = {
  temperate: ['european-organic', 'bastide', 'roman-core', 'russian-kremlin', 'hanseatic', 'celtic-oppidum', 'barbarian', 'barbarian-celtic', 'halfling', 'wizard-city', 'byzantine-greek', 'gnomish'],
  forest: ['elven', 'barbarian', 'barbarian-celtic', 'barbarian-norse', 'native-iroquoian', 'russian-kremlin', 'norse-ringfort', 'japanese-jokamachi', 'korean', 'halfling'],
  desert: ['medina', 'sahel', 'persian', 'native-pueblo', 'ottoman', 'necropolis', 'swahili-stone-town', 'kraal'],
  steppe: ['nomad-camp', 'native-plains', 'chinese', 'russian-kremlin', 'orcish', 'persian', 'kraal'],
  tropical: ['maya', 'khmer', 'indian-temple', 'swahili-stone-town', 'stilt-town', 'aztec', 'kraal'],
  tundra: ['barbarian-norse', 'norse-ringfort', 'dwarven', 'russian-kremlin', 'orcish'],
  underdark: ['drow-enclave', 'duergar-hold', 'myconid-colony'],
  'underdark-caverns': ['drow-enclave', 'duergar-hold', 'myconid-colony'],
};

/** Surface biomes come up far more often than the Underdark ones. */
const BIOME_WEIGHTS: [BiomeName, number][] = [
  ['temperate', 5], ['forest', 4], ['desert', 4], ['steppe', 3], ['tropical', 3], ['tundra', 3], ['underdark', 1], ['underdark-caverns', 1],
];
const SIZE_WEIGHTS: [SizeName, number][] = [['hamlet', 1], ['village', 3], ['town', 4], ['city', 3], ['capital', 1]];
const RELIEFS: Options['relief'][] = ['flat', 'hills', 'valley', 'mountains'];
const COASTS: Options['coast'][] = ['none', 'none', 'random', 'N', 'E', 'S', 'W'];
const RIVERS: Options['river'][] = ['none', 'stream', 'river', 'river', 'major'];

function weighted<T>(items: readonly [T, number][], rand: () => number): T {
  let t = rand() * items.reduce((sum, [, w]) => sum + w, 0);
  for (const [item, w] of items) { t -= w; if (t < 0) return item; }
  return items[items.length - 1][0];
}
const pick = <T>(items: readonly T[], rand: () => number): T => items[Math.min(items.length - 1, Math.floor(rand() * items.length))];

export type SurprisePatch = Pick<Options, 'biome' | 'relief' | 'coast' | 'river' | 'culture' | 'size' | 'population' | 'cultureMix' | 'plan' | 'settlements' | 'settlementMode' | 'workflow' | 'center'>;

/**
 * A random environment and main settlement (biome, relief, water, culture, population), as an automatic
 * composition. The caller adds the seed. `knownCultures` guards against stale ids.
 */
export function surprisePatch(rand: () => number, knownCultures: ReadonlySet<string>): SurprisePatch {
  const biome = weighted(BIOME_WEIGHTS, rand);
  const cultures = BIOME_CULTURES[biome].filter((id) => knownCultures.has(id));
  const [low, high] = POP_RANGE[weighted(SIZE_WEIGHTS, rand)];
  const population = Math.round(low * Math.pow(high / low, rand()));
  const underground = biome === 'underdark' || biome === 'underdark-caverns';
  return {
    biome, population, size: sizeForPop(population),
    relief: pick(RELIEFS, rand),
    coast: underground ? 'none' : pick(COASTS, rand),
    river: pick(RIVERS, rand),
    culture: (cultures.length ? pick(cultures, rand) : 'european-organic') as Options['culture'],
    cultureMix: null, plan: null,
    workflow: 'automatic', settlementMode: 'automatic', settlements: 'auto', center: undefined,
  };
}
