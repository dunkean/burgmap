/**
 * More city cultures (URBAN_MORPHOLOGY.md §3b): plain data on the street engine, with their own building operators
 * and landmark plans. Inca (Cusco): kancha compounds on a terrain-adapted orthogonal grid, the great plaza with its
 * ushnu and kallankas, the temple, royal palaces, the zigzag fortress on the hill, agricultural terraces, canalized
 * streams.
 */
import type { Culture } from './culture';
import type { MorphologyParams } from './morphology';
import { MORPHOLOGIES, EO_BASE, deepMerge } from './morphology';

const morph = (id: string, base: MorphologyParams, over: Record<string, unknown>): MorphologyParams => deepMerge(base, { ...over, id });

const M: Record<string, MorphologyParams> = {};
M['inca'] = morph('inca', MORPHOLOGIES['bastide'], {
  // straight narrow streets on a grid following the valley; blocks of two to four kanchas
  streets: ['grid'], closeOp: 'none', plotOp: 'courtyard', buildingOp: 'kancha', orientation: 'terrain',
  gridSpacing: [72, 112], gridSkew: 0.02, fieldNoise: 2, gatePlaces: 0, crossPlaces: 0,
  blockSize: { core: [4000, 7500], middle: [4000, 8000], edge: [4500, 9000], faubourg: [4500, 12000], village: [4000, 10000] },
  minBlock: 1500, minWidth: 26, widthByRank: [7, 5.5, 4, 3.2, 2.6],
  houseArea: { core: [1500, 2700], middle: [1600, 2900], edge: [1700, 3100], faubourg: [1400, 2800], village: [1200, 2500] }, roomDepth: [5.5, 7],
  coverage: { core: [0.42, 0.52], middle: [0.4, 0.5], edge: [0.36, 0.46], faubourg: [0.3, 0.4], village: [0.3, 0.42] },
  footprintConformity: { core: 0, middle: 0, edge: 0, faubourg: 0, village: 0 },
  density: { core: 130, middle: 115, edge: 100, faubourg: 55, village: 45 },
  arch: { typology: 'kancha-house', roof: 'gable', storeys: [1, 2], material: 'stone' },
});
M['aztec'] = morph('aztec', MORPHOLOGIES['bastide'], {
  // a cardinal grid of lanes (every second one a canal) round the ceremonial precinct; courtyard houses of adobe
  streets: ['axis', 'grid'], closeOp: 'none', plotOp: 'courtyard', buildingOp: 'courtyardHouse', orientation: 'cardinal',
  gridSpacing: [58, 84], gridSkew: 0.01, fieldNoise: 1, gatePlaces: 0, crossPlaces: 0,
  blockSize: { core: [3000, 5500], middle: [3000, 6000], edge: [3500, 7000], faubourg: [4000, 9000], village: [4000, 9000] },
  minBlock: 1100, minWidth: 22, widthByRank: [12, 8, 5.2, 4, 3],
  houseArea: { core: [180, 420], middle: [220, 520], edge: [260, 620], faubourg: [300, 700], village: [300, 700] }, roomDepth: [4, 5.5],
  coverage: { core: [0.6, 0.72], middle: [0.52, 0.64], edge: [0.45, 0.56], faubourg: [0.38, 0.5], village: [0.35, 0.5] },
  footprintConformity: { core: 0, middle: 0, edge: 0, faubourg: 0, village: 0 },
  density: { core: 210, middle: 170, edge: 130, faubourg: 70, village: 50 },
  arch: { typology: 'calli', roof: 'flat', storeys: [1, 1], material: 'adobe' },
});
M['posad'] = morph('posad', EO_BASE, {
  // the posad: wide log-paved streets, large fenced yards (dvory), log houses on the street, gardens behind
  buildingOp: 'yardHouse', plotOp: 'burgage', deadEndRatio: 0.15, curvature: 0.45, fieldNoise: 12, gatePlaces: 0.3, crossPlaces: 0.2,
  blockSize: { core: [6000, 14000], middle: [8000, 18000], edge: [9000, 22000], faubourg: [8000, 20000], village: [9000, 24000] },
  minWidth: 30, widthByRank: [12, 9, 6, 4.2, 3],
  frontage: { core: [15, 22], middle: [16, 26], edge: [18, 30], faubourg: [18, 30], village: [20, 36] },
  plotDepth: { core: [32, 48], middle: [36, 56], edge: [40, 64], faubourg: [40, 64], village: [45, 80] },
  coverage: { core: [0.3, 0.42], middle: [0.26, 0.36], edge: [0.2, 0.3], faubourg: [0.18, 0.28], village: [0.12, 0.22] },
  footprintConformity: { core: 0, middle: 0, edge: 0, faubourg: 0, village: 0 },
  density: { core: 75, middle: 58, edge: 46, faubourg: 36, village: 26 },
  arch: { typology: 'izba', roof: 'gable', storeys: [1, 2], material: 'wood' },
});
M['necropolis'] = morph('necropolis', MORPHOLOGIES['bastide'], {
  // the city of the dead: a cardinal grid of tomb lots off a processional avenue
  streets: ['axis', 'grid'], closeOp: 'none', plotOp: 'courtyard', buildingOp: 'tomb', orientation: 'cardinal',
  gridSpacing: [40, 58], gridSkew: 0, fieldNoise: 0, gatePlaces: 0, crossPlaces: 0,
  blockSize: { core: [1400, 2600], middle: [1400, 2800], edge: [1600, 3200], faubourg: [2000, 4000], village: [1400, 3000] },
  minBlock: 500, minWidth: 16, widthByRank: [14, 6.5, 4.2, 3, 2.5],
  houseArea: { core: [70, 260], middle: [60, 240], edge: [50, 220], faubourg: [50, 200], village: [50, 220] }, roomDepth: [4, 5],
  coverage: { core: [0.3, 0.4], middle: [0.28, 0.38], edge: [0.25, 0.35], faubourg: [0.2, 0.3], village: [0.25, 0.35] },
  footprintConformity: { core: 0, middle: 0, edge: 0, faubourg: 0, village: 0 },
  density: { core: 260, middle: 240, edge: 220, faubourg: 120, village: 200 },
  arch: { typology: 'mausoleum', roof: 'hip', storeys: [1, 1], material: 'stone' },
});
Object.assign(MORPHOLOGIES, M);

export const CITY_CULTURES: Culture[] = [
  {
    id: 'necropolis', label: 'Necropolis (city of the dead)', fantasy: true,
    nucleus: { kind: 'mortuary', shape: 'rect', area: [4000, 30000], compound: true, ring: 14, orientation: 'cardinal' },
    core: { morphology: 'necropolis', enclosure: { shape: 'rect', wall: 'wall', fossil: 'street', towers: 'square', gates: 'cardinal', orientation: 'cardinal', aspect: [1.2, 1.5] } },
    ring: { morphology: 'necropolis', enclosure: { shape: 'rect', wall: 'wall', fossil: 'street', towers: 'square', gates: 'cardinal', orientation: 'cardinal' } },
    phaseCount: [[0, 1], [12000, 2]],
    faubourg: null, faubShare: [0.02, 0.02],
    landmarks: [
      { role: 'civic', kind: 'charnel-house', place: 'edge', area: [1500, 6000], minPop: 600, count: 2, sep: 200 },
    ],
    village: {
      form: 'walled', morphology: 'necropolis', enclosure: { shape: 'rect', wall: 'wall', fossil: 'none', towers: 'square', orientation: 'cardinal' },
      nucleus: { kind: 'mortuary', shape: 'rect', area: [1500, 3000], compound: true, ring: 8, orientation: 'cardinal' },
    },
    hamlet: { form: 'walled', morphology: 'necropolis', enclosure: { shape: 'rect', wall: 'none', fossil: 'none', orientation: 'cardinal' } },
    m4: { castle: 'none', cathedral: null, palace: null, monastery: null, marketHall: false, arena: 0, port: false, activities: false },
    render: { towerShape: 'square', graves: true },
    scale: { min: 'hamlet', max: 'city' },
    sitePrefs: { flatness: 1.2, weights: { hilltop: 1.5, valley: 1.2, plain: 1, harbor: 0.2 } },
  },
  {
    id: 'russian-kremlin', label: 'Russian kremlin and posad',
    nucleus: { kind: 'market', shape: 'hull', area: 'market', compound: false, ring: 7 },
    core: { morphology: 'posad', enclosure: { shape: 'organic', wall: 'palisade', fossil: 'street', towers: 'square' } },
    ring: { morphology: 'posad', enclosure: { shape: 'organic', wall: 'palisade', fossil: 'street', towers: 'square' } },
    phaseCount: [[0, 1], [7000, 2], [25000, 3]],
    faubourg: 'posad', faubShare: [0.25, 0.2],
    landmarks: [
      { role: 'worship', kind: 'orthodox-church', place: 'adjacent-nucleus', area: [700, 3500], minPop: 200 },
      { role: 'extra', kind: 'orthodox-church', place: 'spread', area: [500, 3000], minPop: 1500, perPop: 1300, sep: 170 },
    ],
    // (villages are open: a street of yards, the wooden church)
    village: { form: 'auto', morphology: 'posad', enclosure: { wall: 'none' } },
    hamlet: { form: 'auto', morphology: 'posad' },
    m4: { castle: 'kremlin', cathedral: null, palace: null, monastery: 'monastery', marketHall: false, arena: 0, shanty: 'zone' },
    render: { towerShape: 'square', compoundWalls: true },
    sitePrefs: { weights: { confluence: 3, meander: 1.6, bridge: 1.5, hilltop: 1.2, plain: 0.5, harbor: 0.5 } },
  },
  {
    id: 'aztec', label: 'Aztec city (Tenochtitlan)',
    nucleus: { kind: 'precinct', shape: 'square', area: [7000, 90000], compound: true, ring: 12, orientation: 'cardinal' },
    core: { morphology: 'aztec', enclosure: { shape: 'square', wall: 'none', fossil: 'street', orientation: 'cardinal', gates: 'cardinal', aspect: [1, 1.15] } },
    ring: { morphology: 'aztec', enclosure: { shape: 'square', wall: 'none', fossil: 'none', orientation: 'cardinal', gates: 'cardinal' } },
    phaseCount: [[0, 1], [9000, 2]],
    faubourg: 'aztec', faubShare: [0.08, 0.08],
    landmarks: [
      { role: 'power', kind: 'tecpan', place: 'adjacent-nucleus', area: [5000, 16000], minPop: 3000 },
      { role: 'market', kind: 'tianguis', place: 'near-nucleus', area: [6000, 22000], minPop: 6000 },
      { role: 'extra', kind: 'calpulli-temple', place: 'spread', area: [900, 4500], minPop: 1200, perPop: 3500, sep: 240 },
    ],
    village: {
      form: 'walled', morphology: 'aztec', enclosure: { shape: 'square', wall: 'none', fossil: 'none', orientation: 'cardinal' },
      nucleus: { kind: 'precinct', shape: 'square', area: [1800, 4000], compound: true, ring: 8, orientation: 'cardinal' },
    },
    hamlet: { form: 'auto', morphology: 'aztec' },
    m4: { castle: 'none', cathedral: null, palace: null, monastery: null, marketHall: false, arena: 0, shanty: 'riverbank', port: false, activities: false },
    render: { towerShape: 'square', streetCanals: true, chinampas: true, plotLines: true },
    scale: { min: 'hamlet', max: 'metropolis' },
    sitePrefs: { flatness: 2.2, weights: { harbor: 2.2, estuary: 2.2, plain: 1.6, bridge: 1.2, hilltop: 0, valley: 0.6 } },
  },
  {
    id: 'inca', label: 'Inca city (Cusco)',
    nucleus: { kind: 'ushnu', shape: 'rect', area: [9000, 30000], compound: true, ring: 6, orientation: 'terrain' },
    core: { morphology: 'inca', enclosure: { shape: 'rect', wall: 'none', fossil: 'street', orientation: 'terrain', aspect: [1.4, 1.9] } },
    ring: { morphology: 'inca', enclosure: { shape: 'organic', wall: 'none', fossil: 'none' } },
    phaseCount: [[0, 1], [9000, 2]],
    faubourg: 'inca', faubShare: [0.12, 0.12],
    landmarks: [
      { role: 'worship', kind: 'inca-temple', place: 'near-nucleus', area: [5000, 14000], minPop: 1200 },
      { role: 'power', kind: 'inca-palace', place: 'adjacent-nucleus', area: [6000, 18000], minPop: 3000, count: 2, sep: 120 },
    ],
    village: {
      form: 'walled', morphology: 'inca', enclosure: { shape: 'rect', wall: 'none', fossil: 'none', orientation: 'terrain' },
      nucleus: { kind: 'ushnu', shape: 'rect', area: [2500, 5000], compound: true, ring: 5, orientation: 'terrain' },
    },
    hamlet: { form: 'auto', morphology: 'inca' },
    m4: { castle: 'inca-fortress', cathedral: null, palace: null, monastery: null, marketHall: false, arena: 0, shanty: 'gecekondu', port: false, activities: false },
    render: { towerShape: 'square', compoundWalls: true, andenes: true, canals: true },
    scale: { min: 'hamlet', max: 'city' },
    sitePrefs: { flatness: 0.7, hillSide: 'N', weights: { valley: 2.5, confluence: 1.5, hilltop: 0.6, plain: 0.6, harbor: 0, estuary: 0 } },
  },
];
