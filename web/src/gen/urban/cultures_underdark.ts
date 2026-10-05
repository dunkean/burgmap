import type { Culture } from './culture';
import { MORPHOLOGIES, deepMerge } from './morphology';

/** Two-dimensional settlement plans on cavern floors; these enclosures are built fortifications, not cave walls. */
export function registerUnderdarkMorphologies(): void {
  MORPHOLOGIES['drow-enclave'] = deepMerge(MORPHOLOGIES.medina, {
    id: 'drow-enclave', streets: ['gateToGate', 'organicInfill', 'culDeSacTree'],
    curvature: 0.6, fieldNoise: 16, fieldRandom: 0.35, spineAmp: 6, deadEndRatio: 0.55,
    widthByRank: [6.5, 4.8, 3.5, 2.6, 2.2], gatePlaces: 0, crossPlaces: 0, ringGaps: 0,
    houseArea: { core: [130, 360], middle: [160, 450], edge: [200, 550], faubourg: [220, 650], village: [240, 750] },
    roomDepth: [4, 5.5], courtyardShare: [0.2, 0.28],
    coverage: { core: [0.82, 0.9], middle: [0.78, 0.87], edge: [0.68, 0.8], faubourg: [0.5, 0.65], village: [0.45, 0.62] },
    density: { core: 260, middle: 210, edge: 160, faubourg: 85, village: 70 },
    arch: { typology: 'drow-courtyard-house', roof: 'flat', storeys: [2, 3], material: 'dark-stone' },
    growth: { road: 0.35, water: 0.16, noise: 0.16, wavelength: 280, elongation: 0.1, wet: 0.5, bipolar: 0 },
  });
  MORPHOLOGIES['duergar-hold'] = deepMerge(MORPHOLOGIES.dwarven, {
    id: 'duergar-hold', streets: ['axis', 'grid'], streetOp: 'grid', contourFollow: 0.25,
    orientation: 'terrain', gridSpacing: [52, 64], gridSkew: 0.015, gatesOnly: true,
    buildingOp: 'duergarHall', curvature: 0.15, fieldNoise: 0, fieldRandom: 0,
    blockSize: { core: [1600, 3400], middle: [1800, 3800], edge: [2200, 4500], faubourg: [3000, 7000], village: [2500, 5500] },
    frontage: { core: [10, 15], middle: [10, 16], edge: [12, 18], faubourg: [14, 20], village: [14, 22] },
    plotDepth: { core: [24, 34], middle: [24, 36], edge: [26, 38], faubourg: [28, 40], village: [28, 42] },
    coverage: { core: [0.8, 0.9], middle: [0.78, 0.88], edge: [0.72, 0.84], faubourg: [0.6, 0.72], village: [0.55, 0.68] },
    density: { core: 220, middle: 205, edge: 180, faubourg: 100, village: 85 },
    arch: { typology: 'duergar-hall', roof: 'flat', storeys: [1, 2], material: 'dark-stone' },
    growth: { road: 0.45, water: 0.1, noise: 0.1, wavelength: 300, elongation: 0, wet: 0.6, bipolar: 0 },
  });
  MORPHOLOGIES['myconid-colony'] = deepMerge(MORPHOLOGIES.elven, {
    id: 'myconid-colony', buildingOp: 'fungalHouse', streets: ['radials', 'rings', 'organicInfill'],
    fieldTwist: 0.15, curvature: 0.65, fieldNoise: 16, fieldRandom: 0.15,
    widthByRank: [4.5, 3.8, 3, 2.4, 2.2], ringGaps: 1.5,
    houseArea: { core: [280, 650], middle: [350, 800], edge: [450, 1100], faubourg: [500, 1200], village: [500, 1300] },
    coverage: { core: [0.15, 0.24], middle: [0.12, 0.2], edge: [0.1, 0.18], faubourg: [0.08, 0.15], village: [0.08, 0.15] },
    density: { core: 95, middle: 80, edge: 60, faubourg: 40, village: 35 },
    arch: { typology: 'fungal-dwelling', roof: 'dome', storeys: [1, 1], material: 'fungal' },
    growth: { road: 0.25, water: 0.3, noise: 0.2, wavelength: 320, elongation: 0, wet: 0.3, bipolar: 0 },
  });
}

const quietM4 = { castle: 'none', cathedral: null, palace: null, monastery: null, marketHall: false, arena: 0, port: false, activities: false } as const;
const openCircle = { shape: 'circle', wall: 'none', fossil: 'none' } as const;
const compactFort = { shape: 'rect', wall: 'wall', fossil: 'none', towers: 'square', orientation: 'terrain', aspect: [1, 1.3] } as const;

export const UNDERDARK_CULTURES: Culture[] = [
  {
    id: 'drow-enclave', label: 'Drow enclave', fantasy: true, family: 'underdark',
    nucleus: { kind: 'precinct', builder: 'drow-sanctum', shape: 'rect', area: [1400, 4500], compound: true, ring: 4.5, orientation: 'road' },
    core: { morphology: 'drow-enclave', enclosure: { shape: 'organic', wall: 'none', fossil: 'none' } },
    ring: { morphology: 'drow-enclave', enclosure: { shape: 'organic', wall: 'none', fossil: 'street' } },
    phaseCount: [[0, 1], [4000, 2], [16000, 3]], faubourg: 'drow-enclave', faubShare: [0.06, 0.08],
    landmarks: [{ role: 'power', kind: 'drow-sanctum', place: 'near-nucleus', area: [900, 2600], minPop: 4000 }],
    village: { form: 'walled', morphology: 'drow-enclave', enclosure: { shape: 'organic', wall: 'none', fossil: 'none' },
      nucleus: { kind: 'precinct', builder: 'drow-sanctum', shape: 'rect', area: [450, 1000], compound: true, ring: 3 } },
    hamlet: { form: 'auto', morphology: 'drow-enclave' },
    m4: { ...quietM4 }, render: { towerShape: 'square', compoundWalls: true },
    sitePrefs: { flatness: 1.2, weights: { valley: 2, plain: 1.4, hilltop: 0.8, harbor: 0.2, estuary: 0.2 } },
  },
  {
    id: 'duergar-hold', label: 'Duergar industrial hold', fantasy: true, family: 'underdark',
    nucleus: { kind: 'precinct', builder: 'duergar-smeltery', shape: 'rect', area: [800, 2200], compound: true, ring: 5, orientation: 'terrain' },
    core: { morphology: 'duergar-hold', enclosure: { ...compactFort, aspect: [1, 1.3] } }, ring: null,
    phaseCount: [[0, 1]], faubourg: 'duergar-hold', faubShare: [0.04, 0.04],
    landmarks: [{ role: 'civic', kind: 'duergar-smeltery', place: 'spread', area: [500, 1700], minPop: 1200, perPop: 4500, sep: 70 }],
    village: { form: 'walled', morphology: 'duergar-hold', enclosure: { ...compactFort, aspect: [1, 1.3] },
      nucleus: { kind: 'precinct', builder: 'duergar-smeltery', shape: 'rect', area: [350, 750], compound: true, ring: 3.5 } },
    hamlet: { form: 'walled', morphology: 'duergar-hold', enclosure: { shape: 'rect', wall: 'none', fossil: 'none', orientation: 'terrain' },
      nucleus: { kind: 'none', area: [0, 0], compound: false } },
    m4: { ...quietM4 }, render: { towerShape: 'square', compoundWalls: true },
    sitePrefs: { flatness: 1.4, weights: { valley: 2, hilltop: 1, plain: 0.8, harbor: 0.1, estuary: 0.1 } },
  },
  {
    id: 'myconid-colony', label: 'Myconid colony', fantasy: true, family: 'underdark',
    nucleus: { kind: 'precinct', builder: 'myconid-circle', shape: 'circle', area: [800, 2200], compound: true, ring: 3 },
    core: { morphology: 'myconid-colony', enclosure: { ...openCircle } }, ring: null,
    phaseCount: [[0, 1]], faubourg: null, faubShare: [0, 0], landmarks: [],
    village: { form: 'walled', morphology: 'myconid-colony', enclosure: { ...openCircle },
      nucleus: { kind: 'precinct', builder: 'myconid-circle', shape: 'circle', area: [500, 1000], compound: true, ring: 2.8 } },
    hamlet: { form: 'walled', morphology: 'myconid-colony', enclosure: { ...openCircle },
      nucleus: { kind: 'precinct', builder: 'myconid-circle', shape: 'circle', area: [250, 500], compound: true, ring: 2.6 } },
    m4: { ...quietM4 }, render: { towerShape: 'round', openGround: true, plotLines: false },
    sitePrefs: { flatness: 1.6, weights: { valley: 2, plain: 1.3, bridge: 1.3, harbor: 0.2, hilltop: 0.2 } },
  },
];
