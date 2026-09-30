/**
 * Culture presets (URBAN_MORPHOLOGY.md §3, §3b, §3c) as plain data, and the morphologies they use. Everything here
 * is JSON-serializable: operators are referenced by id and implemented in the urban modules.
 */
import type { Culture } from './culture';
import type { MorphologyParams } from './morphology';
import { MORPHOLOGIES, EO_BASE, deepMerge } from './morphology';

const EO = EO_BASE;
const morph = (id: string, base: MorphologyParams, over: Record<string, unknown>): MorphologyParams => deepMerge(base, { ...over, id });

// ---------------------------------------------------------------- morphologies
const M: Record<string, MorphologyParams> = {};
M['bastide'] = MORPHOLOGIES['bastide'];

M['roman-castrum'] = morph('roman-castrum', MORPHOLOGIES['bastide'], {
  streets: ['axis', 'grid', 'closes'], closeOp: 'none', plotOp: 'courtyard', buildingOp: 'courtyardHouse',
  gridSpacing: [72, 72], gridSkew: 0.01, blockSize: { core: [3500, 6000], middle: [3500, 6000], edge: [3500, 6000] },
  widthByRank: [9, 7, 4.5, 3.5, 2.5], houseArea: { core: [250, 700], middle: [250, 700], edge: [300, 800] }, roomDepth: [5, 7],
  coverage: { core: [0.82, 0.92], middle: [0.8, 0.9], edge: [0.75, 0.85] }, footprintConformity: { core: 0.3, middle: 0.3, edge: 0.3 },
  density: { core: 160, middle: 150, edge: 130 },
  arch: { typology: 'domus', roof: 'tiled-hip', storeys: [1, 2], material: 'brick' },
});

M['medina'] = morph('medina', EO, {
  streets: ['gateToGate', 'extraRadials', 'organicInfill', 'culDeSacTree'], closeOp: 'culDeSacTree', plotOp: 'courtyard', buildingOp: 'courtyardHouse',
  curvature: 0.95, fieldNoise: 32, fieldWavelength: 110, fieldRandom: 0.65, spineAmp: 12,
  blockSize: { core: [3000, 9000], middle: [7000, 22000], edge: [9000, 26000], faubourg: [6000, 16000], village: [6000, 16000] },
  minBlock: 900, minWidth: 22, widthByRank: [6, 4.4, 3.2, 2.4, 2.2], widthJitter: 0.3, placeThreshold: 250, deadEndRatio: 0.9,
  houseArea: { core: [70, 240], middle: [90, 320], edge: [110, 420], faubourg: [120, 450], village: [150, 500] }, roomDepth: [3.5, 5],
  accessDepth: 19, ringGaps: 0,
  coverage: { core: [0.9, 0.97], middle: [0.88, 0.95], edge: [0.82, 0.92], faubourg: [0.6, 0.75], village: [0.5, 0.7] },
  footprintConformity: { core: 0.97, middle: 0.95, edge: 0.95, faubourg: 0.9, village: 0.9 },
  density: { core: 330, middle: 250, edge: 190, faubourg: 90, village: 60 },
  arch: { typology: 'courtyard-house', roof: 'flat', storeys: [1, 3], material: 'mud' },
});
M['medina-souk'] = morph('medina-souk', M['medina'], {
  closeOp: 'none', plotOp: 'burgage', buildingOp: 'streetFrontRow',
  blockSize: { core: [900, 2600], middle: [900, 2600] }, minBlock: 350, minWidth: 14, widthByRank: [5, 3.8, 3, 2.4, 2.2], fieldRandom: 0.3,
  frontage: { core: [2.8, 4.5], middle: [3, 5] }, plotDepth: { core: [5, 8], middle: [5, 9] }, buildDepth: { core: [5, 8], middle: [5, 8] },
  coverage: { core: [0.93, 0.98], middle: [0.9, 0.97] }, bigCourtChance: 0.6,
  arch: { typology: 'souk-shop', roof: 'flat', storeys: [1, 1], material: 'mud' },
});

M['chinese'] = morph('chinese', MORPHOLOGIES['bastide'], {
  streets: ['axis', 'grid', 'wardWalls'], closeOp: 'none', plotOp: 'siheyuan', buildingOp: 'pavilionCompound', orientation: 'cardinal',
  gridSpacing: [230, 230], laneSpacing: [0, 58], wardArea: 26000, gridSkew: 0,
  blockSize: { core: [9000, 16000], middle: [9000, 16000], edge: [9000, 16000], faubourg: [4500, 14000] },
  minBlock: 1500, minWidth: 22, widthByRank: [14, 10, 7, 4.5, 3],
  frontage: { core: [14, 22], middle: [14, 22], edge: [15, 24] }, plotDepth: { core: [22, 34], middle: [22, 34], edge: [24, 36] }, plotTilt: 0,
  coverage: { core: [0.5, 0.62], middle: [0.5, 0.62], edge: [0.45, 0.58] }, footprintConformity: { core: 0.1, middle: 0.1, edge: 0.1, faubourg: 0.3 },
  density: { core: 170, middle: 160, edge: 140, faubourg: 60 },
  arch: { typology: 'siheyuan-hall', roof: 'tiled-hip', storeys: [1, 1], material: 'brick' },
});

M['jp-samurai'] = morph('jp-samurai', EO, {
  streets: ['radials', 'defensiveKinks', 'organicInfill'], closeOp: 'none', plotOp: 'compound', buildingOp: 'yashiki', extraRadials: false,
  curvature: 0.3, fieldNoise: 8, fieldRandom: 0.1, kinks: 2, ringGaps: 0,
  blockSize: { core: [8000, 20000], middle: [8000, 20000], edge: [9000, 22000] }, minWidth: 30,
  houseArea: { core: [900, 2600], middle: [900, 2600], edge: [1000, 3000] },
  coverage: { core: [0.25, 0.35], middle: [0.25, 0.35], edge: [0.22, 0.32] }, footprintConformity: { core: 0.1, middle: 0.1, edge: 0.1 },
  density: { core: 70, middle: 70, edge: 60 },
  arch: { typology: 'yashiki', roof: 'tiled-hip', storeys: [1, 1], material: 'wood' },
});
M['jp-merchant'] = morph('jp-merchant', MORPHOLOGIES['bastide'], {
  streets: ['radials', 'defensiveKinks', 'grid'], closeOp: 'none', plotOp: 'machiya', buildingOp: 'machiya', kinks: 1,
  gridSpacing: [120, 120], gridSkew: 0.02, blockSize: { core: [9000, 15000], middle: [9000, 15000], edge: [9000, 15000], faubourg: [4000, 12000] },
  minWidth: 30, widthByRank: [9, 7, 5.5, 3.6, 2.5],
  frontage: { core: [4.5, 7], middle: [4.5, 7.5], edge: [5, 8], faubourg: [6, 10] }, plotDepth: { core: [22, 34], middle: [22, 36], edge: [24, 38] },
  coverage: { core: [0.72, 0.82], middle: [0.7, 0.8], edge: [0.62, 0.74] }, footprintConformity: { core: 0.5, middle: 0.5, edge: 0.5 },
  density: { core: 190, middle: 180, edge: 150 },
  arch: { typology: 'machiya', roof: 'gable', storeys: [2, 2], material: 'wood' },
});

M['indian-temple'] = morph('indian-temple', MORPHOLOGIES['bastide'], {
  streets: ['axis', 'rings', 'grid'], closeOp: 'none', plotOp: 'burgage', buildingOp: 'streetFrontRow', orientation: 'cardinal',
  gridSpacing: [95, 48], gridSkew: 0.0, blockSize: { core: [3000, 7000], middle: [3500, 8000], edge: [4000, 9000], faubourg: [4000, 12000] },
  widthByRank: [12, 9, 5, 3.4, 2.5], ringGaps: 0,
  frontage: { core: [5, 8], middle: [6, 9], edge: [7, 11] }, plotDepth: { core: [18, 26], middle: [20, 28], edge: [22, 32] },
  coverage: { core: [0.8, 0.9], middle: [0.72, 0.82], edge: [0.58, 0.7] }, footprintConformity: { core: 0.4, middle: 0.4, edge: 0.4 },
  bigCourtChance: 0.35, density: { core: 190, middle: 160, edge: 120 },
  arch: { typology: 'row-house-mutram', roof: 'tiled-hip', storeys: [1, 2], material: 'brick' },
});

M['elven'] = morph('elven', EO, {
  streets: ['spiral', 'rings', 'organicInfill'], closeOp: 'none', plotOp: 'compound', buildingOp: 'treeHouse', extraRadials: false,
  curvature: 1.2, fieldNoise: 25, fieldWavelength: 120, fieldRandom: 0.25, fieldTwist: 0.6, ringGaps: 1.2,
  blockSize: { core: [9000, 22000], middle: [12000, 30000], edge: [15000, 35000], faubourg: [12000, 30000], village: [15000, 40000] },
  minWidth: 34, widthByRank: [4, 3.4, 2.8, 2.2, 2], widthJitter: 0.25, placeThreshold: 1500,
  houseArea: { core: [500, 1400], middle: [700, 1800], edge: [900, 2400], faubourg: [900, 2400], village: [1000, 2800] },
  coverage: { core: [0.1, 0.18], middle: [0.08, 0.15], edge: [0.06, 0.12], faubourg: [0.06, 0.12], village: [0.05, 0.1] },
  density: { core: 45, middle: 35, edge: 28, faubourg: 25, village: 20 },
  arch: { typology: 'tree-house', roof: 'dome', storeys: [1, 3], material: 'living-wood' },
});

M['dwarven'] = morph('dwarven', MORPHOLOGIES['bastide'], {
  streets: ['switchbacks', 'grid'], closeOp: 'none', plotOp: 'burgage', buildingOp: 'hall', orientation: 'road',
  gridSpacing: [64, 1000], gridSkew: 0, blockSize: { core: [1200, 3500], middle: [1200, 3500], edge: [1200, 3500], faubourg: [3000, 9000] },
  minBlock: 400, minWidth: 14, widthByRank: [9, 7, 4, 3, 2.5],
  frontage: { core: [14, 24], middle: [14, 24], edge: [14, 24] }, plotDepth: { core: [16, 30], middle: [16, 30], edge: [16, 30] },
  coverage: { core: [0.78, 0.88], middle: [0.75, 0.85], edge: [0.7, 0.8] }, footprintConformity: { core: 0, middle: 0, edge: 0 }, cornerFill: { core: 0, middle: 0, edge: 0 },
  density: { core: 170, middle: 170, edge: 170 },
  arch: { typology: 'stone-hall', roof: 'flat', storeys: [1, 2], material: 'rock' },
});

Object.assign(MORPHOLOGIES, M);

// ---------------------------------------------------------------- cultures
const walledEO = { shape: 'organic', wall: 'auto', fossil: 'street', towers: 'round' } as const;

export const CULTURE_LIST: Culture[] = [
  {
    id: 'european-organic', label: 'Medieval organic (Europe)',
    nucleus: { kind: 'market', shape: 'hull', area: 'market', compound: false, ring: 4.6 },
    core: { morphology: 'european-organic', enclosure: { ...walledEO } },
    ring: { morphology: 'european-organic', enclosure: { ...walledEO } },
    phaseCount: [[0, 2], [5000, 3], [20000, 4]],
    faubourg: 'european-organic', faubShare: [0.17, 0.1],
    landmarks: [{ role: 'worship', kind: 'church', place: 'adjacent-nucleus', area: [700, 12000], minPop: 200 }],
    village: { form: 'auto' }, hamlet: { form: 'auto' },
    render: { towerShape: 'round' },
  },
  {
    id: 'bastide', label: 'Bastide (planned grid)',
    nucleus: { kind: 'market', shape: 'rect', area: 'market', compound: false, ring: 5 },
    core: { morphology: 'bastide', enclosure: { shape: 'rect', wall: 'auto', fossil: 'street', towers: 'round', orientation: 'road', aspect: [1.25, 1.6] } },
    ring: null,
    phaseCount: [[0, 1]],
    faubourg: 'european-organic', faubShare: [0.17, 0.1],
    landmarks: [{ role: 'worship', kind: 'church', place: 'adjacent-nucleus', area: [700, 9000], minPop: 200 }],
    village: { form: 'auto' }, hamlet: { form: 'auto' },
    render: { towerShape: 'round' },
  },
];
