import type { LandKind } from './types';

export const BIOME_NAMES = ['temperate', 'forest', 'desert', 'steppe', 'tropical', 'tundra', 'underdark', 'underdark-caverns'] as const;
export type BiomeName = typeof BIOME_NAMES[number];
export const BIOME_LABELS: [BiomeName, string][] = [
  ['temperate', 'Temperate countryside'], ['forest', 'Woodland'], ['desert', 'Desert and oases'],
  ['steppe', 'Steppe'], ['tropical', 'Tropical forest'], ['tundra', 'Tundra'],
  ['underdark', 'Underdark'], ['underdark-caverns', 'Underdark with caverns'],
];
export const biomeName = (value?: string): BiomeName =>
  BIOME_NAMES.includes(value as BiomeName) ? value as BiomeName : 'temperate';

export const isUnderdarkBiome = (name?: string): boolean => name === 'underdark' || name === 'underdark-caverns';

export interface BiomeGround {
  water: number; hab: number; slope: number; soil: number; settlement: number; arableRadius: number;
}

/** Vegetation and cultivation follow climate, access and water; urban geometry is independent of the biome. */
export function biomeLandKind(kind: LandKind, biome: BiomeName, g: BiomeGround): LandKind {
  if (biome === 'temperate') return kind;
  if (isUnderdarkBiome(biome)) {
    // Cultivation is supplied by nearby inhabitants, not sunlight. Wild wet fungi remain uncultivated marsh.
    if (kind === 'marsh') return 'marsh';
    const cultivated = kind === 'field' || kind === 'garden' || kind === 'orchard';
    return cultivated && g.settlement < Math.max(100, g.arableRadius * 0.35) && g.slope < 0.12 && g.water < 450
      ? 'garden' : 'commons';
  }
  if (biome === 'desert') {
    // Irrigation and oasis groves stay close to perennial water. Dry uplands remain bare or sparse grazing land.
    if (g.water > 420 || g.hab > 28) return g.soil > 0.25 && g.slope < 0.12 ? 'pasture' : 'commons';
    if (kind === 'forest') return g.water < 150 && g.slope < 0.12 ? 'orchard' : 'pasture';
    if (kind === 'meadow' && g.water > 180) return 'pasture';
    return kind;
  }
  if (biome === 'forest' || biome === 'tropical') {
    if (kind === 'marsh') return kind;
    const clearing = Math.max(110, g.arableRadius * (biome === 'tropical' ? 0.42 : 0.58));
    if (g.settlement > clearing * (1 + 0.4 * g.soil)) return 'forest';
    return kind;
  }
  if (biome === 'steppe') {
    if (kind === 'forest') return g.water < 120 && g.soil > 0.15 ? 'forest' : 'pasture';
    if (kind === 'orchard' && g.water > 220) return 'pasture';
    return kind;
  }
  // Treeless tundra: small sheltered crofts near homes, wet meadows, exposed heath beyond them.
  if (kind === 'marsh' || kind === 'meadow') return kind;
  if (kind === 'field' || kind === 'garden') {
    return g.settlement < 140 && g.slope < 0.08 ? kind : 'pasture';
  }
  return g.soil < -0.1 || g.slope > 0.15 ? 'commons' : 'pasture';
}
