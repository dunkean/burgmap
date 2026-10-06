/** Native cultural recipes and the parameters actually consumed by each bench stage. */
import { CULTURES, getCulture, type Culture } from './culture';
import { applySprawl, deepMerge, MORPHOLOGIES, resolveMorph, type MorphologyParams, type MorphRef, type Zone } from './morphology';

export const BENCH_STAGES = ['streets', 'plots', 'buildings'] as const;
export type BenchStage = typeof BENCH_STAGES[number];
type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
export type BenchParams = DeepPartial<MorphologyParams>;
export interface BenchStageConfig { preset?: string; params?: BenchParams }
export interface BenchRecipe { id: string; label: string; ref: MorphRef; zone: Zone }

export function benchRecipes(culture: Culture): BenchRecipe[] {
  const recipes: BenchRecipe[] = [];
  const add = (id: string, label: string, ref: MorphRef | null | undefined, zone: Zone) => {
    if (ref) recipes.push({ id, label, ref, zone });
  };
  add('core', 'Cœur', culture.core.morphology, 'core');
  culture.core.sectors?.forEach((s, i) => add(`core-sector-${i}`, `Cœur / secteur ${i + 1}`, s.morphology, 'core'));
  add('ring', 'Extension', culture.ring?.morphology, 'middle');
  culture.ring?.sectors?.forEach((s, i) => add(`ring-sector-${i}`, `Extension / secteur ${i + 1}`, s.morphology, 'middle'));
  add('faubourg', 'Faubourg', culture.faubourg, 'faubourg');
  add('village', 'Village', culture.village.morphology ?? culture.core.morphology, 'village');
  add('hamlet', 'Hameau', culture.hamlet.morphology ?? culture.core.morphology, 'village');
  if (culture.urbanGrowth) {
    const g = culture.urbanGrowth.recipe;
    add('grown-core', 'Ville développée / cœur', g.core.morphology, 'core');
    g.core.sectors?.forEach((s, i) => add(`grown-sector-${i}`, `Ville développée / secteur ${i + 1}`, s.morphology, 'core'));
    add('grown-ring', 'Ville développée / extension', g.ring?.morphology, 'middle');
    g.ring?.sectors?.forEach((s, i) => add(`grown-ring-sector-${i}`, `Ville développée / extension / secteur ${i + 1}`, s.morphology, 'middle'));
    add('grown-faubourg', 'Ville développée / faubourg', g.faubourg, 'faubourg');
  }
  return recipes;
}

// Include explicit cultural overrides as well as every registered morphology (e.g. souk).
export const BENCH_PRESETS: Record<string, { label: string; ref: MorphRef }> = Object.fromEntries([
  ...Object.values(CULTURES).flatMap(c => benchRecipes(c).map(r => [
    `${c.id}/${r.id}`, { label: `${c.label} / ${r.label}`, ref: r.ref },
  ] as const)),
  ...Object.keys(MORPHOLOGIES).map(id => [`morph/${id}`, { label: id, ref: id }] as const),
]);

export const BENCH_OPERATORS = {
  streetOp: ['organic', 'grid'],
  closeOp: ['closes', 'culDeSacTree', 'hutong', 'roji', 'none'],
  plotOp: ['burgage', 'courtyard', 'siheyuan', 'machiya', 'compound', 'garden', 'wholeBlock'],
  buildingOp: ['streetFrontRow', 'streetFrontRowExperimental', 'courtyardHouse', 'shopRow', 'pavilionCompound', 'yashiki', 'machiya', 'detached', 'treeHouse', 'hall', 'longhouse', 'kancha', 'yardHouse', 'tomb', 'venetian', 'konak', 'sahelCompound', 'giebelhaus', 'hanok', 'gnome', 'primitive', 'fungalHouse', 'duergarHall', 'perimeterBlock'],
  orientation: ['road', 'cardinal', 'terrain', 'water'],
} as const;

/** Menu entries represent implementations, rather than cultural aliases. */
export const BENCH_METHODS = {
  plots: [
    { id: 'cutPlots', aliases: ['burgage', 'machiya', 'wholeBlock'] },
    { id: 'cutCourtyards', aliases: ['courtyard', 'compound'] },
    { id: 'garden', aliases: ['garden'] },
    { id: 'cutPlots + raffinement', aliases: ['siheyuan'] },
  ],
  buildings: [
    { id: 'buildPlot', aliases: ['streetFrontRow', 'detached', 'longhouse'] },
    ...BENCH_OPERATORS.buildingOp.filter(id => !['streetFrontRow', 'detached', 'longhouse'].includes(id))
      .map(id => ({ id: ({ streetFrontRowExperimental: 'buildPlotExperimental', primitive: 'primitiveHouse', gnome: 'gnomeHouse', fungalHouse: 'treeHouse + adaptation fongique', perimeterBlock: 'buildPerimeterBlock' } as Record<string, string>)[id] ?? id, aliases: [id] })),
  ],
};
export function benchMethod(stage: 'plots' | 'buildings', operator: string): string {
  return BENCH_METHODS[stage].find(m => m.aliases.includes(operator))!.id;
}

/** Only dials read by the selected native implementation (metadata included). */
export function benchMethodFields(stage: 'plots' | 'buildings', P: MorphologyParams): readonly (keyof MorphologyParams)[] {
  if (stage === 'plots') {
    if (P.plotOp === 'garden' || P.plotOp === 'wholeBlock') return [];
    const tilt: (keyof MorphologyParams)[] = P.streetOp === 'grid' ? [] : ['plotTilt'];
    if (['courtyard', 'compound'].includes(P.plotOp)) return ['houseArea', ...tilt];
    return ['coverage', 'frontage', 'plotDepth', ...tilt, 'wideLotChance', 'deepFill', ...(P.plotOp === 'siheyuan' ? ['houseArea' as const] : [])];
  }
  switch (P.buildingOp) {
    case 'perimeterBlock': return ['blockCourtShare', 'blockSolidChance', 'blockInfillChance', 'arch'];
    case 'streetFrontRowExperimental': case 'streetFrontRow': case 'detached': case 'longhouse': case 'venetian':
      return ['coverage', 'buildDepth', 'setback', 'bigCourtChance', 'houseVariation', 'arch'];
    case 'courtyardHouse': return ['coverage', 'houseArea', 'roomDepth', 'courtyardShare', 'arch'];
    case 'kancha': return ['roomDepth', 'arch'];
    case 'shopRow': case 'pavilionCompound': case 'hall': case 'duergarHall': return ['arch'];
    case 'yardHouse': case 'konak': case 'giebelhaus': case 'gnome': case 'primitive': return ['coverage', 'arch'];
    case 'machiya': case 'sahelCompound': case 'hanok': return ['coverage'];
    default: return [];
  }
}

export const BENCH_FIELDS: Record<BenchStage, readonly (keyof MorphologyParams)[]> = {
  streets: ['streetOp', 'closeOp', 'orientation', 'laneSpacing', 'wardArea', 'accessDepth', 'fieldTwist', 'curvature', 'fieldNoise', 'fieldWavelength', 'fieldRandom', 'gridSpacing', 'gridSkew', 'blockSize', 'minBlock', 'minWidth', 'widthByRank', 'widthScale', 'widthJitter', 'placeThreshold', 'deadEndRatio', 'slitDepth', 'plotDepth', 'contourFollow', 'contourBlend', 'longCut'],
  plots: ['plotOp', 'streetOp', 'houseArea', 'coverage', 'frontage', 'plotDepth', 'plotTilt', 'wideLotChance', 'deepFill'],
  buildings: ['buildingOp', 'arch', 'houseArea', 'roomDepth', 'courtyardShare', 'coverage', 'buildDepth', 'setback', 'bigCourtChance', 'houseVariation', 'frontage', 'blockCourtShare', 'blockSolidChance', 'blockInfillChance', 'footprintConformity', 'cornerFill'],
};

export interface BenchMorphOptions {
  culture: string; zone: Zone; density: number; recipe?: string;
  stages?: Partial<Record<BenchStage, BenchStageConfig>>;
}

/** Reject invalid/unused overrides rather than silently testing a different method. */
export function validateBenchParams(stage: BenchStage, value: unknown): asserts value is BenchParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Les paramètres doivent être un objet JSON.');
  const base = MORPHOLOGIES['european-organic'];
  const check = (v: unknown, example: unknown, key: string): void => {
    if (typeof example === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v) || (v < 0 && key !== 'fieldTwist')) throw new Error(`${key} : nombre positif ou nul attendu.`);
    } else if (Array.isArray(example)) {
      if (!Array.isArray(v) || v.length !== example.length) throw new Error(`${key} : ${example.length} valeurs attendues.`);
      v.forEach((item, i) => check(item, example[i], key));
      if (v.length === 2 && v.every(item => typeof item === 'number') && v[0] > v[1]
        && !['gridSpacing', 'laneSpacing'].includes(key)) throw new Error(`${key} : minimum supérieur au maximum.`);
    } else if (example && typeof example === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${key} : objet attendu.`);
      for (const [k, item] of Object.entries(v)) {
        if (!Object.hasOwn(example, k)) throw new Error(`${key}.${k} : paramètre inconnu.`);
        check(item, (example as Record<string, unknown>)[k], `${key}.${k}`);
      }
    } else if (typeof v !== typeof example) throw new Error(`${key} : type invalide.`);
  };
  for (const [key, v] of Object.entries(value)) {
    if (!BENCH_FIELDS[stage].includes(key as keyof MorphologyParams)) throw new Error(`${key} n’est pas utilisé à cette étape.`);
    if (key in BENCH_OPERATORS) {
      if (!(BENCH_OPERATORS[key as keyof typeof BENCH_OPERATORS] as readonly unknown[]).includes(v)) throw new Error(`${key} : opérateur inconnu.`);
    } else {
      const optional: Record<string, unknown> = { courtyardShare: [0, 1], houseVariation: 0, blockCourtShare: [0.12, 0.45], blockSolidChance: 0.08, blockInfillChance: 0.22, contourFollow: 0, contourBlend: 0, longCut: 0, deepFill: false };
      check(v, base[key as keyof MorphologyParams] ?? optional[key], key);
    }
    if (['widthScale', 'minWidth', 'fieldWavelength', 'accessDepth'].includes(key) && Number(v) <= 0) throw new Error(`${key} doit être supérieur à zéro.`);
    if (key === 'gridSpacing' && (v as number[]).some(n => n <= 0)) throw new Error('gridSpacing doit être supérieur à zéro.');
    if (['houseVariation', 'blockSolidChance', 'blockInfillChance'].includes(key) && Number(v) > 1) throw new Error(`${key} doit être compris entre zéro et un.`);
    if (key === 'blockCourtShare' && (v as number[]).some(n => n < 0 || n > 0.75)) throw new Error('blockCourtShare doit être compris entre zéro et 0.75.');
  }
}

export function benchMorph(options: BenchMorphOptions, stage: BenchStage): MorphologyParams {
  const culture = getCulture(options.culture);
  const ref = options.recipe
    ? benchRecipes(culture).find(r => r.id === options.recipe)?.ref
    : options.zone === 'village' ? culture.village.morphology ?? culture.core.morphology : culture.core.morphology;
  if (options.recipe && !ref) throw new Error(`Recette inconnue : ${options.recipe}`);
  const config = options.stages?.[stage];
  const preset = config?.preset && config.preset !== 'culture' ? BENCH_PRESETS[config.preset] : undefined;
  if (config?.preset && config.preset !== 'culture' && !preset) throw new Error(`Préréglage inconnu : ${config.preset}`);
  if (config?.params) validateBenchParams(stage, config.params);
  const P = deepMerge(applySprawl(resolveMorph(preset?.ref ?? ref), 1 / options.density), config?.params ?? {});
  // Old shared links retain their options, but the discontinued custom parcel
  // mode now replays through the native cadastral operator.
  if (stage === 'plots' && P.plotOp === 'wholeBlock') P.plotOp = 'burgage';
  return P;
}
