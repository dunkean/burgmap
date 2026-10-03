/**
 * Village and camp cultures (POLISH.md "New cultures"): planned without streets by the camp layouts
 * (camps/index.ts). Plain data like the other presets; the morphology of each carries the architecture metadata
 * of its ordinary dwellings and the densities used for sizing.
 */
import type { Culture } from './culture';
import type { MorphologyParams } from './morphology';
import { MORPHOLOGIES, EO_BASE, deepMerge } from './morphology';
import { attachUrbanGrowth } from './cultures_primitive';

const morph = (id: string, over: Record<string, unknown>): MorphologyParams => deepMerge(EO_BASE, { ...over, id, gatePlaces: 0, crossPlaces: 0 });

const M: Record<string, MorphologyParams> = {
  kraal: morph('kraal', { arch: { typology: 'beehive-hut', roof: 'thatch-round', storeys: [1, 1], material: 'thatch' }, density: { core: 60, middle: 60, edge: 60, faubourg: 60, village: 60 } }),
  'plains-camp': morph('plains-camp', { arch: { typology: 'tipi', roof: 'conical', storeys: [1, 1], material: 'hide' }, density: { core: 30, middle: 30, edge: 30, faubourg: 30, village: 30 } }),
  'barbarian': morph('barbarian', { arch: { typology: 'byre-house', roof: 'gable', storeys: [1, 1], material: 'thatch' }, density: { core: 60, middle: 60, edge: 60, faubourg: 60, village: 60 } }),
  'barbarian-celtic': morph('barbarian-celtic', { arch: { typology: 'roundhouse', roof: 'thatch-round', storeys: [1, 1], material: 'wattle' }, density: { core: 70, middle: 70, edge: 70, faubourg: 70, village: 70 } }),
  'barbarian-norse': morph('barbarian-norse', { arch: { typology: 'longhouse', roof: 'gable', storeys: [1, 1], material: 'turf' }, density: { core: 25, middle: 25, edge: 25, faubourg: 25, village: 25 } }),
  'iroquoian': morph('iroquoian', { arch: { typology: 'longhouse', roof: 'barrel', storeys: [1, 1], material: 'bark' }, density: { core: 160, middle: 160, edge: 160, faubourg: 160, village: 160 } }),
  pueblo: morph('pueblo', { arch: { typology: 'pueblo-room', roof: 'terraced', storeys: [1, 5], material: 'adobe' }, density: { core: 250, middle: 250, edge: 250, faubourg: 250, village: 250 } }),
  'norse-ringfort': morph('norse-ringfort', { arch: { typology: 'longhouse', roof: 'gable', storeys: [1, 1], material: 'timber' }, density: { core: 60, middle: 60, edge: 60, faubourg: 60, village: 60 } }),
  maya: morph('maya', { arch: { typology: 'maya-house', roof: 'thatch-round', storeys: [1, 1], material: 'wattle' }, density: { core: 40, middle: 40, edge: 40, faubourg: 40, village: 40 } }),
  khmer: morph('khmer', { arch: { typology: 'stilt-house', roof: 'gable', storeys: [1, 1], material: 'wood' }, density: { core: 62, middle: 62, edge: 62, faubourg: 62, village: 62 } }),
  oppidum: morph('oppidum', { arch: { typology: 'roundhouse', roof: 'thatch-round', storeys: [1, 1], material: 'wattle' }, density: { core: 45, middle: 45, edge: 45, faubourg: 45, village: 45 } }),
  orcish: morph('orcish', { arch: { typology: 'orc-hut', roof: 'conical', storeys: [1, 1], material: 'hide' }, density: { core: 90, middle: 90, edge: 90, faubourg: 90, village: 90 } }),
  halfling: morph('halfling', { arch: { typology: 'smial', roof: 'dome', storeys: [1, 1], material: 'turf' }, density: { core: 32, middle: 32, edge: 32, faubourg: 32, village: 32 } }),
  'stilt-town': morph('stilt-town', { arch: { typology: 'stilt-house', roof: 'thatch-round', storeys: [1, 1], material: 'thatch' }, density: { core: 120, middle: 120, edge: 120, faubourg: 120, village: 120 } }),
  'nomad-camp': morph('nomad-camp', { arch: { typology: 'ger', roof: 'dome', storeys: [1, 1], material: 'felt' }, density: { core: 60, middle: 60, edge: 60, faubourg: 60, village: 60 } }),
};
Object.assign(MORPHOLOGIES, M);

/** The fields a camp culture does not use (the street engine's recipe), filled once. */
const campBase = (id: string, label: string, morphology: string): Omit<Culture, 'camp' | 'scale'> => ({
  id, label,
  nucleus: { kind: 'none', shape: 'circle', area: [0, 0], compound: false, ring: 3 },
  core: { morphology, enclosure: { shape: 'circle', wall: 'none', fossil: 'none' } },
  ring: null, phaseCount: [[0, 1]], faubourg: null, faubShare: [0, 0], landmarks: [],
  village: { form: 'ring', morphology }, hamlet: { form: 'ring', morphology },
  m4: { castle: 'none', cathedral: null, palace: null, monastery: null, marketHall: false, arena: 0, port: false },
  render: { towerShape: 'round', plotLines: false, openGround: true },
});

export const CAMP_CULTURES: Culture[] = [
  {
    ...campBase('stilt-town', 'Stilt town (marsh folk)', 'stilt-town'), fantasy: true,
    scale: { min: 'hamlet', max: 'megacity' }, camp: { layout: 'stilts', variant: 'lagoon' }, waterBuild: true,
    render: { towerShape: 'round', plotLines: true, stilts: true },
    sitePrefs: { flatness: 1.5, weights: { estuary: 3, harbor: 3, meander: 2, confluence: 2, bridge: 1, plain: 0.4, hilltop: 0, valley: 0.4 } },
  },
  {
    ...campBase('barbarian', 'Barbarian: Germanic village', 'barbarian'), family: 'barbarian',
    scale: { min: 'hamlet', max: 'megacity' }, camp: { layout: 'yards', variant: 'germanic' },
    sitePrefs: { weights: { plain: 1.5, valley: 1.3, bridge: 1.2, hilltop: 0.6 } },
  },
  {
    ...campBase('barbarian-celtic', 'Barbarian: Celtic ringfort', 'barbarian-celtic'), family: 'barbarian',
    scale: { min: 'hamlet', max: 'megacity' }, camp: { layout: 'yards', variant: 'celtic' },
    sitePrefs: { flatness: 0.6, weights: { hilltop: 2.5, plain: 0.6 } },
  },
  {
    ...campBase('barbarian-norse', 'Barbarian: Norse farmstead cluster', 'barbarian-norse'), family: 'barbarian',
    scale: { min: 'hamlet', max: 'megacity' }, camp: { layout: 'yards', variant: 'norse' },
    sitePrefs: { weights: { harbor: 2, estuary: 1.6, plain: 1, hilltop: 0.4 } },
  },
  {
    ...campBase('norse-ringfort', 'Norse ring fortress (Trelleborg)', 'norse-ringfort'),
    scale: { min: 'hamlet', max: 'megacity' }, camp: { layout: 'ringfort', variant: 'trelleborg' },
    sitePrefs: { flatness: 1.4, weights: { harbor: 1.4, estuary: 1.4, plain: 1.5, hilltop: 0.5 } },
  },
  {
    // (Tikal, Copán, Caracol: a garden city; the dispersed houselots grow to a city of tens of thousands)
    ...campBase('maya', 'Maya city (ceremonial core, sacbeob)', 'maya'),
    scale: { min: 'hamlet', max: 'megacity' }, camp: { layout: 'yards', variant: 'maya' },
    render: { towerShape: 'square', plotLines: false, openGround: true },
    sitePrefs: { flatness: 1.2, weights: { plain: 1.6, hilltop: 1.2, valley: 1, harbor: 0.3 } },
  },
  {
    // (Angkor Thom: the moated square, the temple-mountain at the crossing of the avenues, the barays)
    ...campBase('khmer', 'Khmer city (Angkor)', 'khmer'),
    scale: { min: 'hamlet', max: 'megacity' }, camp: { layout: 'khmer', variant: 'angkor' },
    render: { towerShape: 'square', plotLines: false, openGround: true },
    sitePrefs: { flatness: 2.4, weights: { plain: 2.5, bridge: 1, hilltop: 0, valley: 0.5, harbor: 0.2 } },
  },
  {
    // (Bibracte, Manching: the hilltop town of the late Iron Age)
    ...campBase('celtic-oppidum', 'Celtic oppidum', 'oppidum'),
    scale: { min: 'hamlet', max: 'megacity' }, camp: { layout: 'yards', variant: 'oppidum' },
    sitePrefs: { flatness: 0.4, weights: { hilltop: 3, valley: 0.8, plain: 0.5, harbor: 0.2, estuary: 0.2 } },
  },
  {
    ...campBase('orcish', 'Orcish war camp', 'orcish'), fantasy: true,
    // (chaotic sprawl inside lobed stake palisades: the camp grew by bursts; the ring layout's 'orc' variant is kept)
    scale: { min: 'hamlet', max: 'megacity' }, camp: { layout: 'warcamp', variant: 'orc' },
    sitePrefs: { flatness: 0.8, weights: { hilltop: 1.6, valley: 1.2, plain: 1, harbor: 0.3 } },
  },
  {
    ...campBase('halfling', 'Halfling shire', 'halfling'), fantasy: true,
    scale: { min: 'hamlet', max: 'megacity' }, camp: { layout: 'yards', variant: 'halfling' },
    render: { towerShape: 'round', plotLines: false, openGround: true },
    sitePrefs: { flatness: 0.7, weights: { hilltop: 1.6, valley: 1.4, plain: 1, harbor: 0.2 } },
  },
  {
    ...campBase('kraal', 'Kraal (African homestead)', 'kraal'),
    scale: { min: 'hamlet', max: 'megacity' }, camp: { layout: 'ring', variant: 'kraal' },
    sitePrefs: { flatness: 0.6, weights: { hilltop: 1.6, valley: 1.2, plain: 1, harbor: 0, estuary: 0 } },
  },
  {
    ...campBase('native-iroquoian', 'Native American: Iroquoian longhouse village', 'iroquoian'), family: 'native-american',
    scale: { min: 'hamlet', max: 'megacity' }, camp: { layout: 'longhouses', variant: 'iroquoian' },
    sitePrefs: { flatness: 0.8, weights: { hilltop: 1.6, valley: 1.2, plain: 1, harbor: 0.2 } },
  },
  {
    ...campBase('native-pueblo', 'Native American: Pueblo', 'pueblo'), family: 'native-american',
    // (the pueblo grows to a town: several great houses, Chaco Canyon)
    scale: { min: 'hamlet', max: 'megacity' }, camp: { layout: 'pueblo', variant: 'pueblo' },
    render: { towerShape: 'square', plotLines: false, storeyShade: true },
    sitePrefs: { flatness: 0.9, weights: { valley: 2, plain: 1.4, hilltop: 0.8, harbor: 0, estuary: 0 } },
  },
  {
    ...campBase('native-plains', 'Native American: Plains tipi camp', 'plains-camp'), family: 'native-american',
    scale: { min: 'hamlet', max: 'megacity' }, camp: { layout: 'ring', variant: 'tipi' },
    sitePrefs: { flatness: 1.8, weights: { plain: 2, bridge: 1.4, hilltop: 0, harbor: 0 } },
  },
  {
    ...campBase('nomad-camp', 'Nomad camp (steppe ordu)', 'nomad-camp'),
    scale: { min: 'hamlet', max: 'megacity' }, camp: { layout: 'ring', variant: 'nomad' },
    sitePrefs: { flatness: 2, weights: { plain: 2.5, hilltop: 0, harbor: 0, estuary: 0 } },
  },
];

attachUrbanGrowth(CAMP_CULTURES);
