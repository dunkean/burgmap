import { cavernDisplayWorld } from './cavernDisplay';
import { cavernPathD, cavernWallsSvg, cavernFungalRoomsSvg } from './caverns';
import type { World } from '../gen/types';
import { renderView } from '../gen/settlements/merge';
import { Vec2, chaikin, simplify, offsetRibbon } from '../gen/core/geom';
import { marchingSquares } from '../gen/terrain/contour';
import { contourSet, ContourSet } from './contours';
import { MAP_STROKES, svgMapStroke } from './strokes';
import { countrysideFringe } from './countryside';
import { currentLandscapeGround } from '../gen/landuse/landscapeGround';
import { worldGroundAppearance } from '../gen/landuse/groundAppearance';
import { worldCampCover } from './campCover';
import { worldForestClearings } from './forestClearings';
import { orientPos } from '../gen/geo/poly';
import { Palette, MapStyle } from './styles';
import { biomePalette } from './biomes';
import { renderTerrainRaster, pngDataUrl } from './raster';
import { f1, pathD, seaWithIslands } from './util';
import { landuseLayer, roadsLayer, siteLayer } from './landuse';
import { urbanLayer } from './urban';
import { labelsSvg } from './svgLabels';
import { cartoucheModel, legendModel, panelSvg } from './legend';
import { frameModel, panelMargin } from './frame';
import { litSvg, shadowSvg, gridSvg, waterLinesSvg } from './extras';
import { FONT_STACKS } from './labelStyles';
import { svgBrushes } from './brushSvg';
import type { BrushSources } from './brushes';
import { supportsPaintedBiome } from './brushes';
import type { Measure } from './mapLabels';
import type { ExportLayers } from './exportLayers';

export interface RenderOptions {
  /** Independent export layers; omitted flags stay visible. */
  layers?: Partial<ExportLayers>;
  /** Actual export width in pixels; sets decorative hairline weight. Defaults to the 1600 px design size, matching the default bounded hairline scale. */
  width?: number;
  style?: MapStyle; contours?: boolean; raster?: boolean; landuse?: boolean; debug?: boolean;
  /** Name labels (default: world.options.labels !== false), legend (default: world.options.legend) and cartouche (default on). */
  labels?: boolean; legend?: boolean; cartouche?: boolean;
  /** Text width measurer for label placement (browser: canvas based; default: estimate). */
  measure?: Measure;
  /** Optional display-only raster stamps; omitted keeps classic output byte-for-byte. */
  brushes?: BrushSources;
}

function contourLayer(world: World, pal: Palette, u: number, scale: number): string {
  const cs = contourSet(world, u);
  const dOf = (l: ContourSet['thin']): string => l.map((c) => pathD(c.pts, c.closed)).join('');
  const thin = dOf(cs.thin), index = dOf(cs.index);
  return `<g id="terrain-contour-ground" class="layer-contours" fill="none" stroke="${pal.contour}" stroke-linejoin="round" stroke-linecap="round">` +
    (thin ? `<path d="${thin}" ${svgMapStroke(MAP_STROKES.contour, scale)} opacity="${pal.contourOpacity * 0.7}"/>` : '') +
    (index ? `<path d="${index}" ${svgMapStroke(MAP_STROKES.contourIndex, scale, pal.contourIndexW / 1.6)} opacity="${pal.contourOpacity}"/>` : '') +
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

export function renderSvg(world0: World, opts: RenderOptions = {}): string {
  world0 = cavernDisplayWorld(world0);
  const world = renderView(world0);
  const style = opts.style ?? world.options.style;
  const pal = biomePalette(style, world.options.biome);
  const S = world.mapSize;
  const u = S / 1600;
  const width = opts.width !== undefined && Number.isFinite(opts.width) ? Math.max(1, opts.width) : 1600;
  const scale = width / S;
  const t = world.terrain;
  const layers = opts.layers ?? {};
  const raster = layers.terrain !== false && opts.raster !== false;
  const contours = layers.terrain !== false && (opts.contours ?? world.options.contours);
  const landuse = layers.landuse !== false && (opts.landuse ?? world.options.landuse);
  const painted = opts.brushes && supportsPaintedBiome(world.options.biome) ? svgBrushes(world, pal, opts.brushes) : undefined;
  const parts: string[] = [];
  const clearings = opts.debug ? [] : worldForestClearings(world0);
  const forestMask = clearings.length ? ' mask="url(#forest-clearance)"' : '';
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${S} ${S}" width="${width}" height="${width}" data-seed="${world.seed}" data-style="${style}">`);
  if (clearings.length) parts.push(`<defs><mask id="forest-clearance" maskUnits="userSpaceOnUse" x="0" y="0" width="${S}" height="${S}" style="mask-type:luminance"><rect width="${S}" height="${S}" fill="white"/>${clearings.map((p) => `<path d="${pathD(orientPos(p.outer), true) + p.holes.map((h) => pathD(orientPos(h).slice().reverse(), true)).join('')}" fill="black" fill-rule="nonzero"/>`).join('')}</mask></defs>`);
  parts.push(`<defs><clipPath id="mapclip"><rect x="0" y="0" width="${S}" height="${S}"/></clipPath></defs>`);
  if (painted) parts.push(painted.defs);
  if (layers.background !== false) parts.push(`<rect x="0" y="0" width="${S}" height="${S}" fill="${pal.paper}"/>`);
  parts.push('<g clip-path="url(#mapclip)">');

  if (raster) {
    const r = renderTerrainRaster(world, pal);
    parts.push(`<g class="layer-terrain"><image id="terrain-ground" x="0" y="0" width="${S}" height="${S}" preserveAspectRatio="none" xlink:href="${pngDataUrl(r.png)}"/></g>`);
  }
  if (t.caverns) parts.push(`<defs><clipPath id="cavern-floor"><path d="${cavernPathD(t.caverns.floor)}" clip-rule="evenodd"/></clipPath></defs><g clip-path="url(#cavern-floor)">`);
  if (layers.decor !== false && pal.grid) parts.push(gridSvg(world, pal, u));
  if (contours) parts.push(contourLayer(world, pal, u, scale));

  if (landuse) parts.push(landuseLayer(world, pal, u, scale, painted?.brushes, forestMask));

  // rivers: casing first, then fill so confluences merge cleanly
  const minW = 1.1 * u;
  const ribbons: string[] = [];
  for (const r of t.rivers) {
    if (r.path.length < 2) continue;
    const w = r.width.map((v, i) => {
      const taper = r.main || r.edgeFed ? 1 : Math.min(1, 0.35 + (0.65 * i) / 7);
      return Math.max(minW, v * taper);
    });
    ribbons.push(pathD(offsetRibbon(r.path, w), true));
  }
  if (layers.water !== false && ribbons.length) {
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
  if (layers.water !== false) parts.push(water);

  // roads and tracks never spill over the sea or the lakes (bridges over rivers are not masked)
  const lakeD = t.lakes.filter((p) => p.length >= 3).map((p) => pathD(p, true)).join('');
  const masked = seaD.length > 0 || lakeD.length > 0;
  if (masked) parts.push(`<clipPath id="landclip"><path d="M-50 -50H${S + 50}V${S + 50}H-50Z${seaD.join('')}${lakeD}" clip-rule="evenodd"/></clipPath>`);
  parts.push(`<g id="regional-road-ground"${masked ? ' clip-path="url(#landclip)"' : ''}>${roadsLayer(world, pal, u, painted?.brushes, { roads: layers.roads !== false, city: layers.city !== false })}</g>`);
  if (world.urban && (layers.city !== false || layers.streets !== false || layers.water !== false)) {
    const landscape = world0.landuse?.landscapeGround !== undefined;
    parts.push(urbanLayer(world, pal, u, !!opts.debug, opts.debug || landscape ? { bands: [], ground: [], streets: [] } : countrysideFringe(world0), raster, landuse, opts.debug || landscape ? [] : (world0.landuse?.naturalGround ?? []), contours, opts.debug ? [] : currentLandscapeGround(world0, true), worldGroundAppearance(world0), opts.debug ? [] : worldCampCover(world0), painted?.brushes, forestMask, layers));
    if (!opts.debug && layers.city !== false) { parts.push(shadowSvg(world, pal, u)); parts.push(litSvg(world, pal, u)); }
  } else if (layers.city !== false) parts.push(siteLayer(world, pal, u, !!opts.debug));

  if (t.caverns && landuse) parts.push(cavernFungalRoomsSvg(world, pal));
  if (t.caverns) { parts.push('</g>'); if (layers.terrain !== false) parts.push(cavernWallsSvg(world, pal, raster)); }
  parts.push('</g>');
  if (layers.labels !== false && (opts.labels ?? world.options.labels !== false)) parts.push(labelsSvg(world, pal, opts.measure, !!(opts.legend ?? world.options.legend)));
  if (layers.decor !== false) parts.push(decor(world, pal, u));
  const fam = FONT_STACKS[style] ?? pal.fontFamily;
  const pm = panelMargin(pal) * u;
  if (layers.decor !== false && opts.cartouche !== false) parts.push(panelSvg(cartoucheModel(world, pal, 1 / u), pm, pm, u, fam, 'cartouche'));
  if (layers.decor !== false && (opts.legend ?? !!world.options.legend)) {
    const lg = legendModel(world, pal);
    parts.push(panelSvg(lg, pm, S - pm - lg.h * u, u, fam, 'legend'));
  }
  parts.push('</svg>');
  return parts.join('\n');
}
