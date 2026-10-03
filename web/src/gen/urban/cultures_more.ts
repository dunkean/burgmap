/**
 * The third set of planning cultures (URBAN_MORPHOLOGY.md §3b, §3c): plain data on the street engine, with their
 * own building operators and landmark plans.
 */
import type { Culture } from './culture';
import type { MorphologyParams } from './morphology';
import { MORPHOLOGIES, EO_BASE, deepMerge } from './morphology';

const morph = (id: string, base: MorphologyParams, over: Record<string, unknown>): MorphologyParams => deepMerge(base, { ...over, id });

/** Registers the morphologies (after the base ones: some derive from the medina's). */
export function registerMoreMorphologies(): void {
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
// ---------------------------------------------------------------- Venetian lagoon town
M['venetian'] = morph('venetian', EO_BASE, {
  // the first cut of each quarter is dug as a canal (rank 2: the width of a rio with its fondamenta); calli inside
  streets: ['radials', 'organicInfill', 'closes'], buildingOp: 'venetian', longCut: 85, growth: { road: 0.12, water: 0.55, noise: 0.22, wavelength: 300, elongation: 0.1, wet: 0.15, bipolar: 0.2 }, extraRadials: false, curvature: 0.8, fieldNoise: 22, fieldRandom: 0.6,
  gatePlaces: 0.2, crossPlaces: 0.25, ringGaps: 2.5, placeThreshold: 650, deadEndRatio: 0.45,
  blockSize: { core: [1500, 4200], middle: [2000, 5500], edge: [2600, 7500], faubourg: [3000, 9000], village: [5000, 14000] },
  minBlock: 500, minWidth: 15, widthByRank: [6.5, 5.5, 8.5, 2.6, 2.1], widthJitter: 0.12,
  frontage: { core: [5, 8], middle: [5.5, 9], edge: [6.5, 11], faubourg: [7, 12], village: [14, 28] },
  plotDepth: { core: [16, 28], middle: [18, 32], edge: [20, 36], faubourg: [20, 36], village: [28, 50] },
  coverage: { core: [0.88, 0.95], middle: [0.8, 0.9], edge: [0.66, 0.8], faubourg: [0.55, 0.68], village: [0.2, 0.35] },
  density: { core: 230, middle: 180, edge: 130, faubourg: 80, village: 40 },
  arch: { typology: 'venetian-house', roof: 'tiled-hip', storeys: [3, 4], material: 'brick' },
});
// ---------------------------------------------------------------- Persian city
M['persian'] = morph('persian', MORPHOLOGIES['medina'], {
  // kucheh: winding lanes and dead ends between the courtyard houses (larger courts with their pool than a medina)
  streets: ['gateToGate', 'organicInfill', 'culDeSacTree'], curvature: 0.8, fieldNoise: 26, fieldRandom: 0.5, spineAmp: 8, deadEndRatio: 0.75,
  blockSize: { core: [3000, 9000], middle: [6000, 18000], edge: [8000, 22000], faubourg: [6000, 16000], village: [6000, 16000] },
  widthByRank: [7, 5, 3.6, 2.8, 2.4], accessDepth: 22,
  houseArea: { core: [150, 420], middle: [200, 550], edge: [250, 700], faubourg: [250, 700], village: [300, 900] }, roomDepth: [4, 6],
  coverage: { core: [0.86, 0.92], middle: [0.82, 0.9], edge: [0.76, 0.86], faubourg: [0.6, 0.72], village: [0.5, 0.65] },
  density: { core: 260, middle: 200, edge: 150, faubourg: 80, village: 50 },
  arch: { typology: 'persian-courtyard-house', roof: 'flat', storeys: [1, 2], material: 'mud' },
});
M['persian-bazaar'] = morph('persian-bazaar', MORPHOLOGIES['medina-souk'], {
  // the bazaar quarter: shop cells in rows along the vaulted lanes, timchehs and caravanserais between them
  streets: ['gateToGate', 'organicInfill'], spineAmp: 8, widthByRank: [7, 5, 3.4, 2.6, 2.2],
  arch: { typology: 'bazaar-shop', roof: 'dome', storeys: [1, 1], material: 'brick' },
});
Object.assign(MORPHOLOGIES, M);
}

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
  {
    id: 'venetian-lagoon', label: 'Venetian lagoon town',
    nucleus: { kind: 'market', shape: 'rect', area: [2500, 11000], compound: false, ring: 6 },
    core: { morphology: 'venetian', enclosure: { shape: 'organic', wall: 'none', fossil: 'street' } },
    ring: { morphology: 'venetian', enclosure: { shape: 'organic', wall: 'none', fossil: 'none' } },
    phaseCount: [[0, 1], [5000, 2], [20000, 3]],
    faubourg: 'venetian', faubShare: [0.06, 0.06],
    landmarks: [
      { role: 'worship', kind: 'doge-basilica', place: 'adjacent-nucleus', area: [2500, 9000], minPop: 4000 },
      { role: 'power', kind: 'doge-palace', place: 'adjacent-nucleus', area: [2500, 9000], minPop: 7000 },
      // (an island parish every ~1,400 inhabitants: its campo, church, campanile and well)
      { role: 'extra', kind: 'campo', place: 'spread', area: [1100, 4500], minPop: 300, perPop: 1400, sep: 150 },
    ],
    village: { form: 'auto', morphology: 'venetian' },
    hamlet: { form: 'auto', morphology: 'venetian' },
    m4: { castle: 'none', cathedral: null, palace: null, monastery: 'monastery', marketHall: false, arena: 0, shanty: 'riverbank', activities: false, arsenal: true },
    render: { towerShape: 'round', lagoon: true },
    scale: { min: 'hamlet', max: 'metropolis' },
    sitePrefs: { flatness: 2.5, weights: { estuary: 3, harbor: 2.6, bridge: 1.4, meander: 1.2, plain: 0.8, hilltop: 0, valley: 0.3 } },
  },
  {
    id: 'persian', label: 'Persian city (Isfahan)',
    nucleus: { kind: 'maidan', shape: 'rect', area: [9000, 70000], compound: true, ring: 9, orientation: 'cardinal' },
    core: { morphology: 'persian-bazaar', share: 0.12, enclosure: { shape: 'organic', wall: 'wall', fossil: 'none', towers: 'round' } },
    ring: { morphology: 'persian', enclosure: { shape: 'organic', wall: 'wall', fossil: 'none', towers: 'round' } },
    phaseCount: [[0, 2], [9000, 3]],
    faubourg: 'persian', faubShare: [0.05, 0.06],
    landmarks: [
      { role: 'worship', kind: 'friday-mosque', place: 'near-nucleus', area: [5000, 18000], minPop: 1500 },
      { role: 'power', kind: 'palace', place: 'adjacent-nucleus', area: [3000, 12000], minPop: 6000 },
      { role: 'market', kind: 'caravanserai', place: 'near-nucleus', area: [1600, 6000], minPop: 1500, count: 2, sep: 80 },
      { role: 'extra', kind: 'caravanserai', place: 'gate', area: [1600, 6000], minPop: 2500, perPop: 7000, sep: 200 },
      { role: 'extra', kind: 'hammam', place: 'near-nucleus', area: [500, 3000], minPop: 2000 },
      { role: 'civic', kind: 'chahar-bagh', place: 'edge', area: [6000, 30000], minPop: 3000 },
    ],
    village: {
      form: 'walled', morphology: 'persian', enclosure: { shape: 'rect', wall: 'wall', fossil: 'none', towers: 'round', orientation: 'road' },
      nucleus: { kind: 'mosque', shape: 'rect', area: [500, 900], compound: true, ring: 3, orientation: 'qibla' },
    },
    hamlet: { form: 'auto', morphology: { base: 'persian', buildingOp: 'courtyardHouse' } },
    m4: { castle: 'kasbah', cathedral: null, palace: null, monastery: 'madrasa', marketHall: false, arena: 0, shanty: 'gecekondu', activities: false },
    render: { towerShape: 'round', bazaarRoof: true, qanats: true },
    scale: { min: 'hamlet', max: 'megacity' },
    sitePrefs: { flatness: 1.6, hillSide: 'N', weights: { plain: 2, valley: 1.4, bridge: 1.6, hilltop: 0.2, harbor: 0.3, estuary: 0.3 } },
  },
];
