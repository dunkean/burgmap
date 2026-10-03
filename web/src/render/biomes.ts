import { biomeName, type BiomeName } from '../gen/biomes';
import { PALETTES, type MapStyle, type Palette } from './styles';

const GROUND: Record<Exclude<BiomeName, 'temperate'>, [string, string, string]> = {
  forest: ['#d8dfc0', '#b5c397', '#9a9f85'], desert: ['#f2d8a4', '#dcc28f', '#bca382'],
  steppe: ['#e7d9ad', '#c9bc8b', '#a7a184'], tropical: ['#d1dfb2', '#a5bd8c', '#929e7b'],
  tundra: ['#dce1d9', '#c6cdbd', '#a9b0a7'],
};
const CACHE = new Map<string, Palette>();

/** Shared palette for SVG, Canvas, terrain and legend. Never mutate the registered map styles. */
export function biomePalette(style: MapStyle | Palette, value?: string): Palette {
  const base = typeof style === 'string' ? PALETTES[style] : style;
  const biome = biomeName(value);
  if (biome === 'temperate') return base;
  // Custom palettes are also supported, but must not share cached tokens with the registered style.
  const key = base === PALETTES[base.name] ? `${base.name}:${biome}` : '';
  const cached = key && CACHE.get(key);
  if (cached) return cached;
  const dry = biome === 'desert', cold = biome === 'tundra';
  const colorful = !['engraving', 'blueprint', 'night'].includes(base.name);
  const tones = GROUND[biome];
  const pal: Palette = {
    ...base, tex: { ...base.tex, commons: dry ? false : base.tex.commons },
    hedgeOn: dry || cold ? false : base.hedgeOn,
    ...(colorful ? {
      hypso: [[0, tones[0]], [0.5, tones[1]], [1, tones[2]]] as [number, string][],
      land: { ...base.land, commons: tones[1], pasture: dry ? '#d5c79d' : cold ? '#c4cbb0' : base.land.pasture,
        forest: biome === 'tropical' ? '#799b65' : biome === 'forest' ? '#879e6e' : base.land.forest },
      grass: dry ? '#a18e64' : cold ? '#89927b' : base.grass,
    } : {}),
  };
  if (key) CACHE.set(key, pal);
  return pal;
}
