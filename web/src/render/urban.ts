/** SVG rendering of the urban layer (streets as space, blocks, plots, building masses, walls). */
import { townBridgesSvg } from './townbridges';
import type { World, PolyH, UrbanWall } from '../gen/types';
import type { Polygon } from '../gen/core/geom';
import type { Palette } from './styles';
import { f1, pathD } from './util';
import { area } from '../gen/geo/poly';

const phD = (p: PolyH): string => pathD(p.outer, true) + p.holes.map((h) => pathD(h, true)).join('');

const DEBUG_PHASE = ['#e8a0a0', '#e8d08a', '#a8d8a0', '#9cc4e8', '#c8a8e0', '#e0b890'];

function hash(i: number): string {
  const h = (i * 137.508) % 360;
  return `hsl(${h.toFixed(0)},55%,70%)`;
}

export function urbanDebugLayer(world: World, u: number): string {
  const dbg = (world.debug?.urban ?? null) as { quarters: { poly: Polygon; phase: number; lab: number[] }[] } | null;
  const ub = world.urban;
  if (!ub) return '';
  let s = '<g class="layer-urban-debug">';
  if (ub.parcels.length) {
    ub.parcels.forEach((pc, i) => {
      const fill = pc.use === 'garden' ? '#9fc98a' : pc.use === 'plot' ? hash(i * 7 + 3) : '#fff';
      s += `<path d="${pathD(pc.poly, true)}" fill="${fill}" stroke="#333" stroke-width="${f1(0.18 * u)}"/>`;
    });
    ub.blocks.forEach((b) => { s += `<path d="${pathD(b, true)}" fill="none" stroke="#000" stroke-width="${f1(0.45 * u)}"/>`; });
    if (ub.masses.length) s += `<path d="${ub.masses.map(phD).join('')}" fill="#000" fill-opacity="0.45" fill-rule="evenodd"/>`;
  } else if (ub.blocks.length) {
    ub.blocks.forEach((b, i) => { s += `<path d="${pathD(b, true)}" fill="${hash(i)}" stroke="#333" stroke-width="${f1(0.3 * u)}"/>`; });
  } else if (dbg) {
    for (const q of dbg.quarters) s += `<path d="${pathD(q.poly, true)}" fill="${DEBUG_PHASE[(q.phase - 1) % DEBUG_PHASE.length]}" fill-opacity="0.8" stroke="none"/>`;
    for (const q of dbg.quarters) {
      const n = q.poly.length;
      for (let i = 0; i < n; i++) {
        const a = q.poly[i], b = q.poly[(i + 1) % n];
        const l = q.lab[i];
        const col = l >= 0 ? '#222' : l === -2 ? '#c00' : l === -3 ? '#06c' : '#999';
        s += `<path d="M${f1(a.x)} ${f1(a.y)}L${f1(b.x)} ${f1(b.y)}" stroke="${col}" stroke-width="${f1((l >= 0 ? 0.9 : 1.6) * u)}"/>`;
      }
    }
  }
  for (const sq of ub.squares) s += `<path d="${pathD(sq, true)}" fill="none" stroke="#f0f" stroke-width="${f1(1 * u)}"/>`;
  for (const w of ub.walls ?? []) {
    s += `<path d="${pathD(w.path, w.closed)}" fill="none" stroke="#800" stroke-width="${f1(1.5 * u)}"/>`;
    for (const g of w.gates) s += `<circle cx="${f1(g.x)}" cy="${f1(g.y)}" r="${f1(5 * u)}" fill="#800"/>`;
  }
  s += '</g>';
  return s;
}

function patterns(pal: Palette): string {
  const U = pal.urban;
  const W = 6;
  return `<defs><pattern id="p-ugarden" patternUnits="userSpaceOnUse" width="${W}" height="${W}" patternTransform="rotate(28)">` +
    `<path d="M0.6 1.5H3.4M3.2 4.5H5.6" stroke="${U.gardenInk}" stroke-width="0.35" stroke-linecap="round" opacity="0.7"/></pattern>` +
    `<pattern id="p-ugrave" patternUnits="userSpaceOnUse" width="5" height="4"><path d="M1.2 1.2V2.8M0.6 1.8H1.8M3.7 3.1V3.9M3.3 3.4H4.1" stroke="${U.gardenInk}" stroke-width="0.25" opacity="0.8"/></pattern>` +
    `<pattern id="p-upave" patternUnits="userSpaceOnUse" width="3" height="3"><circle cx="1.5" cy="1.5" r="0.28" fill="${U.placeInk}" opacity="0.55"/></pattern></defs>`;
}

/** Direction of the nearest edge of a ring at p (for square towers). */
function edgeDir(ring: Polygon, p: { x: number; y: number }): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    const d = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    if (d < bd) { bd = d; best = Math.atan2(dy, dx); }
  }
  return best;
}

/** Straight curtain bands with mitred joins, towers at the vertices (round or square), flanking gate towers. */
export function wallSvg(w: UrbanWall, ink: string, fill: string, wallScale = 1, towerScale = 1): string {
  const th = w.thickness * wallScale;
  const d = (w.pieces ?? [w.path]).map((p) => pathD(p, false)).join('');
  let s = `<g class="u-walls"><path d="${d}" fill="none" stroke="${ink}" stroke-width="${f1(th + 1.4)}" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="6"/>` +
    `<path d="${d}" fill="none" stroke="${fill}" stroke-width="${f1(Math.max(0.6, th - 1))}" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="6"/>`;
  const tower = (t: { x: number; y: number }, r: number): string => {
    if (w.towerShape !== 'square') return `<circle cx="${f1(t.x)}" cy="${f1(t.y)}" r="${f1(r)}"/>`;
    const a = edgeDir(w.path, t), c = Math.cos(a), sn = Math.sin(a), h = r * 0.95;
    const pts = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, y]) => `${f1(t.x + x * c - y * sn)} ${f1(t.y + x * sn + y * c)}`);
    return `<path d="M${pts.join('L')}Z"/>`;
  };
  const tr = w.thickness * 1.6 * towerScale;
  const tw = w.towers.map((t, i) => tower(t, tr * (w.towerScale?.[i] ?? 1))).join('');
  const gt = (w.gateTowers ?? []).map((t) => tower(t, tr * 0.93)).join('');
  s += `<g fill="${fill}" stroke="${ink}" stroke-width="0.9">${tw}${gt}</g></g>`;
  return s;
}

const hex2 = (h: string): [number, number, number] => { const v = parseInt(h.slice(1, 7), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
const rgb2 = (c: number[]): string => '#' + c.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
const mixHex = (a: string, b: string, t: number): string => { const A = hex2(a), B = hex2(b); return rgb2(A.map((x, i) => x + (B[i] - x) * t)); };
const lumHex = (h: string): number => { const [r, g, b] = hex2(h); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };

/** Landmark building kinds (drawn distinctly, not as ordinary roofs). */
export const LANDMARK_KINDS = new Set(['church', 'cathedral', 'landmark']);

/**
 * Buildings drawn one by one: a roof tone varied slightly per building and a crisp dark outline, so shared party
 * walls show and the fabric reads cellular (cadastre / watabou) instead of one dark blob. Colours come from the
 * style tokens: a light `mass` is the roof itself (outlined with the darker of `massEdge` or a shade of it); an ink
 * `mass` (parchment) is lifted toward the yard colour into a warm roof tone and outlined with the ink.
 */
function buildingsSvg(ub: NonNullable<World['urban']>, U: Palette['urban'], lw: (m: number, px: number) => string): string {
  const lm = lumHex(U.mass);
  const base = lm < 0.3 ? mixHex(U.mass, U.yard, 0.42) : U.mass;
  const edge = lm < 0.3 ? mixHex(U.mass, '#000000', 0.25) : lumHex(U.massEdge) < lm ? U.massEdge : mixHex(U.mass, '#000000', 0.6);
  const tones = (ub.renderHints?.storeyShade ? [-0.32, -0.22, -0.12, -0.03, 0.08] : [-0.09, -0.045, 0, 0.045, 0.09]).map((k) => (k < 0 ? mixHex(base, '#000000', -k) : mixHex(base, '#ffffff', k)));
  const buckets: string[][] = tones.map(() => []);
  ub.buildings.forEach((b, i) => {
    if (LANDMARK_KINDS.has(b.kind)) return;
    // (terraced room blocks: the tone follows the storeys, lighter at the plaza, darker at the high back rows)
    const h = ub.renderHints?.storeyShade && b.storeys ? Math.max(0, Math.min(tones.length - 1, tones.length - b.storeys)) : (Math.imul(i + 1, 2654435761) >>> 0) % tones.length;
    buckets[h].push(pathD(b.poly, true));
  });
  const ew = lw(Math.max(0.28, U.massEdgeW * 0.9), 0.22);
  let s = `<g class="u-buildings" stroke="${edge}" stroke-width="${ew}" stroke-linejoin="miter">`;
  buckets.forEach((list, k) => { if (list.length) s += `<path d="${list.join('')}" fill="${tones[k]}"/>`; });
  s += '</g>';
  // landmarks: church / cathedral as a darker, hatched mass with a cross
  const ch = ub.buildings.filter((b) => LANDMARK_KINDS.has(b.kind));
  if (ch.length) {
    const d = ch.map((b) => pathD(b.poly, true)).join('');
    s += `<defs><pattern id="p-lmhatch" patternUnits="userSpaceOnUse" width="1.6" height="1.6" patternTransform="rotate(45)"><path d="M0 0.8H1.6" stroke="${U.landmarkEdge}" stroke-width="0.35" stroke-opacity="0.55"/></pattern></defs>`;
    s += `<g class="u-landmarks"><path d="${d}" fill="${U.landmark}" stroke="${U.landmarkEdge}" stroke-width="${lw(0.8, 0.4)}"/><path d="${d}" fill="url(#p-lmhatch)"/>`;
    // a cross on each church (Christian landmarks only), on its nave
    for (const b of ch) {
      if (b.kind !== 'church' && b.kind !== 'cathedral') continue;
      if (area(b.poly) < 60) continue;
      let cx = 0, cy = 0, x0 = Infinity, x1 = -Infinity;
      for (const q of b.poly) { cx += q.x; cy += q.y; x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); }
      cx /= b.poly.length; cy /= b.poly.length;
      const r = Math.max(2.5, (x1 - x0) * 0.08);
      s += `<path d="M${f1(cx - r)} ${f1(cy)}H${f1(cx + r)}M${f1(cx)} ${f1(cy - r * 1.4)}V${f1(cy + r)}" stroke="${U.landmarkEdge}" stroke-width="${lw(0.9, 0.5)}"/>`;
    }
    s += '</g>';
  }
  return s;
}

const GROUND_USES = new Set(['bailey', 'causeway', 'ghat', 'castle-honmaru', 'compound:castle-honmaru', 'bailey-gate', 'esplanade']);
/** Fences of camps and villages (width m): byre, yard, pen and orda fences, palisade lines inside a village. */
const CAMP_FENCES: Record<string, number> = { 'kraal-fence': 1.1, 'yard-fence': 0.45, 'pen-fence': 0.5, 'orda-fence': 0.8, palisade: 1.2, 'turf-wall': 2.2, albarrada: 0.9 };
/**
 * Fences drawn as fences: a thin rail line with its posts (a dash pattern of short wide strokes), stakes close
 * together for a palisade; a turf wall is a low grassy bank; a dry-stone wall a row of stones. [rail, post width,
 * post length, gap] in meters.
 */
export const FENCE_STYLE: Record<string, [number, number, number, number]> = {
  'yard-fence': [0.16, 0.55, 0.45, 2.4], 'pen-fence': [0.14, 0.45, 0.4, 1.8], 'orda-fence': [0.2, 0.7, 0.55, 1.6],
  palisade: [0.3, 1.05, 0.55, 0.28], 'kraal-fence': [0.3, 1.15, 0.8, 0.5],
};
function fenceSvg(k: string, d: string, pal: Palette, lw: (m: number, px: number) => string): string {
  const U = pal.urban;
  if (k === 'turf-wall') return `<path d="${d}" fill="none" stroke="${mixHex(pal.grass, U.wall, 0.35)}" stroke-opacity="0.42" stroke-width="${lw(2.2, 0.8)}"/><path d="${d}" fill="none" stroke="${U.wall}" stroke-opacity="0.45" stroke-width="${lw(0.16, 0.15)}"/>`;
  if (k === 'albarrada') return `<path d="${d}" fill="none" stroke="${U.wall}" stroke-opacity="0.55" stroke-width="${lw(0.85, 0.3)}" stroke-dasharray="0.9 0.45" stroke-linecap="round"/>`;
  const [rail, pw, pl, gap] = FENCE_STYLE[k] ?? FENCE_STYLE['yard-fence'];
  return `<path d="${d}" fill="none" stroke="${U.wall}" stroke-opacity="0.8" stroke-width="${lw(rail, 0.18)}"/><path d="${d}" fill="none" stroke="${U.wall}" stroke-opacity="0.9" stroke-width="${f1(pw)}" stroke-dasharray="${pl} ${gap}" stroke-linecap="butt"/>`;
}
const WALL_LINES: Record<string, number> = { 'arcane-circle': 0.5, 'lock-gate': 0.8, bank: 0.8, stands: 2.4, dome: 0.6, gallery: 2.2, 'zigzag-wall': 2.4, 'canal-wall': 1, 'pyramid-step': 0.5, 'stall-row': 2.2,  'compound-wall': 1, 'citadel-wall': 2.4, 'stone-wall': 1.8, prakara: 1.6, 'ward-wall': 1.8 };

/** Compound grounds, water pieces (moats, tanks) and the moat outside the town wall (drawn under the buildings). */
function cultureUnderlay(ub: NonNullable<World['urban']>, pal: Palette, lw: (m: number, px: number) => string): string {
  const U = pal.urban;
  let s = '';
  const moats = (ub.lines ?? []).filter((l) => l.kind === 'moat');
  if (moats.length) s += `<path class="u-moat" d="${moats.map((l) => pathD(l.path, !!l.closed)).join('')}" fill="none" stroke="${pal.riverFill}" stroke-width="${f1(moats[0].width ?? 8)}" stroke-linejoin="miter"/>`;
  const grounds = ub.parcels.filter((p) => (typeof p.use === 'string' && p.use.startsWith('compound:')) || GROUND_USES.has(p.use));
  if (grounds.length) s += `<path class="u-compounds" d="${grounds.map((p) => pathD(p.poly, true)).join('')}" fill="${U.place}"/>`;
  const sahn = ub.landmarks.filter((l) => l.kind === 'sahn');
  if (sahn.length) s += `<path d="${sahn.map((l) => pathD(l.poly, true)).join('')}" fill="${U.place}" stroke="${U.plotLine}" stroke-width="${lw(0.2, 0.1)}"/><path d="${sahn.map((l) => pathD(l.poly, true)).join('')}" fill="url(#p-upave)"/>`;
  const garth = ub.landmarks.filter((l) => l.kind === 'garth');
  if (garth.length) s += `<path d="${garth.map((l) => pathD(l.poly, true)).join('')}" fill="${U.garden}" stroke="${U.plotLine}" stroke-width="${lw(0.25, 0.1)}"/>`;
  const ditch = ub.parcels.filter((p) => p.use === 'ditch');
  if (ditch.length) s += `<path class="u-ditch" d="${ditch.map((p) => pathD(p.poly, true)).join('')}" fill="${U.garden}" stroke="${U.plotLine}" stroke-width="${lw(0.3, 0.12)}"/><path d="${ditch.map((p) => pathD(p.poly, true)).join('')}" fill="url(#p-ugarden)"/>`;
  // chinampas: the canals between the strips, the strips themselves (and canals down the lanes)
  const chW = ub.landmarks.filter((l) => l.kind === 'chinampa-canal' || l.kind === 'baray' || l.kind === 'pond');
  if (chW.length) s += `<path class="u-chinampa-canals" d="${chW.map((l) => pathD(l.poly, true)).join('')}" fill="${pal.riverFill}"/>`;
  const chF = ub.landmarks.filter((l) => l.kind === 'chinampa');
  if (chF.length) { const d = chF.map((l) => pathD(l.poly, true)).join(''); s += `<g class="u-chinampas"><path d="${d}" fill="${U.garden}" stroke="${pal.waterEdge}" stroke-width="${lw(0.3, 0.15)}"/><path d="${d}" fill="url(#p-ugarden)"/></g>`; }
  const canalsL = (ub.lines ?? []).filter((l) => l.kind === 'canal');
  for (const l of canalsL) s += `<path d="${pathD(l.path, false)}" fill="none" stroke="${pal.riverFill}" stroke-width="${f1(l.width ?? 2)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  // cornfields round a native village: corn hills in rows
  const corn = ub.landmarks.filter((l) => l.kind === 'cornfield' || l.kind === 'terrace-field' || l.kind === 'garden-bed');
  if (corn.length) {
    const d = corn.map((l) => pathD(l.poly, true)).join('');
    s += `<defs><pattern id="p-ucorn" patternUnits="userSpaceOnUse" width="3" height="3" patternTransform="rotate(12)"><circle cx="1.5" cy="1.5" r="0.45" fill="${U.gardenInk}" opacity="0.6"/></pattern></defs>`;
    s += `<g class="u-cornfields"><path d="${d}" fill="${pal.land.field}" stroke="${U.gardenInk}" stroke-opacity="0.5" stroke-width="${lw(0.4, 0.2)}"/><path d="${d}" fill="url(#p-ucorn)"/></g>`;
  }
  const cem = ub.landmarks.filter((l) => l.kind === 'cemetery');
  if (cem.length) s += `<path d="${cem.map((l) => pathD(l.poly, true)).join('')}" fill="${U.garden}"/><path d="${cem.map((l) => pathD(l.poly, true)).join('')}" fill="url(#p-ugrave)"/>`;
  const water = (ub.water ?? []).map((w) => pathD(w.outer, true)).join('');
  if (water) s += `<path class="u-water" d="${water}" fill="${pal.riverFill}" stroke="${pal.waterEdge}" stroke-width="${lw(0.5, 0.3)}"/>`;
  const bases = ub.landmarks.filter((l) => l.kind === 'tenshu-base' || l.kind === 'mebon');
  if (bases.length) s += `<path d="${bases.map((l) => pathD(l.poly, true)).join('')}" fill="${U.wallFill}" stroke="${U.wall}" stroke-width="${lw(0.4, 0.2)}"/>`;
  return s;
}

/** Plan lines (enclosure walls, ward walls, prakaras, hedges, steps) and tree canopies (drawn over the buildings). */
function cultureOverlay(ub: NonNullable<World['urban']>, pal: Palette, lw: (m: number, px: number) => string): string {
  const U = pal.urban;
  const open = !!ub.renderHints?.openGround;
  let s = '';
  const byKind = new Map<string, string[]>();
  for (const l of ub.lines ?? []) {
    if (l.kind === 'moat' || l.kind === 'canal') continue;
    const k = l.kind;
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k)!.push(pathD(l.path, !!l.closed));
  }
  for (const [k, ds] of byKind) {
    const d = ds.join('');
    if (k === 'hedge') s += `<path d="${d}" fill="none" stroke="${pal.treeInk ?? '#4a6a3a'}" stroke-width="${lw(2.6, 0.8)}" stroke-opacity="0.8" stroke-dasharray="3 1.5"/>`;
    else if (k === 'track') s += `<path d="${d}" fill="none" stroke="${open ? pathEarth(pal) : U.street}" stroke-opacity="${open ? 0.75 : 1}" stroke-width="${lw(open ? 2.6 : 3, 0.6)}" stroke-linecap="round"/>`;
    else if (k === 'weir') s += `<path d="${d}" fill="none" stroke="${U.wall}" stroke-width="${lw(1.4, 0.5)}" stroke-dasharray="1.2 0.6"/>`;
    else if (k === 'parterre' || k === 'footpath') s += `<path d="${d}" fill="none" stroke="${k === 'footpath' ? (open ? pathEarth(pal) : U.street) : U.plotLine}" stroke-width="${lw(k === 'footpath' ? 1.4 : 0.5, 0.15)}" stroke-linecap="round"/>`;
    else if (k === 'ghat-steps') s += `<path d="${d}" fill="none" stroke="${U.plotLine}" stroke-width="${lw(0.3, 0.12)}"/>`;
    else if (k === 'terrace') s += `<path d="${d}" fill="none" stroke="${U.wall}" stroke-width="${lw(1.6, 0.8)}"/>`;
    else if (k === 'andene') s += `<path d="${d}" fill="none" stroke="${U.wall}" stroke-width="${lw(0.9, 0.4)}" stroke-opacity="0.75"/>`;
    else if (k === 'thorn-fence') s += `<path d="${d}" fill="none" stroke="${pal.treeInk ?? '#4a6a3a'}" stroke-width="${lw(2.2, 0.8)}" stroke-opacity="0.85" stroke-dasharray="1.3 0.9" stroke-linecap="round"/>`;
    else if (CAMP_FENCES[k]) s += fenceSvg(k, d, pal, lw);
    else if (k === 'roof-line') s += `<path d="${d}" fill="none" stroke="${U.massEdge}" stroke-opacity="0.7" stroke-width="${lw(0.2, 0.08)}" stroke-linecap="butt"/>`;
    else if (k === 'rampart') s += `<path d="${d}" fill="none" stroke="${U.garden}" stroke-width="${lw(7, 1.4)}" stroke-opacity="0.9"/><path d="${d}" fill="none" stroke="${U.wall}" stroke-width="${lw(0.6, 0.3)}"/>`;
    else if (k === 'ditch') s += `<path d="${d}" fill="none" stroke="${U.wall}" stroke-width="${lw(4, 0.9)}" stroke-opacity="0.35"/>`;
    else if (k === 'footbridge') {
      // canal footbridges: the deck between its parapets (drawn per bridge: widths differ)
      for (const l of (ub.lines ?? []).filter((x) => x.kind === 'footbridge')) {
        const w = l.width ?? 2.5, dd = pathD(l.path, false);
        s += `<path d="${dd}" fill="none" stroke="${pal.bridgeInk}" stroke-width="${f1(w + 0.9)}" stroke-linecap="butt"/><path d="${dd}" fill="none" stroke="${pal.bridgeDeck}" stroke-width="${f1(w)}" stroke-linecap="butt"/>`;
      }
    }
    else if (k === 'bazaar-roof') {
      // the vaulted bazaar street: a roof over the street's own width
      for (const l of (ub.lines ?? []).filter((x) => x.kind === 'bazaar-roof')) {
        const w = Math.max(2, (l.width ?? 5) - 0.6), dd = pathD(l.path, false);
        s += `<path d="${dd}" fill="none" stroke="${U.landmarkEdge}" stroke-width="${f1(w + 0.8)}" stroke-linecap="butt" stroke-linejoin="round"/><path d="${dd}" fill="none" stroke="${U.landmark}" stroke-width="${f1(w)}" stroke-linecap="butt" stroke-linejoin="round"/>`;
      }
    }
    else if (k === 'qanat') s += `<path d="${d}" fill="none" stroke="${U.wall}" stroke-width="${lw(1, 0.5)}" stroke-dasharray="4 3" stroke-opacity="0.7"/>`;
    else if (k === 'qanat-shaft') s += `<path d="${d}" fill="${U.garden}" stroke="${U.wall}" stroke-width="${lw(0.7, 0.3)}"/>`;
    else if (k === 'hachure') s += `<path d="${d}" fill="none" stroke="${U.wall}" stroke-width="${lw(0.55, 0.3)}" stroke-opacity="0.85"/>`;
    else s += `<path class="u-line-${k}" d="${d}" fill="none" stroke="${U.wall}" stroke-width="${lw(WALL_LINES[k] ?? 1, 0.4)}" stroke-linejoin="miter" stroke-linecap="square"/>`;
  }
  const trees = ub.trees ?? [];
  if (trees.length) {
    const fill = pal.treeFill ?? '#7f9a5a', ink = pal.treeInk ?? '#4a6a3a';
    s += `<g class="u-canopy" fill="${fill}" fill-opacity="0.78" stroke="${ink}" stroke-width="${lw(0.35, 0.15)}">` + trees.map((t) => `<circle cx="${f1(t.x)}" cy="${f1(t.y)}" r="${f1(t.r)}"/>`).join('') + '</g>';
  }
  return s;
}

/** Parcel uses of an open-ground settlement drawn as grass (yards, paddocks), gardens and open greens. */
export const OPEN_GRASS_USES = ['plot', 'pen', 'commons'];
export const OPEN_GREEN_USES = ['meadow', 'green'];
/** Trampled earth of the paths of an open-ground settlement (between the rural track ink and the street colour). */
export const pathEarth = (pal: Palette): string => mixHex(pal.trackFill, pal.urban.street, 0.52);
export const yardEarthTone = (pal: Palette): string => mixHex(pal.farmYard, pal.trackFill, 0.12);

/**
 * Open ground (camps, barbarian and native villages): no street space or block fill. Yards and paddocks are grass
 * over the terrain (the land-use tints), gardens and greens their own tints; the trampled ground round the
 * buildings and the paths are earth; plazas and compound grounds stay paved.
 */
function openGroundSvg(ub: NonNullable<World['urban']>, pal: Palette, lw: (m: number, px: number) => string): string {
  const U = pal.urban;
  const mul = pal.landBlend === 'multiply' ? ' style="mix-blend-mode:multiply"' : '';
  let s = `<defs><pattern id="p-utuft" patternUnits="userSpaceOnUse" width="11" height="9"><path d="M2.5 4.5l-0.8-1.9M2.5 4.5v-2.1M2.5 4.5l0.8-1.9M8 8.4l-0.8-1.9M8 8.4l0.8-1.9" stroke="${pal.grass}" stroke-width="0.35" fill="none" stroke-linecap="round" opacity="0.75"/></pattern></defs>`;
  const of = (uses: string[]) => ub.parcels.filter((p) => uses.includes(p.use)).map((p) => pathD(p.poly, true)).join('');
  const grass = of(OPEN_GRASS_USES);
  if (grass) s += `<g class="u-yards-grass"><path d="${grass}" fill="${pal.land.pasture}" fill-opacity="${f1(pal.landOpacity * 0.85)}"${mul}/><path d="${grass}" fill="url(#p-utuft)"/></g>`;
  const green = of(OPEN_GREEN_USES);
  if (green) s += `<g class="u-greens"><path d="${green}" fill="${pal.land.meadow}" fill-opacity="${f1(pal.landOpacity)}"${mul}/><path d="${green}" fill="url(#p-utuft)"/></g>`;
  const gard = of(['garden']) + ub.backLand.filter(() => false).map(phD).join('');
  if (gard) s += `<g class="u-gardens"><path d="${gard}" fill="${pal.land.garden}" fill-opacity="${f1(pal.landOpacity)}"${mul}/><path d="${gard}" fill="url(#p-ugarden)" opacity="0.7"/></g>`;
  const fields = of(['field']);
  if (fields) s += `<path class="u-fields" d="${fields}" fill="${pal.land.field}" fill-opacity="${f1(pal.landOpacity)}"${mul}/>`;
  const paved = of(['place', 'plaza', 'market']);
  if (paved) s += `<g class="u-places"><path d="${paved}" fill="${U.place}"/><path d="${paved}" fill="url(#p-upave)"/></g>`;
  // the trampled ground round the buildings
  const earth = ub.landmarks.filter((l) => l.kind === 'yard-earth').map((l) => pathD(l.poly, true)).join('');
  if (earth) s += `<path class="u-yard-earth" d="${earth}" fill="${yardEarthTone(pal)}" fill-opacity="0.85"/>`;
  // paths: trampled earth along the street centrelines (wide causeways keep the street colour)
  const ink = pathEarth(pal);
  const byW = new Map<string, string[]>();
  for (const st of ub.streets) {
    const k = (st.width >= 6.5 && st.rank <= 1 ? 'c' : 'e') + (Math.round(st.width * 2) / 2);
    if (!byW.has(k)) byW.set(k, []);
    byW.get(k)!.push(pathD(st.path, false));
  }
  s += '<g class="u-paths" fill="none" stroke-linecap="round" stroke-linejoin="round">';
  for (const [k, ds] of byW) {
    const w = Number(k.slice(1));
    s += `<path d="${ds.join('')}" stroke="${k[0] === 'c' ? U.street : ink}" stroke-opacity="${k[0] === 'c' ? 1 : 0.8}" stroke-width="${f1(Math.max(1.2, w * 0.92))}"/>`;
  }
  s += '</g>';
  return s;
}

export function urbanLayer(world: World, pal: Palette, u: number, debug: boolean): string {
  if (debug) return urbanDebugLayer(world, u);
  const ub = world.urban;
  if (!ub) return '';
  const U = pal.urban;
  const lw = (m: number, px: number) => f1(Math.max(m, px * u)); // meters, with a floor in pixels of a 1600 px render
  let s = `<g class="layer-urban" stroke-linejoin="round">` + patterns(pal);
  const stilts = !!ub.renderHints?.stilts;
  const open = !!ub.renderHints?.openGround && !stilts;
  // street space: the quarters (blocks are drawn on top, so what remains visible is exactly quarter \ blocks);
  // a stilt town has no ground: its boardwalks are drawn as planks over the water and the marsh
  if (open) s += openGroundSvg(ub, pal, lw);
  else if (stilts) {
    s += '<g class="u-boardwalks" fill="none" stroke-linecap="butt" stroke-linejoin="round">';
    for (const st of ub.streets) s += `<path d="${pathD(st.path, false)}" stroke="${pal.bridgeInk}" stroke-width="${f1(Math.max(1.6, st.width + 0.2))}"/>`;
    for (const st of ub.streets) s += `<path d="${pathD(st.path, false)}" stroke="${pal.bridgeDeck}" stroke-width="${f1(Math.max(1, st.width - 0.7))}"/>`;
    s += '</g>';
  } else s += `<path class="u-streets" d="${ub.quarters.map((q) => pathD(q.poly.outer, true)).join('')}" fill="${U.street}" stroke="${U.street}" stroke-width="0.4"/>`;
  if (!open) {
  const places = ub.parcels.filter((p) => p.use === 'place' || p.use === 'market' || p.use === 'quay' || p.use === 'pier' || p.use === 'slipway' || p.use === 'timber-yard' || p.use === 'mill-yard' || p.use === 'mill' || p.use === 'tannery-yard' || p.use === 'bridge');
  if (places.length) {
    const d = places.map((p) => pathD(p.poly, true)).join('');
    s += `<g class="u-places"><path d="${d}" fill="${U.place}"/><path d="${d}" fill="url(#p-upave)"/></g>`;
  }
  const greens = ub.parcels.filter((p) => p.use === 'green' || p.use === 'mill-island' || p.use === 'windmill-mound' || p.use === 'gallows-hill' || p.use === 'ropewalk-yard');
  if (greens.length) {
    const d = greens.map((p) => pathD(p.poly, true)).join('');
    s += `<g class="u-greens"><path d="${d}" fill="${U.garden}"/><path d="${d}" fill="url(#p-ugarden)" opacity="0.6"/></g>`;
  }
  const yards = ub.parcels.filter((p) => p.use === 'church');
  if (yards.length) {
    const d = yards.map((p) => pathD(p.poly, true)).join('');
    s += `<g class="u-churchyard"><path d="${d}" fill="${U.garden}"/><path d="${d}" fill="url(#p-ugrave)"/></g>`;
  }
  const blockD = ub.blocks.filter((_, i) => ub.blockInfo[i]?.kind === 'block').map((b) => pathD(b, true)).concat(ub.parcels.filter((p) => p.use === 'arena-plot' || p.use === 'inn').map((p) => pathD(p.poly, true))).join('');
  if (!stilts) s += `<path class="u-blocks" d="${blockD}" fill="${U.yard}"/>`;
  // meadows inside a block (village greens, thing places, open camp ground): over the yard colour
  const plazas = ub.parcels.filter((p) => p.use === 'plaza');
  if (plazas.length) { const d = plazas.map((p) => pathD(p.poly, true)).join(''); s += `<g class="u-plazas"><path d="${d}" fill="${U.place}"/><path d="${d}" fill="url(#p-upave)"/></g>`; }
  const meadows = ub.parcels.filter((p) => p.use === 'meadow');
  if (meadows.length) { const d = meadows.map((p) => pathD(p.poly, true)).join(''); s += `<g class="u-meadows"><path d="${d}" fill="${U.garden}"/><path d="${d}" fill="url(#p-ugarden)" opacity="0.45"/></g>`; }
  if (ub.backLand.length) {
    const d = ub.backLand.map(phD).join('');
    s += `<g class="u-gardens"><path d="${d}" fill="${U.garden}"/><path d="${d}" fill="url(#${ub.renderHints?.graves ? 'p-ugrave' : 'p-ugarden'})"/></g>`;
  }
  // plot hairlines first: the buildings cover them, so they read on yards and gardens only (cadastre style)
  const plotD = ub.renderHints?.plotLines === false ? '' : ub.parcels.filter((p) => p.use === 'plot').map((p) => pathD(p.poly, true)).join('');
  if (plotD) s += `<path class="u-plots" d="${plotD}" fill="none" stroke="${U.plotLine}" stroke-opacity="${f1(U.plotAlpha * 0.75)}" stroke-width="${lw(U.plotW, 0.05)}"/>`;
  }
  s += cultureUnderlay(ub, pal, lw);
  s += buildingsSvg(ub, U, lw);
  // courtyard houses: the patio drawn as a paved court with a crisp inner edge, so the courts read at town scale
  const courts = ub.buildings.flatMap((b) => (b.kind === 'house' && b.courtyards?.length ? b.courtyards : []));
  if (courts.length) {
    const d = courts.map((c) => pathD(c, true)).join('');
    s += `<g class="u-patios"><path d="${d}" fill="${U.place}" stroke="${U.massEdge}" stroke-width="${lw(0.45, 0.35)}"/><path d="${d}" fill="url(#p-upave)"/></g>`;
  }
  s += cultureOverlay(ub, pal, lw);
  // main streets keep a legible minimum width at small scales (drawn over the street space only where wider)
  // (not the village and hamlet streets: widened to the town's minimum they become long white strokes on the map)
  const secondary = new Set<unknown>();
  for (const st of world.settlements ?? []) if (!st.main) for (const x of st.urban?.streets ?? []) secondary.add(x);
  const mains = ub.streets.filter((st) => st.rank <= 1 && st.role !== 'close' && !secondary.has(st));
  const minW = 2.4 * u;
  const wide = mains.filter((st) => st.width < minW);
  if (wide.length) s += `<path class="u-main-streets"${stilts || !(world.terrain.coastline.length || world.terrain.lakes.some((l) => l.length >= 3)) ? '' : ' clip-path="url(#landclip)"'} d="${wide.map((st) => pathD(st.path, false)).join('')}" fill="none" stroke="${U.street}" stroke-width="${f1(minW)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (!stilts) s += `<path class="u-block-edges" d="${ub.blocks.map((b) => pathD(b, true)).join('')}" fill="none" stroke="${U.blockEdge}" stroke-width="${lw(U.blockEdgeW, 0.3)}"/>`;
  // small bridges over the streams (true size, by kind: footbridges, arches, fords), over the street space
  s += townBridgesSvg(world.bridges ?? [], pal);
  for (const w of ub.walls ?? []) s += wallSvg(w, U.wall, U.wallFill, U.wallScale, U.towerScale);
  s += '</g>';
  return s;
}
