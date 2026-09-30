/** SVG rendering of the urban layer (streets as space, blocks, plots, building masses, walls). */
import type { World, PolyH } from '../gen/types';
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
    `<pattern id="p-upave" patternUnits="userSpaceOnUse" width="3" height="3"><circle cx="1.5" cy="1.5" r="0.28" fill="${U.placeInk}" opacity="0.55"/></pattern></defs>`;
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
  const blockD = ub.blocks.filter((_, i) => ub.blockInfo[i]?.kind === 'block').map((b) => pathD(b, true)).join('');
  s += `<path class="u-blocks" d="${blockD}" fill="${U.yard}"/>`;
  if (ub.backLand.length) {
    const d = ub.backLand.map(phD).join('');
    s += `<g class="u-gardens"><path d="${d}" fill="${U.garden}"/><path d="${d}" fill="url(#p-ugarden)"/></g>`;
  }
  if (ub.masses.length) {
    s += `<path class="u-masses" d="${ub.masses.map(phD).join('')}" fill="${U.mass}" fill-rule="evenodd" stroke="${U.massEdge}" stroke-width="${lw(0.3, 0.15)}"/>`;
  }
  const plotD = ub.parcels.filter((p) => p.use === 'plot').map((p) => pathD(p.poly, true)).join('');
  s += `<path class="u-plots" d="${plotD}" fill="none" stroke="${U.plotLine}" stroke-width="${lw(0.12, 0.05)}" stroke-opacity="0.5"/>`;
  s += `<path class="u-block-edges" d="${ub.blocks.map((b) => pathD(b, true)).join('')}" fill="none" stroke="${U.blockEdge}" stroke-width="${lw(0.4, 0.3)}"/>`;
  for (const w of ub.walls ?? []) {
    const th = w.thickness;
    const d = (w.pieces ?? [w.path]).map((p) => pathD(p, false)).join('');
    s += `<g class="u-walls"><path d="${d}" fill="none" stroke="${U.wall}" stroke-width="${f1(th + 1.4)}" stroke-linecap="butt"/>` +
      `<path d="${d}" fill="none" stroke="${U.wallFill}" stroke-width="${f1(Math.max(0.6, th - 1))}" stroke-linecap="butt"/>`;
    const tw = w.towers.map((t) => `<circle cx="${f1(t.x)}" cy="${f1(t.y)}" r="${f1(th * 1.6)}"/>`).join('');
    const gt = (w.gateTowers ?? []).map((t) => `<circle cx="${f1(t.x)}" cy="${f1(t.y)}" r="${f1(th * 1.45)}"/>`).join('');
    s += `<g fill="${U.wallFill}" stroke="${U.wall}" stroke-width="0.9">${tw}${gt}</g></g>`;
  }
  s += '</g>';
  return s;
}
