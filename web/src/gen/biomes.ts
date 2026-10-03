import type { LandKind } from './types';

export const BIOME_NAMES = ['temperate', 'forest', 'desert', 'steppe', 'tropical', 'tundra'] as const;
export type BiomeName = typeof BIOME_NAMES[number];
export const BIOME_LABELS: [BiomeName, string][] = [
  ['temperate', 'Temperate countryside'], ['forest', 'Woodland'], ['desert', 'Desert and oases'],
  ['steppe', 'Steppe'], ['tropical', 'Tropical forest'], ['tundra', 'Tundra'],
];
export const biomeName = (value?: string): BiomeName =>
  BIOME_NAMES.includes(value as BiomeName) ? value as BiomeName : 'temperate';

export interface BiomeGround {
  water: number; hab: number; slope: number; soil: number; settlement: number; arableRadius: number;
}

/** Vegetation and cultivation follow climate, access and water; urban geometry is independent of the biome. */
export function biomeLandKind(kind: LandKind, biome: BiomeName, g: BiomeGround): LandKind {
  if (biome === 'temperate') return kind;
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
