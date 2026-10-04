import type { NameFamily } from './names/types';
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
/** One explicitly listed secondary settlement. */
export interface SettlementSpec {
  population: number;
  /** Culture preset id (default: the main culture). */
  culture?: string;
  siteType?: SiteArchetype;
  /** Fixed position (meters); otherwise placed by site scoring. */
  position?: { x: number; y: number };
}
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

export function toQuery(o: Options): string {
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
  if (o.settlements && o.settlements !== 'auto') p.set('settl', settlementsToString(o.settlements));
  if (o.eagerPop !== undefined) p.set('eager', String(o.eagerPop));
  // the image itself is never put in the URL: only a marker plus its two scalars
  if (o.importedHeight) {
    p.set('hm', 'custom');
    p.set('hscale', String(o.heightScale ?? 120));
    p.set('hsea', String(o.importSea ?? 0));
  }
  return p.toString();
}

function oneOf<T extends string>(v: string | null, list: readonly T[], def: T): T {
  return v !== null && (list as readonly string[]).includes(v) ? (v as T) : def;
}

export function fromQuery(q: string | URLSearchParams): Options {
  const p = typeof q === 'string' ? new URLSearchParams(q.startsWith('?') ? q.slice(1) : q) : q;
  const o = makeOptions({ seed: p.get('seed') ?? DEFAULTS.seed });
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
  const st = settlementsFromString(p.get('settl'));
  if (st !== 'auto') o.settlements = st;
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
  const hs = Number(p.get('hscale')), hz = Number(p.get('hsea'));
  if (Number.isFinite(hs) && p.get('hscale') !== null) o.heightScale = Math.max(1, Math.min(9000, hs));
  if (Number.isFinite(hz) && p.get('hsea') !== null) o.importSea = Math.max(-1000, Math.min(9000, hz));
  return o;
}

/** True when the URL asks for a custom heightmap that the page cannot rebuild from the link alone. */
export const wantsCustomHeight = (q: string | URLSearchParams): boolean =>
  (typeof q === 'string' ? new URLSearchParams(q.startsWith('?') ? q.slice(1) : q) : q).get('hm') === 'custom';

/** Parse "k=v" overrides (used by the preview script). */
export function applyOverride(o: Options, k: string, v: string): void {
  const rec = o as unknown as Record<string, unknown>;
  if (k === 'roads' || k === 'seaLevel' || k === 'population' || k === 'heightScale' || k === 'importSea' || k === 'mapSize' || k === 'sprawl' || k === 'eagerPop') rec[k] = Number(v);
  else if (k === 'center') o.center = positionFromString(v);
  else if (k === 'biome') o.biome = biomeName(v);
  else if (k === 'moat') o.moat = oneOf(v, TRIS, 'auto');
  else if (k === 'settlements' || k === 'settl') o.settlements = settlementsFromString(v);
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
