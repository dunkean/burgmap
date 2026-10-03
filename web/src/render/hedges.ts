import type { LandArea, Polyline, Vec2 } from '../gen/types';
import { hexToRgb, type Palette } from './styles';

/** Field boundaries sit below roads and forest edges in both renderers. */
export function fieldHedgeStyle(pal: Palette, u: number): { color: string; width: number; alpha: number } {
  const green = hexToRgb(pal.hedge), earth = hexToRgb(pal.furrow);
  const color = '#' + green.map((v, i) => Math.round(v * 0.35 + earth[i] * 0.65).toString(16).padStart(2, '0')).join('');
  return { color, width: 0.55 * Math.pow(Math.max(1, u), 0.55), alpha: 0.35 };
}

const hash2 = (x: number, y: number): number => {
  let h = Math.imul(Math.round(x * 7) ^ 0x9e3779b1, 0x85ebca6b) ^ Math.imul(Math.round(y * 7) + 0x7f4a7c15, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return ((h ^ (h >>> 12)) >>> 0) / 4294967296;
};

export interface HedgeTree { center: Vec2; radius: number }

/** Shared geometry, including enclosed pasture: draw identical edges and their trees once. */
export function fieldHedges(areas: LandArea[], u: number): { lines: Polyline[]; trees: HedgeTree[] } {
  const edges = new Map<string, Polyline>();
  const key = (p: Vec2) => `${p.x},${p.y}`;
  for (const area of areas) {
    if (!(area as LandArea & { enclosed?: boolean }).enclosed) continue;
    for (const ring of [area.poly, ...(area.holes ?? [])]) {
      for (let i = 0; i < ring.length; i++) {
        let a = ring[i], b = ring[(i + 1) % ring.length];
        if (a.x > b.x || (a.x === b.x && a.y > b.y)) [a, b] = [b, a];
        if (Math.hypot(b.x - a.x, b.y - a.y) < 0.001) continue;
        edges.set(`${key(a)}|${key(b)}`, [a, b]);
      }
    }
  }
  const lines = [...edges.values()].sort((a, b) => a[0].x - b[0].x || a[0].y - b[0].y || a[1].x - b[1].x || a[1].y - b[1].y);
  const trees: HedgeTree[] = [];
  const s = Math.max(1, u), radius = 1.15 * Math.pow(s, 0.4), spacing = Math.pow(s, 0.55);
  for (const [a, b] of lines) {
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    let t = (8 + 10 * hash2(a.x, a.y)) * spacing;
    while (t < length) {
      const x = a.x + (b.x - a.x) * t / length, y = a.y + (b.y - a.y) * t / length;
      const h = hash2(x, y);
      if (h < 0.3) trees.push({ center: { x, y }, radius: radius * (0.75 + 0.6 * h) });
      t += (18 + 28 * hash2(y, x)) * spacing;
    }
  }
  return { lines, trees };
}
