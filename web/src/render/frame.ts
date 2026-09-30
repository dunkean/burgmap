/**
 * Map frame, border ornaments and north arrow per style, described once as panel primitives in a pixel-like
 * coordinate system (W x H px). The SVG export scales them by u = mapSize / 1600, the canvas view paints them
 * in screen space around the map rectangle, so both show the same frame.
 */
import type { Palette } from './styles';
import type { Prim } from './legend';

export function frameModel(W: number, H: number, pal: Palette, arrow: boolean): Prim[] {
  const out: Prim[] = [];
  const ink = pal.frame;
  const rect = (i: number, sw: number, stroke = ink): void => { out.push({ t: 'rect', x: i, y: i, w: W - 2 * i, h: H - 2 * i, stroke, sw }); };
  switch (pal.frameKind) {
    case 'double': rect(5, 2); rect(9, 0.7); break;
    case 'thin': rect(4, 1.1); break;
    case 'none': break;
    case 'ticks': {
      // alternating graticule bar between two rules
      rect(5, 1.3); rect(12, 0.6);
      const segs = Math.max(8, Math.min(40, Math.round(W / 50)));
      const sx = (W - 24) / segs, sy = (H - 24) / segs;
      for (let i = 0; i < segs; i++) {
        if (i % 2) continue;
        out.push({ t: 'rect', x: 12 + i * sx, y: 5.6, w: sx, h: 6.4, fill: ink });
        out.push({ t: 'rect', x: 12 + i * sx, y: H - 12, w: sx, h: 6.4, fill: ink });
        out.push({ t: 'rect', x: 5.6, y: 12 + i * sy, w: 6.4, h: sy, fill: ink });
        out.push({ t: 'rect', x: W - 12, y: 12 + i * sy, w: 6.4, h: sy, fill: ink });
      }
      break;
    }
    case 'blueprint': {
      rect(6, 1.6); rect(15, 0.6);
      const n = Math.max(6, Math.min(40, Math.round(W / 40)));
      for (let i = 1; i < n; i++) {
        const x = (W * i) / n, y = (H * i) / n, l = i % 5 === 0 ? 9 : 4.5;
        out.push({ t: 'line', pts: [[x, 6], [x, 6 + l]], stroke: ink, sw: 0.8 }, { t: 'line', pts: [[x, H - 6], [x, H - 6 - l]], stroke: ink, sw: 0.8 });
        out.push({ t: 'line', pts: [[6, y], [6 + l, y]], stroke: ink, sw: 0.8 }, { t: 'line', pts: [[W - 6, y], [W - 6 - l, y]], stroke: ink, sw: 0.8 });
      }
      break;
    }
    case 'illuminated': {
      const gold = pal.accent, band = pal.cart.accent, deep = pal.frame;
      out.push({ t: 'rect', x: 16, y: 16, w: W - 32, h: H - 32, stroke: band, sw: 18 });
      out.push({ t: 'rect', x: 4, y: 4, w: W - 8, h: H - 8, stroke: deep, sw: 2.6 });
      out.push({ t: 'rect', x: 7, y: 7, w: W - 14, h: H - 14, stroke: gold, sw: 1.7 });
      out.push({ t: 'rect', x: 25, y: 25, w: W - 50, h: H - 50, stroke: gold, sw: 1.7 });
      out.push({ t: 'rect', x: 27.5, y: 27.5, w: W - 55, h: H - 55, stroke: deep, sw: 0.8 });
      // gold studs along the band, diamonds at mid-sides and rosettes in the corners
      const n = Math.max(8, Math.min(60, Math.round(W / 36)));
      for (let i = 1; i < n; i++) {
        const x = (W * i) / n, y = (H * i) / n;
        const big = i === n / 2;
        const r = big ? 4.6 : 2;
        for (const [cx, cy] of [[x, 16], [x, H - 16], [16, y], [W - 16, y]]) {
          if (big) out.push({ t: 'poly', pts: [[cx, cy - r * 1.5], [cx + r * 1.5, cy], [cx, cy + r * 1.5], [cx - r * 1.5, cy]], fill: gold, stroke: deep, sw: 0.6 });
          else out.push({ t: 'circle', x: cx, y: cy, r, fill: gold });
        }
      }
      for (const [cx, cy] of [[16, 16], [W - 16, 16], [16, H - 16], [W - 16, H - 16]]) {
        out.push({ t: 'rect', x: cx - 15, y: cy - 15, w: 30, h: 30, fill: '#8f2418', stroke: gold, sw: 1.7 });
        out.push({ t: 'circle', x: cx, y: cy, r: 9, stroke: gold, sw: 1.4 });
        for (const [dx, dy] of [[0, -5], [5, 0], [0, 5], [-5, 0]]) out.push({ t: 'circle', x: cx + dx, y: cy + dy, r: 2.6, fill: gold });
        out.push({ t: 'circle', x: cx, y: cy, r: 2.2, fill: '#8f2418' });
      }
      break;
    }
  }
  if (arrow) {
    const m = pal.frameKind === 'illuminated' ? 40 : 22;
    const cx = W - m - 22, cy = m + 34, r = 26;
    out.push({ t: 'circle', x: cx, y: cy, r: r * 1.15, fill: pal.paper, op: 0.72 });
    out.push({ t: 'poly', pts: [[cx, cy - r], [cx + r * 0.32, cy + r * 0.55], [cx, cy + r * 0.25]], fill: pal.ink });
    out.push({ t: 'poly', pts: [[cx, cy - r], [cx - r * 0.32, cy + r * 0.55], [cx, cy + r * 0.25]], stroke: pal.ink, sw: 0.9 });
    out.push({ t: 'text', x: cx, y: cy - r - 4, s: 'N', size: 12, anchor: 'middle', fill: pal.ink, bold: true });
  }
  return out;
}

/** Distance (px units) of the cartouche / legend from the map corner. */
export const panelMargin = (pal: Palette): number => (pal.frameKind === 'illuminated' ? 40 : 22);
