import type { Culture } from './culture';
import { MORPHOLOGIES, deepMerge } from './morphology';

/** Dense trading towns of the Swahili coast: coral-stone courts behind bazaar fronts, open to the waterfront. */
export function registerSwahiliMorphologies(): void {
  MORPHOLOGIES['swahili-stone'] = deepMerge(MORPHOLOGIES.medina, {
    id: 'swahili-stone', streets: ['gateToGate', 'organicInfill', 'culDeSacTree'],
    curvature: 0.8, fieldNoise: 24, fieldWavelength: 130, fieldRandom: 0.5, spineAmp: 8, deadEndRatio: 0.65,
    widthByRank: [6, 4.5, 3.4, 2.5, 2.2], gatePlaces: 0, crossPlaces: 0.12, ringGaps: 0,
    growth: { road: 0.12, water: 0.48, noise: 0.18, wavelength: 320, elongation: 0.15, wet: 0.35, bipolar: 0.1 },
    houseArea: { core: [130, 360], middle: [160, 480], edge: [180, 540], faubourg: [160, 500], village: [180, 520] },
    roomDepth: [3.6, 5.5], courtyardShare: [0.22, 0.3],
    coverage: { core: [0.82, 0.9], middle: [0.78, 0.87], edge: [0.7, 0.8], faubourg: [0.56, 0.7], village: [0.5, 0.66] },
    density: { core: 280, middle: 230, edge: 160, faubourg: 80, village: 55 },
    arch: { typology: 'swahili-stone-house', roof: 'flat', storeys: [2, 3], material: 'coral-stone' },
  });
  MORPHOLOGIES['swahili-bazaar'] = deepMerge(MORPHOLOGIES['medina-souk'], {
    id: 'swahili-bazaar', streets: ['radials', 'organicInfill'], fieldRandom: 0.35,
    widthByRank: [6, 4.5, 3.4, 2.5, 2.2], gatePlaces: 0, crossPlaces: 0.1,
    frontage: { core: [4.6, 6.5], middle: [4.6, 7] }, buildDepth: { core: [6, 9], middle: [6, 9] },
    arch: { typology: 'swahili-bazaar-shop', roof: 'flat', storeys: [1, 2], material: 'coral-stone' },
  });
}

export const SWAHILI_CULTURE: Culture = {
  id: 'swahili-stone-town', label: 'Swahili stone town (Lamu / Zanzibar)',
  nucleus: { kind: 'mosque', builder: 'swahili-juma-mosque', shape: 'rect', area: [1800, 6500], compound: true, ring: 4, orientation: 'road' },
  core: { morphology: 'swahili-stone', sectors: [{ morphology: 'swahili-bazaar', share: 0.18 }], enclosure: { shape: 'organic', wall: 'none', fossil: 'none' } },
  ring: { morphology: 'swahili-stone', enclosure: { shape: 'organic', wall: 'none', fossil: 'street' } },
  phaseCount: [[0, 1], [3500, 2], [14000, 3]], faubourg: 'swahili-stone', faubShare: [0.1, 0.1],
  landmarks: [
    { role: 'worship', kind: 'swahili-mosque', place: 'spread', area: [650, 2600], minPop: 1500, perPop: 3000, sep: 180 },
    { role: 'power', kind: 'swahili-fort', place: 'edge', area: [3000, 10000], minPop: 4500, count: 1 },
    { role: 'extra', kind: 'swahili-merchant-house', place: 'near-nucleus', area: [900, 3500], minPop: 2500, count: 1 },
  ],
  village: { form: 'walled', morphology: 'swahili-stone', enclosure: { shape: 'organic', wall: 'none', fossil: 'none' },
    nucleus: { kind: 'mosque', builder: 'swahili-mosque', shape: 'rect', area: [450, 950], compound: true, ring: 3, orientation: 'road' } },
  hamlet: { form: 'auto', morphology: 'swahili-stone' },
  m4: { castle: 'none', cathedral: null, palace: null, monastery: null, marketHall: false, arena: 0, port: true, activities: false },
  sitePrefs: { waterSide: 'S', flatness: 1.3, weights: { harbor: 3, estuary: 2, bridge: 1.2, plain: 0.5, hilltop: 0.2 } },
  render: { towerShape: 'square', carvedDoors: true }, scale: { min: 'hamlet', max: 'megacity' },
};
