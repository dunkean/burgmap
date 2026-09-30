import type { StyleName } from '../gen/options';

export interface Palette {
  name: StyleName;
  paper: string;
  ink: string;
  inkSoft: string;
  /** hypsometric stops: [t in 0..1 of relative land height, hex] */
  hypso: [number, string][];
  /** hillshade strength multiplier */
  shade: number;
  grain: number;
  seaFill: string;
  lakeFill: string;
  waterEdge: string;
  ripple: string;
  rippleOpacity: number[];
  riverFill: string;
  riverEdge: string;
  contour: string;
  contourOpacity: number;
  frame: string;
  fontFamily: string;
  /** Land-use base fills (drawn semi-transparent over the terrain). */
  land: Record<'field' | 'meadow' | 'pasture' | 'forest' | 'orchard' | 'garden' | 'marsh' | 'commons', string>;
  landOpacity: number;
  stripA: string; stripB: string;
  furrow: string; hedge: string;
  treeFill: string; treeInk: string;
  grass: string; reed: string; orchardDot: string;
  roadEdge: string; roadFill: string; trackFill: string;
  bridgeDeck: string; bridgeInk: string;
  farmRoof: string; farmInk: string; farmYard: string;
  marker: string;
  /** Urban layer. */
  urban: {
    street: string; streetEdge: string; yard: string; garden: string; gardenInk: string;
    mass: string; massEdge: string; plotLine: string; place: string; placeInk: string;
    wall: string; wallFill: string; blockEdge: string;
  };
}

export const PALETTES: Record<StyleName, Palette> = {
  parchment: {
    name: 'parchment',
    paper: '#eee2c3',
    ink: '#4e3b28',
    inkSoft: '#7a6247',
    hypso: [[0, '#f0e5c8'], [0.35, '#e6d6ae'], [0.7, '#d6c091'], [1, '#c2a875']],
    shade: 0.9,
    grain: 0.022,
    seaFill: '#bccbc8',
    lakeFill: '#bccbc8',
    waterEdge: '#5f7a7d',
    ripple: '#5d7e82',
    rippleOpacity: [0.9, 0.75, 0.6, 0.45],
    riverFill: '#bccbc8',
    riverEdge: '#5f7a7d',
    contour: '#8a6b47',
    contourOpacity: 0.5,
    frame: '#4e3b28',
    fontFamily: "Georgia, 'Times New Roman', serif",
    land: { field: '#e1cf94', meadow: '#bfca8e', pasture: '#cdd097', forest: '#94a86e', orchard: '#c6cb8a', garden: '#cdc78c', marsh: '#b4c5a6', commons: '#d3cc9b' },
    landOpacity: 0.62,
    stripA: '#e8d9a4', stripB: '#d9c488',
    furrow: '#8d7443', hedge: '#5f6d3d',
    treeFill: '#8aa065', treeInk: '#4a5a33',
    grass: '#5f7a3c', reed: '#4f7a72', orchardDot: '#55703a',
    roadEdge: '#4e3b28', roadFill: '#f6edd0', trackFill: '#6b5236',
    bridgeDeck: '#f6edd0', bridgeInk: '#3b2c1c',
    farmRoof: '#c69b70', farmInk: '#4e3b28', farmYard: '#d8c79a',
    marker: '#8b2f1f',
    urban: {
      street: '#f4ead0', streetEdge: '#6b5236', yard: '#e6d6a8', garden: '#d3cf98', gardenInk: '#6f7a42',
      mass: '#4a3826', massEdge: '#f1e5c6', plotLine: '#5a4530', place: '#ece0bf', placeInk: '#8a7050',
      wall: '#3b2c1c', wallFill: '#6b5540', blockEdge: '#5a4530',
    },
  },
  atlas: {
    name: 'atlas',
    paper: '#f4f1e8',
    ink: '#33404a',
    inkSoft: '#5b6975',
    hypso: [[0, '#a8c98d'], [0.12, '#c2d798'], [0.32, '#e4d9a2'], [0.52, '#d9bd8b'], [0.72, '#bb9675'], [0.88, '#d6cdc6'], [1, '#f6f6f6']],
    shade: 1.05,
    grain: 0,
    seaFill: '#8fc0e2',
    lakeFill: '#8fc0e2',
    waterEdge: '#4a86b3',
    ripple: '#e9f4fb',
    rippleOpacity: [0.7, 0.5, 0.35, 0.2],
    riverFill: '#8fc0e2',
    riverEdge: '#4a86b3',
    contour: '#8b5a3c',
    contourOpacity: 0.55,
    frame: '#33404a',
    fontFamily: "'Segoe UI', Helvetica, Arial, sans-serif",
    land: { field: '#f0e6a6', meadow: '#b9dc95', pasture: '#cfe3a2', forest: '#7fba78', orchard: '#c5dc8a', garden: '#d5e3a0', marsh: '#a6d1b8', commons: '#dde3aa' },
    landOpacity: 0.72,
    stripA: '#f4ecb4', stripB: '#e6dc92',
    furrow: '#a89a55', hedge: '#4f8a4a',
    treeFill: '#5fa35a', treeInk: '#2f6a34',
    grass: '#4c8f3f', reed: '#3a8f88', orchardDot: '#3f8a3a',
    roadEdge: '#5a4a3c', roadFill: '#fffdf4', trackFill: '#8a7660',
    bridgeDeck: '#fffdf4', bridgeInk: '#3b3b3b',
    farmRoof: '#d9a678', farmInk: '#5a4a3c', farmYard: '#e8dcae',
    marker: '#b3261e',
    urban: {
      street: '#fbf7ec', streetEdge: '#6a5a4a', yard: '#efe5c9', garden: '#d8e2ad', gardenInk: '#6f9a4f',
      mass: '#b4604a', massEdge: '#6e3526', plotLine: '#8a6a58', place: '#f1ead6', placeInk: '#9a8a70',
      wall: '#4a3c34', wallFill: '#8a7a6c', blockEdge: '#7a6252',
    },
  },};

export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
