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
Object.assign(MORPHOLOGIES, M);

export const CITY_CULTURES: Culture[] = [
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
