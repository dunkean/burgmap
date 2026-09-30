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
  },
};

export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
