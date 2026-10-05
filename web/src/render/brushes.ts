/** Display-only, shared placement for the optional ImageGen botanical stamps. */
import { biomeName } from '../gen/biomes';
import type { World, LandKind } from '../gen/types';
import type { Palette } from './styles';

export interface BrushSources { version: string; vegetation: string; terrain: string }
export interface BrushImages { sources: BrushSources; vegetation: CanvasImageSource; terrain: CanvasImageSource }
export type BrushKind = 'forest' | 'orchard' | 'meadow' | 'pasture' | 'marsh' | 'commons' | 'garden' | 'field';
export interface BrushStamp { atlas: 'vegetation' | 'terrain'; cell: number; x: number; y: number; size: number; alpha: number }
export interface BrushMotif { width: number; stamps: BrushStamp[] }
export const BRUSH_CELL = 209;
export const BRUSH_ATLAS = 1254;
const BIOMES = ['temperate', 'forest', 'desert', 'steppe', 'tropical', 'tundra'] as const;
const SPECIES: number[][] = [[0, 0, 1, 2, 3, 3, 4, 5], [0, 0, 1, 1, 2, 3, 3, 4, 5], [0, 1, 2, 2, 3, 4, 4, 5], [0, 1, 2, 3, 3, 4, 5], [0, 1, 1, 2, 3, 4, 5, 5], [0, 1, 2, 3, 4, 5]];
const LOW_FLORA = [
  { cells: [4, 5], chance: 0.18 }, { cells: [10], chance: 0.5 },
  { cells: [16, 17], chance: 0.7 }, { cells: [21, 22, 23], chance: 0.65 },
  { cells: [27, 28], chance: 0.5 }, { cells: [30, 31, 33, 34, 35], chance: 0.92 },
];
// The atlas has only one temperate fruit canopy. Legacy cold orchards reuse the hardy fruit cell, never willow/birch.
const FRUIT: number[][] = [[1], [1], [12, 12, 13], [20], [24, 24, 26], [20]];

export function brushHash(seed: string, x = 0, y = 0, salt = 0): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (Math.round(x * 1000) | 0), 0x85ebca6b);
  h = Math.imul(h ^ (Math.round(y * 1000) | 0) ^ salt, 0xc2b2ae35);
  h ^= h >>> 16; return (h >>> 0) / 4294967296;
}

export function brushCell(world: Pick<World, 'seed' | 'options'>, x: number, y: number, orchard = false): number {
  const row = BIOMES.indexOf(biomeName(world.options.biome));
  const choices = orchard ? FRUIT[row] : SPECIES[row].map(c => row * 6 + c);
  const dominant = choices[Math.floor(brushHash(world.seed, 0, 0, orchard ? 73 : 19) * choices.length)];
  // Map-wide character, with spatially stable minority species. Never consumes generation RNG.
  return brushHash(world.seed, x, y, 101) < 0.48 ? dominant : choices[Math.floor(brushHash(world.seed, x, y, 137) * choices.length)];
}

export function isBrushKind(kind: LandKind | string): kind is BrushKind {
  return ['forest', 'orchard', 'meadow', 'pasture', 'marsh', 'commons', 'garden', 'field'].includes(kind);
}

export function brushTextureOn(kind: BrushKind, pal: Palette, biome?: string): boolean {
  return kind === 'field' || (kind === 'commons' && biomeName(biome) === 'desert') || !!pal.tex[kind];
}

/** Repeated world-anchored motif: identical placements in SVG and Canvas, bounded export size. */
export function brushMotif(world: Pick<World, 'seed' | 'options'>, kind: BrushKind): BrushMotif {
  const spacing = { forest: 9, orchard: 11, meadow: 16, pasture: 24, marsh: 15, commons: 22, garden: 8, field: 14 }[kind];
  const cells = kind === 'forest' || kind === 'orchard' ? 8 : 4;
  const stamps: BrushStamp[] = [];
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
    const h = (salt: number): number => brushHash(world.seed, i, j, salt + kind.length * 29);
    const x = (i + (kind === 'orchard' ? 0.5 : 0.15 + h(3) * 0.7)) * spacing;
    const y = (j + (kind === 'orchard' ? 0.5 : 0.15 + h(7) * 0.7)) * spacing;
    const tree = kind === 'forest' || kind === 'orchard';
    const flora = LOW_FLORA[BIOMES.indexOf(biomeName(world.options.biome))];
    const lowFlora = (kind === 'meadow' || kind === 'pasture') && h(31) < flora.chance;
    const row = kind === 'commons' ? biomeName(world.options.biome) === 'desert' ? 0 : 1 : kind === 'marsh' ? 3 : kind === 'garden' ? 4 : kind === 'field' ? 5 : 2;
    stamps.push({ atlas: tree || lowFlora ? 'vegetation' : 'terrain', cell: tree ? brushCell(world, i, j, kind === 'orchard') : lowFlora ? flora.cells[Math.floor(h(37) * flora.cells.length)] : row * 6 + Math.floor(h(13) * 6),
      x, y, size: (kind === 'forest' ? 9.5 : kind === 'orchard' ? 7 : kind === 'commons' ? row === 0 ? 17 : 9 : kind === 'garden' ? 8 : kind === 'field' ? 11 : lowFlora ? 7.5 : 10) * (0.82 + h(23) * 0.18),
      alpha: kind === 'field' ? 0.65 : kind === 'commons' ? 0.8 : 0.94 });
  }
  return { width: cells * spacing, stamps };
}

/** Optional monochrome conversion shared by SVG feColorMatrix and cached Canvas pixels. */
export function brushColorMatrix(pal: Palette): number[] | null {
  if (!['engraving', 'blueprint', 'night'].includes(pal.name)) return null;
  const rgb = (hex: string): number[] => { const n = parseInt(hex.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
  let a = rgb(pal.treeInk), b = rgb(pal.treeFill);
  if (pal.name === 'night') {
    // Painted foliage needs visible leaf tones on navy ground; never alters the classic palette.
    const paper = rgb(pal.paper), ink = rgb(pal.ink);
    a = a.map((c, i) => c * 0.9 + paper[i] * 0.1);
    b = b.map((c, i) => Math.min(0.55, c * 0.58 + ink[i] * 0.42));
  }
  const out: number[] = [];
  for (let c = 0; c < 3; c++) out.push((b[c] - a[c]) * 0.2126, (b[c] - a[c]) * 0.7152, (b[c] - a[c]) * 0.0722, 0, a[c]);
  out.push(0, 0, 0, 1, 0); return out;
}

/** Decode is explicit and asynchronous; failure returns classic rather than breaking a map. */
export async function decodeBrushes(sources: BrushSources): Promise<BrushImages | null> {
  const decode = async (uri: string): Promise<CanvasImageSource> => {
    if (typeof createImageBitmap === 'function') {
      const blob = await (await fetch(uri)).blob();
      const img = await createImageBitmap(blob);
      if (img.width !== BRUSH_ATLAS || img.height !== BRUSH_ATLAS) { img.close(); throw new Error('Invalid brush atlas'); }
      return img;
    }
    if (typeof Image !== 'undefined') return new Promise((resolve, reject) => {
      const img = new Image(); img.onload = () => img.naturalWidth === BRUSH_ATLAS && img.naturalHeight === BRUSH_ATLAS ? resolve(img) : reject(new Error('Invalid brush atlas'));
      img.onerror = reject; img.src = uri;
    });
    throw new Error('Brush image decoding unavailable');
  };
  const results = await Promise.allSettled([decode(sources.vegetation), decode(sources.terrain)]);
  if (results.every(r => r.status === 'fulfilled')) return { sources, vegetation: (results[0] as PromiseFulfilledResult<CanvasImageSource>).value, terrain: (results[1] as PromiseFulfilledResult<CanvasImageSource>).value };
  for (const r of results) if (r.status === 'fulfilled' && 'close' in r.value) (r.value as ImageBitmap).close();
  return null;
}
