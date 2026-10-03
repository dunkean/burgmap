/**
 * More city cultures (URBAN_MORPHOLOGY.md §3b): plain data on the street engine, with their own building operators
 * and landmark plans. Inca (Cusco): kancha compounds on a terrain-adapted orthogonal grid, the great plaza with its
 * ushnu and kallankas, the temple, royal palaces, the zigzag fortress on the hill, agricultural terraces, canalized
 * streams.
 */
import type { Culture } from './culture';
import type { MorphologyParams } from './morphology';
import { MORPHOLOGIES, deepMerge } from './morphology';

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
Object.assign(MORPHOLOGIES, M);

export const CITY_CULTURES: Culture[] = [
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
