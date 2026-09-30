/**
 * Label typography per map style. Fonts are system stacks (nothing is fetched, so the single-file
 * build stays self-contained): an old-style serif for the parchment look, a humanist sans for the atlas.
 */
import type { NameKind } from '../gen/names/types';
import type { StyleName } from '../gen/options';
import type { Palette } from './styles';

export const FONT_STACKS: Record<StyleName, string> = {
  parchment: "'Palatino Linotype', Palatino, 'Book Antiqua', 'URW Palladio L', 'Iowan Old Style', 'Hoefler Text', Georgia, 'Times New Roman', serif",
  atlas: "'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif",
};

export type LabelShape = 'point' | 'area' | 'path';
export type Symbol = 'dot' | 'ring' | 'cross' | 'tri' | 'square';

export interface KindStyle {
  shape: LabelShape;
  italic: boolean;
  bold: boolean;
  caps: 'none' | 'upper' | 'small';
  /** Letter spacing in em. */
  spacing: number;
  /** Extra stretch allowed for area labels (em). */
  stretch: number;
  color: string;
  /** Font size = clamp(sizeM * scale, minPx, maxPx). */
  sizeM: number; minPx: number; maxPx: number;
  minScale: number; maxScale: number;
  priority: number;
  symbol?: Symbol;
}

const INF = 1e9;

export function kindStyles(style: StyleName, pal: Palette): Record<NameKind, KindStyle> {
  const ink = pal.ink, soft = pal.inkSoft;
  const water = style === 'atlas' ? '#2f6d99' : '#3f6468';
  const wood = style === 'atlas' ? '#2f6a34' : '#4a5a33';
  const base: KindStyle = { shape: 'point', italic: false, bold: false, caps: 'none', spacing: 0, stretch: 0, color: ink, sizeM: 6, minPx: 10, maxPx: 14, minScale: 0, maxScale: INF, priority: 30 };
  const k = (o: Partial<KindStyle>): KindStyle => ({ ...base, ...o });
  return {
    town: k({ shape: 'area', caps: 'small', bold: true, spacing: 0.1, stretch: 0.12, sizeM: 60, minPx: 17, maxPx: 34, minScale: 0, maxScale: 0.85, priority: 100 }),
    quarter: k({ shape: 'area', caps: 'small', spacing: 0.13, stretch: 0.3, color: soft, sizeM: 26, minPx: 10, maxPx: 20, minScale: 0.1, maxScale: 0.6, priority: 48 }),
    street: k({ shape: 'path', sizeM: 7, minPx: 10, maxPx: 15, minScale: 0.1, priority: 40 }),
    road: k({ shape: 'path', italic: true, color: soft, sizeM: 8, minPx: 10, maxPx: 12, minScale: 0.03, maxScale: 0.7, priority: 36 }),
    square: k({ shape: 'point', italic: true, sizeM: 9, minPx: 10, maxPx: 13, minScale: 0.32, priority: 52 }),
    church: k({ shape: 'point', symbol: 'cross', sizeM: 9, minPx: 10.5, maxPx: 14, minScale: 0.26, priority: 62 }),
    castle: k({ shape: 'point', symbol: 'square', bold: true, sizeM: 10, minPx: 11, maxPx: 15, minScale: 0.18, priority: 64 }),
    gate: k({ shape: 'point', symbol: 'ring', italic: true, color: soft, sizeM: 7, minPx: 10, maxPx: 12, minScale: 0.25, priority: 50 }),
    river: k({ shape: 'path', italic: true, color: water, spacing: 0.1, sizeM: 14, minPx: 11, maxPx: 20, priority: 70 }),
    lake: k({ shape: 'area', italic: true, color: water, spacing: 0.1, stretch: 0.25, sizeM: 18, minPx: 11, maxPx: 22, priority: 80 }),
    sea: k({ shape: 'area', italic: true, color: water, spacing: 0.22, stretch: 0.5, sizeM: 40, minPx: 13, maxPx: 28, priority: 90 }),
    forest: k({ shape: 'area', italic: true, color: wood, spacing: 0.16, stretch: 0.3, sizeM: 18, minPx: 10, maxPx: 18, minScale: 0.03, maxScale: 0.9, priority: 44 }),
    hill: k({ shape: 'point', symbol: 'tri', italic: true, color: soft, sizeM: 12, minPx: 10, maxPx: 14, maxScale: 0.7, priority: 42 }),
    village: k({ shape: 'point', symbol: 'dot', bold: false, sizeM: 14, minPx: 11.5, maxPx: 16, maxScale: 0.7, priority: 75 }),
    farm: k({ shape: 'point', symbol: 'dot', italic: true, color: soft, sizeM: 6, minPx: 9.5, maxPx: 11, minScale: 0.22, priority: 28 }),
    bridge: k({ shape: 'point', italic: true, sizeM: 6, minPx: 10, maxPx: 12, minScale: 0.5, priority: 34 }),
  };
}

/** Street labels: visibility and weight depend on the street rank (0 arterial ... 4 lane). */
export function streetRankStyle(base: KindStyle, rank: number): KindStyle {
  const minScale = [0.1, 0.17, 0.32, 0.6, 0.8][Math.max(0, Math.min(4, rank))];
  return { ...base, minScale, priority: base.priority + (4 - Math.min(4, rank)) * 6, bold: rank === 0, sizeM: base.sizeM * (rank === 0 ? 1.15 : 1), caps: rank === 0 ? 'none' : 'none' };
}

export function fontString(st: Pick<KindStyle, 'italic' | 'bold'>, sizePx: number, family: string): string {
  return `${st.italic ? 'italic ' : ''}${st.bold ? '600 ' : ''}${sizePx}px ${family}`;
}
