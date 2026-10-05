import type { NameFamily } from './names/types';
import { expandMapQuery, encodeMapId } from './mapId';
import { NAME_FAMILIES } from './names/types';
import { BIOME_NAMES, biomeName, type BiomeName } from './biomes';
import type { ImportedHeight } from './terrain/import';
import { CULTURE_IDS, CULTURES as CULTURE_REGISTRY, mixToString, mixFromString, planToString, planFromString } from './urban/culture';
import type { CultureMix, PlanOverride } from './urban/culture';

export type SizeName = 'hamlet' | 'village' | 'town' | 'city' | 'capital';
export type Relief = 'flat' | 'hills' | 'valley' | 'mountains';
export type CoastOpt = 'none' | 'N' | 'E' | 'S' | 'W' | 'random';
export type RiverOpt = 'none' | 'stream' | 'river' | 'major';
export type StyleName = 'parchment' | 'atlas';
export type Tri = 'auto' | 'yes' | 'no';
/** Suburb growth (M4): none, the faubourg ribbons, or thick suburbs with their own churches (and an outer wall for cities). */
/** Town wall (M4): auto, none (open town), single curtain, double enceinte (inner curtain + outer wall, lists between). 'yes' / 'no' are the older spellings of single / none. */
export type WallsOpt = Tri | 'none' | 'single' | 'double';
/** Number of castles: auto (size and culture) or 0–3 on distinct defensible sites. */
export type CastlesOpt = 'auto' | '0' | '1' | '2' | '3';
export type SuburbOpt = 'auto' | 'none' | 'some' | 'many';
/** Informal settlements on the least valued land (M4). */
export type ShantyOpt = 'auto' | 'none' | 'some' | 'many';
/** Historical site archetypes the settlement core can be placed in (site/site.ts). */
export type SiteArchetype = 'bridge' | 'confluence' | 'meander' | 'harbor' | 'estuary' | 'valley' | 'hilltop' | 'plain';
export const SITE_ARCHETYPES: SiteArchetype[] = ['bridge', 'confluence', 'meander', 'harbor', 'estuary', 'valley', 'hilltop', 'plain'];
export type SiteType = 'auto' | SiteArchetype;
/** Cultural / scenario hooks for site selection (filled by the culture layer). All fields optional. */
export interface SitePrefs {
  /** Multipliers on the archetype probabilities, e.g. { hilltop: 0, harbor: 3 }. */
  weights?: Partial<Record<SiteArchetype, number>>;
  /** Side of the town where open water should lie (screen directions, y down): 'S' = water to the south. */
  waterSide?: 'N' | 'E' | 'S' | 'W';
  /** Side of the town where the high ground should lie: 'N' = hills to the north. */
  hillSide?: 'N' | 'E' | 'S' | 'W';
  /** 0..1: prefer the foot of a mountain face (dwarven). */
  mountainFace?: number;
  /** 0..1: prefer woodland edges (elven). Reserved: land use is generated after the site, so it has no effect yet. */
  woodland?: number;
  /** Multiplier on the importance of flat ground (Chinese plains: > 1). */
  flatness?: number;
  /** Share of the map side kept free between the site and the map edge (default 0.2; megacities need more). */
  margin?: number;
  /** Minimum edge clearance in meters for an explicitly placed main centre (megacity footprint reserve). */
  centerInset?: number;
}
/** Culture preset id (URBAN_MORPHOLOGY.md §3; registry in urban/cultures.ts). */
export type Culture = string;
export const CULTURES: Culture[] = CULTURE_IDS;
/** [id, label] pairs for selectors. */
export const CULTURE_LABELS: [string, string][] = CULTURE_IDS.map((id) => [id, CULTURE_REGISTRY[id].label]);
export type { CultureMix, PlanOverride };

export interface Options {
  seed: string;
  /** Opt-in generation workflow; absent keeps the original one-step map and URL contract. */
  workflow?: 'environment' | 'automatic' | 'list';
  /** Selected composition while the environment is shown; the list draft may remain stored in either mode. */
  settlementMode?: 'automatic' | 'list';
  size: SizeName;
  relief: Relief;
  /** Climate and vegetation; omitted on legacy links to preserve the temperate world. */
  biome?: BiomeName;
  coast: CoastOpt;
  river: RiverOpt;
  /** Site archetype: 'auto' picks one from what the terrain offers. */
  siteType?: SiteType;
  sitePrefs?: SitePrefs;
  /** Requested main settlement centre in meters; unsuitable points move to nearby usable land. */
  center?: { x: number; y: number };
  /** Shifts the sea inland (+) or seaward (-), range about [-1, 1]. Only used when a coast exists. */
  seaLevel?: number;
  // Placeholders for later stages
  walls: WallsOpt;
  /** Wet ditch outside the curtain; auto follows the culture and local water supply. */
  moat?: Tri;
  /** Castle count (M4): overrides `castle` when not 'auto'. */
  castles?: CastlesOpt;
  /** Castle / citadel on the most defensible spot at the town edge (auto: town and larger, sometimes a village motte). */
  castle: Tri;
  // ---- landmarks and activities (M4, URBAN_LANDMARKS.md); 'auto' follows the size and the culture
  cathedral?: Tri;
  palace?: Tri;
  monasteries?: Tri;
  port?: Tri;
  arena?: Tri;
  /** Mills, windmills, nuisance trades, inns, hospitals, gallows, lazar house, cemeteries. */
  activities?: Tri;
  suburbs?: SuburbOpt;
  shantytowns?: ShantyOpt;
  /** Number of regional road exits; 0 = automatic. */
  roads: number;
  style: StyleName;
  contours: boolean;
  /** Show the rural land-use layer (fields, forest, ...). */
  landuse: boolean;
  /** Urban morphology preset (URBAN_MORPHOLOGY.md). */
  culture: Culture;
  /** Second culture mixed in: by growth phases, by sectors, or as a continuous blend with weight t. */
  cultureMix?: CultureMix | null;
  /** Explicit plan (nucleus + phases list) overriding the culture's phase recipe. */
  plan?: PlanOverride | null;
  /** Inhabitants; 0 = automatic from the size preset. */
  population: number;
  /** Sprawl 0.5 (compact, dense) … 2 (loose, gardens, spread suburbs) for the same population; 1 = the culture's baseline. */
  sprawl?: number;
  /** Toponym language family; 'auto' (default) follows the culture. */
  language?: NameFamily | 'auto';
  /** Draw labels (names) / legend on the map. Display only. */
  labels?: boolean;
  legend?: boolean;
  /** Imported heightmap (pixels; never serialized to the URL). When set it replaces the procedural relief. */
  importedHeight?: ImportedHeight;
  /** Imported heightmap: height in meters of a white pixel (default 120). */
  heightScale?: number;
  /** Imported heightmap: sea level in meters (pixels below become sea; default 0 = no sea). */
  importSea?: number;
  // ---- settlement system (M3c, REGION_SETTLEMENTS.md), additive
  /** Custom map extent in meters (600 – 40 000); undefined = the preset, expanded by the pipeline for megacities. */
  mapSize?: number;
  /** Secondary settlements: automatic, none, counts per class, or an explicit list. Default 'auto'. */
  settlements?: SettlementsOpt;
  /** Megacity scaling: main settlements above this population get a macro plan with lazily generated quarters (default 40 000). */
  eagerPop?: number;
}

/** Settlement classes of the planner (farmstead → megacity), derived continuously from the population. */
export type SettlementClass = 'farmstead' | 'hamlet' | 'village' | 'town' | 'city' | 'metropolis' | 'megacity';
/** Classes that can be requested by count (secondary settlements). */
export type CountClass = 'city' | 'town' | 'village' | 'hamlet' | 'farmstead';
export const COUNT_CLASSES: CountClass[] = ['city', 'town', 'village', 'hamlet', 'farmstead'];
export type SettlementCounts = Record<CountClass, number>;
/** One explicit settlement (main-inclusive only in workflow=list; legacy lists contain secondaries). */
export interface SettlementSpec {
  population: number;
  /** Culture preset id (default: the main culture). */
  culture?: string;
  siteType?: SiteArchetype;
  /** Fixed position (meters); otherwise placed by site scoring. */
  position?: { x: number; y: number };
  /** Town controls specific to this instance. Unspecified values inherit the general theme in list mode. */
  options?: SettlementOverrides;
}
export type SettlementOverrides = Partial<Pick<Options,
  'size' | 'sitePrefs' | 'walls' | 'moat' | 'castles' | 'castle' | 'cathedral' | 'palace' |
  'monasteries' | 'port' | 'arena' | 'activities' | 'suburbs' | 'shantytowns' |
  'roads' | 'cultureMix' | 'plan' | 'sprawl' | 'language'
>>;
export type SettlementsOpt = 'auto' | 'none' | { counts: SettlementCounts } | { list: SettlementSpec[] };

export const MAP_SIZE_MIN = 600, MAP_SIZE_MAX = 40000;
export const POP_MIN = 10, POP_MAX = 5000000;

/** Population thresholds of the classes (lower bounds). */
export const CLASS_FLOOR: [SettlementClass, number][] = [
  ['megacity', 1000000], ['metropolis', 100000], ['city', 20000], ['town', 1000], ['village', 150], ['hamlet', 15], ['farmstead', 0],
];
export function classOfPop(pop: number): SettlementClass {
  for (const [c, lo] of CLASS_FLOOR) if (pop >= lo) return c;
  return 'farmstead';
}
/** Legacy size class used by the stages that are tuned per preset (site reserve, road count, tracks...). */
export function sizeForPop(pop: number): SizeName {
  return pop < 200 ? 'hamlet' : pop < 1200 ? 'village' : pop < 8000 ? 'town' : pop < 30000 ? 'city' : 'capital';
}
/** Map extent (m): the custom `mapSize` when set, else the preset's. */
export function mapSizeOf(o: Pick<Options, 'size' | 'mapSize'>): number {
  return o.mapSize !== undefined && Number.isFinite(o.mapSize) ? Math.max(MAP_SIZE_MIN, Math.min(MAP_SIZE_MAX, Math.round(o.mapSize))) : SIZE_PRESETS[o.size].mapSize;
}
/**
 * The size class the main settlement is generated with. Legacy maps (no custom extent) keep their preset, so old
 * links reproduce exactly; with a custom extent the class follows the population when one is given.
 */
export function effectiveSize(o: Pick<Options, 'size' | 'mapSize' | 'population'>): SizeName {
  return o.mapSize !== undefined && o.population > 0 ? sizeForPop(o.population) : o.size;
}

const CLS_KEYS: Record<CountClass, string> = { city: 'c', town: 't', village: 'v', hamlet: 'h', farmstead: 'f' };
/** URL form: 'auto' | 'none' | 'c0.t1.v8.h10.f20' | 'L' + items joined by '_' (pop~culture~site~x~y). */
export function settlementsToString(s: SettlementsOpt | undefined): string {
  if (!s || s === 'auto') return 'auto';
  if (s === 'none') return 'none';
  if ('counts' in s) return COUNT_CLASSES.map((c) => CLS_KEYS[c] + Math.max(0, Math.round(s.counts[c] ?? 0))).join('.');
  return 'L' + s.list.map((it) => {
    const f = [String(Math.round(it.population)), it.culture ?? '', it.siteType ?? '', it.position ? String(Math.round(it.position.x)) : '', it.position ? String(Math.round(it.position.y)) : ''];
    while (f.length > 1 && f[f.length - 1] === '') f.pop();
    return f.join('~');
  }).join('_');
}
export function settlementsFromString(v: string | null): SettlementsOpt {
  if (!v || v === 'auto') return 'auto';
  if (v === 'none') return 'none';
  if (v[0] === 'L') {
    const list: SettlementSpec[] = [];
    for (const item of v.slice(1).split('_')) {
      if (!item) continue;
      const [p, cu, st, x, y] = item.split('~');
      const pop = Number(p);
      if (!Number.isFinite(pop) || pop <= 0) continue;
      const spec: SettlementSpec = { population: Math.max(POP_MIN, Math.min(POP_MAX, Math.round(pop))) };
      if (cu && (CULTURE_IDS as string[]).includes(cu)) spec.culture = cu;
      if (st && (SITE_ARCHETYPES as string[]).includes(st)) spec.siteType = st as SiteArchetype;
      if (x !== undefined && y !== undefined && x !== '' && y !== '' && Number.isFinite(Number(x)) && Number.isFinite(Number(y))) spec.position = { x: Math.round(Number(x)), y: Math.round(Number(y)) };
      list.push(spec);
    }
    return { list };
  }
  const counts: SettlementCounts = { city: 0, town: 0, village: 0, hamlet: 0, farmstead: 0 };
  let any = false;
  for (const part of v.split('.')) {
    const cls = COUNT_CLASSES.find((c) => CLS_KEYS[c] === part[0]);
    const n = Number(part.slice(1));
    if (cls && Number.isFinite(n)) { counts[cls] = Math.max(0, Math.min(2000, Math.round(n))); any = true; }
  }
  return any ? { counts } : 'auto';
}

/** Ordered keys keep a many-settlement URL shorter than repeated property names. This format is opt-in. */
export const SETTLEMENT_OVERRIDE_KEYS = [
  'size', 'sitePrefs', 'walls', 'moat', 'castles', 'castle', 'cathedral', 'palace',
  'monasteries', 'port', 'arena', 'activities', 'suburbs', 'shantytowns',
  'roads', 'cultureMix', 'plan', 'sprawl', 'language',
] as const;

/** The first entry is the main settlement in workflow=list. Legacy settl=L... remains secondary-only. */
export function settlementListToString(list: SettlementSpec[]): string {
  return JSON.stringify(list.map((spec) => {
    const values: unknown[] = SETTLEMENT_OVERRIDE_KEYS.map((key) => {
      const value = spec.options?.[key];
      if (key === 'sitePrefs') return validSitePrefs(value);
      if (key === 'cultureMix') return value === null ? '!' : value ? mixToString(value as CultureMix) : undefined;
      if (key === 'plan') return value === null ? '!' : value ? planToString(value as PlanOverride) : undefined;
      return value;
    });
    while (values.length && values[values.length - 1] == null) values.pop();
    return [spec.population, spec.culture ?? null, spec.siteType ?? null,
      spec.position?.x ?? null, spec.position?.y ?? null, values];
  }));
}

function validSitePrefs(raw: unknown): SitePrefs | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: SitePrefs = {};
  if (r.weights && typeof r.weights === 'object' && !Array.isArray(r.weights)) {
    const weights: NonNullable<SitePrefs['weights']> = {};
    for (const site of SITE_ARCHETYPES) {
      const n = (r.weights as Record<string, unknown>)[site];
      if (typeof n === 'number' && Number.isFinite(n)) weights[site] = Math.max(0, Math.min(10, n));
    }
    if (Object.keys(weights).length) out.weights = weights;
  }
  for (const key of ['waterSide', 'hillSide'] as const) {
    const value = r[key];
    if (value === 'N' || value === 'E' || value === 'S' || value === 'W') out[key] = value;
  }
  for (const key of ['mountainFace', 'woodland', 'flatness', 'margin', 'centerInset'] as const) {
    const n = r[key];
    if (typeof n === 'number' && Number.isFinite(n)) out[key] = Math.max(0, Math.min(key === 'centerInset' ? MAP_SIZE_MAX : 10, n));
  }
  return Object.keys(out).length ? out : undefined;
}

function validOverrides(raw: unknown): SettlementOverrides | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SettlementOverrides = {};
  const value = (key: typeof SETTLEMENT_OVERRIDE_KEYS[number]): unknown => raw[SETTLEMENT_OVERRIDE_KEYS.indexOf(key)];
  const size = value('size');
  if (typeof size === 'string' && SIZES.includes(size as SizeName)) out.size = size as SizeName;
  out.sitePrefs = validSitePrefs(value('sitePrefs'));
  const walls = value('walls');
  if (typeof walls === 'string' && WALLS.includes(walls as WallsOpt)) out.walls = walls as WallsOpt;
  const moat = value('moat');
  if (typeof moat === 'string' && TRIS.includes(moat as Tri)) out.moat = moat as Tri;
  const castles = value('castles');
  if (typeof castles === 'string' && CASTLES.includes(castles as CastlesOpt)) out.castles = castles as CastlesOpt;
  for (const key of ['castle', 'cathedral', 'palace', 'monasteries', 'port', 'arena', 'activities'] as const) {
    const item = value(key);
    if (typeof item === 'string' && TRIS.includes(item as Tri)) out[key] = item as Tri;
  }
  const suburbs = value('suburbs');
  if (typeof suburbs === 'string' && SUBURBS.includes(suburbs as SuburbOpt)) out.suburbs = suburbs as SuburbOpt;
  const shantytowns = value('shantytowns');
  if (typeof shantytowns === 'string' && SHANTIES.includes(shantytowns as ShantyOpt)) out.shantytowns = shantytowns as ShantyOpt;
  const roads = value('roads');
  if (typeof roads === 'number' && Number.isFinite(roads)) out.roads = Math.max(0, Math.min(8, Math.round(roads)));
  const mix = value('cultureMix');
  if (mix === '!') out.cultureMix = null;
  else if (typeof mix === 'string') out.cultureMix = mixFromString(mix) ?? undefined;
  const plan = value('plan');
  if (plan === '!') out.plan = null;
  else if (typeof plan === 'string') out.plan = planFromString(plan) ?? undefined;
  const sprawl = value('sprawl');
  if (typeof sprawl === 'number' && Number.isFinite(sprawl)) out.sprawl = Math.max(0.5, Math.min(2, sprawl));
  const language = value('language');
  if (language === 'auto' || (typeof language === 'string' && (NAME_FAMILIES as string[]).includes(language))) out.language = language as Options['language'];
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

/** Bounded parser for the opt-in, main-inclusive list. */
export function settlementListFromString(value: string | null): SettlementSpec[] {
  if (!value || value.length > 100000) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const list: SettlementSpec[] = [];
  for (const row of parsed.slice(0, 2000)) {
    if (!Array.isArray(row)) continue;
    const [population, culture, siteType, x, y, overrides] = row;
    if (typeof population !== 'number' || !Number.isFinite(population) || population <= 0) continue;
    const spec: SettlementSpec = { population: Math.max(POP_MIN, Math.min(POP_MAX, Math.round(population))) };
    if (typeof culture === 'string' && CULTURE_IDS.includes(culture)) spec.culture = culture;
    if (typeof siteType === 'string' && SITE_ARCHETYPES.includes(siteType as SiteArchetype)) spec.siteType = siteType as SiteArchetype;
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
      spec.position = { x: Math.max(0, Math.min(MAP_SIZE_MAX, x)), y: Math.max(0, Math.min(MAP_SIZE_MAX, y)) };
    }
    const parsedOverrides = validOverrides(overrides);
    if (parsedOverrides) spec.options = parsedOverrides;
    list.push(spec);
  }
  return list;
}

/** Apply the first list item before site selection, urban generation and map-size planning. */
export function optionsForMainSettlement(o: Options): Options {
  if (o.workflow !== 'list' || !o.settlements || typeof o.settlements !== 'object' || !('list' in o.settlements)) return o;
  const first = o.settlements.list[0];
  if (!first) return o;
  return optionsForSettlement(o, first);
}

/** Effective controls for one explicit instance. A new culture drops the previous culture's mix and plan. */
export function optionsForSettlement(base: Options, spec: SettlementSpec): Options {
  const cultureBase = spec.culture ? withCulture(base, spec.culture) : base;
  return {
    ...cultureBase, ...spec.options, population: spec.population,
    size: spec.options?.size ?? sizeForPop(spec.population),
    siteType: spec.siteType ?? cultureBase.siteType,
    center: spec.position,
  };
}

/** Stable generation identity. Presentation controls and UI view/pins are deliberately excluded. */
export function generationUid(o: Options): string {
  // Parsing and serializing without uid applies the same bounds/defaults as a shared link. It also removes values
  // that the URL deliberately omits (sprawl=1, moat=auto, null mix/plan, temperate biome, ...).
  const normalized = fromQuery(queryForOptions(o, false));
  const p = new URLSearchParams(queryForOptions(normalized, false));
  for (const key of ['style', 'contours', 'landuse', 'labels', 'legend', 'compose']) p.delete(key);
  if (o.workflow === 'environment') {
    const env = new Set(['seed', 'size', 'map', 'relief', 'biome', 'coast', 'river', 'seaLevel', 'mode']);
    const inactive: string[] = [];
    p.forEach((_, key) => { if (!env.has(key)) inactive.push(key); });
    for (const key of inactive) p.delete(key);
    if (p.has('map')) p.delete('size');
    if (normalized.coast === 'none') p.delete('seaLevel');
  } else if (o.workflow === 'automatic') p.delete('set2');
  if (o.importedHeight) {
    p.set('hm', 'custom');
    p.set('hscale', String(normalized.heightScale ?? 120));
    p.set('hsea', String(normalized.importSea ?? 0));
  }
  const data = p.toString();
  let hash = 0x6c62272e07bb014262b821756295c58dn;
  const prime = 0x0000000001000000000000000000013bn;
  const mask = (1n << 128n) - 1n;
  const mixByte = (b: number): void => { hash = ((hash ^ BigInt(b)) * prime) & mask; };
  for (let i = 0; i < data.length; i++) {
    mixByte(data.charCodeAt(i) & 255);
    mixByte(data.charCodeAt(i) >>> 8);
  }
  if (o.importedHeight) {
    const dimensions = `|height:${o.importedHeight.w}x${o.importedHeight.h}:`;
    for (let i = 0; i < dimensions.length; i++) mixByte(dimensions.charCodeAt(i));
    for (const byte of o.importedHeight.rgba) mixByte(byte);
  }
  return hash.toString(36).padStart(25, '0');
}

export interface SizePreset { mapSize: number; grid: number; label: string }

export const SIZE_PRESETS: Record<SizeName, SizePreset> = {
  hamlet: { mapSize: 1200, grid: 300, label: 'Hamlet' },
  village: { mapSize: 1600, grid: 400, label: 'Village' },
  town: { mapSize: 2400, grid: 480, label: 'Town' },
  city: { mapSize: 3600, grid: 450, label: 'City' },
  capital: { mapSize: 5000, grid: 500, label: 'Capital' },
};

export const DEFAULTS: Options = {
  seed: '1',
  size: 'town',
  relief: 'hills',
  coast: 'none',
  river: 'river',
  siteType: 'auto',
  walls: 'auto',
  castle: 'auto',
  castles: 'auto',
  cathedral: 'auto',
  palace: 'auto',
  monasteries: 'auto',
  port: 'auto',
  arena: 'auto',
  activities: 'auto',
  suburbs: 'auto',
  shantytowns: 'auto',
  roads: 0,
  style: 'parchment',
  contours: true,
  landuse: true,
  culture: 'european-organic',
  population: 0,
  language: 'auto',
  labels: true,
  legend: false,
  heightScale: 120,
  importSea: 0,
};

/** Number of regional road exits when the `roads` option is 0 (auto). */
export const DEFAULT_ROADS: Record<SizeName, number> = { hamlet: 2, village: 3, town: 4, city: 5, capital: 6 };
export const roadCount = (o: Pick<Options, 'roads' | 'size'>): number => (o.roads > 0 ? o.roads : DEFAULT_ROADS[o.size]);

const RELIEFS: Relief[] = ['flat', 'hills', 'valley', 'mountains'];
const COASTS: CoastOpt[] = ['none', 'N', 'E', 'S', 'W', 'random'];
const RIVERS: RiverOpt[] = ['none', 'stream', 'river', 'major'];
const STYLES: StyleName[] = ['parchment', 'atlas'];
const TRIS: Tri[] = ['auto', 'yes', 'no'];
const SUBURBS: SuburbOpt[] = ['auto', 'none', 'some', 'many'];
const WALLS: WallsOpt[] = ['auto', 'yes', 'no', 'none', 'single', 'double'];
const CASTLES: CastlesOpt[] = ['auto', '0', '1', '2', '3'];
const SHANTIES: ShantyOpt[] = ['auto', 'none', 'some', 'many'];
/** M4 landmark toggles: option key → URL key. */
export const LANDMARK_TOGGLES: [keyof Options & ('cathedral' | 'palace' | 'monasteries' | 'port' | 'arena' | 'activities'), string][] = [
  ['cathedral', 'cathedral'], ['palace', 'palace'], ['monasteries', 'monasteries'], ['port', 'port'], ['arena', 'arena'], ['activities', 'activities'],
];
const SITE_TYPES: SiteType[] = ['auto', ...SITE_ARCHETYPES];
const SIZES = Object.keys(SIZE_PRESETS) as SizeName[];

/**
 * Switch the culture: the options that only make sense for the previous culture are dropped (a plan override, a
 * culture mix, explicit site preferences), so choosing a culture again always gives its own plan whatever was tried
 * in between (and the link no longer carries `plan=` / `mix=` of another culture). Same object when unchanged.
 */
export function withCulture(o: Options, culture: Options['culture']): Options {
  if (culture === o.culture) return o;
  const { plan: _p, cultureMix: _m, sitePrefs: _s, ...rest } = o;
  return { ...rest, culture };
}

export function makeOptions(partial: Partial<Options> = {}): Options {
  return { ...DEFAULTS, ...partial, seed: String(partial.seed ?? DEFAULTS.seed) };
}

function queryForOptions(o: Options, includeUid: boolean): string {
  const p = new URLSearchParams();
  p.set('seed', o.seed);
  const keys = ['size', 'relief', 'coast', 'river', 'walls', 'castle', 'roads', 'style', 'culture', 'population'] as const;
  for (const k of keys) if (o[k] !== DEFAULTS[k]) p.set(k, String(o[k]));
  if (o.biome && o.biome !== 'temperate') p.set('biome', o.biome);
  if (o.moat && o.moat !== 'auto') p.set('moat', o.moat);
  for (const [k, q] of LANDMARK_TOGGLES) if (o[k] && o[k] !== 'auto') p.set(q, String(o[k]));
  if (o.suburbs && o.suburbs !== 'auto') p.set('suburbs', o.suburbs);
  if (o.castles && o.castles !== 'auto') p.set('castles', o.castles);
  if (o.shantytowns && o.shantytowns !== 'auto') p.set('shanty', o.shantytowns);
  if (o.siteType && o.siteType !== 'auto') p.set('site', o.siteType);
  if (o.center && Number.isFinite(o.center.x) && Number.isFinite(o.center.y)) p.set('center', `${o.center.x},${o.center.y}`);
  if (o.seaLevel !== undefined) p.set('seaLevel', String(o.seaLevel));
  if (o.contours !== DEFAULTS.contours) p.set('contours', o.contours ? '1' : '0');
  if (o.landuse !== DEFAULTS.landuse) p.set('landuse', o.landuse ? '1' : '0');
  if (o.language && o.language !== 'auto') p.set('lang', o.language);
  if (o.labels === false) p.set('labels', '0');
  if (o.legend) p.set('legend', '1');
  if (o.sprawl !== undefined && o.sprawl !== 1) p.set('sprawl', String(o.sprawl));
  if (o.cultureMix) p.set('mix', mixToString(o.cultureMix));
  if (o.plan) p.set('plan', planToString(o.plan));
  if (o.mapSize !== undefined) p.set('map', String(mapSizeOf(o)));
  if (o.settlements && o.settlements !== 'auto' && !o.workflow) p.set('settl', settlementsToString(o.settlements));
  if (o.eagerPop !== undefined) p.set('eager', String(o.eagerPop));
  if (o.workflow) {
    p.set('mode', o.workflow === 'environment' ? 'e' : o.workflow === 'automatic' ? 'a' : 'l');
    if (o.workflow === 'environment') {
      const selected = o.settlementMode ?? (o.settlements && typeof o.settlements === 'object' && 'list' in o.settlements ? 'list' : 'automatic');
      p.set('compose', selected === 'list' ? 'l' : 'a');
    }
    if (o.settlements && typeof o.settlements === 'object' && 'list' in o.settlements) {
      p.set('set2', settlementListToString(o.settlements.list));
    }
    const prefs = validSitePrefs(o.sitePrefs);
    if (prefs) p.set('prefs', JSON.stringify(prefs));
    if (includeUid) p.set('uid', generationUid(o));
  }
  // the image itself is never put in the URL: only a marker plus its two scalars
  if (o.importedHeight) {
    p.set('hm', 'custom');
    p.set('hscale', String(o.heightScale ?? 120));
    p.set('hsea', String(o.importSea ?? 0));
  }
  return p.toString();
}

export function toQuery(o: Options): string { return queryForOptions(o, true); }

/** Reversible configuration + seed for compact share links; the old hash stays an internal identity. */
export function mapId(o: Options): string { return encodeMapId(queryForOptions(o, false)); }

function oneOf<T extends string>(v: string | null, list: readonly T[], def: T): T {
  return v !== null && (list as readonly string[]).includes(v) ? (v as T) : def;
}

export function fromQuery(q: string | URLSearchParams): Options {
  const p = expandMapQuery(q);
  const o = makeOptions({ seed: p.get('seed') ?? DEFAULTS.seed });
  const mode = p.get('mode');
  if (mode === 'e') o.workflow = 'environment';
  else if (mode === 'a') o.workflow = 'automatic';
  else if (mode === 'l') o.workflow = 'list';
  if (o.workflow === 'environment') {
    const compose = p.get('compose');
    o.settlementMode = compose === 'a' ? 'automatic' : compose === 'l' || p.has('set2') ? 'list' : 'automatic';
  } else if (o.workflow) o.settlementMode = o.workflow;
  o.size = oneOf(p.get('size'), SIZES, DEFAULTS.size);
  o.relief = oneOf(p.get('relief'), RELIEFS, DEFAULTS.relief);
  if (p.has('biome')) o.biome = oneOf(p.get('biome'), BIOME_NAMES, 'temperate');
  o.coast = oneOf(p.get('coast'), COASTS, DEFAULTS.coast);
  o.river = oneOf(p.get('river'), RIVERS, DEFAULTS.river);
  o.siteType = oneOf(p.get('site'), SITE_TYPES, 'auto');
  o.center = positionFromString(p.get('center'));
  o.walls = oneOf(p.get('walls'), WALLS, DEFAULTS.walls);
  if (p.has('moat')) o.moat = oneOf(p.get('moat'), TRIS, 'auto');
  o.castles = oneOf(p.get('castles'), CASTLES, 'auto');
  o.castle = oneOf(p.get('castle'), TRIS, DEFAULTS.castle);
  for (const [k, q] of LANDMARK_TOGGLES) o[k] = oneOf(p.get(q), TRIS, 'auto');
  o.suburbs = oneOf(p.get('suburbs'), SUBURBS, 'auto');
  o.shantytowns = oneOf(p.get('shanty'), SHANTIES, 'auto');
  o.style = oneOf(p.get('style'), STYLES, DEFAULTS.style);
  o.culture = oneOf(p.get('culture'), CULTURES, DEFAULTS.culture);
  const pop = Number(p.get('population'));
  o.population = Number.isFinite(pop) && pop > 0 ? Math.max(POP_MIN, Math.min(POP_MAX, Math.round(pop))) : 0;
  const ms = Number(p.get('map'));
  if (p.get('map') !== null && Number.isFinite(ms) && ms > 0) o.mapSize = Math.max(MAP_SIZE_MIN, Math.min(MAP_SIZE_MAX, Math.round(ms)));
  const ep = Number(p.get('eager'));
  if (p.get('eager') !== null && Number.isFinite(ep) && ep > 0) o.eagerPop = Math.max(1000, Math.min(POP_MAX, Math.round(ep)));
  if (o.workflow && p.has('set2')) o.settlements = { list: settlementListFromString(p.get('set2')) };
  else if (o.workflow === 'list') o.settlements = { list: [] };
  else if (!o.workflow) {
    const st = settlementsFromString(p.get('settl'));
    if (st !== 'auto') o.settlements = st;
  }
  const roads = Number(p.get('roads'));
  o.roads = Number.isFinite(roads) && p.get('roads') !== null ? Math.max(0, Math.min(8, Math.round(roads))) : 0;
  const sl = p.get('seaLevel');
  if (sl !== null && Number.isFinite(Number(sl))) o.seaLevel = Math.max(-1, Math.min(1, Number(sl)));
  const c = p.get('contours');
  o.contours = c === null ? DEFAULTS.contours : c === '1' || c === 'true';
  const lu = p.get('landuse');
  o.landuse = lu === null ? DEFAULTS.landuse : lu === '1' || lu === 'true';
  const lang = p.get('lang');
  o.language = lang !== null && (NAME_FAMILIES as string[]).includes(lang) ? (lang as NameFamily) : 'auto';
  o.labels = p.get('labels') !== '0' && p.get('labels') !== 'false';
  o.legend = p.get('legend') === '1' || p.get('legend') === 'true';
  const sp = Number(p.get('sprawl'));
  if (p.get('sprawl') !== null && Number.isFinite(sp)) o.sprawl = Math.max(0.5, Math.min(2, sp));
  o.cultureMix = mixFromString(p.get('mix')) ?? undefined;
  o.plan = planFromString(p.get('plan')) ?? undefined;
  const prefs = p.get('prefs');
  if (o.workflow && prefs && prefs.length <= 5000) {
    try { o.sitePrefs = validSitePrefs(JSON.parse(prefs)); } catch { /* malformed preference data is ignored */ }
  }
  const hs = Number(p.get('hscale')), hz = Number(p.get('hsea'));
  if (Number.isFinite(hs) && p.get('hscale') !== null) o.heightScale = Math.max(1, Math.min(9000, hs));
  if (Number.isFinite(hz) && p.get('hsea') !== null) o.importSea = Math.max(-1000, Math.min(9000, hz));
  return o;
}

/** True when the URL asks for a custom heightmap that the page cannot rebuild from the link alone. */
export const wantsCustomHeight = (q: string | URLSearchParams): boolean =>
  expandMapQuery(q).get('hm') === 'custom';

/** Parse "k=v" overrides (used by the preview script). */
export function applyOverride(o: Options, k: string, v: string): void {
  const rec = o as unknown as Record<string, unknown>;
  if (k === 'roads' || k === 'seaLevel' || k === 'population' || k === 'heightScale' || k === 'importSea' || k === 'mapSize' || k === 'sprawl' || k === 'eagerPop') rec[k] = Number(v);
  else if (k === 'center') o.center = positionFromString(v);
  else if (k === 'biome') o.biome = biomeName(v);
  else if (k === 'moat') o.moat = oneOf(v, TRIS, 'auto');
  else if (k === 'settlements' || k === 'settl') o.settlements = settlementsFromString(v);
  else if (k === 'set2') o.settlements = { list: settlementListFromString(v) };
  else if (k === 'workflow' || k === 'mode') o.workflow = v === 'e' ? 'environment' : v === 'a' ? 'automatic' : v === 'l' ? 'list' : v as Options['workflow'];
  else if (k === 'settlementMode' || k === 'compose') {
    if (v === 'a' || v === 'automatic') o.settlementMode = 'automatic';
    else if (v === 'l' || v === 'list') o.settlementMode = 'list';
  }
  else if (k === 'contours' || k === 'landuse' || k === 'labels' || k === 'legend') rec[k] = v === '1' || v === 'true';
  else if (k === 'mix' || k === 'cultureMix') o.cultureMix = mixFromString(v);
  else if (k === 'plan') o.plan = planFromString(v) ?? (() => { try { return JSON.parse(v); } catch { return null; } })();
  else rec[k] = v;
}

function positionFromString(value: string | null): Options['center'] {
  const parts = value?.split(',');
  if (!parts || parts.length !== 2 || parts.some((v) => !v.trim())) return undefined;
  const [x, y] = parts.map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}
