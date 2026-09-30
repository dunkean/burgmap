import type { World } from '../gen/types';
import { Vec2, chaikin, simplify, offsetRibbon } from '../gen/core/geom';
import { marchingSquares } from '../gen/terrain/contour';
import { contourSet, ContourSet } from './contours';
import { PALETTES, Palette, MapStyle } from './styles';
import { renderTerrainRaster, pngDataUrl } from './raster';
import { f1, pathD, seaWithIslands } from './util';
import { landuseLayer, roadsLayer, siteLayer } from './landuse';
import { urbanLayer } from './urban';
import { labelsSvg } from './svgLabels';
import { cartoucheModel, legendModel, panelSvg } from './legend';
import { frameModel, panelMargin } from './frame';
import { litSvg, shadowSvg, gridSvg, waterLinesSvg } from './extras';
import { FONT_STACKS } from './labelStyles';
import type { Measure } from './mapLabels';

export interface RenderOptions {
  style?: MapStyle; contours?: boolean; raster?: boolean; landuse?: boolean; debug?: boolean;
  /** Name labels (default: world.options.labels !== false), legend (default: world.options.legend) and cartouche (default on). */
  labels?: boolean; legend?: boolean; cartouche?: boolean;
  /** Text width measurer for label placement (browser: canvas based; default: estimate). */
  measure?: Measure;
}

function contourLayer(world: World, pal: Palette, u: number): string {
  const cs = contourSet(world, u);
  const dOf = (l: ContourSet['thin']): string => l.map((c) => pathD(c.pts, c.closed)).join('');
  const thin = dOf(cs.thin), index = dOf(cs.index);
  const sw = 0.55 * u;
  return `<g class="layer-contours" fill="none" stroke="${pal.contour}" stroke-linejoin="round" stroke-linecap="round">` +
    (thin ? `<path d="${thin}" stroke-width="${f1(sw)}" opacity="${pal.contourOpacity * 0.7}"/>` : '') +
    (index ? `<path d="${index}" stroke-width="${f1(sw * pal.contourIndexW)}" opacity="${pal.contourOpacity}"/>` : '') +
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

function decor(world: World, pal: Palette, u: number): string {
  const W = world.mapSize / u;
  return panelSvg({ w: W, h: W, prims: frameModel(W, W, pal, true) }, 0, 0, u, FONT_STACKS[pal.name] ?? pal.fontFamily, 'layer-decor');
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
  if (pal.grid) parts.push(gridSvg(world, pal, u));
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
  water += waterLinesSvg(world, pal);
  water += '</g>';
  parts.push(water);

  parts.push(roadsLayer(world, pal, u));
  if (world.urban) {
    parts.push(urbanLayer(world, pal, u, !!opts.debug));
    if (!opts.debug) { parts.push(shadowSvg(world, pal, u)); parts.push(litSvg(world, pal, u)); }
  } else parts.push(siteLayer(world, pal, u, !!opts.debug));

  parts.push('</g>');
  if (opts.labels ?? world.options.labels !== false) parts.push(labelsSvg(world, pal, opts.measure, !!(opts.legend ?? world.options.legend)));
  parts.push(decor(world, pal, u));
  const fam = FONT_STACKS[style] ?? pal.fontFamily;
  const pm = panelMargin(pal) * u;
  if (opts.cartouche !== false) parts.push(panelSvg(cartoucheModel(world, pal, 1 / u), pm, pm, u, fam, 'cartouche'));
  if (opts.legend ?? !!world.options.legend) {
    const lg = legendModel(world, pal);
    parts.push(panelSvg(lg, pm, S - pm - lg.h * u, u, fam, 'legend'));
  }
  parts.push('</svg>');
  return parts.join('\n');
}
