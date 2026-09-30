export type SizeName = 'hamlet' | 'village' | 'town' | 'city' | 'capital';
export type Relief = 'flat' | 'hills' | 'valley' | 'mountains';
export type CoastOpt = 'none' | 'N' | 'E' | 'S' | 'W' | 'random';
export type RiverOpt = 'none' | 'stream' | 'river' | 'major';
export type StyleName = 'parchment' | 'atlas';
export type Tri = 'auto' | 'yes' | 'no';

export interface Options {
  seed: string;
  size: SizeName;
  relief: Relief;
  coast: CoastOpt;
  river: RiverOpt;
  /** Shifts the sea inland (+) or seaward (-), range about [-1, 1]. Only used when a coast exists. */
  seaLevel?: number;
  // Placeholders for later stages
  walls: Tri;
  castle: Tri;
  /** Number of regional road exits; 0 = automatic. */
  roads: number;
  style: StyleName;
  contours: boolean;
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
  walls: 'auto',
  castle: 'auto',
  roads: 0,
  style: 'parchment',
  contours: true,
};

const RELIEFS: Relief[] = ['flat', 'hills', 'valley', 'mountains'];
const COASTS: CoastOpt[] = ['none', 'N', 'E', 'S', 'W', 'random'];
const RIVERS: RiverOpt[] = ['none', 'stream', 'river', 'major'];
const STYLES: StyleName[] = ['parchment', 'atlas'];
const TRIS: Tri[] = ['auto', 'yes', 'no'];
const SIZES = Object.keys(SIZE_PRESETS) as SizeName[];

export function makeOptions(partial: Partial<Options> = {}): Options {
  return { ...DEFAULTS, ...partial, seed: String(partial.seed ?? DEFAULTS.seed) };
}

export function toQuery(o: Options): string {
  const p = new URLSearchParams();
  p.set('seed', o.seed);
  const keys = ['size', 'relief', 'coast', 'river', 'walls', 'castle', 'roads', 'style'] as const;
  for (const k of keys) if (o[k] !== DEFAULTS[k]) p.set(k, String(o[k]));
  if (o.seaLevel !== undefined) p.set('seaLevel', String(o.seaLevel));
  if (o.contours !== DEFAULTS.contours) p.set('contours', o.contours ? '1' : '0');
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
  o.walls = oneOf(p.get('walls'), TRIS, DEFAULTS.walls);
  o.castle = oneOf(p.get('castle'), TRIS, DEFAULTS.castle);
  o.style = oneOf(p.get('style'), STYLES, DEFAULTS.style);
  const roads = Number(p.get('roads'));
  o.roads = Number.isFinite(roads) && p.get('roads') !== null ? Math.max(0, Math.min(8, Math.round(roads))) : 0;
  const sl = p.get('seaLevel');
  if (sl !== null && Number.isFinite(Number(sl))) o.seaLevel = Math.max(-1, Math.min(1, Number(sl)));
  const c = p.get('contours');
  o.contours = c === null ? DEFAULTS.contours : c === '1' || c === 'true';
  return o;
}

/** Parse "k=v" overrides (used by the preview script). */
export function applyOverride(o: Options, k: string, v: string): void {
  const rec = o as unknown as Record<string, unknown>;
  if (k === 'roads' || k === 'seaLevel') rec[k] = Number(v);
  else if (k === 'contours') rec[k] = v === '1' || v === 'true';
  else rec[k] = v;
}
