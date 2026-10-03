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
// ---------------------------------------------------------------- Ottoman town
M['ottoman'] = morph('ottoman', EO_BASE, {
  // the mahalle: winding streets and many dead ends (cikmaz) following the slope, wooden houses with gardens
  streets: ['radials', 'organicInfill', 'closes'], buildingOp: 'konak', contourBlend: 0.6, extraRadials: true, curvature: 0.8, fieldNoise: 24, fieldRandom: 0.55,
  gatePlaces: 0.15, crossPlaces: 0.2, ringGaps: 3, deadEndRatio: 0.6, slitDepth: 0.6, placeThreshold: 500,
  blockSize: { core: [2500, 7000], middle: [3500, 10000], edge: [4500, 13000], faubourg: [4500, 13000], village: [7000, 20000] },
  minWidth: 18, widthByRank: [6.5, 5, 3.6, 2.8, 2.3],
  frontage: { core: [8, 13], middle: [9, 15], edge: [10, 17], faubourg: [10, 18], village: [16, 32] },
  plotDepth: { core: [18, 30], middle: [22, 36], edge: [24, 42], faubourg: [24, 42], village: [30, 55] },
  coverage: { core: [0.55, 0.68], middle: [0.45, 0.58], edge: [0.38, 0.5], faubourg: [0.32, 0.45], village: [0.15, 0.3] },
  density: { core: 150, middle: 110, edge: 85, faubourg: 55, village: 32 },
  arch: { typology: 'ottoman-wooden-house', roof: 'tiled-hip', storeys: [2, 3], material: 'wood' },
});
M['ottoman-carsi'] = morph('ottoman-carsi', MORPHOLOGIES['medina-souk'], {
  // the carsi: rows of small shops (dukkan) along the market streets round the bedesten and the hans
  streets: ['radials', 'organicInfill'], widthByRank: [6.5, 5, 3.4, 2.6, 2.2], fieldRandom: 0.4,
  arch: { typology: 'dukkan-shop', roof: 'tiled-hip', storeys: [1, 2], material: 'wood' },
});
// ---------------------------------------------------------------- Sahelian town
M['sahel'] = morph('sahel', EO_BASE, {
  // sand lanes of uneven width, widening into irregular open spaces; walled compounds round their courts
  streets: ['radials', 'organicInfill', 'closes'], buildingOp: 'sahelCompound', extraRadials: true, curvature: 0.9, fieldNoise: 30, fieldRandom: 0.75,
  gatePlaces: 0.6, crossPlaces: 0.6, ringGaps: 4, deadEndRatio: 0.45, placeThreshold: 2600, widthJitter: 0.45,
  blockSize: { core: [2200, 6500], middle: [3000, 9000], edge: [4000, 12000], faubourg: [4000, 12000], village: [5000, 16000] },
  minWidth: 18, widthByRank: [9, 7, 5, 3.6, 3],
  frontage: { core: [10, 16], middle: [12, 18], edge: [13, 21], faubourg: [14, 22], village: [16, 28] },
  plotDepth: { core: [14, 22], middle: [16, 26], edge: [18, 28], faubourg: [18, 30], village: [20, 34] },
  coverage: { core: [0.62, 0.74], middle: [0.5, 0.62], edge: [0.4, 0.52], faubourg: [0.32, 0.45], village: [0.25, 0.4] },
  footprintConformity: { core: 0, middle: 0, edge: 0, faubourg: 0, village: 0 },
  density: { core: 210, middle: 160, edge: 120, faubourg: 70, village: 45 },
  arch: { typology: 'sudano-sahelian-house', roof: 'flat', storeys: [1, 2], material: 'mud' },
});
M['sahel-town'] = morph('sahel-town', MORPHOLOGIES['medina'], {
  // the old town (Djenne): two-storey mud houses round their courts, wall to wall along the sand lanes
  streets: ['radials', 'organicInfill', 'culDeSacTree'], curvature: 0.85, fieldNoise: 28, fieldRandom: 0.7, deadEndRatio: 0.55,
  placeThreshold: 1600, widthJitter: 0.4, widthByRank: [8, 6, 4.2, 3.2, 2.6], gatePlaces: 0.5, crossPlaces: 0.5,
  blockSize: { core: [2500, 7000], middle: [4000, 12000], edge: [5000, 14000], faubourg: [5000, 14000], village: [5000, 14000] },
  houseArea: { core: [140, 380], middle: [180, 460], edge: [220, 560], faubourg: [220, 560], village: [250, 600] }, roomDepth: [3.6, 5],
  coverage: { core: [0.84, 0.92], middle: [0.8, 0.88], edge: [0.72, 0.82], faubourg: [0.6, 0.72], village: [0.5, 0.65] },
  density: { core: 240, middle: 190, edge: 140, faubourg: 80, village: 50 },
  arch: { typology: 'sudano-sahelian-house', roof: 'flat', storeys: [1, 2], material: 'mud' },
});
// ---------------------------------------------------------------- Hanseatic town
M['hanseatic'] = morph('hanseatic', MORPHOLOGIES['bastide'], {
  // ribs: streets straight down the slope to the harbour every ~75 m, long streets along the ridge every ~220 m
  streets: ['radials', 'grid'], closeOp: 'none', buildingOp: 'giebelhaus', orientation: 'water',
  gridSpacing: [76, 220], gridSkew: 0.07, fieldNoise: 3, curvature: 0.12,
  growth: { road: 0.12, water: 0.5, noise: 0.16, wavelength: 360, elongation: 0.15, wet: 0.4, bipolar: 0 },
  blockSize: { core: [6000, 16000], middle: [6000, 17000], edge: [7000, 18000], faubourg: [5000, 14000], village: [7000, 20000] },
  minBlock: 900, minWidth: 26, widthByRank: [9, 7.5, 5.5, 3.4, 2.5], gatePlaces: 0.2, crossPlaces: 0,
  frontage: { core: [5.5, 8], middle: [6, 8.5], edge: [6.5, 10], faubourg: [7, 12], village: [16, 32] },
  plotDepth: { core: [28, 40], middle: [28, 42], edge: [30, 46], faubourg: [26, 44], village: [36, 60] },
  coverage: { core: [0.82, 0.92], middle: [0.74, 0.85], edge: [0.62, 0.74], faubourg: [0.45, 0.6], village: [0.15, 0.3] },
  wideLotChance: 0.1, deepFill: true, plotTilt: 1,
  density: { core: 190, middle: 160, edge: 120, faubourg: 60, village: 35 },
  arch: { typology: 'giebelhaus', roof: 'gable', storeys: [3, 5], material: 'brick' },
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
  {
    id: 'ottoman', label: 'Ottoman town (Bursa)',
    nucleus: { kind: 'market', shape: 'hull', area: [800, 3500], compound: false, ring: 5 },
    core: { morphology: 'ottoman-carsi', share: 0.08, enclosure: { shape: 'organic', wall: 'none', fossil: 'none' } },
    ring: { morphology: 'ottoman', enclosure: { shape: 'organic', wall: 'none', fossil: 'none' } },
    phaseCount: [[0, 2], [7000, 3]],
    faubourg: 'ottoman', faubShare: [0.12, 0.12],
    landmarks: [
      { role: 'worship', kind: 'ulu-cami', place: 'adjacent-nucleus', area: [1500, 7000], minPop: 2500 },
      { role: 'market', kind: 'bedesten', place: 'near-nucleus', area: [700, 2500], minPop: 3000 },
      { role: 'extra', kind: 'caravanserai', place: 'near-nucleus', area: [1200, 4500], minPop: 3000, count: 1 },
      // (a mahalle every ~600 inhabitants, each round its mescit)
      { role: 'civic', kind: 'mescit', place: 'spread', area: [300, 2200], minPop: 150, perPop: 600, sep: 110 },
      { role: 'power', kind: 'kulliye', place: 'edge', area: [7000, 30000], minPop: 4000, count: 1, sep: 400 },
      { role: 'extra', kind: 'hammam', place: 'near-nucleus', area: [500, 3000], minPop: 1500 },
    ],
    village: { form: 'auto', morphology: 'ottoman' },
    hamlet: { form: 'auto', morphology: 'ottoman' },
    m4: { castle: 'castle', cathedral: null, palace: null, monastery: null, marketHall: false, arena: 0, shanty: 'gecekondu', activities: false },
    render: { towerShape: 'round' },
    scale: { min: 'hamlet', max: 'metropolis' },
    sitePrefs: { flatness: 0.8, hillSide: 'S', weights: { valley: 2, hilltop: 1.2, bridge: 1.4, plain: 1, harbor: 1.2 } },
  },
  {
    id: 'sahel', label: 'Sahelian mud town (Djenne)',
    nucleus: { kind: 'mud-mosque', shape: 'rect', area: [4500, 16000], compound: true, ring: 8, orientation: 'cardinal' },
    core: { morphology: 'sahel-town', enclosure: { shape: 'organic', wall: 'none', fossil: 'none' } },
    ring: { morphology: 'sahel', enclosure: { shape: 'organic', wall: 'none', fossil: 'none' } },
    phaseCount: [[0, 1], [2500, 2], [12000, 3]],
    faubourg: 'sahel', faubShare: [0.1, 0.1],
    landmarks: [
      { role: 'power', kind: 'sahel-palace', place: 'near-nucleus', area: [1800, 6000], minPop: 2000 },
      { role: 'worship', kind: 'sahel-mosque', place: 'spread', area: [900, 4000], minPop: 3000, perPop: 5000, sep: 300 },
    ],
    village: {
      form: 'walled', morphology: 'sahel', enclosure: { shape: 'organic', wall: 'none', fossil: 'none' },
      nucleus: { kind: 'mud-mosque', shape: 'rect', area: [1200, 2500], compound: true, ring: 6, orientation: 'cardinal' },
    },
    hamlet: { form: 'auto', morphology: 'sahel' },
    m4: { castle: 'none', cathedral: null, palace: null, monastery: null, marketHall: false, arena: 0, shanty: 'bidonville', activities: false },
    render: { towerShape: 'square', compoundWalls: true },
    scale: { min: 'hamlet', max: 'city' },
    sitePrefs: { flatness: 2, weights: { meander: 2, confluence: 2, bridge: 1.6, plain: 1.6, estuary: 1, harbor: 0.6, hilltop: 0, valley: 0.5 } },
  },
  {
    id: 'hanseatic', label: 'Hanseatic port (Lubeck)',
    nucleus: { kind: 'market', shape: 'rect', area: [2500, 9000], compound: false, ring: 7, orientation: 'water' },
    core: { morphology: 'hanseatic', enclosure: { shape: 'organic', wall: 'auto', fossil: 'street', towers: 'square' } },
    ring: { morphology: 'hanseatic', enclosure: { shape: 'organic', wall: 'auto', fossil: 'street', towers: 'square' } },
    phaseCount: [[0, 1], [9000, 2]],
    faubourg: 'european-organic', faubShare: [0.1, 0.08],
    landmarks: [
      { role: 'worship', kind: 'hall-church', place: 'adjacent-nucleus', area: [2500, 12000], minPop: 1500 },
      { role: 'civic', kind: 'rathaus', place: 'adjacent-nucleus', area: [1200, 6000], minPop: 2500 },
      { role: 'extra', kind: 'hall-church', place: 'spread', area: [2000, 9000], minPop: 6000, perPop: 5000, sep: 350 },
    ],
    village: { form: 'auto', morphology: 'hanseatic' },
    hamlet: { form: 'auto' },
    m4: { castle: 'none', cathedral: null, palace: null, monastery: 'monastery', marketHall: false, arena: 0, shanty: 'zone' },
    render: { towerShape: 'square' },
    scale: { min: 'hamlet', max: 'metropolis' },
    sitePrefs: { flatness: 1.2, weights: { harbor: 3, estuary: 3, bridge: 1.2, confluence: 1.2, plain: 0.8, hilltop: 0.4, valley: 0.5 } },
  },
];
