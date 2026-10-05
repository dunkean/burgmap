import type { World } from '../gen/types';
import type { Palette } from './styles';
import { BRUSH_ATLAS, BRUSH_CELL, brushCell, brushColorMatrix, brushMotif, type BrushSources, type BrushKind } from './brushes';

export interface SvgBrushes { tree(x: number, y: number, radius: number, orchard?: boolean): string; pattern(kind: BrushKind): string }
const n = (x: number): string => String(Number(x.toFixed(5)));

export function svgBrushes(world: World, pal: Palette, sources: BrushSources): { defs: string; brushes: SvgBrushes } {
  const use = (atlas: string, cell: number, x: number, y: number, size: number, alpha = 1): string =>
    `<use href="#brush-${atlas}-${cell}" xlink:href="#brush-${atlas}-${cell}" x="${n(x - size / 2)}" y="${n(y - size / 2)}" width="${n(size)}" height="${n(size)}" opacity="${n(alpha)}"/>`;
  let defs = '<defs>';
  const matrix = brushColorMatrix(pal);
  if (matrix) defs += `<filter id="brush-tint" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${matrix.join(' ')}"/></filter>`;
  for (const atlas of ['vegetation', 'terrain'] as const) {
    defs += `<image id="brush-${atlas}" width="${BRUSH_ATLAS}" height="${BRUSH_ATLAS}" xlink:href="${sources[atlas]}"/>`;
    for (let cell = 0; cell < 36; cell++) defs += `<symbol id="brush-${atlas}-${cell}" viewBox="${cell % 6 * BRUSH_CELL} ${Math.floor(cell / 6) * BRUSH_CELL} ${BRUSH_CELL} ${BRUSH_CELL}" overflow="hidden"><use href="#brush-${atlas}" xlink:href="#brush-${atlas}"${matrix ? ' filter="url(#brush-tint)"' : ''}/></symbol>`;
  }
  for (const kind of ['forest', 'orchard', 'meadow', 'pasture', 'marsh', 'commons', 'garden', 'field'] as BrushKind[]) {
    const motif = brushMotif(world, kind);
    defs += `<pattern id="brush-p-${kind}" patternUnits="userSpaceOnUse" width="${motif.width}" height="${motif.width}">` + motif.stamps.flatMap(s => [-motif.width, 0, motif.width].flatMap(dx => [-motif.width, 0, motif.width].filter(dy => s.x + dx + s.size / 2 > 0 && s.x + dx - s.size / 2 < motif.width && s.y + dy + s.size / 2 > 0 && s.y + dy - s.size / 2 < motif.width).map(dy => use(s.atlas, s.cell, s.x + dx, s.y + dy, s.size, s.alpha)))).join('') + '</pattern>';
  }
  return { defs: defs + '</defs>', brushes: {
    pattern: kind => `brush-p-${kind}`,
    tree: (x, y, radius, orchard = false) => use('vegetation', brushCell(world, x, y, orchard), x, y, radius * 2),
  } };
}
