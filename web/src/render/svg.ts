import type { World } from '../gen/types';
import type { StyleName } from '../gen/options';
import { Vec2, chaikin, simplify, offsetRibbon } from '../gen/core/geom';
import { marchingSquares } from '../gen/terrain/contour';
import { contourSet, ContourSet } from './contours';
import { PALETTES, Palette } from './styles';
import { renderTerrainRaster, pngDataUrl } from './raster';
import { f1, pathD, seaWithIslands } from './util';
import { landuseLayer, roadsLayer, siteLayer } from './landuse';
import { urbanLayer } from './urban';

export interface RenderOptions {
  style?: StyleName; contours?: boolean; raster?: boolean; landuse?: boolean; debug?: boolean;
}

function contourLayer(world: World, pal: Palette, u: number): string {
  const cs = contourSet(world, u);
  const dOf = (l: ContourSet['thin']): string => l.map((c) => pathD(c.pts, c.closed)).join('');
  const thin = dOf(cs.thin), index = dOf(cs.index);
  const sw = 0.55 * u;
  return `<g class="layer-contours" fill="none" stroke="${pal.contour}" stroke-linejoin="round" stroke-linecap="round">` +
    (thin ? `<path d="${thin}" stroke-width="${f1(sw)}" opacity="${pal.contourOpacity * 0.7}"/>` : '') +
    (index ? `<path d="${index}" stroke-width="${f1(sw * 1.9)}" opacity="${pal.contourOpacity}"/>` : '') +
    '</g>';
}

function rippleLayer(world: World, pal: Palette, u: number): string {
  const hg = world.terrain.height;
  if (!world.terrain.seaSide) return '';
  const levels = [-2.5, -5.5, -9, -13];
  let out = '';
  levels.forEach((lv, i) => {
    // contour where height crosses lv (inside = deeper than lv => use negated field)
    const neg = new Float32Array(hg.data.length);
    for (let k = 0; k < neg.length; k++) neg[k] = -hg.data[k];
    const paths = marchingSquares(neg, hg.w, hg.h, -lv, hg.cell, hg.cell / 2, hg.cell / 2);
    let d = '';
    for (const p of paths) {
      if (p.pts.length < 4) continue;
      let pts = chaikin(p.pts, 2, p.closed);
      pts = simplify(pts, 0.4 * u);
      d += pathD(pts, p.closed);
    }
    if (!d) return;
    const dash = i >= 2 ? ` stroke-dasharray="${f1((i === 2 ? 9 : 5) * u)} ${f1((i === 2 ? 4 : 6) * u)}"` : '';
    out += `<path d="${d}" stroke-width="${f1((1.3 - i * 0.2) * u)}" opacity="${pal.rippleOpacity[i]}"${dash}/>`;
  });
  return `<g class="ripples" fill="none" stroke="${pal.ripple}" stroke-linecap="round">${out}</g>`;
}

function niceLength(target: number): number {
  const opts = [25, 50, 100, 200, 250, 500, 1000, 2000];
  let best = opts[0];
  for (const o of opts) if (o <= target) best = o;
  return best;
}

function decor(world: World, pal: Palette, u: number): string {
  const S = world.mapSize;
  const m = 22 * u;
  const fs = 11 * u;
  let s = `<g class="layer-decor" font-family="${pal.fontFamily}" fill="${pal.ink}">`;
  // frame
  s += `<rect x="${f1(5 * u)}" y="${f1(5 * u)}" width="${f1(S - 10 * u)}" height="${f1(S - 10 * u)}" fill="none" stroke="${pal.frame}" stroke-width="${f1(2 * u)}"/>`;
  s += `<rect x="${f1(9 * u)}" y="${f1(9 * u)}" width="${f1(S - 18 * u)}" height="${f1(S - 18 * u)}" fill="none" stroke="${pal.frame}" stroke-width="${f1(0.7 * u)}"/>`;
  // scale bar
  const L = niceLength(S * 0.2);
  const x0 = m + 6 * u, y0 = S - m - 8 * u;
  const bh = 5 * u;
  s += `<rect x="${f1(x0 - 8 * u)}" y="${f1(y0 - 20 * u)}" width="${f1(L + 40 * u)}" height="${f1(40 * u)}" fill="${pal.paper}" opacity="0.72"/>`;
  const seg = 4;
  for (let i = 0; i < seg; i++) {
    s += `<rect x="${f1(x0 + (L * i) / seg)}" y="${f1(y0 - bh / 2)}" width="${f1(L / seg)}" height="${f1(bh)}" fill="${i % 2 ? pal.paper : pal.ink}" stroke="${pal.ink}" stroke-width="${f1(0.8 * u)}"/>`;
  }
  s += `<text x="${f1(x0)}" y="${f1(y0 - 8 * u)}" font-size="${f1(fs)}" text-anchor="middle">0</text>`;
  s += `<text x="${f1(x0 + L / 2)}" y="${f1(y0 - 8 * u)}" font-size="${f1(fs)}" text-anchor="middle">${L / 2}</text>`;
  s += `<text x="${f1(x0 + L)}" y="${f1(y0 - 8 * u)}" font-size="${f1(fs)}" text-anchor="start"> ${L} m</text>`;
  // north arrow
  const cx = S - m - 22 * u, cy = m + 34 * u, r = 26 * u;
  s += `<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r * 1.15)}" fill="${pal.paper}" opacity="0.72"/>`;
  s += `<path d="M${f1(cx)} ${f1(cy - r)}L${f1(cx + r * 0.32)} ${f1(cy + r * 0.55)}L${f1(cx)} ${f1(cy + r * 0.25)}Z" fill="${pal.ink}"/>`;
  s += `<path d="M${f1(cx)} ${f1(cy - r)}L${f1(cx - r * 0.32)} ${f1(cy + r * 0.55)}L${f1(cx)} ${f1(cy + r * 0.25)}Z" fill="none" stroke="${pal.ink}" stroke-width="${f1(0.9 * u)}"/>`;
  s += `<text x="${f1(cx)}" y="${f1(cy - r - 4 * u)}" font-size="${f1(fs * 1.1)}" text-anchor="middle" font-weight="bold">N</text>`;
  s += '</g>';
  return s;
}

export function renderSvg(world: World, opts: RenderOptions = {}): string {
  const style = opts.style ?? world.options.style;
  const pal = PALETTES[style];
  const S = world.mapSize;
  const u = S / 1600;
  const t = world.terrain;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" data-seed="${world.seed}" data-style="${style}">`);
  parts.push(`<defs><clipPath id="mapclip"><rect x="0" y="0" width="${S}" height="${S}"/></clipPath></defs>`);
  parts.push(`<rect x="0" y="0" width="${S}" height="${S}" fill="${pal.paper}"/>`);
  parts.push('<g clip-path="url(#mapclip)">');

  if (opts.raster !== false) {
    const r = renderTerrainRaster(world, pal);
    parts.push(`<g class="layer-terrain"><image x="0" y="0" width="${S}" height="${S}" preserveAspectRatio="none" xlink:href="${pngDataUrl(r.png)}"/></g>`);
  }
  if (opts.contours ?? world.options.contours) parts.push(contourLayer(world, pal, u));

  if (opts.landuse ?? world.options.landuse) parts.push(landuseLayer(world, pal, u));

  // rivers: casing first, then fill so confluences merge cleanly
  const minW = 1.1 * u;
  const ribbons: string[] = [];
  for (const r of t.rivers) {
    if (r.path.length < 2) continue;
    const w = r.width.map((v, i) => {
      const taper = r.main ? 1 : Math.min(1, 0.35 + (0.65 * i) / 7);
      return Math.max(minW, v * taper);
    });
    ribbons.push(pathD(offsetRibbon(r.path, w), true));
  }
  if (ribbons.length) {
    parts.push(`<g class="layer-rivers">` +
      `<g fill="${pal.riverEdge}" stroke="${pal.riverEdge}" stroke-width="${f1(1.7 * u)}" stroke-linejoin="round">${ribbons.map((d) => `<path d="${d}"/>`).join('')}</g>` +
      `<g fill="${pal.riverFill}">${ribbons.map((d) => `<path d="${d}"/>`).join('')}</g></g>`);
  }

  // water
  let water = '<g class="layer-water">';
  // islands are holes of the sea polygon they lie in (evenodd), so the land shows through
  const swi = seaWithIslands(t.coastline, t.islands);
  const seaD = swi.sea.map((poly, i) => pathD(poly, true) + swi.holes[i].map((h) => pathD(h, true)).join(''));
  for (const d of seaD) water += `<path d="${d}" fill="${pal.seaFill}" fill-rule="evenodd"/>`;
  water += rippleLayer(world, pal, u);
  for (const d of seaD) water += `<path d="${d}" fill="none" stroke="${pal.waterEdge}" stroke-width="${f1(1.5 * u)}" stroke-linejoin="round"/>`;
  for (const poly of t.lakes) {
    water += `<path d="${pathD(poly, true)}" fill="${pal.lakeFill}" stroke="${pal.waterEdge}" stroke-width="${f1(1.3 * u)}" stroke-linejoin="round"/>`;
  }
  water += '</g>';
  parts.push(water);

  parts.push(roadsLayer(world, pal, u));
  if (world.urban) parts.push(urbanLayer(world, pal, u, !!opts.debug));
  else parts.push(siteLayer(world, pal, u, !!opts.debug));

  parts.push('</g>');
  parts.push(decor(world, pal, u));
  parts.push('</svg>');
  return parts.join('\n');
}
