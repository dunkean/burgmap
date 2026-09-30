/** SVG rendering of the urban layer (streets as space, blocks, plots, building masses, walls). */
import type { World, PolyH } from '../gen/types';
import type { Vec2, Polygon } from '../gen/core/geom';
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
  if (ub.blocks.length) {
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
  for (const sq of ub.squares) s += `<path d="${pathD(sq, true)}" fill="#fff" fill-opacity="0.6" stroke="#f0f" stroke-width="${f1(1 * u)}"/>`;
  for (const st of ub.streets) s += `<path d="${pathD(st.path, false)}" fill="none" stroke="#000" stroke-opacity="0.35" stroke-width="${f1(0.5 * u)}"/>`;
  for (const w of ub.walls ?? []) {
    s += `<path d="${pathD(w.path, w.closed)}" fill="none" stroke="#800" stroke-width="${f1(1.5 * u)}"/>`;
    for (const g of w.gates) s += `<circle cx="${f1(g.x)}" cy="${f1(g.y)}" r="${f1(5 * u)}" fill="#800"/>`;
  }
  s += '</g>';
  return s;
}

export function urbanLayer(world: World, pal: Palette, u: number, debug: boolean): string {
  if (debug) return urbanDebugLayer(world, u);
  void pal; void ({} as Vec2); void phD;
  return urbanDebugLayer(world, u);
}
