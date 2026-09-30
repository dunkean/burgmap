/**
 * Style extras that are layered on top of the shared urban drawing: cast shadows of the building masses
 * (engraving), deterministic lit windows (night), water line texture and the drawing grid.
 * SVG fragments live here; the Canvas renderer uses the same data helpers (`litDots`).
 */
import type { World } from '../gen/types';
import type { Palette } from './styles';
import { hash3 } from './scene';
import { f1, pathD, seaWithIslands } from './util';

/** Lit-window speckles: flat [x0, y0, x1, y1, ...] in meters. Deterministic (hash of the building's position). */
export function litDots(world: World, density: number): Float32Array {
  const bs = world.urban?.buildings ?? [];
  const out: number[] = [];
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (b.poly.length < 3 || b.kind === 'church') continue;
    let cx = 0, cy = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const q of b.poly) { cx += q.x; cy += q.y; if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
    cx /= b.poly.length; cy /= b.poly.length;
    const hx = Math.round(cx * 4), hy = Math.round(cy * 4);
    if (hash3(hx, hy, 101) >= density) continue;
    const w = x1 - x0, h = y1 - y0;
    const jx = (hash3(hx, hy, 103) - 0.5) * Math.min(2, w * 0.3), jy = (hash3(hx, hy, 107) - 0.5) * Math.min(2, h * 0.3);
    out.push(cx + jx, cy + jy);
    // big houses: a second window
    if (w * h > 130 && hash3(hx, hy, 109) < 0.6) out.push(cx - jx * 2 + Math.min(3, w * 0.22), cy - jy * 2 - Math.min(3, h * 0.22));
  }
  return Float32Array.from(out);
}

export function litSvg(world: World, pal: Palette, u: number): string {
  const lit = pal.urban.lit;
  if (!lit || !world.urban) return '';
  const d = litDots(world, lit.density);
  if (!d.length) return '';
  let p = '';
  for (let i = 0; i < d.length; i += 2) p += `M${f1(d[i])} ${f1(d[i + 1])}h0`;
  const r = Math.max(1.3, 1.5 * u);
  return `<g class="u-lit" fill="none" stroke-linecap="round"><path d="${p}" stroke="${lit.color}" stroke-width="${f1(r * 3.2)}" stroke-opacity="0.16"/><path d="${p}" stroke="${lit.color}" stroke-width="${f1(r)}"/></g>`;
}

/** Hatched cast shadow of the masses, visible only where it is not covered by the masses themselves. */
export function shadowSvg(world: World, pal: Palette, u: number): string {
  const sh = pal.urban.shadow;
  const ub = world.urban;
  if (!sh || !ub || !ub.masses.length) return '';
  const S = world.mapSize;
  const phD = (p: { outer: { x: number; y: number }[]; holes: { x: number; y: number }[][] }): string => pathD(p.outer, true) + p.holes.map((h) => pathD(h, true)).join('');
  const d = ub.masses.map(phD).join('');
  const g = Math.max(1.6, 3 * u);
  const dx = sh.dx * Math.max(1, u), dy = sh.dy * Math.max(1, u);
  return `<defs><pattern id="p-shadow" patternUnits="userSpaceOnUse" width="${f1(g)}" height="${f1(g)}" patternTransform="rotate(45)"><rect width="${f1(g)}" height="${f1(g)}" fill="${sh.color}" fill-opacity="${sh.alpha * 0.35}"/><path d="M0 ${f1(g / 2)}H${f1(g)}" stroke="${sh.color}" stroke-width="${f1(g * 0.36)}" stroke-opacity="${sh.alpha}"/></pattern>` +
    `<mask id="m-nomass" maskUnits="userSpaceOnUse" x="0" y="0" width="${S}" height="${S}"><rect x="0" y="0" width="${S}" height="${S}" fill="#fff"/><path d="${d}" fill="#000" fill-rule="evenodd"/></mask></defs>` +
    `<g class="u-shadow" mask="url(#m-nomass)"><path d="${d}" transform="translate(${f1(dx)} ${f1(dy)})" fill="${sh.hatch ? 'url(#p-shadow)' : sh.color}" fill-opacity="${sh.hatch ? 1 : sh.alpha}" fill-rule="evenodd"/></g>`;
}

export function gridSvg(world: World, pal: Palette, u: number): string {
  const g = pal.grid;
  if (!g) return '';
  const S = world.mapSize;
  let d = '';
  for (let v = g.step; v < S; v += g.step) d += `M${v} 0V${S}M0 ${v}H${S}`;
  return `<path class="layer-grid" d="${d}" fill="none" stroke="${g.color}" stroke-opacity="${g.opacity}" stroke-width="${f1(0.6 * u)}"/>`;
}

/** Engraved horizontal lines over the sea and the lakes (pattern defined here, referenced as p-waterlines). */
export function waterLinesSvg(world: World, pal: Palette): string {
  const wl = pal.waterLines;
  if (!wl) return '';
  const t = world.terrain;
  const swi = seaWithIslands(t.coastline, t.islands);
  const seaD = swi.sea.map((poly, i) => pathD(poly, true) + swi.holes[i].map((h) => pathD(h, true)).join('')).join('');
  const lakeD = t.lakes.map((l) => pathD(l, true)).join('');
  const g = wl.gap;
  return `<defs><pattern id="p-waterlines" patternUnits="userSpaceOnUse" width="${f1(g)}" height="${f1(g)}"><path d="M0 ${f1(g / 2)}H${f1(g)}" stroke="${wl.color}" stroke-opacity="${wl.opacity}" stroke-width="${f1(wl.width)}"/></pattern></defs>` +
    `<g class="water-lines">${seaD ? `<path d="${seaD}" fill="url(#p-waterlines)" fill-rule="evenodd"/>` : ''}${lakeD ? `<path d="${lakeD}" fill="url(#p-waterlines)"/>` : ''}</g>`;
}
