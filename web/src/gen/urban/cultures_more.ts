/**
 * The third set of planning cultures (URBAN_MORPHOLOGY.md §3b, §3c): plain data on the street engine, with their
 * own building operators and landmark plans.
 */
import type { Culture } from './culture';
import type { MorphologyParams } from './morphology';
import { MORPHOLOGIES, EO_BASE, deepMerge } from './morphology';

const morph = (id: string, base: MorphologyParams, over: Record<string, unknown>): MorphologyParams => deepMerge(base, { ...over, id });

const M: Record<string, MorphologyParams> = {};
// ---------------------------------------------------------------- Byzantine / Greek hillside town
M['byzantine'] = morph('byzantine', EO_BASE, {
  // streets along the contours, stepped lanes climbing between them; small blocks of terraced houses
  streets: ['radials', 'organicInfill', 'closes'], contourBlend: 0.95, extraRadials: false, curvature: 0.75, fieldNoise: 14, fieldRandom: 0.2,
  gatePlaces: 0.25, crossPlaces: 0.15, ringGaps: 3,
  blockSize: { core: [1400, 4200], middle: [1800, 5500], edge: [2400, 7500], faubourg: [2500, 8000], village: [3500, 12000] },
  minBlock: 450, minWidth: 14, widthByRank: [5.2, 4, 3, 2.3, 2], widthJitter: 0.2, placeThreshold: 380, deadEndRatio: 0.5,
  frontage: { core: [5, 8], middle: [5.5, 9], edge: [6.5, 11], faubourg: [7, 12], village: [12, 26] },
  plotDepth: { core: [10, 18], middle: [12, 22], edge: [14, 26], faubourg: [14, 28], village: [22, 40] },
  buildDepth: { core: [7, 10], middle: [7, 10], edge: [6.5, 9.5], faubourg: [6.5, 9], village: [7, 10] },
  coverage: { core: [0.82, 0.92], middle: [0.7, 0.82], edge: [0.55, 0.68], faubourg: [0.45, 0.58], village: [0.18, 0.32] },
  footprintConformity: { core: 0.8, middle: 0.65, edge: 0.5, faubourg: 0.35, village: 0.3 },
  density: { core: 200, middle: 150, edge: 110, faubourg: 70, village: 40 },
  arch: { typology: 'byzantine-house', roof: 'tiled-hip', storeys: [2, 3], material: 'stone' },
});
Object.assign(MORPHOLOGIES, M);

export const MORE_CULTURES: Culture[] = [
  {
    id: 'byzantine-greek', label: 'Byzantine hill town (Mystras)',
    nucleus: { kind: 'market', shape: 'hull', area: [500, 2400], compound: false, ring: 3.6 },
    core: { morphology: 'byzantine', enclosure: { shape: 'organic', wall: 'auto', fossil: 'street', towers: 'square' } },
    ring: { morphology: 'byzantine', enclosure: { shape: 'organic', wall: 'auto', fossil: 'street', towers: 'square' } },
    phaseCount: [[0, 1], [4000, 2], [15000, 3]],
    faubourg: 'byzantine', faubShare: [0.08, 0.08],
    landmarks: [
      { role: 'worship', kind: 'byz-metropolis', place: 'adjacent-nucleus', area: [900, 4500], minPop: 600 },
      // (dozens of small churches: one per ~700 inhabitants, spread through the quarters)
      { role: 'extra', kind: 'byz-church', place: 'spread', area: [250, 1800], minPop: 200, perPop: 700, sep: 90 },
      { role: 'civic', kind: 'byz-monastery', place: 'edge', area: [2500, 9000], minPop: 2000 },
    ],
    village: { form: 'auto', morphology: 'byzantine' },
    hamlet: { form: 'auto', morphology: 'byzantine' },
    m4: { castle: 'kastro', cathedral: null, palace: null, monastery: null, marketHall: false, arena: 0, shanty: 'gecekondu', activities: false },
    render: { towerShape: 'square', stairs: true },
    scale: { min: 'hamlet', max: 'city' },
    // (the town hangs on a slope below its kastro: high ground behind, the valley or the sea below)
    sitePrefs: { flatness: 0.5, hillSide: 'N', weights: { hilltop: 1.6, valley: 2.2, harbor: 2, plain: 0.25, bridge: 0.6, estuary: 0.6 } },
  },
];
