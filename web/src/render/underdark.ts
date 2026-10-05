/** Top-down underground cover, shared by SVG patterns, Canvas paths and the legend. */
import type { LandKind } from '../gen/types';
import type { Palette } from './styles';
import { panelSvg, type Prim } from './legend';

export function underdarkMark(kind: LandKind, x: number, y: number, r: number, pal: Palette, strokeScale = 1): Prim[] {
  if (kind === 'commons') return [{
    // A small closed pebble seen from above; no forked interior resembling a broken plant.
    t: 'poly', pts: [[x - r, y - r * .1], [x - r * .8, y - r * .6],
      [x - r * .15, y - r * .8], [x + r * .6, y - r * .55], [x + r, y],
      [x + r * .65, y + r * .6], [x - r * .1, y + r * .8], [x - r * .8, y + r * .5]],
    stroke: pal.grass, sw: .5 * strokeScale,
  }];
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

/** Sizes are metres, independent of the extent of the map or its export width. */
export function underdarkTextureSpec(kind: LandKind): { spacing: number; radius: number } {
  const specs: Partial<Record<LandKind, [number, number]>> = {
    commons: [28, 2.5], garden: [8, 1.7], field: [14, 2.7], forest: [9, 3.1],
    orchard: [11, 2.3], meadow: [16, 3], pasture: [24, 2.4], marsh: [15, 3.2],
  };
  const [spacing, radius] = specs[kind] ?? [16, 2.7];
  return { spacing, radius };
}
export function underdarkPatterns(pal: Palette, _s = 1): string {
  return (['commons', 'meadow', 'pasture', 'forest', 'orchard', 'marsh', 'garden', 'field'] as LandKind[]).map(kind => {
    const { spacing: size, radius: r } = underdarkTextureSpec(kind);
    return `<pattern id="p-${kind}" patternUnits="userSpaceOnUse" width="${size}" height="${size}">${underdarkMarkSvg(kind, size / 2, size / 2, r, pal)}</pattern>`;
  }).join('');
}
