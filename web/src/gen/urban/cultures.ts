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

MORPHOLOGIES['bastide'].gatePlaces = 0.5;
MORPHOLOGIES['bastide'].crossPlaces = 0;
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
  gridSpacing: [240, 240], laneSpacing: [58, 125], wardArea: 26000, gridSkew: 0, fieldNoise: 0,
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
  gridSkew: 0.0, blockSize: { core: [3000, 7000], middle: [3500, 8000], edge: [4000, 9000], faubourg: [4000, 12000] },
  widthByRank: [12, 8.5, 3.6, 3, 2.5], ringGaps: 0, gridSpacing: [88, 88], ringSpacing: 64,
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
  houseArea: { core: [320, 800], middle: [400, 1000], edge: [500, 1300], faubourg: [500, 1300], village: [600, 1600] },
  coverage: { core: [0.1, 0.18], middle: [0.08, 0.15], edge: [0.06, 0.12], faubourg: [0.06, 0.12], village: [0.05, 0.1] },
  density: { core: 90, middle: 75, edge: 60, faubourg: 40, village: 35 },
  arch: { typology: 'tree-house', roof: 'dome', storeys: [1, 3], material: 'living-wood' },
});

M['dwarven'] = morph('dwarven', MORPHOLOGIES['bastide'], {
  streets: ['switchbacks', 'grid'], closeOp: 'none', plotOp: 'burgage', buildingOp: 'hall', orientation: 'terrain', gatesOnly: true,
  gridSpacing: [46, 150], gridSkew: 0, fieldNoise: 0, blockSize: { core: [1200, 3500], middle: [1200, 3500], edge: [1200, 3500], faubourg: [3000, 9000] },
  minBlock: 400, minWidth: 14, widthByRank: [9, 7, 4, 3, 2.5],
  frontage: { core: [14, 24], middle: [14, 24], edge: [14, 24] }, plotDepth: { core: [16, 30], middle: [16, 30], edge: [16, 30] },
  coverage: { core: [0.78, 0.88], middle: [0.75, 0.85], edge: [0.7, 0.8] }, footprintConformity: { core: 0, middle: 0, edge: 0 }, cornerFill: { core: 0, middle: 0, edge: 0 },
  density: { core: 170, middle: 170, edge: 170 },
  arch: { typology: 'stone-hall', roof: 'flat', storeys: [1, 2], material: 'rock' },
});

M['chinese-suburb'] = morph('chinese-suburb', EO, {
  streets: ['radials', 'organicInfill'], plotOp: 'siheyuan', buildingOp: 'pavilionCompound', extraRadials: false,
  frontage: { faubourg: [14, 22], village: [22, 40] }, plotDepth: { faubourg: [22, 34], village: [30, 50] },
  coverage: { faubourg: [0.4, 0.55], village: [0.2, 0.35] }, arch: { typology: 'siheyuan-hall', roof: 'tiled-hip', storeys: [1, 1], material: 'brick' },
});

for (const [k, m] of Object.entries(M)) if (k !== 'bastide') { m.gatePlaces = 0; m.crossPlaces = 0; }
M['roman-castrum'].gatePlaces = 0.4;
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
    landmarks: [
      { role: 'worship', kind: 'church', place: 'adjacent-nucleus', area: [700, 12000], minPop: 200 },
      // parish churches, one per ~2,200 inhabitants beyond the main church, spread across the quarters
      { role: 'extra', kind: 'parish-church', place: 'spread', area: [900, 6000], minPop: 3500, perPop: 2200, sep: 220 },
    ],
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
    landmarks: [
      { role: 'worship', kind: 'church', place: 'adjacent-nucleus', area: [700, 9000], minPop: 200 },
      { role: 'extra', kind: 'parish-church', place: 'spread', area: [900, 6000], minPop: 5000, perPop: 2800, sep: 200 },
    ],
    village: { form: 'auto' }, hamlet: { form: 'auto' },
    m4: { castle: 'castle', cathedral: null, palace: null, monastery: 'monastery', arena: 0 },
    render: { towerShape: 'round' },
  },
  {
    id: 'medina', label: 'Medina (North Africa)',
    nucleus: { kind: 'mosque', shape: 'rect', area: [3200, 9000], compound: true, ring: 3.2, orientation: 'qibla' },
    core: { morphology: 'medina-souk', share: 0.1, enclosure: { shape: 'organic', wall: 'wall', fossil: 'none', towers: 'square' } },
    ring: { morphology: 'medina', enclosure: { shape: 'organic', wall: 'wall', fossil: 'none', towers: 'square' } },
    phaseCount: [[0, 2], [9000, 3]],
    faubourg: 'medina', faubShare: [0.04, 0.06],
    landmarks: [
      { role: 'power', kind: 'kasbah', place: 'edge', area: [8000, 30000], minPop: 1500 },
      { role: 'extra', kind: 'hammam', place: 'near-nucleus', area: [500, 3000], minPop: 2000 },
    ],
    village: {
      form: 'walled', morphology: 'medina', enclosure: { shape: 'rect', wall: 'wall', fossil: 'none', towers: 'square', orientation: 'road' },
      nucleus: { kind: 'mosque', shape: 'rect', area: [500, 900], compound: true, ring: 3, orientation: 'qibla' },
    },
    hamlet: { form: 'auto', morphology: { base: 'medina', buildingOp: 'courtyardHouse' } },
    m4: { castle: 'kasbah', cathedral: null, palace: null, monastery: 'madrasa', marketHall: false, arena: 0, shanty: 'bidonville' },
    render: { towerShape: 'square' },
  },
  {
    id: 'chinese', label: 'Chinese walled city',
    nucleus: { kind: 'drum-tower', shape: 'square', area: [1600, 4000], compound: false, ring: 10, orientation: 'cardinal' },
    core: { morphology: 'chinese', enclosure: { shape: 'square', wall: 'wall', fossil: 'wall', towers: 'square', gates: 'cardinal', orientation: 'cardinal', aspect: [1, 1.2] } },
    ring: { morphology: 'chinese', enclosure: { shape: 'rect', wall: 'wall', fossil: 'street', towers: 'square', gates: 'cardinal', orientation: 'cardinal', aspect: [1.1, 1.3] } },
    phaseCount: [[0, 1], [30000, 2]],
    faubourg: 'chinese-suburb', faubShare: [0.12, 0.1],
    landmarks: [
      { role: 'power', kind: 'yamen', place: 'axis-north', area: [4000, 16000], minPop: 1500 },
      { role: 'worship', kind: 'chinese-temple', place: 'east', area: [3000, 12000], minPop: 1500 },
      { role: 'civic', kind: 'chinese-temple', place: 'west', area: [3000, 12000], minPop: 4000 },
      { role: 'market', kind: 'walled-market', place: 'east', area: [4000, 14000], minPop: 6000 },
      { role: 'extra', kind: 'walled-market', place: 'west', area: [4000, 14000], minPop: 9000 },
    ],
    village: {
      form: 'walled', morphology: 'chinese', enclosure: { shape: 'square', wall: 'wall', fossil: 'none', towers: 'square', gates: 'cardinal', orientation: 'cardinal' },
      nucleus: { kind: 'none', shape: 'square', area: [0, 0], compound: false, ring: 8, orientation: 'cardinal' },
    },
    hamlet: { form: 'auto', morphology: 'chinese-suburb' },
    m4: { castle: 'none', cathedral: null, palace: null, monastery: null, marketHall: false, arena: 0, shanty: 'riverbank' },
    render: { towerShape: 'square', wardWalls: true, moat: true, compoundWalls: true },
    sitePrefs: { flatness: 2, waterSide: 'S', hillSide: 'N', weights: { hilltop: 0, plain: 2 } },
  },
  {
    id: 'japanese-jokamachi', label: 'Japanese castle town (jōkamachi)',
    nucleus: { kind: 'castle', shape: 'square', area: [40000, 110000], compound: true, ring: 9, orientation: 'road' },
    core: { morphology: 'jp-samurai', share: 0.3, enclosure: { shape: 'organic', wall: 'none', fossil: 'street' } },
    ring: { morphology: 'jp-merchant', enclosure: { shape: 'organic', wall: 'none', fossil: 'none' } },
    phaseCount: [[0, 2], [15000, 3]],
    faubourg: 'jp-merchant', faubShare: [0.15, 0.15],
    landmarks: [
      { role: 'worship', kind: 'jp-temple', place: 'edge', area: [2500, 12000], minPop: 1500, count: 4 },
      { role: 'extra', kind: 'jp-temple', place: 'edge', area: [2500, 12000], minPop: 9000, count: 3 },
    ],
    village: { form: 'auto', morphology: 'jp-merchant' },
    hamlet: { form: 'auto', morphology: 'jp-merchant' },
    m4: { castle: 'none', cathedral: null, palace: null, monastery: null, marketHall: false, arena: 0, shanty: 'riverbank' },
    render: { towerShape: 'square', compoundWalls: true },
    sitePrefs: { weights: { hilltop: 2, plain: 1.5 } },
  },
  {
    id: 'indian-temple', label: 'Indian temple town',
    nucleus: { kind: 'temple', shape: 'square', area: [16000, 60000], compound: true, ring: 10, orientation: 'cardinal' },
    core: { morphology: 'indian-temple', enclosure: { shape: 'square', wall: 'none', fossil: 'street', orientation: 'cardinal' } },
    ring: { morphology: 'indian-temple', enclosure: { shape: 'square', wall: 'none', fossil: 'street', orientation: 'cardinal' } },
    phaseCount: [[0, 1]],
    faubourg: 'indian-temple', faubShare: [0.1, 0.1],
    landmarks: [
      { role: 'extra', kind: 'tank', place: 'near-nucleus', area: [3500, 14000], minPop: 1200 },
      { role: 'power', kind: 'palace', place: 'near-nucleus', area: [5000, 20000], minPop: 8000 },
    ],
    village: {
      form: 'walled', morphology: 'indian-temple', enclosure: { shape: 'square', wall: 'none', fossil: 'none', orientation: 'cardinal' },
      nucleus: { kind: 'temple', shape: 'square', area: [2500, 4500], compound: true, ring: 6, orientation: 'cardinal' },
    },
    hamlet: { form: 'auto', morphology: 'indian-temple' },
    m4: { castle: 'none', cathedral: null, palace: null, monastery: null, marketHall: false, arena: 0, shanty: 'riverbank' },
    render: { towerShape: 'square' },
    sitePrefs: { flatness: 1.6, weights: { hilltop: 0, plain: 2, bridge: 1.5 } },
  },
  {
    id: 'roman-core', label: 'Roman castrum core',
    nucleus: { kind: 'forum', shape: 'rect', area: [3500, 9000], compound: false, ring: 6, orientation: 'road' },
    core: { morphology: 'roman-castrum', share: 0.3, enclosure: { shape: 'rounded-rect', wall: 'wall', fossil: 'street', towers: 'round', orientation: 'road', aspect: [1.25, 1.5] } },
    ring: { morphology: 'european-organic', culture: 'european-organic', enclosure: { shape: 'organic', wall: 'auto', fossil: 'street', towers: 'round' } },
    phaseCount: [[0, 1], [3000, 2], [12000, 3]],
    faubourg: 'european-organic', faubShare: [0.12, 0.1],
    landmarks: [
      { role: 'civic', kind: 'basilica', place: 'adjacent-nucleus', area: [1200, 6000], minPop: 800 },
      { role: 'worship', kind: 'roman-temple', place: 'adjacent-nucleus', area: [600, 4000], minPop: 1500 },
    ],
    village: {
      form: 'walled', morphology: 'roman-castrum', enclosure: { shape: 'rounded-rect', wall: 'wall', fossil: 'none', towers: 'round', orientation: 'road' },
      nucleus: { kind: 'forum', shape: 'rect', area: [900, 1600], compound: false, ring: 5, orientation: 'road' },
    },
    hamlet: { form: 'auto' },
    m4: { castle: 'castle', arena: 1 },
    render: { towerShape: 'round' },
  },
  {
    id: 'elven', label: 'Elven forest town', fantasy: true,
    nucleus: { kind: 'grove', shape: 'circle', area: [5000, 14000], compound: true, ring: 3.4 },
    core: { morphology: 'elven', enclosure: { shape: 'organic', wall: 'hedge', fossil: 'street' } },
    ring: { morphology: 'elven', enclosure: { shape: 'organic', wall: 'hedge', fossil: 'street' } },
    phaseCount: [[0, 1], [2500, 2]],
    faubourg: null, faubShare: [0.02, 0.02],
    landmarks: [],
    village: {
      form: 'walled', morphology: 'elven', enclosure: { shape: 'circle', wall: 'hedge', fossil: 'none' },
      nucleus: { kind: 'grove', shape: 'circle', area: [2500, 5000], compound: true, ring: 3 },
    },
    hamlet: {
      form: 'walled', morphology: 'elven', enclosure: { shape: 'circle', wall: 'none', fossil: 'none' },
      nucleus: { kind: 'grove', shape: 'circle', area: [1200, 2500], compound: true, ring: 2.6 },
    },
    m4: { castle: 'none', cathedral: null, palace: null, monastery: null, marketHall: false, arena: 0, port: false },
    render: { towerShape: 'round', canopy: true },
    sitePrefs: { woodland: 1 },
  },
  {
    id: 'dwarven', label: 'Dwarven hold', fantasy: true,
    nucleus: { kind: 'none', shape: 'rect', area: [0, 0], compound: false, ring: 8, orientation: 'terrain' },
    core: { morphology: 'dwarven', enclosure: { shape: 'rect', wall: 'wall', fossil: 'none', towers: 'square', orientation: 'terrain', aspect: [1.6, 2.2] } },
    ring: null,
    phaseCount: [[0, 1]],
    faubourg: 'dwarven', faubShare: [0.05, 0.05],
    landmarks: [
      { role: 'power', kind: 'dwarf-gate', place: 'high', area: [900, 6000], minPop: 300 },
      { role: 'extra', kind: 'mine', place: 'high', area: [300, 3000], minPop: 300, count: 2 },
      { role: 'civic', kind: 'forge', place: 'any', area: [400, 3000], minPop: 300, count: 3 },
    ],
    village: {
      form: 'walled', morphology: 'dwarven', enclosure: { shape: 'rect', wall: 'wall', fossil: 'none', towers: 'square', orientation: 'terrain' },
      nucleus: { kind: 'none', shape: 'rect', area: [0, 0], compound: false, ring: 6 },
    },
    hamlet: { form: 'walled', morphology: 'dwarven', enclosure: { shape: 'rect', wall: 'none', fossil: 'none', orientation: 'terrain' } },
    m4: { castle: 'none', cathedral: null, palace: null, monastery: null, marketHall: false, arena: 0, shanty: 'gecekondu', port: false },
    render: { towerShape: 'square', terraces: true },
    sitePrefs: { mountainFace: 1, weights: { valley: 2, hilltop: 1.5, plain: 0.3 } },
  },
];
