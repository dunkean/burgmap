import type { NameFamily } from './names/types';
import { NAME_FAMILIES } from './names/types';
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
  coast: CoastOpt;
  river: RiverOpt;
  /** Site archetype: 'auto' picks one from what the terrain offers. */
  siteType?: SiteType;
  sitePrefs?: SitePrefs;
  /** Shifts the sea inland (+) or seaward (-), range about [-1, 1]. Only used when a coast exists. */
  seaLevel?: number;
  // Placeholders for later stages
  walls: WallsOpt;
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

export function makeOptions(partial: Partial<Options> = {}): Options {
  return { ...DEFAULTS, ...partial, seed: String(partial.seed ?? DEFAULTS.seed) };
}

export function toQuery(o: Options): string {
  const p = new URLSearchParams();
  p.set('seed', o.seed);
  const keys = ['size', 'relief', 'coast', 'river', 'walls', 'castle', 'roads', 'style', 'culture', 'population'] as const;
  for (const k of keys) if (o[k] !== DEFAULTS[k]) p.set(k, String(o[k]));
  for (const [k, q] of LANDMARK_TOGGLES) if (o[k] && o[k] !== 'auto') p.set(q, String(o[k]));
  if (o.suburbs && o.suburbs !== 'auto') p.set('suburbs', o.suburbs);
  if (o.castles && o.castles !== 'auto') p.set('castles', o.castles);
  if (o.shantytowns && o.shantytowns !== 'auto') p.set('shanty', o.shantytowns);
  if (o.siteType && o.siteType !== 'auto') p.set('site', o.siteType);
  if (o.seaLevel !== undefined) p.set('seaLevel', String(o.seaLevel));
  if (o.contours !== DEFAULTS.contours) p.set('contours', o.contours ? '1' : '0');
  if (o.landuse !== DEFAULTS.landuse) p.set('landuse', o.landuse ? '1' : '0');
  if (o.language && o.language !== 'auto') p.set('lang', o.language);
  if (o.labels === false) p.set('labels', '0');
  if (o.legend) p.set('legend', '1');
  if (o.sprawl !== undefined && o.sprawl !== 1) p.set('sprawl', String(o.sprawl));
  if (o.cultureMix) p.set('mix', mixToString(o.cultureMix));
  if (o.plan) p.set('plan', planToString(o.plan));
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
  o.coast = oneOf(p.get('coast'), COASTS, DEFAULTS.coast);
  o.river = oneOf(p.get('river'), RIVERS, DEFAULTS.river);
  o.siteType = oneOf(p.get('site'), SITE_TYPES, 'auto');
  o.walls = oneOf(p.get('walls'), WALLS, DEFAULTS.walls);
  o.castles = oneOf(p.get('castles'), CASTLES, 'auto');
  o.castle = oneOf(p.get('castle'), TRIS, DEFAULTS.castle);
  for (const [k, q] of LANDMARK_TOGGLES) o[k] = oneOf(p.get(q), TRIS, 'auto');
  o.suburbs = oneOf(p.get('suburbs'), SUBURBS, 'auto');
  o.shantytowns = oneOf(p.get('shanty'), SHANTIES, 'auto');
  o.style = oneOf(p.get('style'), STYLES, DEFAULTS.style);
  o.culture = oneOf(p.get('culture'), CULTURES, DEFAULTS.culture);
  const pop = Number(p.get('population'));
  o.population = Number.isFinite(pop) && pop > 0 ? Math.min(200000, Math.round(pop)) : 0;
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
  if (k === 'roads' || k === 'seaLevel' || k === 'population' || k === 'heightScale' || k === 'importSea' || k === 'sprawl') rec[k] = Number(v);
  else if (k === 'contours' || k === 'landuse' || k === 'labels' || k === 'legend') rec[k] = v === '1' || v === 'true';
  else if (k === 'mix' || k === 'cultureMix') o.cultureMix = mixFromString(v);
  else if (k === 'plan') o.plan = planFromString(v) ?? (() => { try { return JSON.parse(v); } catch { return null; } })();
  else rec[k] = v;
}
