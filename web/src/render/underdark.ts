/** Top-down underground cover, shared by SVG patterns, Canvas paths and the legend. */
import type { LandKind } from '../gen/types';
import type { Palette } from './styles';
import { panelSvg, type Prim } from './legend';

export function underdarkMark(kind: LandKind, x: number, y: number, r: number, pal: Palette, strokeScale = 1): Prim[] {
  if (kind === 'commons') return [
    { t: 'poly', pts: [[x - r, y - r * .2], [x - r * .55, y - r * .85], [x + r * .7, y - r * .65], [x + r, y + r * .5], [x - r * .25, y + r * .85]], stroke: pal.grass, sw: .5 * strokeScale },
    { t: 'line', pts: [[x - r * .55, y - r * .85], [x, y], [x + r, y + r * .5]], stroke: pal.grass, sw: .4 * strokeScale },
  ];
  if (kind === 'meadow' || kind === 'pasture') return [[-.4, -.3, .48], [.38, -.1, .4], [0, .4, .42]].map(([dx, dy, rr]) =>
    ({ t: 'circle', x: x + dx * r, y: y + dy * r, r: rr * r, stroke: pal.grass, sw: .5 * strokeScale }));
  // Scalloped caps and spores, without a side-view trunk or an outdoor canopy.
  const pts: [number, number][] = Array.from({ length: 18 }, (_, i) => {
    const a = i * Math.PI / 9, rr = r * (i % 3 === 1 ? .82 : 1);
    return [x + Math.cos(a) * rr, y + Math.sin(a) * rr];
  });
  return [{ t: 'poly', pts, fill: pal.treeFill, stroke: pal.treeInk, sw: .5 * strokeScale },
    ...[[-.35, -.25], [.35, -.15], [0, .35]].map(([dx, dy]): Prim =>
      ({ t: 'circle', x: x + dx * r, y: y + dy * r, r: r * .13, stroke: pal.treeInk, sw: .4 * strokeScale }))];
}

export function appendUnderdarkMark(path: Path2D, kind: LandKind, x: number, y: number, r: number, pal: Palette): void {
  for (const p of underdarkMark(kind, x, y, r, pal)) {
    if (p.t === 'circle') { path.moveTo(p.x + p.r, p.y); path.arc(p.x, p.y, p.r, 0, Math.PI * 2); }
    else if (p.t === 'poly' || p.t === 'line') {
      p.pts.forEach(([px, py], i) => i ? path.lineTo(px, py) : path.moveTo(px, py));
      if (p.t === 'poly') path.closePath();
    }
  }
}

export const underdarkMarkSvg = (kind: LandKind, x: number, y: number, r: number, pal: Palette, strokeScale = 1): string =>
  panelSvg({ w: 0, h: 0, prims: underdarkMark(kind, x, y, r, pal, strokeScale) }, 0, 0, 1, pal.fontFamily, `underdark-${kind}`);

export function underdarkPatterns(pal: Palette, s: number): string {
  return (['commons', 'meadow', 'pasture', 'forest', 'orchard', 'marsh', 'garden', 'field'] as LandKind[]).map(kind => {
    const size = kind === 'commons' ? 18 : kind === 'garden' ? 8 : kind === 'orchard' ? 11 : kind === 'marsh' ? 15 : 16;
    const r = kind === 'commons' ? 2.5 : kind === 'garden' ? 1.7 : 2.7;
    return `<pattern id="p-${kind}" patternUnits="userSpaceOnUse" width="${size * s}" height="${size * s}">${underdarkMarkSvg(kind, size * s / 2, size * s / 2, r * s, pal, s)}</pattern>`;
  }).join('');
}
