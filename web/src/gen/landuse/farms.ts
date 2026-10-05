/**
 * Isolated farmsteads (HANDOFF §7.6): the plan of one farm from its context, never from noise alone.
 *
 * - The farm TYPE follows the culture (a regional vernacular per culture family: Vierkanthof, longère, Low German
 *   hall house, L- and U-yards, Haufenhof, masseria; Norse longhouse, minka, Chinese court, ksar, kraal, …) and,
 *   inside a culture, the land: hall houses on wet lowland, longères in the west (Atlantic) country, closed courts on
 *   rich soil near the market, scattered yards and bank barns on slopes and exposed hills.
 * - The SIZE comes from wealth = soil, slope, wetness and distance to the market (cottage … manor farm).
 * - The plan is built in a local frame (u along the track, v away from it) as an exact partition of the LOT:
 *   farmyard zone (buildings around a coherent yard) at the front, then garden / orchard / paddock strips behind.
 *   Buildings lie inside the farmyard zone, never overlap, and the yard is reachable from the gate on the track.
 * - Orientation: the dwelling sits on the north side of the yard (facing south) when the layout allows, barns run
 *   along the contour on slopes (bank barns), ranges follow the track or the slope.
 */
import type { Rng } from '../core/rng';
import type { Vec2, Polygon, Polyline } from '../core/geom';
import type { FarmBuilding, FarmPlot, FarmSize, RoofKind } from '../types';
import type { BiomeName } from '../biomes';

export type FarmType =
  | 'vierkanthof' | 'u-yard' | 'l-yard' | 'haufenhof' | 'longere' | 'einhaus' | 'masseria' | 'dvor'
  | 'norse-longhouse' | 'roundhouse' | 'minka' | 'hanok' | 'chinese-court' | 'indian-court' | 'ksar'
  | 'sahel-compound' | 'kraal' | 'ail' | 'native-longhouse' | 'pueblo-ranch' | 'solar' | 'kancha' | 'stilt'
  | 'fungal-farm' | 'spore-farm';

export const FARM_SIZES: FarmSize[] = ['cottage', 'family', 'large', 'manor'];

/** Context of a farm site (all world-derived). */
export interface FarmContext {
  culture: string;
  biome?: BiomeName;
  /** Soil quality −1 … 1 (the land-use soil field). */
  soil: number;
  /** Smoothed slope (rise / run) and the downhill direction (world, unit) when the ground is not flat. */
  slope: number;
  downhill: Vec2 | null;
  /** 0 … 1: low ground near water. */
  wet: number;
  /** 0 … 1: prominent ground (hill tops, sea fronts). */
  exposed: number;
  /** 0 at the town edge … 1 at the far end of the farmland (travel cost). */
  market: number;
  /** Regional gradient −1 (inland / continental) … 1 (Atlantic / west country). */
  west: number;
  /** Inhabitants (planner farmsteads). */
  pop?: number;
}

type V2 = [number, number];
type Edge = 'back' | 'left' | 'right' | 'front';
interface LPart { use: string; poly: V2[]; passage?: boolean; round?: boolean }
interface LPlot { kind: FarmPlot['kind']; poly: V2[] }
/** A farm plan in the local frame: lot u ∈ [−W/2, W/2], v ∈ [0, D] (v = 0 on the track side). */
export interface LocalFarm {
  type: FarmType; size: FarmSize;
  W: number; D: number;
  parts: LPart[];
  yard: V2[];
  walls: V2[][];
  plots: LPlot[];
  trees: V2[];
  /** Gate on the lot front (u) and a point inside the yard reached from it. */
  gateU: number; entry: V2;
  tags: string[];
}
/** Local frame directions (u, v components of world unit vectors). */
interface Frame { south: V2; west: V2; down: V2 | null }
interface Ctx { c: FarmContext; f: Frame; size: FarmSize; si: number; r: Rng; slopeF: number }

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---------------------------------------------------------------- culture regimes

const REGIMES: Record<string, [FarmType, number][]> = {
  europe: [['vierkanthof', 1], ['u-yard', 1], ['l-yard', 1], ['haufenhof', 1], ['longere', 1], ['einhaus', 1]],
  hanse: [['einhaus', 2.2], ['vierkanthof', 1], ['haufenhof', 0.8], ['l-yard', 0.6], ['u-yard', 0.6]],
  bastide: [['longere', 1.5], ['masseria', 1], ['l-yard', 1], ['u-yard', 0.6], ['haufenhof', 0.5]],
  med: [['masseria', 2], ['l-yard', 0.7], ['u-yard', 0.6], ['longere', 0.4]],
  russia: [['dvor', 2.5], ['haufenhof', 0.6], ['u-yard', 0.3]],
  germanic: [['einhaus', 1.6], ['haufenhof', 1], ['norse-longhouse', 0.3]],
  norse: [['norse-longhouse', 2.5], ['haufenhof', 0.3]],
  celtic: [['roundhouse', 2.5], ['haufenhof', 0.3]],
  japan: [['minka', 1]],
  korea: [['hanok', 1]],
  china: [['chinese-court', 1]],
  india: [['indian-court', 1]],
  islam: [['ksar', 2], ['masseria', 0.3]],
  ottoman: [['masseria', 1.2], ['ksar', 1]],
  sahel: [['sahel-compound', 1]],
  kraal: [['kraal', 1]],
  steppe: [['ail', 1]],
  iroquois: [['native-longhouse', 1]],
  pueblo: [['pueblo-ranch', 1]],
  meso: [['solar', 1]],
  andes: [['kancha', 1]],
  stilt: [['stilt', 1]],
  underdark: [['fungal-farm', 1]],
  myconid: [['spore-farm', 1]],
};
const CULTURE_REGIME: Record<string, string> = {
  hanseatic: 'hanse', bastide: 'bastide', 'roman-core': 'med', 'byzantine-greek': 'med', 'venetian-lagoon': 'med',
  'russian-kremlin': 'russia', barbarian: 'germanic', 'barbarian-norse': 'norse', 'norse-ringfort': 'norse',
  'barbarian-celtic': 'celtic', 'celtic-oppidum': 'celtic', 'japanese-jokamachi': 'japan', korean: 'korea', chinese: 'china',
  'indian-temple': 'india', medina: 'islam', persian: 'islam', ottoman: 'ottoman', sahel: 'sahel', kraal: 'kraal', orcish: 'kraal',
  'nomad-camp': 'steppe', 'native-plains': 'steppe', 'native-iroquoian': 'iroquois', 'native-pueblo': 'pueblo', maya: 'meso', aztec: 'meso',
  inca: 'andes', khmer: 'stilt', 'stilt-town': 'stilt', dwarven: 'europe', elven: 'europe', halfling: 'europe', gnomish: 'europe',
  'drow-enclave': 'underdark', 'duergar-hold': 'underdark', 'myconid-colony': 'myconid',
};
/** Farm types the culture builds (its rural vernacular). */
export function farmRegime(culture: string): [FarmType, number][] {
  return REGIMES[CULTURE_REGIME[culture] ?? 'europe'];
}

/** Wealth → size class (soil, slope, wetness, distance to market; planner farmsteads by their population). */
export function farmSize(c: FarmContext, r: Rng): FarmSize {
  const slopeF = clamp01(c.slope / 0.16);
  let w = 0.45 * c.soil + 0.45 * (0.45 - c.market) - 0.45 * slopeF - 0.3 * c.wet + 0.36 * (r.float() - 0.5);
  if (c.pop !== undefined) w += (c.pop - 8) / 14;
  return w < -0.3 ? 'cottage' : w < 0.04 ? 'family' : w < 0.2 ? 'large' : 'manor';
}

/** Context affinity of a type (multiplies the culture weight). */
function affinity(t: FarmType, c: FarmContext, size: FarmSize): number {
  const slopeF = clamp01(c.slope / 0.16), rich = clamp01((c.soil + 1) / 2), near = 1 - c.market, westF = clamp01(0.5 + c.west);
  const small = size === 'cottage', big = size === 'large' || size === 'manor';
  switch (t) {
    case 'vierkanthof': return small ? 0 : (0.3 + 1.7 * rich) * (0.5 + near) * (1.25 - 0.8 * westF) * (1 - 0.7 * slopeF) * (big ? 1.5 : 0.8);
    case 'u-yard': return small ? 0.15 : (0.5 + rich) * (1 - 0.5 * slopeF) * (big ? 1.2 : 1);
    case 'l-yard': return 0.6 + 1.8 * slopeF;
    case 'haufenhof': return (0.35 + 1.1 * slopeF + 0.6 * (1 - rich) + 0.8 * c.exposed) * (size === 'manor' ? 0.4 : 1);
    case 'longere': return (0.2 + 1.5 * westF) * (0.7 + 0.6 * (1 - rich)) * (size === 'manor' ? 0.3 : small ? 1.4 : 1) * (1 - 0.5 * slopeF);
    case 'einhaus': return 0.2 + 3 * c.wet + 0.4 * clamp01(1 - 2 * slopeF) * (1 - westF);
    case 'masseria': return (0.6 + 0.8 * (1 - westF)) * (1 + 0.5 * c.exposed);
    default: return 1;
  }
}

/** Type of a farm: the culture's vernacular weighted by the site (a context-driven draw: plausible types only). */
export function farmType(c: FarmContext, size: FarmSize, r: Rng): FarmType {
  if (c.biome === 'underdark') return c.culture === 'myconid-colony' ? 'spore-farm' : 'fungal-farm';
  let best: FarmType = farmRegime(c.culture)[0][0], bs = -1;
  for (const [t, w] of farmRegime(c.culture)) {
    const s = w * affinity(t, c, size) * (0.45 + r.float());
    if (s > bs) { bs = s; best = t; }
  }
  return best;
}

// ---------------------------------------------------------------- dress (arch + roof metadata)

interface Dress { arch: string; roof: RoofKind; material: string; roofs?: Record<string, RoofKind>; names?: Record<string, string>; mats?: Record<string, string> }
const DRESS: Record<FarmType, Dress> = {
  vierkanthof: { arch: 'vierkanthof', roof: 'gable', material: 'brick', roofs: { house: 'hip' } },
  'u-yard': { arch: 'dreiseithof', roof: 'gable', material: 'timber-frame' },
  'l-yard': { arch: 'hakenhof', roof: 'gable', material: 'stone' },
  haufenhof: { arch: 'haufenhof', roof: 'gable', material: 'timber-frame', roofs: { house: 'hip' } },
  longere: { arch: 'longere', roof: 'gable', material: 'stone', roofs: { 'lean-to': 'flat' } },
  einhaus: { arch: 'hallenhaus', roof: 'hip', material: 'timber-frame', names: { house: 'hall-house' } },
  masseria: { arch: 'masseria', roof: 'flat', material: 'stone', roofs: { barn: 'gable', byre: 'gable' } },
  dvor: { arch: 'izba', roof: 'gable', material: 'log', names: { house: 'izba', barn: 'ambar' } },
  'norse-longhouse': { arch: 'norse', roof: 'gable', material: 'turf', roofs: { 'pit-house': 'gable' } },
  roundhouse: { arch: 'celtic', roof: 'conical', material: 'wattle', roofs: { granary: 'pyramidal' } },
  minka: { arch: 'minka', roof: 'hip', material: 'thatch', roofs: { storehouse: 'gable' }, names: { storehouse: 'kura', gatehouse: 'nagaya-mon' }, mats: { storehouse: 'plaster' } },
  hanok: { arch: 'hanok', roof: 'tiled-hip', material: 'timber', roofs: { barn: 'gable', shed: 'gable' }, names: { house: 'anchae', byre: 'oeyanggan' } },
  'chinese-court': { arch: 'siheyuan', roof: 'gable', material: 'brick', names: { house: 'zhengfang', byre: 'xiangfang', 'cart-shed': 'daozuofang' } },
  'indian-court': { arch: 'indian-court', roof: 'flat', material: 'mudbrick', roofs: { byre: 'gable' } },
  ksar: { arch: 'ksar', roof: 'flat', material: 'mudbrick', roofs: { tower: 'flat' } },
  'sahel-compound': { arch: 'sahel', roof: 'conical', material: 'mudbrick', roofs: { house: 'flat' } },
  kraal: { arch: 'kraal', roof: 'thatch-round', material: 'wattle' },
  ail: { arch: 'ger', roof: 'dome', material: 'felt', roofs: { shed: 'gable' } },
  'native-longhouse': { arch: 'iroquoian', roof: 'barrel', material: 'bark', roofs: { granary: 'gable' } },
  'pueblo-ranch': { arch: 'pueblo', roof: 'flat', material: 'adobe', roofs: { shed: 'flat' } },
  solar: { arch: 'solar', roof: 'hip', material: 'thatch', roofs: { granary: 'conical', bath: 'dome' } },
  kancha: { arch: 'kancha', roof: 'gable', material: 'stone' },
  stilt: { arch: 'stilt', roof: 'gable', material: 'bamboo' },
  'fungal-farm': { arch: 'fungal-farm', roof: 'flat', material: 'dark-stone', names: { house: 'dwelling', barn: 'cultivation-hall', byre: 'spore-store', shed: 'store' } },
  'spore-farm': { arch: 'spore-farm', roof: 'dome', material: 'fungal', names: { roundhouse: 'dwelling', hut: 'cultivation-pod', byre: 'cultivation-pod', granary: 'spore-store' } },
};

function dress(t: FarmType, p: LPart, tags: string[]): Omit<FarmBuilding, 'poly'> {
  const d = DRESS[t];
  const use = p.use;
  let arch = `${d.arch}-${d.names?.[use] ?? use}`;
  let roof: RoofKind = d.roofs?.[use] ?? d.roof;
  if (use === 'dovecote') { arch = 'dovecote'; roof = p.round ? 'conical' : 'pyramidal'; }
  else if (use === 'tower') { arch = `${d.arch}-tower`; roof = 'flat'; }
  else if (use === 'barn' && tags.includes('bank-barn')) arch = 'bank-barn';
  else if (use === 'hut' || use === 'roundhouse' || use === 'ger') roof = d.roof === 'dome' ? 'dome' : d.roof === 'conical' ? 'conical' : 'thatch-round';
  if (p.round && roof === 'gable') roof = 'conical';
  const storeys = use === 'tower' ? 3 : use === 'house' && (t === 'masseria' || t === 'vierkanthof' || t === 'dvor') ? 2 : 1;
  const out: Omit<FarmBuilding, 'poly'> = { use, arch, roof, storeys, material: d.mats?.[use] ?? d.material };
  if (t === 'fungal-farm' || t === 'spore-farm') {
    if (use === 'barn' || use === 'byre' || use === 'hut') out.use = 'cultivation';
    else if (use === 'granary' || use === 'shed') out.use = 'spore-store';
  }
  if (tags.includes('wet') && (t === 'stilt' || t === 'native-longhouse' || t === 'solar')) out.arch += '-raised';
  if (p.passage) out.passage = true;
  return out;
}

// ---------------------------------------------------------------- geometry helpers (local frame)

const R = (u0: number, v0: number, u1: number, v1: number): V2[] => {
  const a = Math.min(u0, u1), b = Math.max(u0, u1), c = Math.min(v0, v1), d = Math.max(v0, v1);
  return [[a, c], [b, c], [b, d], [a, d]];
};
/** Rectangle centred at (cu, cv), long axis `len` at angle `a` (local). */
const rotRect = (cu: number, cv: number, len: number, dep: number, a: number): V2[] => {
  const c = Math.cos(a), s = Math.sin(a);
  return ([[-len / 2, -dep / 2], [len / 2, -dep / 2], [len / 2, dep / 2], [-len / 2, dep / 2]] as V2[]).map(([x, y]) => [cu + x * c - y * s, cv + x * s + y * c]);
};
const circle = (cu: number, cv: number, r: number, k = 10): V2[] => {
  const out: V2[] = [];
  for (let i = 0; i < k; i++) { const a = (i / k) * 2 * Math.PI; out.push([cu + r * Math.cos(a), cv + r * Math.sin(a)]); }
  return out;
};
/** Bow-sided (Norse) or round-ended (Iroquoian) longhouse, convex. */
const longhouse = (cu: number, cv: number, len: number, dep: number, a: number, kind: 'bow' | 'round'): V2[] => {
  const pts: V2[] = [];
  if (kind === 'bow') {
    const k = 5;
    for (let i = 0; i <= k; i++) { const x = -len / 2 + (len * i) / k; const t = (2 * i) / k - 1; pts.push([x, -(dep / 2) * (1 - 0.32 * t * t)]); }
    for (let i = k; i >= 0; i--) { const x = -len / 2 + (len * i) / k; const t = (2 * i) / k - 1; pts.push([x, (dep / 2) * (1 - 0.32 * t * t)]); }
  } else {
    const rr = dep / 2, h = len / 2 - rr;
    for (let i = 0; i <= 4; i++) { const t = -Math.PI / 2 + (i / 4) * Math.PI; pts.push([h + rr * Math.cos(t), rr * Math.sin(t)]); }
    for (let i = 0; i <= 4; i++) { const t = Math.PI / 2 + (i / 4) * Math.PI; pts.push([-h + rr * Math.cos(t), rr * Math.sin(t)]); }
  }
  const c = Math.cos(a), s = Math.sin(a);
  return pts.map(([x, y]) => [cu + x * c - y * s, cv + x * s + y * c]);
};

/** Separating-axis overlap test of two convex polygons, with clearance `gap`. */
function overlaps(a: V2[], b: V2[], gap = 0): boolean {
  for (const P of [a, b]) {
    for (let i = 0; i < P.length; i++) {
      const p = P[i], q = P[(i + 1) % P.length];
      let nx = -(q[1] - p[1]), ny = q[0] - p[0];
      const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [x, y] of a) { const d = x * nx + y * ny; if (d < a0) a0 = d; if (d > a1) a1 = d; }
      for (const [x, y] of b) { const d = x * nx + y * ny; if (d < b0) b0 = d; if (d > b1) b1 = d; }
      if (a1 + gap <= b0 + 1e-6 || b1 + gap <= a0 + 1e-6) return false;
    }
  }
  return true;
}
const bboxOf = (ps: V2[][]): [number, number, number, number] => {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const P of ps) for (const [x, y] of P) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
  return [a, b, c, d];
};
const shift = (P: V2[], du: number, dv: number): V2[] => P.map(([x, y]) => [x + du, y + dv]);
/** Segment from p to q crosses the convex polygon P (strictly inside). */
function segHits(p: V2, q: V2, P: V2[]): boolean {
  const seg: V2[] = [p, q, [q[0] + 1e-4, q[1] + 1e-4]];
  return overlaps(seg, P, 0.25);
}

/** Footprint dimensions [length, depth] (m) by use and size (house 8–14 × 6–9, barn 15–30 × 8–12, sheds smaller). */
function dims(use: string, si: number, r: Rng): [number, number] {
  const T: Record<string, [V2, V2][]> = {
    house: [[[8, 10], [6, 7]], [[10, 13], [6.5, 8]], [[12, 14], [7, 9]], [[13, 14], [8, 9]]],
    barn: [[[15, 16], [8, 8.5]], [[16, 22], [8, 10]], [[20, 28], [9, 11]], [[24, 30], [10, 12]]],
    byre: [[[8, 10], [5.5, 6.5]], [[10, 14], [6, 8]], [[12, 16], [7, 8]], [[14, 18], [7, 9]]],
  };
  const t = T[use === 'stable' ? 'byre' : use];
  if (t) { const [[a, b], [c, d]] = t[si]; return [r.range(a, b), r.range(c, d)]; }
  switch (use) {
    case 'cart-shed': return [r.range(7, 10), r.range(5, 6)];
    case 'lean-to': return [r.range(4, 7), r.range(2.5, 3.5)];
    case 'granary': case 'storehouse': return [r.range(4.5, 6.5), r.range(4, 5)];
    case 'bakehouse': return [r.range(4, 6), r.range(3.5, 5)];
    default: return [r.range(4.5, 8), r.range(3, 5.5)]; // shed
  }
}

// ---------------------------------------------------------------- layouts

interface Zone { parts: LPart[]; yard: V2[]; walls: V2[][]; gateU: number; entry: V2; W: number; D: number; houseU: number }

/** North-ness of an outward edge normal (the dwelling on that edge faces south across the yard). */
const N: Record<Edge, V2> = { back: [0, 1], left: [-1, 0], right: [1, 0], front: [0, -1] };
const dot = (a: V2, b: V2): number => a[0] * b[0] + a[1] * b[1];

/**
 * Ranges around a rectangular yard on the given edges (U-, L-, closed courts, masserias, siheyuan): the dwelling on
 * the northern edge, the barn along the contour on slopes (bank barn) or on the windward side, a gate in the front.
 */
function court(x: Ctx, edges: Edge[], tags: string[], o: { walled?: boolean; gateEnd?: boolean; tower?: boolean; uses?: string[]; depth?: number; yard?: [number, number]; dovecote?: boolean } = {}): Zone {
  const { r, si, f } = x;
  const side = edges.filter((e) => e !== 'front');
  const north = (e: Edge) => -dot(N[e], f.south);
  let houseE = side[0];
  for (const e of side) if (north(e) + 0.02 * (e === 'back' ? 1 : 0) > north(houseE)) houseE = e;
  const rest = side.filter((e) => e !== houseE);
  let barnE: Edge | undefined;
  if (rest.length) {
    barnE = rest[0];
    for (const e of rest) {
      const tang: V2 = [N[e][1], -N[e][0]];
      const sc = (q: Edge, t: V2) => (f.down && x.slopeF > 0.25 ? -Math.abs(dot(t, f.down)) : dot(N[q], f.west));
      if (sc(e, tang) > sc(barnE, [N[barnE][1], -N[barnE][0]])) barnE = e;
    }
    if (f.down && x.slopeF > 0.35) {
      const tb: V2 = [N[barnE][1], -N[barnE][0]];
      if (Math.abs(dot(tb, f.down)) < 0.5) tags.push('bank-barn');
    }
  }
  const uses = o.uses ?? ['house', 'barn', 'byre', 'stable'];
  const role = new Map<Edge, string>();
  role.set(houseE, uses[0]);
  if (barnE) role.set(barnE, uses[1]);
  let k = 2;
  for (const e of rest) if (e !== barnE) role.set(e, uses[Math.min(uses.length - 1, k++)]);
  if (edges.includes('front')) role.set('front', 'cart-shed');
  const depthOf = (use: string): number => o.depth ?? (use === 'cart-shed' ? r.range(5, 6.5) : dims(use, si, r)[1]);
  const dE: Record<Edge, number> = { back: 0, left: 0, right: 0, front: 0 };
  for (const e of edges) dE[e] = depthOf(role.get(e)!);
  const yr = o.yard ?? ([[11, 15], [15, 21], [19, 26], [24, 32]] as V2[])[si];
  let Yw = r.range(yr[0], yr[1]), Yd = r.range(yr[0], yr[1]) * 0.95;
  const lenOf = (use: string) => dims(use, si, r)[0];
  // the barn's edge is as long as the barn (15–30 m)
  if (barnE && (uses[1] === 'barn')) {
    const lb = lenOf('barn');
    if (barnE === 'back') Yw = Math.max(Yw, lb - dE.left - dE.right); else Yd = Math.max(Yd, Math.min(30, lb));
  }
  const wallM = o.walled ? 1.5 : 0;
  const fM = 2 + wallM;
  const yv0 = fM + dE.front, yv1 = yv0 + Yd;
  const uL = -Yw / 2 - dE.left, uR = Yw / 2 + dE.right;
  const parts: LPart[] = [];
  /** Fill a range band [a, b] along its edge with the role, then secondary uses in the remainder. */
  const fill = (e: Edge, a: number, b: number, d0: number, d1: number, first: string, startHigh: boolean) => {
    const along = e === 'back' || e === 'front';
    const L = b - a;
    const seq: string[] = [first];
    if (first === 'house' || first === 'tower') seq.push(si >= 1 ? 'byre' : 'shed', 'shed');
    else if (first === 'barn') seq.push(si >= 2 ? 'cart-shed' : 'shed');
    else seq.push('shed', 'shed');
    if (o.tower && first === 'house') seq.unshift('tower');
    let pos = 0;
    for (const use of seq) {
      const rem = L - pos;
      if (rem < 4) break;
      let len = use === 'tower' ? 8 : Math.min(rem, use === first ? Math.max(lenOf(use), use === 'barn' ? 15 : 0) : lenOf(use));
      const maxL = use === 'barn' ? 30 : use === 'byre' || use === 'stable' ? 18 : 10;
      if (use === first && first !== 'house' && first !== 'tower' && rem - len < 4 && rem <= maxL) len = rem; // a range fills its edge
      if (use === 'house' && rem - len < 4 && rem - len > 0) len = Math.min(14, rem);
      const p0 = startHigh ? b - pos - len : a + pos, p1 = p0 + len;
      const poly = along ? R(p0, d0, p1, d1) : R(d0, p0, d1, p1);
      // a shed bay in a deep range is a cart shed
      parts.push({ use: use === 'shed' && len * Math.abs(d1 - d0) > 40 ? 'cart-shed' : use, poly });
      pos += len + (use === 'tower' ? 0 : r.chance(0.3) ? r.range(1.5, 3) : 0);
    }
  };
  for (const e of edges) {
    const use = role.get(e)!;
    if (e === 'back') fill(e, uL, uR, yv1 + dE.back, yv1, use, r.chance(0.5));
    else if (e === 'left') fill(e, yv0, yv1, uL, -Yw / 2, use, true);
    else if (e === 'right') fill(e, yv0, yv1, uR, Yw / 2, use, true);
  }
  // front range: gate gap (centre, or the east end for Chinese courts), a gatehouse on manors
  let gateU = 0;
  if (o.gateEnd) gateU = (f.west[0] > 0 ? -1 : 1) * (Yw / 2 - 4.2);
  if (edges.includes('front')) {
    const g = 2.2;
    const gh = x.size === 'manor' || (o.walled && si >= 2);
    if (gh) parts.push({ use: 'gatehouse', poly: R(gateU - 3.5, fM, gateU + 3.5, yv0), passage: true });
    const gl = gh ? 3.5 : g, a = gateU - gl, b = gateU + gl;
    // the front range halves: cart sheds (long), sheds (short), the manor's stable
    if (a - uL >= 4) parts.push({ use: si >= 2 || a - uL > 9 ? 'cart-shed' : 'shed', poly: R(uL, fM, a, yv0) });
    if (uR - b >= 4) parts.push({ use: si >= 3 ? 'stable' : uR - b > 9 ? 'cart-shed' : 'shed', poly: R(b, fM, uR, yv0) });
  } else if (x.size === 'manor' && o.walled) {
    parts.push({ use: 'gatehouse', poly: R(gateU - 3.5, 0.5, gateU + 3.5, fM + 3.5), passage: true });
  }
  const yard = R(-Yw / 2, yv0, Yw / 2, yv1);
  // dovecote in the yard corner away from the gate (manors; some large farms)
  if (o.dovecote && (x.size === 'manor' || (si === 2 && r.chance(0.35)))) {
    const cu = (gateU >= 0 ? -1 : 1) * (Yw / 2 - 3.5), cv = yv1 - 3.5;
    parts.push({ use: 'dovecote', poly: r.chance(0.5) ? circle(cu, cv, 2.4, 12) : R(cu - 2.2, cv - 2.2, cu + 2.2, cv + 2.2), round: true });
  }
  const walls: V2[][] = [];
  const W = uR - uL + 2 * wallM, D = yv1 + dE.back + wallM;
  if (o.walled) {
    const w0 = uL - wallM * 0.6, w1 = uR + wallM * 0.6, v0 = wallM * 0.6, v1 = D - wallM * 0.4;
    const gw = 2.2;
    walls.push([[gateU - gw, v0], [w0, v0], [w0, v1], [w1, v1], [w1, v0], [gateU + gw, v0]]);
  }
  const hp = parts.find((p) => p.use === 'house');
  const houseU = hp ? (bboxOf([hp.poly])[0] + bboxOf([hp.poly])[2]) / 2 : 0;
  // centre the zone on u = 0
  const cu = (uL + uR) / 2;
  const sh = (P: V2[]) => shift(P, -cu, 0);
  return {
    parts: parts.map((p) => ({ ...p, poly: sh(p.poly) })), yard: sh(yard), walls: walls.map(sh), gateU: gateU - cu,
    entry: [gateU - cu, yv0 + 1.5], W, D, houseU: houseU - cu,
  };
}

/** One long range (longère, pueblo rooms): along the contour on slopes, else facing south across its court. */
function range(x: Ctx, tags: string[], uses: string[], depth: number): Zone {
  const { r, f, si } = x;
  const alongV = f.down && x.slopeF > 0.3 ? Math.abs(f.down[0]) > Math.abs(f.down[1]) : Math.abs(f.south[0]) > Math.abs(f.south[1]) + 0.2;
  const lens = uses.map((u) => (u === 'room' ? r.range(4.5, 6.5) : dims(u, si, r)[0]));
  const T = lens.reduce((a, b) => a + b, 0);
  const Yc = r.range(10, 15);
  const parts: LPart[] = [];
  const fM = 2;
  let p = 0;
  let W: number, D: number, entry: V2, gateU: number, yard: V2[];
  if (!alongV) {
    // range parallel to the track: at the back with the court in front when the front faces south, else at the front
    const back = f.south[1] <= 0.15;
    const lane = back ? 0 : 4.5;
    W = T + lane + 2;
    const u0 = -W / 2 + 1 + (back ? 0 : 0);
    const v0 = back ? fM + Yc : fM, v1 = v0 + depth;
    uses.forEach((use, i) => { parts.push({ use: use === 'room' ? (i === 0 ? 'house' : 'storeroom') : use, poly: R(u0 + p, v0, u0 + p + lens[i], v1) }); p += lens[i]; });
    yard = back ? R(-W / 2 + 1, fM, W / 2 - 1, v0) : R(-W / 2 + 1, v1, W / 2 - 1, v1 + Yc);
    D = back ? v1 + (si === 0 ? 4 : 1) : v1 + Yc + 1;
    gateU = back ? 0 : W / 2 - 1 - lane / 2;
    entry = back ? [0, fM + Yc / 2] : [gateU, v1 + 2];
  } else {
    // range across the track (gable to it), the court on its south side
    const left = f.south[0] > 0;
    W = depth + Yc + 2;
    const a = left ? -W / 2 + 1 : W / 2 - 1 - depth;
    uses.forEach((use, i) => { parts.push({ use: use === 'room' ? (i === 0 ? 'house' : 'storeroom') : use, poly: R(a, fM + p, a + depth, fM + p + lens[i]) }); p += lens[i]; });
    const ya = left ? a + depth : -W / 2 + 1, yb = left ? W / 2 - 1 : a;
    yard = R(ya, fM, yb, fM + T);
    D = fM + T + 1;
    gateU = (ya + yb) / 2;
    entry = [gateU, fM + 3];
  }
  // a lean-to behind the house of small farms
  if (uses[0] === 'house' && si === 0) {
    const hb = bboxOf([parts[0].poly]);
    const l = r.range(4, 6);
    const lp = !alongV ? (f.south[1] <= 0.15 ? R(hb[0] + 1, hb[3], hb[0] + 1 + l, hb[3] + 3) : null) : null;
    if (lp && lp[2][1] <= D - 0.5) parts.push({ use: 'lean-to', poly: lp });
  }
  // a detached outbuilding across the court
  const yb = bboxOf([yard]);
  if (yb[2] - yb[0] > 12 && yb[3] - yb[1] > 9) {
    const [l, d] = dims(si >= 2 ? 'cart-shed' : 'bakehouse', si, r);
    const cu = gateU > (yb[0] + yb[2]) / 2 ? yb[0] + l / 2 + 1 : yb[2] - l / 2 - 1;
    const near = !alongV && f.south[1] <= 0.15 ? yb[1] + d / 2 + 1 : yb[3] - d / 2 - 1;
    const pp = !alongV ? R(cu - l / 2, near - d / 2, cu + l / 2, near + d / 2) : null;
    if (pp) parts.push({ use: si >= 2 ? 'cart-shed' : 'bakehouse', poly: pp });
  }
  const hp = parts[0];
  return { parts, yard, walls: [], gateU, entry, W, D, houseU: (bboxOf([hp.poly])[0] + bboxOf([hp.poly])[2]) / 2 };
}

/** Low German hall house (Einhaus): one great aisled house, gable and threshing door to the yard, outbuildings around. */
function hall(x: Ctx, tags: string[]): Zone {
  const { r, si, f } = x;
  const w = [r.range(9, 11), r.range(12, 14), r.range(13, 15), r.range(14, 16)][si];
  const L = [r.range(14, 18), r.range(20, 27), r.range(27, 34), r.range(33, 40)][si];
  const Yd = r.range(9, 13);
  const fM = 2;
  const parts: LPart[] = [{ use: 'house', poly: R(-w / 2, fM + Yd, w / 2, fM + Yd + L) }];
  let uMin = -w / 2, uMax = w / 2;
  // barn beside the hall (large farms), on the windward side; a second one on manors
  const westSide = f.west[0] < 0 ? -1 : 1;
  if (si >= 2) {
    const [bl, bd] = dims('barn', si, r);
    const a = westSide < 0 ? -w / 2 - 6 - bd : w / 2 + 6;
    parts.push({ use: 'barn', poly: R(a, fM + Yd + 2, a + bd, fM + Yd + 2 + bl) });
    uMin = Math.min(uMin, a); uMax = Math.max(uMax, a + bd);
  }
  if (si >= 3) {
    const [bl, bd] = dims('byre', si, r);
    const a = westSide < 0 ? w / 2 + 6 : -w / 2 - 6 - bd;
    parts.push({ use: 'byre', poly: R(a, fM + Yd + 2, a + bd, fM + Yd + 2 + bl) });
    uMin = Math.min(uMin, a); uMax = Math.max(uMax, a + bd);
  }
  // small buildings at the yard corners: granary (Spieker), bakehouse, sheep shed
  const small = si === 0 ? ['shed'] : si === 1 ? ['granary', 'bakehouse'] : ['granary', 'bakehouse', 'shed'];
  small.forEach((use, i) => {
    const [l, d] = dims(use, si, r);
    const sgn = i % 2 === 0 ? -westSide : westSide;
    const a = sgn < 0 ? uMin - 4 - l : uMax + 4;
    const v0 = fM + 1 + (i >= 2 ? Yd + 4 : r.range(0, 2));
    parts.push({ use, poly: R(a, v0, a + l, v0 + d) });
    if (sgn < 0) uMin = Math.min(uMin, a); else uMax = Math.max(uMax, a + l);
  });
  if (x.size === 'manor') {
    parts.push({ use: 'dovecote', poly: circle(0 + (westSide < 0 ? w / 2 + 3 : -w / 2 - 3), fM + 3.5, 2.3, 12), round: true });
  }
  const bb = bboxOf(parts.map((p) => p.poly));
  const cu = (bb[0] + bb[2]) / 2;
  const W = bb[2] - bb[0] + 2, D = bb[3] + 1;
  const yard = R(-w / 2 - 2 - cu, fM, w / 2 + 2 - cu, fM + Yd);
  if (x.c.wet > 0.35) tags.push('warft');
  return { parts: parts.map((p) => ({ ...p, poly: shift(p.poly, -cu, 0) })), yard, walls: [], gateU: -cu, entry: [-cu, fM + Yd / 2], W, D, houseU: -cu };
}

/** Russian dvor: izba with its gable to the track, the covered yard behind it, ambar and bathhouse apart. */
function dvor(x: Ctx): Zone {
  const { r, si } = x;
  const [hl, hd] = [r.range(8, 11), r.range(6.5, 8.5)];
  const cl = [r.range(8, 10), r.range(10, 14), r.range(13, 17), r.range(15, 20)][si];
  const fM = 2;
  const lane = r.range(5, 7);
  const parts: LPart[] = [
    { use: 'house', poly: R(0, fM, hd, fM + hl) },
    { use: 'covered-yard', poly: R(0, fM + hl, hd + 1, fM + hl + cl) },
  ];
  const ou = hd + 1 + lane;
  const [al, ad] = dims('granary', si, r);
  parts.push({ use: 'barn', poly: R(ou, fM + 4, ou + ad + 1, fM + 4 + al + 1) });
  if (si >= 1) parts.push({ use: 'bath', poly: R(ou, fM + hl + cl - 4.5, ou + 4, fM + hl + cl) });
  if (si >= 2) { const [sl, sd] = dims('shed', si, r); parts.push({ use: 'shed', poly: R(ou, fM + 6 + al + 2, ou + sd, fM + 6 + al + 2 + sl) }); }
  const bb = bboxOf(parts.map((p) => p.poly));
  const cu = (bb[0] + bb[2]) / 2;
  const yard = R(hd + 1 - cu, fM, ou - cu, fM + hl + cl);
  return { parts: parts.map((p) => ({ ...p, poly: shift(p.poly, -cu, 0) })), yard, walls: [], gateU: hd + 1 + lane / 2 - cu, entry: [hd + 1 + lane / 2 - cu, fM + 3], W: bb[2] - bb[0] + 2, D: bb[3] + 1, houseU: hd / 2 - cu };
}

interface Item { use: string; len: number; dep: number; shape?: 'rect' | 'bow' | 'round' | 'circle' }
/**
 * Buildings scattered round an open yard (Haufenhof, Norse farm, Maya solar, stilt farm, longhouse homestead): the
 * dwelling at the back, the others around the yard facing it, the front sector kept open for the way in; on slopes
 * the long buildings follow the contour.
 */
function scatter(x: Ctx, items: Item[], o: { parallel?: boolean } = {}): Zone {
  const { r, f } = x;
  const Ry = 5 + 1.1 * items.length + r.range(0, 2.5);
  const contour = f.down && x.slopeF > 0.3 ? Math.atan2(f.down[0], -f.down[1]) : null; // perpendicular to downhill
  const ew = Math.atan2(-f.south[0], f.south[1]); // long axis east–west (perpendicular to south)
  const slots = [90, 20, 160, -28, -152, 55, 125, 0, 180, -60, -120];
  const parts: LPart[] = [];
  const placed: V2[][] = [];
  const front = -90;
  items.forEach((it, i) => {
    let a = slots[i % slots.length] + r.range(-12, 12);
    if (Math.abs(((a - front + 540) % 360) - 180) < 40) a += 40;
    const ar = (a * Math.PI) / 180;
    let ang = o.parallel ? (contour ?? ew) : ar + Math.PI / 2 + r.range(-0.15, 0.15);
    if (!o.parallel && contour !== null && it.len > 9) ang = contour + r.range(-0.1, 0.1);
    for (let k = 0; k < 10; k++) {
      const d = Ry + (it.shape === 'circle' ? it.len / 2 : Math.max(it.dep, Math.abs(Math.sin(ang - ar)) * it.len) / 2) + 1.5 + 2.5 * k;
      const cu = Math.cos(ar) * d, cv = Ry + 2 + Math.sin(ar) * d;
      const poly = it.shape === 'circle' ? circle(cu, cv, it.len / 2, 12) : it.shape === 'bow' || it.shape === 'round' ? longhouse(cu, cv, it.len, it.dep, ang, it.shape === 'bow' ? 'bow' : 'round') : rotRect(cu, cv, it.len, it.dep, ang);
      if (placed.some((P) => overlaps(P, poly, 2.5))) continue;
      // keep the way in from the front open
      if (segHits([0, -50], [0, Ry + 2], poly)) continue;
      parts.push({ use: it.use, poly, round: it.shape === 'circle' });
      placed.push(poly);
      break;
    }
  });
  const yardC: V2 = [0, Ry + 2];
  const bb = bboxOf([...parts.map((p) => p.poly), circle(yardC[0], yardC[1], Ry * 0.8)]);
  const fM = 2;
  const du = -(bb[0] + bb[2]) / 2, dv = fM - bb[1];
  const hp = parts.find((p) => p.use === 'house' || p.use === 'longhouse' || p.use === 'hall');
  return {
    parts: parts.map((p) => ({ ...p, poly: shift(p.poly, du, dv) })), yard: shift(circle(yardC[0], yardC[1], Ry * 0.8, 12), du, dv), walls: [],
    gateU: du, entry: [du, yardC[1] + dv], W: bb[2] - bb[0] + 2, D: bb[3] - bb[1] + fM + 1, houseU: hp ? (bboxOf([hp.poly])[0] + bboxOf([hp.poly])[2]) / 2 + du : du,
  };
}

/** Round enclosures: kraal (huts round the cattle byre), Sahel compound, steppe ail, Celtic roundhouse farm. */
function ring(x: Ctx, kind: FarmType, plots: LPlot[]): Zone {
  const { r, si } = x;
  const fM = 2;
  const parts: LPart[] = [];
  const walls: V2[][] = [];
  let Ro: number;
  const ringPts = (cx: number, cy: number, rad: number, gapA: number, gapW: number): V2[] => {
    const out: V2[] = [];
    const k = 28;
    for (let i = 0; i <= k; i++) {
      const a = gapA + gapW / 2 + (i / k) * (2 * Math.PI - gapW);
      out.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
    }
    return out;
  };
  const front = -Math.PI / 2;
  if (kind === 'roundhouse') {
    Ro = [r.range(13, 16), r.range(16, 20), r.range(19, 24), r.range(23, 28)][si];
    const c: V2 = [0, fM + Ro + 1];
    const n = si >= 2 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const dia = i === 0 ? [r.range(8, 10), r.range(9, 12), r.range(11, 13), r.range(12, 14)][si] : r.range(7, 9);
      const a = Math.PI / 2 + (i === 0 ? 0 : (r.chance(0.5) ? 1 : -1) * 1.3);
      const d = i === 0 ? Ro * 0.25 : Ro - dia / 2 - 2.5;
      parts.push({ use: i === 0 ? 'roundhouse' : 'byre', poly: circle(c[0] + Math.cos(a) * d * (i === 0 ? 0 : 1), c[1] + Math.sin(a) * d, dia / 2, 14), round: true });
    }
    const ng = 1 + si;
    for (let i = 0; i < ng; i++) {
      const a = front + 0.9 + i * 0.55 + r.range(-0.1, 0.1), s = r.range(2.6, 3.4), d = Ro - 4;
      const p = rotRect(c[0] + Math.cos(a) * d, c[1] + Math.sin(a) * d, s, s, a);
      if (!parts.some((q) => overlaps(q.poly, p, 1))) parts.push({ use: 'granary', poly: p });
    }
    walls.push(ringPts(c[0], c[1], Ro, front, 0.32));
    return { parts, yard: circle(c[0], c[1], Ro - 1, 16), walls, gateU: 0, entry: [0, fM + 4], W: 2 * Ro + 3, D: 2 * Ro + fM + 2, houseU: 0 };
  }
  // kraal / compound / ail: huts on a ring round the centre (the cattle byre for the kraal)
  const nHut = kind === 'ail' ? [1, 2, 3, 4][si] : [2, r.int(3, 4), r.int(5, 6), r.int(7, 9)][si];
  const hutR = kind === 'ail' ? r.range(2.8, 3.6) : kind === 'sahel-compound' ? r.range(2.2, 2.8) : r.range(2.3, 3);
  const pen = kind === 'kraal' ? [4, 5, 7, 9][si] : kind === 'ail' ? [4, 5, 6, 7][si] : 0;
  const Rh = Math.max(pen + hutR + 3.5, (nHut * (2 * hutR + 2.2)) / (2 * Math.PI - 1.2));
  Ro = Rh + hutR + 2.5;
  const c: V2 = [0, fM + Ro + 1];
  const span = 2 * Math.PI - 1.2;
  for (let i = 0; i < nHut; i++) {
    const a = front + 0.6 + (span * (i + 0.5)) / nHut;
    const big = i === Math.floor(nHut / 2);
    if (kind === 'sahel-compound' && big && si >= 1) {
      parts.push({ use: 'house', poly: rotRect(c[0] + Math.cos(a) * Rh, c[1] + Math.sin(a) * Rh, 8, 5, a + Math.PI / 2) });
    } else parts.push({ use: kind === 'ail' ? 'ger' : 'hut', poly: circle(c[0] + Math.cos(a) * Rh, c[1] + Math.sin(a) * Rh, big ? hutR * 1.2 : hutR, 12), round: true });
  }
  if (kind !== 'ail') {
    const ng = kind === 'sahel-compound' ? 2 + si : si;
    for (let i = 0; i < ng; i++) {
      const a = front + 0.45 + (span * (i + 1)) / (ng + 1), d = Rh - hutR - 2.2;
      const p = circle(c[0] + Math.cos(a) * d, c[1] + Math.sin(a) * d, 1.2, 8);
      if (!parts.some((q) => overlaps(q.poly, p, 0.6)) && d > pen + 2) parts.push({ use: 'granary', poly: p, round: true });
    }
  }
  if (pen) {
    const pp = ringPts(c[0], c[1], pen, Math.PI / 2, 0.5);
    walls.push(pp);
    plots.push({ kind: 'pen', poly: circle(c[0], c[1], pen - 0.3, 16) });
  }
  if (kind !== 'ail') walls.push(ringPts(c[0], c[1], Ro, front, 0.32));
  return { parts, yard: circle(c[0], c[1], Ro - 0.8, 16), walls, gateU: 0, entry: [0, c[1] - pen - 1.5], W: 2 * Ro + 3, D: 2 * Ro + fM + 2, houseU: 0 };
}

/** Ksar farm: a mud-walled square with corner towers, rooms along the inner walls, a gate passage, the court inside. */
function ksar(x: Ctx): Zone {
  const { r, si } = x;
  const Q = [r.range(18, 22), r.range(24, 30), r.range(30, 36), r.range(36, 44)][si];
  const t = si >= 1 ? 4.5 : 0;
  const d = r.range(4, 4.5); // rooms no deeper than the towers
  const fM = 2;
  const a = -Q / 2, b = Q / 2, v0 = fM, v1 = fM + Q;
  const parts: LPart[] = [];
  if (t) for (const [cu, cv] of [[a, v1], [b, v1], ...(si >= 2 ? [[a, v0], [b, v0]] : [])] as V2[]) parts.push({ use: 'tower', poly: R(cu === a ? a : b - t, cv === v0 ? v0 : v1 - t, cu === a ? a + t : b, cv === v0 ? v0 + t : v1) });
  const tf = si >= 2 ? t : 0;
  parts.push({ use: 'house', poly: R(a + t, v1 - d, b - t, v1) });
  parts.push({ use: 'storeroom', poly: R(a, v0 + tf, a + d, v1 - t) });
  parts.push({ use: 'byre', poly: R(b - d, v0 + tf, b, v1 - t) });
  const g = 2;
  if (si >= 3) parts.push({ use: 'gatehouse', poly: R(-3.5, v0, 3.5, v0 + d), passage: true });
  const gl = si >= 3 ? 3.5 : g;
  const e = Math.max(d, tf);
  if (-gl - (a + e) >= 3) parts.push({ use: 'storeroom', poly: R(a + e, v0, -gl, v0 + d) });
  if (b - e - gl >= 3) parts.push({ use: 'shed', poly: R(gl, v0, b - e, v0 + d) });
  const walls: V2[][] = [[[-g, v0], [a, v0], [a, v1], [b, v1], [b, v0], [g, v0]]];
  return { parts, yard: R(a + d, v0 + d, b - d, v1 - d), walls, gateU: 0, entry: [0, v0 + d + 2], W: Q + 2, D: v1 + 1, houseU: 0 };
}

function zoneOf(x: Ctx, type: FarmType, tags: string[], plots: LPlot[]): Zone {
  const { si, r } = x;
  switch (type) {
    case 'fungal-farm': return court(x, ['back', 'left'], tags, { walled: si >= 2, uses: ['house', si === 0 ? 'byre' : 'barn'] });
    case 'spore-farm': return ring(x, 'roundhouse', plots);
    case 'vierkanthof': return court(x, ['back', 'left', 'right', 'front'], tags, { walled: false, dovecote: true });
    case 'u-yard': return court(x, ['back', 'left', 'right'], tags, { walled: si >= 2, dovecote: true });
    case 'l-yard': return court(x, ['back', x.f.west[0] < 0 ? 'left' : 'right'], tags, { walled: si >= 3, uses: ['house', si === 0 ? 'byre' : 'barn'], dovecote: true });
    case 'masseria': return si === 0 ? court(x, ['back', 'left'], tags, { walled: true, uses: ['house', 'byre'] }) : court(x, ['back', 'left', 'right'], tags, { walled: true, tower: si >= 2, dovecote: true });
    case 'chinese-court': return court(x, si >= 2 ? ['back', 'left', 'right', 'front'] : si === 1 ? ['back', 'left', 'right'] : ['back', 'left'], tags, { walled: si >= 1, gateEnd: true, uses: ['house', 'byre', 'byre', 'shed'] });
    case 'indian-court': return court(x, si >= 2 ? ['back', 'left', 'right', 'front'] : ['back', 'left', 'right'], tags, { walled: si <= 1, uses: ['house', 'byre', 'storeroom'], depth: si >= 2 ? 5 : undefined });
    case 'kancha': return court(x, si >= 1 ? ['back', 'left', 'right', 'front'] : ['back', 'left'], tags, { walled: true, uses: ['house', 'house', 'storeroom'], depth: 5.5, yard: [[9, 12], [11, 15], [14, 19], [18, 24]][si] as [number, number] });
    case 'minka': return court(x, si >= 2 ? ['back', 'left', 'right'] : ['back', 'left'], tags, { walled: si >= 3, uses: ['house', 'storehouse', 'barn'], yard: [[10, 13], [12, 16], [15, 20], [18, 24]][si] as [number, number] });
    case 'hanok': return court(x, si >= 2 ? ['back', 'left', 'right'] : ['back', 'left'], tags, { walled: true, uses: ['house', 'byre', 'storehouse'] });
    case 'haufenhof': {
      const it: Item[] = [{ use: 'house', ...ld('house') }];
      if (si >= 1) it.push({ use: 'barn', ...ld('barn') }, { use: 'byre', ...ld('byre') });
      it.push({ use: 'shed', ...ld('shed') });
      if (si >= 1) it.push({ use: 'bakehouse', ...ld('bakehouse') });
      if (si >= 2) it.push({ use: 'granary', ...ld('granary') }, { use: 'barn', ...ld('barn') });
      if (si >= 3) it.push({ use: 'stable', ...ld('stable') }, { use: 'dovecote', len: 4.6, dep: 4.6, shape: 'circle' });
      return scatter(x, it);
    }
    case 'norse-longhouse': {
      const lh = [r.range(14, 18), r.range(20, 28), r.range(28, 36), r.range(36, 45)][si];
      const it: Item[] = [{ use: 'longhouse', len: lh, dep: r.range(5.5, 7.5) + si * 0.4, shape: 'bow' }];
      if (si >= 1) it.push({ use: 'barn', len: r.range(12, 16), dep: r.range(5.5, 7), shape: 'bow' });
      for (let i = 0; i < 1 + si; i++) it.push({ use: 'pit-house', len: r.range(3.5, 4.5), dep: r.range(3, 3.5) });
      if (si >= 2) it.push({ use: 'smithy', len: 5, dep: 4 }, { use: 'storehouse', ...ld('storehouse') });
      return scatter(x, it);
    }
    case 'native-longhouse': {
      const n = [1, 1, 2, 3][si];
      const it: Item[] = [];
      for (let i = 0; i < n; i++) it.push({ use: i === 0 ? 'house' : 'longhouse', len: r.range(18, 22) + si * 5, dep: r.range(6, 7), shape: 'round' });
      for (let i = 0; i < 1 + si; i++) it.push({ use: 'granary', len: 3, dep: 3 });
      return scatter(x, it, { parallel: true });
    }
    case 'solar': {
      const it: Item[] = [{ use: 'house', len: r.range(8, 10), dep: r.range(5, 6), shape: 'round' }, { use: 'kitchen', len: 5, dep: 4 }, { use: 'granary', len: 3.2, dep: 3.2, shape: 'circle' }];
      for (let i = 0; i < si; i++) it.push({ use: 'house', len: r.range(8, 10), dep: r.range(5, 6), shape: 'round' });
      if (si >= 1) it.push({ use: 'bath', len: 3, dep: 3, shape: 'circle' });
      return scatter(x, it);
    }
    case 'stilt': {
      const it: Item[] = [{ use: 'house', len: r.range(8, 12), dep: r.range(5, 7) }, { use: 'granary', len: 3.5, dep: 3 }, { use: 'byre', len: r.range(6, 8), dep: r.range(4, 5) }];
      for (let i = 0; i < si; i++) it.push({ use: i % 2 ? 'shed' : 'house', len: r.range(7, 10), dep: r.range(5, 6) });
      return scatter(x, it, { parallel: true });
    }
    case 'pueblo-ranch': return range(x, tags, Array.from({ length: 2 + si * 2 }, () => 'room'), 5);
    case 'longere': {
      const uses = si === 0 ? ['house', 'byre'] : si === 1 ? ['house', 'byre', 'barn'] : si === 2 ? ['house', 'byre', 'barn', 'stable'] : ['house', 'house', 'stable', 'barn', 'barn'];
      return range(x, tags, uses, si === 0 ? r.range(6.5, 7.5) : r.range(8, 9));
    }
    case 'einhaus': return hall(x, tags);
    case 'dvor': return dvor(x);
    case 'ksar': return ksar(x);
    case 'roundhouse': case 'kraal': case 'sahel-compound': case 'ail': return ring(x, type, plots);
  }
  function ld(use: string) { const [len, dep] = dims(use, si, r); return { len, dep }; }
}

// ---------------------------------------------------------------- lot: zone + garden / orchard / paddock

const HOME = new Set(['house', 'longhouse', 'roundhouse', 'hut', 'ger']);
const ARID = new Set<FarmType>(['ksar', 'masseria', 'pueblo-ranch', 'sahel-compound', 'indian-court']);
const NO_ORCHARD = new Set<FarmType>(['kraal', 'ail', 'sahel-compound', 'roundhouse', 'norse-longhouse', 'native-longhouse', 'pueblo-ranch']);

/**
 * Local plan of a farm of type `type` and size `size`. `south`, `west`, `down` are the world directions in the local
 * frame (u along the track, v inward).
 */
export function layoutFarm(type: FarmType, size: FarmSize, c: FarmContext, frame: Frame, r: Rng): LocalFarm {
  const subterranean = c.biome === 'underdark' || type === 'fungal-farm' || type === 'spore-farm';
  const si = FARM_SIZES.indexOf(size);
  const x: Ctx = { c, f: frame, size, si, r, slopeF: clamp01(c.slope / 0.16) };
  const tags: string[] = [];
  if (x.slopeF > 0.35) tags.push('slope');
  if (c.wet > 0.35) tags.push('wet');
  if (c.exposed > 0.5) tags.push('exposed');
  const plots: LPlot[] = [];
  const z = zoneOf(x, type, tags, plots);
  // safety: drop parts that overlap an earlier one or block the way in (never the dwelling)
  const parts: LPart[] = [];
  let home = false;
  for (const p of z.parts) {
    const essential = !home && HOME.has(p.use);
    if (essential) home = true;
    if (!essential && parts.some((q) => overlaps(q.poly, p.poly, 0))) continue;
    if (!p.passage && !essential && segHits([z.gateU, -1], z.entry, p.poly)) continue;
    parts.push(p);
  }
  const side = c.exposed > 0.5 ? 4 : 2;
  const W = Math.max(z.W, 14) + 2 * side;
  // back zone: garden next to the dwelling, orchard (or paddock on wet ground) beside it, pond by context
  const Db = c.wet > 0.55 && si === 0 ? 0 : [r.range(12, 18), r.range(18, 26), r.range(24, 32), r.range(30, 40)][si];
  const Dz = z.D;
  const D = Dz + Db;
  const lotPlots: LPlot[] = [{ kind: 'farmyard', poly: R(-W / 2, 0, W / 2, Dz) }];
  const trees: V2[] = [];
  let pondHost: V2[] | null = null;
  if (Db > 0) {
    const gShare = si === 0 ? 0.6 : 0.4;
    const gSide = Math.abs(z.houseU) > 2 ? Math.sign(z.houseU) : frame.south[0] >= 0 ? 1 : -1;
    const gw = W * gShare;
    const g = gSide > 0 ? R(W / 2 - gw, Dz, W / 2, D) : R(-W / 2, Dz, -W / 2 + gw, D);
    const o = gSide > 0 ? R(-W / 2, Dz, W / 2 - gw, D) : R(-W / 2 + gw, Dz, W / 2, D);
    const orchard = !subterranean && !NO_ORCHARD.has(type) && c.wet < 0.55;
    lotPlots.push({ kind: 'garden', poly: g }, { kind: orchard ? 'orchard' : 'paddock', poly: o });
    pondHost = o;
    if (orchard) {
      const ob = bboxOf([o]);
      const sp = ARID.has(type) ? 8 : 7;
      for (let u = ob[0] + 3; u <= ob[2] - 3; u += sp) for (let v = ob[1] + 3.5; v <= ob[3] - 2.5; v += sp) trees.push([u + r.range(-0.6, 0.6), v + r.range(-0.6, 0.6)]);
    }
  }
  // pond: on wet ground, far from running water, or the manor's fish pond, in the downhill corner of the back zone
  if (pondHost && (c.wet > 0.3 || si === 3 || type === 'stilt') && !ARID.has(type)) {
    const ob = bboxOf([pondHost]);
    const pr = Math.min(si === 3 ? r.range(6, 8) : r.range(3.5, 5.5), (ob[2] - ob[0]) / 2 - 2, (ob[3] - ob[1]) / 2 - 2);
    if (pr > 2.5) {
      const du = frame.down ? frame.down[0] : r.chance(0.5) ? 1 : -1, dv = frame.down ? frame.down[1] : 1;
      const cu = du >= 0 ? ob[2] - pr - 2 : ob[0] + pr + 2, cv = dv >= 0 ? ob[3] - pr - 2 : ob[1] + pr + 2;
      const pond = circle(cu, cv, pr, 14);
      lotPlots.push({ kind: 'pond', poly: pond });
      for (let i = trees.length - 1; i >= 0; i--) if (Math.hypot(trees[i][0] - cu, trees[i][1] - cv) < pr + 2.5) trees.splice(i, 1);
    }
  }
  // threshing floor of the dry-country farms (in the paddock / beside the court)
  if ((type === 'masseria' || type === 'ksar') && pondHost) {
    const ob = bboxOf([pondHost]);
    const tr = Math.min(5, (ob[3] - ob[1]) / 2 - 1.5, (ob[2] - ob[0]) / 2 - 1.5);
    if (tr > 3) {
      const cu = (ob[0] + ob[2]) / 2, cv = (ob[1] + ob[3]) / 2;
      lotPlots.push({ kind: 'threshing-floor', poly: circle(cu, cv, tr, 12) });
      for (let i = trees.length - 1; i >= 0; i--) if (Math.hypot(trees[i][0] - cu, trees[i][1] - cv) < tr + 2.5) trees.splice(i, 1);
    }
  }
  // shelter belt on the windward (west) edges of exposed farms
  if (c.exposed > 0.5 && !subterranean) {
    const edges: [V2, V2, V2][] = [[[-W / 2 + 1.5, 1], [-W / 2 + 1.5, D - 1], [-1, 0]], [[W / 2 - 1.5, 1], [W / 2 - 1.5, D - 1], [1, 0]], [[-W / 2 + 1, D - 1.5], [W / 2 - 1, D - 1.5], [0, 1]]];
    for (const [a, b, n] of edges) {
      if (dot(n, frame.west) < 0.3) continue;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let s = 0; s <= L; s += 5) {
        const p: V2 = [a[0] + ((b[0] - a[0]) * s) / L, a[1] + ((b[1] - a[1]) * s) / L];
        const blocked = parts.some((q) => overlaps(q.poly, circle(p[0], p[1], 1.8, 6), 0)) || lotPlots.some((q) => q.kind === 'pond' && overlaps(q.poly, circle(p[0], p[1], 1.8, 6), 0));
        if (!blocked && Math.abs(p[0] - z.gateU) > 4) trees.push(p);
      }
    }
  }
  if (tags.includes('wet') || tags.includes('warft')) plots.push({ kind: 'platform', poly: R(-W / 2 + 0.5, 0.5, W / 2 - 0.5, Dz - 0.5) });
  if (subterranean) {
    tags.push('fungal-cultivation');
    for (const plot of [...lotPlots, ...plots]) if (['orchard', 'paddock', 'pen', 'threshing-floor'].includes(plot.kind)) plot.kind = 'garden';
  }
  // centre the zone's parts in the (possibly wider) lot
  return {
    type, size, W, D, parts, yard: z.yard, walls: z.walls, plots: [...lotPlots, ...plots], trees, gateU: z.gateU, entry: z.entry, tags,
  };
}

/** World geometry of a local plan: lot front middle at `origin`, `inward` = unit vector from the track into the lot. */
export function placeFarm(lf: LocalFarm, t: FarmType, origin: Vec2, inward: Vec2): {
  lot: Polygon; parts: FarmBuilding[]; yard: Polygon; walls: Polyline[]; plots: FarmPlot[]; trees: Vec2[]; gate: Vec2; entry: Vec2; angle: number;
} {
  const U = { x: inward.y, y: -inward.x };
  const P = ([u, v]: V2): Vec2 => ({ x: origin.x + u * U.x + v * inward.x, y: origin.y + u * U.y + v * inward.y });
  const poly = (Q: V2[]): Polygon => Q.map(P);
  return {
    lot: poly(R(-lf.W / 2, 0, lf.W / 2, lf.D)),
    parts: lf.parts.map((p) => ({ poly: poly(p.poly), ...dress(t, p, lf.tags) })),
    yard: poly(lf.yard),
    walls: lf.walls.map(poly),
    plots: lf.plots.map((p) => ({ kind: p.kind, poly: poly(p.poly) })),
    trees: lf.trees.map(P),
    gate: P([lf.gateU, 0]),
    entry: P(lf.entry),
    angle: Math.atan2(U.y, U.x),
  };
}

/** Local frame directions of the world south, west and downhill for a lot facing `inward`. */
export function frameOf(inward: Vec2, downhill: Vec2 | null): Frame {
  const U = { x: inward.y, y: -inward.x };
  const loc = (w: Vec2): V2 => [w.x * U.x + w.y * U.y, w.x * inward.x + w.y * inward.y];
  return { south: loc({ x: 0, y: 1 }), west: loc({ x: -1, y: 0 }), down: downhill ? loc(downhill) : null };
}

/** Distance from segment ab to the axis-aligned rectangle [u0,u1]×[v0,v1] (0 when they intersect). */
export function segRectDist(ax: number, ay: number, bx: number, by: number, u0: number, v0: number, u1: number, v1: number): number {
  // clip test (Liang–Barsky)
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  if (clip(-dx, ax - u0) && clip(dx, u1 - ax) && clip(-dy, ay - v0) && clip(dy, v1 - ay) && t0 <= t1) return 0;
  const pr = (px: number, py: number): number => { const dU = Math.max(u0 - px, 0, px - u1), dV = Math.max(v0 - py, 0, py - v1); return Math.hypot(dU, dV); };
  const ps = (px: number, py: number): number => {
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  };
  return Math.min(pr(ax, ay), pr(bx, by), ps(u0, v0), ps(u1, v0), ps(u1, v1), ps(u0, v1));
}
