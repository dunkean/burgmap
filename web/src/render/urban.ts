/** SVG rendering of the urban layer (streets as space, blocks, plots, building masses, walls). */
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
  const tones = [-0.09, -0.045, 0, 0.045, 0.09].map((k) => (k < 0 ? mixHex(base, '#000000', -k) : mixHex(base, '#ffffff', k)));
  const buckets: string[][] = tones.map(() => []);
  ub.buildings.forEach((b, i) => {
    if (LANDMARK_KINDS.has(b.kind)) return;
    const h = (Math.imul(i + 1, 2654435761) >>> 0) % tones.length;
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
const WALL_LINES: Record<string, number> = { 'compound-wall': 1, 'citadel-wall': 2.4, 'stone-wall': 1.8, prakara: 1.6, 'ward-wall': 1.8 };

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
  const cem = ub.landmarks.filter((l) => l.kind === 'cemetery');
  if (cem.length) s += `<path d="${cem.map((l) => pathD(l.poly, true)).join('')}" fill="${U.garden}"/><path d="${cem.map((l) => pathD(l.poly, true)).join('')}" fill="url(#p-ugrave)"/>`;
  const water = (ub.water ?? []).map((w) => pathD(w.outer, true)).join('');
  if (water) s += `<path class="u-water" d="${water}" fill="${pal.riverFill}" stroke="${pal.waterEdge}" stroke-width="${lw(0.5, 0.3)}"/>`;
  const bases = ub.landmarks.filter((l) => l.kind === 'tenshu-base');
  if (bases.length) s += `<path d="${bases.map((l) => pathD(l.poly, true)).join('')}" fill="${U.wallFill}" stroke="${U.wall}" stroke-width="${lw(0.4, 0.2)}"/>`;
  return s;
}

/** Plan lines (enclosure walls, ward walls, prakaras, hedges, steps) and tree canopies (drawn over the buildings). */
function cultureOverlay(ub: NonNullable<World['urban']>, pal: Palette, lw: (m: number, px: number) => string): string {
  const U = pal.urban;
  let s = '';
  const byKind = new Map<string, string[]>();
  for (const l of ub.lines ?? []) {
    if (l.kind === 'moat') continue;
    const k = l.kind;
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k)!.push(pathD(l.path, !!l.closed));
  }
  for (const [k, ds] of byKind) {
    const d = ds.join('');
    if (k === 'hedge') s += `<path d="${d}" fill="none" stroke="${pal.treeInk ?? '#4a6a3a'}" stroke-width="${lw(2.6, 0.8)}" stroke-opacity="0.8" stroke-dasharray="3 1.5"/>`;
    else if (k === 'track') s += `<path d="${d}" fill="none" stroke="${U.street}" stroke-width="${lw(3, 0.6)}" stroke-linecap="round"/>`;
    else if (k === 'weir') s += `<path d="${d}" fill="none" stroke="${U.wall}" stroke-width="${lw(1.4, 0.5)}" stroke-dasharray="1.2 0.6"/>`;
    else if (k === 'parterre' || k === 'footpath') s += `<path d="${d}" fill="none" stroke="${k === 'footpath' ? U.street : U.plotLine}" stroke-width="${lw(k === 'footpath' ? 1.4 : 0.5, 0.15)}" stroke-linecap="round"/>`;
    else if (k === 'ghat-steps') s += `<path d="${d}" fill="none" stroke="${U.plotLine}" stroke-width="${lw(0.3, 0.12)}"/>`;
    else if (k === 'terrace') s += `<path d="${d}" fill="none" stroke="${U.wall}" stroke-width="${lw(1.6, 0.8)}"/>`;
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

export function urbanLayer(world: World, pal: Palette, u: number, debug: boolean): string {
  if (debug) return urbanDebugLayer(world, u);
  const ub = world.urban;
  if (!ub) return '';
  const U = pal.urban;
  const lw = (m: number, px: number) => f1(Math.max(m, px * u)); // meters, with a floor in pixels of a 1600 px render
  let s = `<g class="layer-urban" stroke-linejoin="round">` + patterns(pal);
  // street space: the quarters (blocks are drawn on top, so what remains visible is exactly quarter \ blocks)
  s += `<path class="u-streets" d="${ub.quarters.map((q) => pathD(q.poly.outer, true)).join('')}" fill="${U.street}" stroke="${U.street}" stroke-width="0.4"/>`;
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
  s += `<path class="u-blocks" d="${blockD}" fill="${U.yard}"/>`;
  if (ub.backLand.length) {
    const d = ub.backLand.map(phD).join('');
    s += `<g class="u-gardens"><path d="${d}" fill="${U.garden}"/><path d="${d}" fill="url(#p-ugarden)"/></g>`;
  }
  // plot hairlines first: the buildings cover them, so they read on yards and gardens only (cadastre style)
  const plotD = ub.parcels.filter((p) => p.use === 'plot').map((p) => pathD(p.poly, true)).join('');
  s += `<path class="u-plots" d="${plotD}" fill="none" stroke="${U.plotLine}" stroke-opacity="${f1(U.plotAlpha * 0.75)}" stroke-width="${lw(U.plotW, 0.05)}"/>`;
  s += cultureUnderlay(ub, pal, lw);
  s += buildingsSvg(ub, U, lw);
  s += cultureOverlay(ub, pal, lw);
  // main streets keep a legible minimum width at small scales (drawn over the street space only where wider)
  const mains = ub.streets.filter((st) => st.rank <= 1 && st.role !== 'close');
  const minW = 2.4 * u;
  const wide = mains.filter((st) => st.width < minW);
  if (wide.length) s += `<path class="u-main-streets" d="${wide.map((st) => pathD(st.path, false)).join('')}" fill="none" stroke="${U.street}" stroke-width="${f1(minW)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  s += `<path class="u-block-edges" d="${ub.blocks.map((b) => pathD(b, true)).join('')}" fill="none" stroke="${U.blockEdge}" stroke-width="${lw(U.blockEdgeW, 0.3)}"/>`;
  for (const w of ub.walls ?? []) s += wallSvg(w, U.wall, U.wallFill, U.wallScale, U.towerScale);
  s += '</g>';
  return s;
}
