/** Scale transitions for tribal villages: one connected town, without replacing their architecture with rows. */
import type { Culture, EnclosureShape } from './culture';
import { MORPHOLOGIES, EO_BASE, deepMerge, resolveMorph, type MorphologyParams, type Zone } from './morphology';

interface Growth {
  minPop: number;
  shape: EnclosureShape;
  wall: 'palisade' | 'none';
  layout: 'organic' | 'grid';
  orientation: MorphologyParams['orientation'];
  density: number;
  frontage: [number, number];
  depth: [number, number];
  aspect?: [number, number];
}
export const PRIMITIVE_GROWTH: Record<string, Growth> = {
  barbarian: { minPop: 2000, shape: 'organic', wall: 'palisade', layout: 'organic', orientation: 'road', density: 110, frontage: [10, 16], depth: [20, 34] },
  'barbarian-celtic': { minPop: 2400, shape: 'circle', wall: 'palisade', layout: 'organic', orientation: 'terrain', density: 95, frontage: [12, 19], depth: [18, 30] },
  'barbarian-norse': { minPop: 2200, shape: 'oval', wall: 'none', layout: 'grid', orientation: 'water', density: 100, frontage: [9, 15], depth: [20, 34], aspect: [1.9, 2.5] },
  'norse-ringfort': { minPop: 1800, shape: 'circle', wall: 'palisade', layout: 'grid', orientation: 'cardinal', density: 105, frontage: [10, 16], depth: [20, 34] },
  kraal: { minPop: 3000, shape: 'organic', wall: 'palisade', layout: 'organic', orientation: 'terrain', density: 90, frontage: [13, 20], depth: [18, 30] },
  'native-iroquoian': { minPop: 3500, shape: 'oval', wall: 'palisade', layout: 'grid', orientation: 'terrain', density: 140, frontage: [12, 18], depth: [22, 40], aspect: [1.5, 2] },
  'native-pueblo': { minPop: 5000, shape: 'rect', wall: 'none', layout: 'grid', orientation: 'terrain', density: 240, frontage: [7, 12], depth: [14, 24] },
  'native-plains': { minPop: 4500, shape: 'circle', wall: 'none', layout: 'organic', orientation: 'road', density: 70, frontage: [12, 18], depth: [16, 28] },
  'nomad-camp': { minPop: 6000, shape: 'oval', wall: 'none', layout: 'organic', orientation: 'road', density: 80, frontage: [12, 18], depth: [18, 30], aspect: [1.4, 1.9] },
  'celtic-oppidum': { minPop: 20000, shape: 'organic', wall: 'palisade', layout: 'organic', orientation: 'terrain', density: 100, frontage: [12, 18], depth: [18, 30] },
  orcish: { minPop: 45000, shape: 'organic', wall: 'palisade', layout: 'organic', orientation: 'road', density: 130, frontage: [10, 18], depth: [16, 28] },
  halfling: { minPop: 1500, shape: 'organic', wall: 'none', layout: 'organic', orientation: 'terrain', density: 85, frontage: [12, 20], depth: [18, 30] },
};

const zones = ['core', 'middle', 'edge', 'faubourg', 'village'] as const;
const byZone = <T>(make: (zone: Zone, i: number) => T): Record<Zone, T> => Object.fromEntries(zones.map((z, i) => [z, make(z, i)])) as Record<Zone, T>;

/** Adds plain-data recipes only; the original village morphology and preset fields remain intact. */
export function attachUrbanGrowth(cultures: Culture[]): void {
  for (const c of cultures) {
    const g = PRIMITIVE_GROWTH[c.id];
    if (!g) continue;
    const village = resolveMorph(c.core.morphology);
    const id = c.id + '-town';
    const town = deepMerge(EO_BASE, {
      id, arch: village.arch, buildingOp: c.id === 'native-pueblo' ? 'streetFrontRow' : 'primitive',
      streets: g.layout === 'grid' ? ['radials', 'grid'] : ['radials', 'rings', 'organicInfill'],
      streetOp: g.layout, closeOp: 'none', plotOp: 'burgage', orientation: g.orientation,
      extraRadials: g.layout !== 'grid', gatePlaces: 0.3, crossPlaces: 0.15,
      growth: { road: 0.5, water: c.id === 'barbarian-norse' ? 0.5 : 0.2, noise: 0.14, elongation: g.aspect ? 0.6 : 0.15 },
      gridSpacing: c.id === 'native-iroquoian' ? [65, 100] : c.id === 'native-pueblo' ? [40, 65] : [55, 85], gridSkew: 0.08,
      widthByRank: [8, 6, 4.5, 3.5, 2.5],
      blockSize: byZone((_, i) => [1800 + i * 500, 5000 + i * 1200]), minBlock: 400, minWidth: 14,
      frontage: byZone(() => g.frontage), plotDepth: byZone(() => g.depth),
      houseArea: byZone(() => [140, 380]),
      setback: byZone(() => c.id === 'native-pueblo' ? [0, 0.5] : [1, 3]), sideGap: byZone(() => c.id === 'native-pueblo' ? [0, 0.6] : [1, 2.5]),
      buildDepth: byZone(() => [9, 16]), bigCourtChance: 0, cornerFill: byZone(() => 0),
      coverage: byZone((_, i) => c.id === 'native-pueblo' ? [0.82 - i * 0.06, 0.95 - i * 0.06] : [0.44 - i * 0.04, 0.68 - i * 0.04]),
      infill: byZone((_, i) => c.id === 'native-pueblo' ? 0.9 - i * 0.08 : 0.65 - i * 0.07),
      density: byZone((_, i) => g.density * [1, 0.8, 0.65, 0.45, 0.4][i]),
      wideLotChance: 0.05, deadEndRatio: 0, ringGaps: 2,
    }) as MorphologyParams;
    MORPHOLOGIES[id] = town;
    const enclosure = { shape: g.shape, wall: g.wall, fossil: 'street' as const, orientation: g.orientation, ...(g.aspect ? { aspect: g.aspect } : {}) };
    c.urbanGrowth = { minPop: g.minPop, recipe: {
      nucleus: { kind: 'market', shape: c.id === 'norse-ringfort' || g.layout === 'grid' ? 'rect' : 'circle', area: [900, 1800], compound: false, ring: 4.5, orientation: g.orientation },
      core: { morphology: id, enclosure }, ring: { morphology: id, enclosure: { ...enclosure, shape: g.shape === 'circle' ? 'circle' : 'organic' } },
      phaseCount: [[0, 1], [8000, 2], [40000, 3], [250000, 4]],
      faubourg: id, faubShare: [0.14, 0.12],
      render: { towerShape: c.id === 'native-pueblo' ? 'square' : 'round', plotLines: false, primitive: true, ...(c.id === 'native-pueblo' ? { storeyShade: true } : {}) },
      m4: { castle: 'none', cathedral: null, palace: null, monastery: null, marketHall: false, arena: 0, activities: false, port: c.id === 'barbarian-norse' },
    } };
  }
}
