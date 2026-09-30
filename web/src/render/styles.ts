/**
 * Map style system. A style is a `Palette`: a flat bag of design tokens for every layer (paper, ink, water,
 * land use fills and textures, roads, street space, building roof / outline / shadow, landmarks, walls, labels,
 * fonts, hillshade, contours, frame and cartouche). Both renderers (SVG in svg.ts, Canvas in canvas.ts) and the
 * label / legend modules read only from here, so switching style is a pure re-render of the same World.
 *
 * `StyleName` (gen/options.ts) only knows the first two styles; `MapStyle` is the full list used by the UI.
 */
import type { StyleName } from '../gen/options';

export type MapStyle = StyleName | 'watabou' | 'engraving' | 'cadastre' | 'blueprint' | 'illuminated' | 'topographic' | 'night';
export type LandKindKey = 'field' | 'meadow' | 'pasture' | 'forest' | 'orchard' | 'garden' | 'marsh' | 'commons';
export type FrameKind = 'double' | 'thin' | 'ticks' | 'blueprint' | 'illuminated' | 'none';

export interface Palette {
  name: MapStyle;
  label: string;
  paper: string;
  ink: string;
  inkSoft: string;
  /** hypsometric stops: [t in 0..1 of relative land height, hex] */
  hypso: [number, string][];
  /** hillshade strength multiplier (0 = flat terrain) */
  shade: number;
  /** ink hatching on the shadow side of slopes (0 = none, 1 = strong); used by the engraving look */
  hatch: number;
  grain: number;
  seaFill: string;
  lakeFill: string;
  waterEdge: string;
  ripple: string;
  rippleOpacity: number[];
  riverFill: string;
  riverEdge: string;
  /** Horizontal engraved lines over sea and lakes (spacing/width in meters). */
  waterLines: { color: string; opacity: number; gap: number; width: number } | null;
  contour: string;
  contourOpacity: number;
  /** Index contour width multiplier (thin ones stay at 1). */
  contourIndexW: number;
  frame: string;
  frameKind: FrameKind;
  /** Accent (gold) used by the illuminated frame / cartouche and the blueprint ticks. */
  accent: string;
  /** Drawing grid (blueprint, topographic). */
  grid: { color: string; opacity: number; step: number } | null;
  fontFamily: string;
  /** Land-use base fills. */
  land: Record<LandKindKey, string>;
  landOpacity: number;
  /** `multiply` keeps the hillshade visible through the tint (light maps); dark maps use `normal`. */
  landBlend: 'multiply' | 'normal';
  /** Which land kinds carry a drawn texture (tree crowns, tufts, reeds...). */
  tex: Record<LandKindKey, boolean>;
  treeShape: 'blob' | 'crown' | 'dot';
  stripA: string; stripB: string; stripAlpha: [number, number];
  furrow: string; furrowAlpha: number; hedge: string; hedgeOn: boolean;
  treeFill: string; treeInk: string;
  grass: string; reed: string; orchardDot: string;
  roadEdge: string; roadFill: string; trackFill: string;
  bridgeDeck: string; bridgeInk: string;
  farmRoof: string; farmInk: string; farmYard: string;
  marker: string;
  /** Urban layer. */
  urban: {
    street: string; streetEdge: string; yard: string; garden: string; gardenInk: string;
    /** Building roof fill / outline (+ outline width in meters). */
    mass: string; massEdge: string; massEdgeW: number;
    plotLine: string; plotAlpha: number; plotLightAlpha: number; plotW: number;
    place: string; placeInk: string;
    wall: string; wallFill: string; wallScale: number; towerScale: number;
    blockEdge: string; blockEdgeW: number;
    landmark: string; landmarkEdge: string;
    /** Cast shadow of the masses (solid, with hatching when zoomed in). */
    shadow: { color: string; alpha: number; dx: number; dy: number; hatch: boolean } | null;
    /** Lit windows (night): deterministic speckles on a share of the buildings. */
    lit: { color: string; density: number } | null;
  };
  /** Labels. */
  lab: {
    water: string; wood: string; town: string; halo: string; haloOp: number;
    /** Area labels (forests, quarters, town): spaced small caps or full caps. */
    areaCaps: 'small' | 'upper';
    /** Italic water labels (seas, lakes, rivers). */
    waterItalic: boolean;
  };
  /** Cartouche / legend panel. */
  cart: { fill: string; stroke: string; accent: string; ornate: boolean; op: number };
}

export const hexToRgb = (hex: string): [number, number, number] => {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

type Nested = 'name' | 'label' | 'urban' | 'lab' | 'cart' | 'land' | 'tex';
type Override = Partial<Omit<Palette, Nested>> & { urban?: Partial<Palette['urban']>; lab?: Partial<Palette['lab']>; cart?: Partial<Palette['cart']>; land?: Partial<Palette['land']>; tex?: Partial<Palette['tex']> };

const ALL_TEX: Palette['tex'] = { field: true, meadow: true, pasture: true, forest: true, orchard: true, garden: true, marsh: true, commons: true };

const PARCHMENT: Palette = {
  name: 'parchment',
  label: 'Parchment',
  paper: '#eee2c3',
  ink: '#4e3b28',
  inkSoft: '#7a6247',
  hypso: [[0, '#f0e5c8'], [0.35, '#e6d6ae'], [0.7, '#d6c091'], [1, '#c2a875']],
  shade: 0.9,
  hatch: 0,
  grain: 0.022,
  seaFill: '#bccbc8',
  lakeFill: '#bccbc8',
  waterEdge: '#5f7a7d',
  ripple: '#5d7e82',
  rippleOpacity: [0.9, 0.75, 0.6, 0.45],
  riverFill: '#bccbc8',
  riverEdge: '#5f7a7d',
  waterLines: null,
  contour: '#8a6b47',
  contourOpacity: 0.5,
  contourIndexW: 1.9,
  frame: '#4e3b28',
  frameKind: 'double',
  accent: '#8a6b47',
  grid: null,
  fontFamily: "Georgia, 'Times New Roman', serif",
  land: { field: '#e1cf94', meadow: '#bfca8e', pasture: '#cdd097', forest: '#94a86e', orchard: '#c6cb8a', garden: '#cdc78c', marsh: '#b4c5a6', commons: '#d3cc9b' },
  landOpacity: 0.62,
  landBlend: 'multiply',
  tex: ALL_TEX,
  treeShape: 'blob',
  stripA: '#e8d9a4', stripB: '#d9c488', stripAlpha: [0.55, 0.5],
  furrow: '#8d7443', furrowAlpha: 0.6, hedge: '#5f6d3d', hedgeOn: true,
  treeFill: '#8aa065', treeInk: '#4a5a33',
  grass: '#5f7a3c', reed: '#4f7a72', orchardDot: '#55703a',
  roadEdge: '#4e3b28', roadFill: '#f6edd0', trackFill: '#6b5236',
  bridgeDeck: '#f6edd0', bridgeInk: '#3b2c1c',
  farmRoof: '#c69b70', farmInk: '#4e3b28', farmYard: '#d8c79a',
  marker: '#8b2f1f',
  urban: {
    street: '#f4ead0', streetEdge: '#6b5236', yard: '#e6d6a8', garden: '#d3cf98', gardenInk: '#6f7a42',
    mass: '#4a3826', massEdge: '#f1e5c6', massEdgeW: 0.3,
    plotLine: '#5a4530', plotAlpha: 0.45, plotLightAlpha: 0.28, plotW: 0.14,
    place: '#ece0bf', placeInk: '#8a7050',
    wall: '#3b2c1c', wallFill: '#6b5540', wallScale: 1, towerScale: 1,
    blockEdge: '#5a4530', blockEdgeW: 0.4,
    landmark: '#9c7a55', landmarkEdge: '#4a3826',
    shadow: null, lit: null,
  },
  lab: { water: '#3f6468', wood: '#4a5a33', town: '#4e3b28', halo: '#eee2c3', haloOp: 0.8, areaCaps: 'small', waterItalic: true },
  cart: { fill: '#eee2c3', stroke: '#4e3b28', accent: '#4e3b28', ornate: false, op: 0.9 },
};

function derive(name: MapStyle, label: string, o: Override, base: Palette = PARCHMENT): Palette {
  const { urban, lab, cart, land, tex, ...rest } = o;
  return {
    ...base, ...(rest as Partial<Palette>), name, label,
    land: { ...base.land, ...land },
    tex: { ...base.tex, ...tex },
    urban: { ...base.urban, ...urban },
    lab: { ...base.lab, ...lab },
    cart: { ...base.cart, ...cart },
  };
}

const SANS = "'Segoe UI', 'Helvetica Neue', Helvetica, Arial, 'Liberation Sans', sans-serif";
const SERIF = "Georgia, 'Times New Roman', 'Liberation Serif', serif";
const OLD_SERIF = "'Palatino Linotype', Palatino, 'Book Antiqua', 'URW Palladio L', Georgia, 'Times New Roman', serif";
/** Script-like hand: no generic `cursive` (it falls back to unreadable faces on some systems). */
const SCRIPT = "'Segoe Script', 'Lucida Handwriting', 'Snell Roundhand', 'Apple Chancery', 'URW Chancery L', 'Z003', 'Palatino Linotype', Georgia, serif";

const atlas = derive('atlas', 'Atlas', {
  paper: '#f4f1e8', ink: '#33404a', inkSoft: '#5b6975',
  hypso: [[0, '#a8c98d'], [0.12, '#c2d798'], [0.32, '#e4d9a2'], [0.52, '#d9bd8b'], [0.72, '#bb9675'], [0.88, '#d6cdc6'], [1, '#f6f6f6']],
  shade: 1.05, grain: 0,
  seaFill: '#8fc0e2', lakeFill: '#8fc0e2', waterEdge: '#4a86b3', ripple: '#e9f4fb', rippleOpacity: [0.7, 0.5, 0.35, 0.2],
  riverFill: '#8fc0e2', riverEdge: '#4a86b3',
  contour: '#8b5a3c', contourOpacity: 0.55, frame: '#33404a', accent: '#4a86b3',
  fontFamily: SANS,
  land: { field: '#f0e6a6', meadow: '#b9dc95', pasture: '#cfe3a2', forest: '#7fba78', orchard: '#c5dc8a', garden: '#d5e3a0', marsh: '#a6d1b8', commons: '#dde3aa' },
  landOpacity: 0.72,
  stripA: '#f4ecb4', stripB: '#e6dc92', furrow: '#a89a55', hedge: '#4f8a4a',
  treeFill: '#5fa35a', treeInk: '#2f6a34', grass: '#4c8f3f', reed: '#3a8f88', orchardDot: '#3f8a3a',
  roadEdge: '#5a4a3c', roadFill: '#fffdf4', trackFill: '#8a7660', bridgeDeck: '#fffdf4', bridgeInk: '#3b3b3b',
  farmRoof: '#d9a678', farmInk: '#5a4a3c', farmYard: '#e8dcae', marker: '#b3261e',
  urban: {
    street: '#fbf7ec', streetEdge: '#6a5a4a', yard: '#efe5c9', garden: '#d8e2ad', gardenInk: '#6f9a4f',
    mass: '#b4604a', massEdge: '#6e3526', plotLine: '#8a6a58', place: '#f1ead6', placeInk: '#9a8a70',
    wall: '#4a3c34', wallFill: '#8a7a6c', blockEdge: '#7a6252', landmark: '#7d4a8a', landmarkEdge: '#4a2a54',
  },
  lab: { water: '#2f6d99', wood: '#2f6a34', town: '#33404a', halo: '#f4f1e8', waterItalic: true },
  cart: { fill: '#f4f1e8', stroke: '#33404a', accent: '#4a86b3' },
});

/** The classic generator look: plain light paper, streets as negative space, grey buildings, thick black walls. */
const watabou = derive('watabou', 'Plain (classic)', {
  paper: '#f4f2ec', ink: '#1d1d1d', inkSoft: '#5c5c58',
  hypso: [[0, '#f4f2ec'], [1, '#efece4']], shade: 0.07, grain: 0,
  seaFill: '#b8cad6', lakeFill: '#b8cad6', waterEdge: '#3c4c57', ripple: '#ffffff', rippleOpacity: [0.55, 0.4, 0.25, 0.12],
  riverFill: '#b8cad6', riverEdge: '#3c4c57',
  contour: '#9c988c', contourOpacity: 0.4, contourIndexW: 1.5,
  frame: '#1d1d1d', frameKind: 'thin', accent: '#1d1d1d',
  fontFamily: SANS,
  land: { field: '#f4f2ec', meadow: '#ecebe0', pasture: '#eeede4', forest: '#dfe2d4', orchard: '#e6e9da', garden: '#e2e7d3', marsh: '#dde5e2', commons: '#eeede4' },
  landOpacity: 0.85, landBlend: 'normal',
  tex: { field: true, meadow: false, pasture: false, forest: false, orchard: true, garden: false, marsh: true, commons: false },
  treeShape: 'dot',
  stripA: '#f4f2ec', stripB: '#f4f2ec', stripAlpha: [0, 0], furrow: '#8f8b80', furrowAlpha: 0.7, hedge: '#8f8b80', hedgeOn: false,
  treeFill: '#c9cdb8', treeInk: '#7e846c', grass: '#8c9279', reed: '#7d9691', orchardDot: '#7e846c',
  roadEdge: '#2a2a2a', roadFill: '#fbfaf7', trackFill: '#6a6a66', bridgeDeck: '#fbfaf7', bridgeInk: '#1d1d1d',
  farmRoof: '#cfcbc0', farmInk: '#2a2a2a', farmYard: '#ebe8df', marker: '#b3261e',
  urban: {
    street: '#fbfaf7', streetEdge: '#6a6a66', yard: '#ece9e0', garden: '#dfe6d2', gardenInk: '#95a283',
    mass: '#cdc9be', massEdge: '#262626', massEdgeW: 0.5,
    plotLine: '#3a3a3a', plotAlpha: 0.5, plotLightAlpha: 0, plotW: 0.16,
    place: '#fbfaf7', placeInk: '#b8b4a8',
    wall: '#0c0c0c', wallFill: '#0c0c0c', wallScale: 1.7, towerScale: 1.3,
    blockEdge: '#262626', blockEdgeW: 0.45,
    landmark: '#9a968a', landmarkEdge: '#1d1d1d',
  },
  lab: { water: '#4f6f82', wood: '#6b7058', town: '#111111', halo: '#f4f2ec', haloOp: 0.85, areaCaps: 'upper', waterItalic: true },
  cart: { fill: '#fbfaf7', stroke: '#1d1d1d', accent: '#1d1d1d', op: 0.95 },
});

/** Merian / Braun & Hogenberg: monochrome sepia ink and wash, hatched relief, drawn tree crowns. */
const engraving = derive('engraving', 'Engraving', {
  paper: '#ede2c6', ink: '#33261a', inkSoft: '#66513b',
  hypso: [[0, '#eee4c9'], [0.5, '#e8dcbb'], [1, '#e0d1ac']], shade: 0.42, hatch: 0.9, grain: 0.03,
  seaFill: '#e4dbc0', lakeFill: '#e4dbc0', waterEdge: '#33261a', ripple: '#33261a', rippleOpacity: [0.85, 0.65, 0.5, 0.35],
  riverFill: '#e4dbc0', riverEdge: '#33261a',
  waterLines: { color: '#4a3a28', opacity: 0.62, gap: 5.6, width: 0.5 },
  contour: '#6b5238', contourOpacity: 0.4, contourIndexW: 1.6,
  frame: '#33261a', frameKind: 'double', accent: '#33261a',
  fontFamily: OLD_SERIF,
  land: { field: '#e5d6ae', meadow: '#e3d8b2', pasture: '#e6dcb9', forest: '#dccfa6', orchard: '#e3d8b2', garden: '#e4d9b4', marsh: '#ddd6b8', commons: '#e6dcb9' },
  landOpacity: 0.55,
  treeShape: 'crown',
  stripA: '#e9dcb6', stripB: '#dccda2', stripAlpha: [0.4, 0.4], furrow: '#4f3d29', furrowAlpha: 0.6, hedge: '#33261a',
  treeFill: '#efe5ca', treeInk: '#33261a', grass: '#4f3d29', reed: '#4f3d29', orchardDot: '#33261a',
  roadEdge: '#33261a', roadFill: '#f2e9d0', trackFill: '#4f3d29', bridgeDeck: '#f2e9d0', bridgeInk: '#33261a',
  farmRoof: '#cdb98f', farmInk: '#33261a', farmYard: '#e6dab4', marker: '#7a2a1a',
  urban: {
    street: '#f2e9d0', streetEdge: '#4f3d29', yard: '#e7dab6', garden: '#e9dfbc', gardenInk: '#5a4a32',
    mass: '#cdb88c', massEdge: '#2b2016', massEdgeW: 0.42,
    plotLine: '#4f3d29', plotAlpha: 0.4, plotLightAlpha: 0.0, plotW: 0.13,
    place: '#f0e6c8', placeInk: '#7a6247',
    wall: '#241a10', wallFill: '#8a7556', wallScale: 1, towerScale: 1.05,
    blockEdge: '#3d2e1f', blockEdgeW: 0.45,
    landmark: '#a98c5e', landmarkEdge: '#241a10',
    shadow: { color: '#2b2016', alpha: 0.62, dx: 1.9, dy: 2.3, hatch: true },
  },
  lab: { water: '#4a3a28', wood: '#3d2e1f', town: '#241a10', halo: '#ede2c6', haloOp: 0.75, areaCaps: 'small', waterItalic: true },
  cart: { fill: '#ede2c6', stroke: '#33261a', accent: '#33261a', op: 0.94 },
});

/** Napoleonic cadastre: carmine buildings, fine black plot lines, pale blue wash, green gardens, script labels. */
const cadastre = derive('cadastre', 'Cadastre 1:1250', {
  paper: '#f3ecd8', ink: '#1f1c1e', inkSoft: '#544c4e',
  hypso: [[0, '#f3ecd8'], [1, '#efe6cf']], shade: 0.05, grain: 0.012,
  seaFill: '#c6dced', lakeFill: '#c6dced', waterEdge: '#5f8fb0', ripple: '#ffffff', rippleOpacity: [0.6, 0.45, 0.3, 0.15],
  riverFill: '#c6dced', riverEdge: '#5f8fb0',
  waterLines: { color: '#6f9cbc', opacity: 0.4, gap: 6, width: 0.3 },
  contour: '#a59b84', contourOpacity: 0.4, contourIndexW: 1.4,
  frame: '#1f1c1e', frameKind: 'ticks', accent: '#1f1c1e',
  fontFamily: SCRIPT,
  land: { field: '#f3ecd8', meadow: '#ebf0d3', pasture: '#f0f3da', forest: '#d2e2b4', orchard: '#dbe8ba', garden: '#cfe3b4', marsh: '#d6e5d4', commons: '#f1f2de' },
  landOpacity: 0.8, landBlend: 'multiply',
  tex: { field: true, meadow: false, pasture: false, forest: true, orchard: true, garden: false, marsh: true, commons: false },
  treeShape: 'dot',
  stripA: '#f3ecd8', stripB: '#efe3c4', stripAlpha: [0, 0.5], furrow: '#1f1c1e', furrowAlpha: 0.65, hedge: '#3e5a2b', hedgeOn: false,
  treeFill: '#b8d08f', treeInk: '#5d7d3f', grass: '#6d8a4c', reed: '#6b94a8', orchardDot: '#5d7d3f',
  roadEdge: '#1f1c1e', roadFill: '#f8f3e3', trackFill: '#4a4446', bridgeDeck: '#f8f3e3', bridgeInk: '#1f1c1e',
  farmRoof: '#dc6f86', farmInk: '#1f1c1e', farmYard: '#f0e8d0', marker: '#b3261e',
  urban: {
    street: '#f8f3e3', streetEdge: '#1f1c1e', yard: '#f3ecd8', garden: '#cfe4b4', gardenInk: '#6d9a4a',
    mass: '#dc6f86', massEdge: '#2a1c20', massEdgeW: 0.36,
    plotLine: '#111111', plotAlpha: 0.85, plotLightAlpha: 0, plotW: 0.17,
    place: '#f8f3e3', placeInk: '#b9ae94',
    wall: '#1f1c1e', wallFill: '#b9b2a8', wallScale: 0.72, towerScale: 0.85,
    blockEdge: '#111111', blockEdgeW: 0.42,
    landmark: '#e7c65c', landmarkEdge: '#2a1c20',
  },
  lab: { water: '#3d6f94', wood: '#4d6a34', town: '#1f1c1e', halo: '#f3ecd8', haloOp: 0.8, areaCaps: 'small', waterItalic: true },
  cart: { fill: '#f8f3e3', stroke: '#1f1c1e', accent: '#c4566b', op: 0.96 },
});

/** White lines on deep blue. */
const blueprint = derive('blueprint', 'Blueprint', {
  paper: '#12356a', ink: '#e6efff', inkSoft: '#a9c2ea',
  hypso: [[0, '#143a72'], [0.5, '#184280'], [1, '#1e4d92']], shade: 0.55, grain: 0.01,
  seaFill: '#0d2a56', lakeFill: '#0d2a56', waterEdge: '#e6efff', ripple: '#9fbfee', rippleOpacity: [0.7, 0.55, 0.4, 0.25],
  riverFill: '#0d2a56', riverEdge: '#e6efff',
  waterLines: { color: '#9fbfee', opacity: 0.28, gap: 5, width: 0.3 },
  contour: '#8fb0e4', contourOpacity: 0.5, contourIndexW: 1.7,
  frame: '#e6efff', frameKind: 'blueprint', accent: '#8fb0e4',
  grid: { color: '#8fb0e4', opacity: 0.16, step: 100 },
  fontFamily: "'Segoe UI', 'Helvetica Neue', Arial, 'Liberation Sans', sans-serif",
  land: { field: '#2a5aa0', meadow: '#245394', pasture: '#275797', forest: '#2e66ae', orchard: '#2a5aa0', garden: '#2b5ca2', marsh: '#245a9c', commons: '#275797' },
  landOpacity: 0.3, landBlend: 'normal',
  treeShape: 'crown',
  stripA: '#2a5aa0', stripB: '#2a5aa0', stripAlpha: [0, 0.25], furrow: '#8fb0e4', furrowAlpha: 0.5, hedge: '#8fb0e4',
  treeFill: '#16407c', treeInk: '#9fbfee', grass: '#8fb0e4', reed: '#8fb0e4', orchardDot: '#9fbfee',
  roadEdge: '#e6efff', roadFill: '#12356a', trackFill: '#a9c2ea', bridgeDeck: '#12356a', bridgeInk: '#e6efff',
  farmRoof: '#1e4d92', farmInk: '#e6efff', farmYard: '#16407c', marker: '#ffd27a',
  urban: {
    street: '#12356a', streetEdge: '#e6efff', yard: '#173f7a', garden: '#1a4484', gardenInk: '#7fa2d8',
    mass: '#1f4f96', massEdge: '#e6efff', massEdgeW: 0.42,
    plotLine: '#e6efff', plotAlpha: 0.3, plotLightAlpha: 0, plotW: 0.13,
    place: '#153a74', placeInk: '#7fa2d8',
    wall: '#e6efff', wallFill: '#12356a', wallScale: 1, towerScale: 1.1,
    blockEdge: '#e6efff', blockEdgeW: 0.42,
    landmark: '#cfe0ff', landmarkEdge: '#e6efff',
  },
  lab: { water: '#b9d0f5', wood: '#b9d0f5', town: '#ffffff', halo: '#12356a', haloOp: 0.85, areaCaps: 'upper', waterItalic: true },
  cart: { fill: '#12356a', stroke: '#e6efff', accent: '#8fb0e4', op: 0.94 },
});

/** Colourful manuscript: lapis water, vermilion roofs, malachite woods, gold accents and an ornamental frame. */
const illuminated = derive('illuminated', 'Illuminated', {
  paper: '#f2e4bc', ink: '#3a2418', inkSoft: '#6b4a2e',
  hypso: [[0, '#f4e8c4'], [0.4, '#ecd9a4'], [0.75, '#dcc085'], [1, '#c9a46a']], shade: 0.5, grain: 0.02,
  seaFill: '#3b64ac', lakeFill: '#3b64ac', waterEdge: '#1c3a7a', ripple: '#d8e6ff', rippleOpacity: [0.85, 0.65, 0.45, 0.3],
  riverFill: '#3b64ac', riverEdge: '#1c3a7a',
  waterLines: { color: '#cfe0ff', opacity: 0.28, gap: 7, width: 0.55 },
  contour: '#a2703c', contourOpacity: 0.45, contourIndexW: 1.6,
  frame: '#2a1a3c', frameKind: 'illuminated', accent: '#c59a1c',
  fontFamily: OLD_SERIF,
  land: { field: '#ebc86a', meadow: '#96c16b', pasture: '#b2cb78', forest: '#4a8a52', orchard: '#86b556', garden: '#9ed070', marsh: '#63ab98', commons: '#c4c66a' },
  landOpacity: 0.7,
  treeShape: 'blob',
  stripA: '#f0d17c', stripB: '#e0b45a', stripAlpha: [0.6, 0.6], furrow: '#8c5a1c', hedge: '#2f6a3c',
  treeFill: '#3f7f4a', treeInk: '#1d4a2a', grass: '#3f7a30', reed: '#2d7a72', orchardDot: '#2d6a2a',
  roadEdge: '#6a3a1a', roadFill: '#fbeeb8', trackFill: '#7a4a24', bridgeDeck: '#fbeeb8', bridgeInk: '#3a2418',
  farmRoof: '#c2452f', farmInk: '#3a2418', farmYard: '#f0dc9c', marker: '#b3261e',
  urban: {
    street: '#fbf0c8', streetEdge: '#6a3a1a', yard: '#efdba0', garden: '#a4cd76', gardenInk: '#3f7a30',
    mass: '#bc432f', massEdge: '#4d1a10', massEdgeW: 0.42,
    plotLine: '#6a3a1a', plotAlpha: 0.4, plotLightAlpha: 0.22, plotW: 0.14,
    place: '#fbf0c8', placeInk: '#b8902e',
    wall: '#2a1a3c', wallFill: '#e8dcc0', wallScale: 1.1, towerScale: 1.1,
    blockEdge: '#6a3a1a', blockEdgeW: 0.42,
    landmark: '#2f58a8', landmarkEdge: '#c59a1c',
  },
  lab: { water: '#1c3a7a', wood: '#1d4a2a', town: '#8f2418', halo: '#f2e4bc', haloOp: 0.8, areaCaps: 'small', waterItalic: true },
  cart: { fill: '#f6e9c2', stroke: '#c59a1c', accent: '#2f58a8', ornate: true, op: 0.97 },
});

/** Modern topographic map: brown contours, green woods, cyan water, dark grey buildings, clean sans labels. */
const topographic = derive('topographic', 'Topographic', {
  paper: '#f6f4ea', ink: '#262626', inkSoft: '#595959',
  hypso: [[0, '#f5f3e6'], [0.5, '#efebd9'], [1, '#e6e0c8']], shade: 0.75, grain: 0,
  seaFill: '#a9d9ef', lakeFill: '#a9d9ef', waterEdge: '#3d9ac7', ripple: '#ffffff', rippleOpacity: [0.6, 0.45, 0.3, 0.15],
  riverFill: '#a9d9ef', riverEdge: '#3d9ac7',
  contour: '#b8753a', contourOpacity: 0.75, contourIndexW: 2.1,
  frame: '#262626', frameKind: 'ticks', accent: '#3d9ac7',
  grid: { color: '#4b9dc9', opacity: 0.3, step: 100 },
  fontFamily: SANS,
  land: { field: '#f8f2cc', meadow: '#dceeb2', pasture: '#e4efbd', forest: '#b5d99b', orchard: '#c9e3a4', garden: '#d3e8ac', marsh: '#c2e0d2', commons: '#e4efbd' },
  landOpacity: 0.85, landBlend: 'multiply',
  tex: { field: true, meadow: false, pasture: false, forest: false, orchard: true, garden: false, marsh: true, commons: false },
  treeShape: 'dot',
  stripA: '#f8f2cc', stripB: '#f0e8b4', stripAlpha: [0.35, 0.5], furrow: '#b9ae74', furrowAlpha: 0.5, hedge: '#5f9a4c', hedgeOn: true,
  treeFill: '#8fc27a', treeInk: '#4b8a3a', grass: '#5f9a4c', reed: '#3d9ac7', orchardDot: '#4b8a3a',
  roadEdge: '#9a5a1c', roadFill: '#ffc869', trackFill: '#7a6a52', bridgeDeck: '#ffc869', bridgeInk: '#262626',
  farmRoof: '#6a6a6a', farmInk: '#262626', farmYard: '#ebe6d0', marker: '#b3261e',
  urban: {
    street: '#fffdf6', streetEdge: '#8a8a8a', yard: '#eeeadb', garden: '#d3e8ac', gardenInk: '#5f9a4c',
    mass: '#4d4d4d', massEdge: '#2a2a2a', massEdgeW: 0.3,
    plotLine: '#7a7a7a', plotAlpha: 0.3, plotLightAlpha: 0.2, plotW: 0.12,
    place: '#fffdf6', placeInk: '#b5b0a0',
    wall: '#262626', wallFill: '#262626', wallScale: 0.85, towerScale: 1.1,
    blockEdge: '#4d4d4d', blockEdgeW: 0.38,
    landmark: '#262626', landmarkEdge: '#262626',
  },
  lab: { water: '#1f86b8', wood: '#3d7a2f', town: '#151515', halo: '#f6f4ea', haloOp: 0.85, areaCaps: 'upper', waterItalic: true },
  cart: { fill: '#fffdf6', stroke: '#262626', accent: '#3d9ac7', op: 0.96 },
});

/** Night: dark navy ground, dark roofs with warm deterministic lit windows, faintly lit streets, black-blue water. */
const night = derive('night', 'Night', {
  paper: '#0c111f', ink: '#d8dcc8', inkSoft: '#8f98b4',
  hypso: [[0, '#10182b'], [0.5, '#16203a'], [1, '#202c4a']], shade: 1.5, grain: 0,
  seaFill: '#060a14', lakeFill: '#060a14', waterEdge: '#2a3b66', ripple: '#3a4f88', rippleOpacity: [0.55, 0.4, 0.3, 0.2],
  riverFill: '#060a14', riverEdge: '#2a3b66',
  waterLines: { color: '#3a4f88', opacity: 0.22, gap: 6, width: 0.3 },
  contour: '#4a5c88', contourOpacity: 0.35, contourIndexW: 1.6,
  frame: '#56679a', frameKind: 'thin', accent: '#e8b867',
  fontFamily: SANS,
  land: { field: '#1a2440', meadow: '#14263a', pasture: '#172a3a', forest: '#0f2a26', orchard: '#14302a', garden: '#15302a', marsh: '#12303a', commons: '#182838' },
  landOpacity: 0.55, landBlend: 'normal',
  treeShape: 'blob',
  stripA: '#1d2a48', stripB: '#16203a', stripAlpha: [0.5, 0.5], furrow: '#3b4c78', furrowAlpha: 0.5, hedge: '#1c4a3c', hedgeOn: true,
  treeFill: '#12342c', treeInk: '#0a1c18', grass: '#1f5a48', reed: '#2a6a72', orchardDot: '#1c4a3c',
  roadEdge: '#04060e', roadFill: '#3a3529', trackFill: '#2a2b38', bridgeDeck: '#3a3529', bridgeInk: '#04060e',
  farmRoof: '#22283e', farmInk: '#04060e', farmYard: '#1a2236', marker: '#ffb45a',
  urban: {
    street: '#352f26', streetEdge: '#04060e', yard: '#141a2c', garden: '#14281f', gardenInk: '#2d6a4a',
    mass: '#232a42', massEdge: '#070a14', massEdgeW: 0.34,
    plotLine: '#04060e', plotAlpha: 0.5, plotLightAlpha: 0, plotW: 0.12,
    place: '#3d372b', placeInk: '#6a6048',
    wall: '#04060e', wallFill: '#45506e', wallScale: 1, towerScale: 1.1,
    blockEdge: '#04060e', blockEdgeW: 0.4,
    landmark: '#34304d', landmarkEdge: '#e0ac57',
    lit: { color: '#ffc45e', density: 0.5 },
  },
  lab: { water: '#7f9bd6', wood: '#6aa88a', town: '#f2e9c8', halo: '#0c111f', haloOp: 0.85, areaCaps: 'small', waterItalic: true },
  cart: { fill: '#10182b', stroke: '#56679a', accent: '#e8b867', op: 0.94 },
});

export const PALETTES: Record<MapStyle, Palette> = {
  parchment: PARCHMENT, atlas, watabou, engraving, cadastre, blueprint, illuminated, topographic, night,
};

/** Display order for the UI. */
export const STYLE_LIST: { id: MapStyle; label: string }[] = (Object.values(PALETTES) as Palette[]).map((p) => ({ id: p.name, label: p.label }));
export const isMapStyle = (v: string | null | undefined): v is MapStyle => !!v && Object.prototype.hasOwnProperty.call(PALETTES, v);
