/** SVG rendering of the urban layer (streets as space, blocks, plots, building masses, walls). */
import type { World, PolyH, UrbanWall } from '../gen/types';
import type { Polygon } from '../gen/core/geom';
import type { Palette } from './styles';
import { f1, pathD } from './util';

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
export function wallSvg(w: UrbanWall, ink: string, fill: string): string {
  const th = w.thickness;
  const d = (w.pieces ?? [w.path]).map((p) => pathD(p, false)).join('');
  let s = `<g class="u-walls"><path d="${d}" fill="none" stroke="${ink}" stroke-width="${f1(th + 1.4)}" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="6"/>` +
    `<path d="${d}" fill="none" stroke="${fill}" stroke-width="${f1(Math.max(0.6, th - 1))}" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="6"/>`;
  const tower = (t: { x: number; y: number }, r: number): string => {
    if (w.towerShape !== 'square') return `<circle cx="${f1(t.x)}" cy="${f1(t.y)}" r="${f1(r)}"/>`;
    const a = edgeDir(w.path, t), c = Math.cos(a), sn = Math.sin(a), h = r * 0.95;
    const pts = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, y]) => `${f1(t.x + x * c - y * sn)} ${f1(t.y + x * sn + y * c)}`);
    return `<path d="M${pts.join('L')}Z"/>`;
  };
  const tw = w.towers.map((t, i) => tower(t, th * 1.6 * (w.towerScale?.[i] ?? 1))).join('');
  const gt = (w.gateTowers ?? []).map((t) => tower(t, th * 1.5)).join('');
  s += `<g fill="${fill}" stroke="${ink}" stroke-width="0.9">${tw}${gt}</g></g>`;
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
  const places = ub.parcels.filter((p) => p.use === 'place' || p.use === 'market');
  if (places.length) {
    const d = places.map((p) => pathD(p.poly, true)).join('');
    s += `<g class="u-places"><path d="${d}" fill="${U.place}"/><path d="${d}" fill="url(#p-upave)"/></g>`;
  }
  const greens = ub.parcels.filter((p) => p.use === 'green');
  if (greens.length) {
    const d = greens.map((p) => pathD(p.poly, true)).join('');
    s += `<g class="u-greens"><path d="${d}" fill="${U.garden}"/><path d="${d}" fill="url(#p-ugarden)" opacity="0.6"/></g>`;
  }
  const yards = ub.parcels.filter((p) => p.use === 'church');
  if (yards.length) {
    const d = yards.map((p) => pathD(p.poly, true)).join('');
    s += `<g class="u-churchyard"><path d="${d}" fill="${U.garden}"/><path d="${d}" fill="url(#p-ugrave)"/></g>`;
  }
  const blockD = ub.blocks.filter((_, i) => ub.blockInfo[i]?.kind === 'block').map((b) => pathD(b, true)).join('');
  s += `<path class="u-blocks" d="${blockD}" fill="${U.yard}"/>`;
  if (ub.backLand.length) {
    const d = ub.backLand.map(phD).join('');
    s += `<g class="u-gardens"><path d="${d}" fill="${U.garden}"/><path d="${d}" fill="url(#p-ugarden)"/></g>`;
  }
  if (ub.masses.length) {
    s += `<path class="u-masses" d="${ub.masses.map(phD).join('')}" fill="${U.mass}" fill-rule="evenodd" stroke="${U.massEdge}" stroke-width="${lw(0.3, 0.15)}"/>`;
  }
  // landmarks: church / cathedral drawn as a distinct, outlined mass with a cross
  const ch = ub.buildings.filter((b) => b.kind === 'church');
  if (ch.length) {
    const d = ch.map((b) => pathD(b.poly, true)).join('');
    s += `<g class="u-landmarks"><path d="${d}" fill="${U.landmark}" stroke="${U.mass}" stroke-width="${lw(0.8, 0.4)}"/>`;
    // cross on the nave
    let cx = 0, cy = 0, n = 0, x0 = Infinity, x1 = -Infinity;
    for (const b of ch) for (const q of b.poly) { cx += q.x; cy += q.y; n++; x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); }
    cx /= n; cy /= n;
    const r = Math.max(2.5, (x1 - x0) * 0.08);
    s += `<path d="M${f1(cx - r)} ${f1(cy)}H${f1(cx + r)}M${f1(cx)} ${f1(cy - r * 1.4)}V${f1(cy + r)}" stroke="${U.mass}" stroke-width="${lw(0.9, 0.5)}"/></g>`;
  }
  // plot hairlines: a dark pass (reads on yards) and a light pass (reads on roofs), so each house is legible
  const plotD = ub.parcels.filter((p) => p.use === 'plot').map((p) => pathD(p.poly, true)).join('');
  s += `<g class="u-plots" fill="none" stroke-width="${lw(0.14, 0.05)}"><path d="${plotD}" stroke="${U.plotLine}" stroke-opacity="0.45"/>` +
    `<path d="${plotD}" stroke="${U.massEdge}" stroke-opacity="0.28"/></g>`;
  // main streets keep a legible minimum width at small scales (drawn over the street space only where wider)
  const mains = ub.streets.filter((st) => st.rank <= 1 && st.role !== 'close');
  const minW = 2.4 * u;
  const wide = mains.filter((st) => st.width < minW);
  if (wide.length) s += `<path class="u-main-streets" d="${wide.map((st) => pathD(st.path, false)).join('')}" fill="none" stroke="${U.street}" stroke-width="${f1(minW)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  s += `<path class="u-block-edges" d="${ub.blocks.map((b) => pathD(b, true)).join('')}" fill="none" stroke="${U.blockEdge}" stroke-width="${lw(0.4, 0.3)}"/>`;
  for (const w of ub.walls ?? []) s += wallSvg(w, U.wall, U.wallFill);
  s += '</g>';
  return s;
}
