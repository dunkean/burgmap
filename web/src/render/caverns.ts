/** Authoritative mask over an unchanged underground map, with dark fractured bedrock. */
import type { PolyH, World } from '../gen/types';
import { Noise2D } from '../gen/core/noise';
import { Rng } from '../gen/core/rng';
import { hexToRgb, type Palette } from './styles';
import { encodePng, pngDataUrl } from './raster';
import { pathD } from './util';

export const cavernPathD = (polys: PolyH[]): string => polys.map(p =>
  pathD(p.outer, true) + p.holes.map(h => pathD(h, true)).join('')).join('');
export function cavernWallFill(pal: Palette): string {
  return pal.name === 'blueprint' ? '#101923' : pal.name === 'engraving' ? '#141414' : '#111116';
}

/** One bounded 512-square image, anchored in world metres and independent of the cave mask. */
export function cavernRockPixels(seed: string, mapSize: number, pal: Palette): { width: number; rgba: Uint8ClampedArray } {
  const width = 512, rgba = new Uint8ClampedArray(width * width * 4);
  const noise = new Noise2D(new Rng(seed).fork('render:cavern-bedrock'));
  const base = hexToRgb(cavernWallFill(pal));
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const px = (x + .5) * mapSize / width, py = (y + .5) * mapSize / width;
    const low = noise.fbm(px / 240, py / 240, 3);
    const wx = px / 48 + low * .9, wy = py / 48 + noise.noise(px / 170 + 13, py / 170) * .7;
    const rock = noise.ridged(wx, wy, 3);
    const light = rock - noise.ridged(wx + .07, wy + .07, 3);
    const grain = noise.noise(px / 3.7, py / 3.7);
    const brightness = low * 5 + rock * 12 + light * 22 + grain * 3;
    const j = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) rgba[j + c] = Math.max(7, Math.min(48, base[c] + brightness));
    rgba[j + 3] = 255;
  }
  return { width, rgba };
}

export const CAVERN_RIM = [
  { color: '#050508', width: 30, alpha: .55 },
  { color: '#09090e', width: 13, alpha: .8 },
  { color: '#645d70', width: 2.5, alpha: .45 },
] as const;

export function cavernWallsSvg(world: World, pal: Palette, texture = true): string {
  const c = world.terrain.caverns;
  if (!c) return '';
  const solid = cavernPathD(c.solid), floor = cavernPathD(c.floor);
  let image = '';
  if (texture) {
    const r = cavernRockPixels(world.seed, world.mapSize, pal);
    image = `<image x="0" y="0" width="${world.mapSize}" height="${world.mapSize}" preserveAspectRatio="none" xlink:href="${pngDataUrl(encodePng(r.rgba, r.width, r.width, 4))}"/>`;
  }
  return `<g class="layer-cavern-walls"><defs><clipPath id="cavern-solid"><path d="${solid}" clip-rule="evenodd"/></clipPath></defs>`
    + `<path d="${solid}" fill="${cavernWallFill(pal)}" fill-rule="evenodd"/>`
    + `<g clip-path="url(#cavern-solid)">${image}`
    + CAVERN_RIM.map(r => `<path d="${floor}" fill="none" stroke="${r.color}" stroke-width="${r.width}" stroke-opacity="${r.alpha}" stroke-linejoin="round"/>`).join('')
    + '</g></g>';
}
