/**
 * SVG export of the name labels: the same placement engine as the canvas (collision avoidance,
 * priority) run once for a notional export scale; rivers/streets use `<textPath>`.
 */
import type { World } from '../gen/types';
import type { Palette } from './styles';
import { buildMapLabels, placeMapLabels, estimateWidth, Measure, PlacedMapLabel } from './mapLabels';
import { FONT_STACKS } from './labelStyles';
import { f1 } from './util';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Notional export scale (px per meter): about 1300 px across the whole map, so big maps keep only the major names. */
export function exportScale(mapSize: number): number {
  return Math.max(0.3, Math.min(1.6, 1300 / mapSize));
}

export function placeForExport(world: World, pal: Palette, measure: Measure = (t, s, st) => estimateWidth(t, s, st), legend = false): { placed: PlacedMapLabel[]; scale: number } {
  const S = world.mapSize;
  const sc = exportScale(S);
  const labels = buildMapLabels(world, pal.name, pal);
  // keep the cartouche (top-left) and the legend (bottom-left) free; panel units are 1/u meters, u = S/1600
  const u = S / 1600, k = sc;
  const reserved = [{ x0: 14 * u * k, y0: 14 * u * k, x1: 22 * u * k + 252 * u * k, y1: 22 * u * k + 112 * u * k }];
  if (legend) reserved.push({ x0: 14 * u * k, y0: S * k - (22 + 330) * u * k, x1: 22 * u * k + 340 * u * k, y1: S * k });
  const placed = placeMapLabels(labels, { cx: S / 2, cy: S / 2, scale: sc }, S * sc, S * sc, measure, { maxLabels: 500, margin: 14, visScale: sc * 0.45, reserved });
  return { placed, scale: sc };
}

export function labelsSvg(world: World, pal: Palette, measure?: Measure, legend = false): string {
  if (!world.names) return '';
  const { placed, scale } = placeForExport(world, pal, measure, legend);
  if (!placed.length) return '';
  const k = 1 / scale; // screen px -> meters
  const family = FONT_STACKS[pal.name] ?? pal.fontFamily;
  let defs = '', body = '';
  placed.forEach((pl, i) => {
    const st = pl.label.st;
    const size = pl.size * k;
    const halo = Math.max(2.4, pl.size * 0.26) * k;
    const attrs = `font-size="${f1(size)}" fill="${st.color}"${st.italic ? ' font-style="italic"' : ''}${st.bold ? ' font-weight="600"' : ''}` +
      ` stroke="${pal.paper}" stroke-width="${f1(halo)}" stroke-opacity="0.8" stroke-linejoin="round" paint-order="stroke"` +
      (pl.spacing ? ` letter-spacing="${f1(pl.spacing * k)}"` : '');
    // runs of equal glyph size (small caps produce several)
    const runs: { s: string; size: number }[] = [];
    for (const g of pl.glyphs) {
      const last = runs[runs.length - 1];
      if (last && last.size === g.size) last.s += g.ch; else runs.push({ s: g.ch, size: g.size });
    }
    const tspans = runs.map((r) => `<tspan${r.size !== pl.size ? ` font-size="${f1(r.size * k)}"` : ''} xml:space="preserve">${esc(r.s)}</tspan>`).join('');
    const dy = f1(pl.size * 0.34 * k);
    if (pl.path && pl.path.length >= 2) {
      const d = pl.path.map(([x, y], j) => (j ? 'L' : 'M') + f1(x * k) + ' ' + f1(y * k)).join('');
      defs += `<path id="lp${i}" d="${d}"/>`;
      body += `<text ${attrs}><textPath xlink:href="#lp${i}" href="#lp${i}" startOffset="50%" text-anchor="middle"><tspan dy="${dy}">${tspans}</tspan></textPath></text>`;
    } else {
      const x0 = pl.glyphs[0].x - pl.glyphs[0].w / 2;
      body += `<text x="${f1(x0 * k)}" y="${f1((pl.cy) * k + pl.size * 0.34 * k)}" ${attrs}>${tspans}</text>`;
    }
    if (pl.symbol) {
      const { x, y, r } = pl.symbol;
      const X = x * k, Y = y * k, R = r * k;
      const c = st.color;
      switch (st.symbol) {
        case 'cross': body += `<path d="M${f1(X)} ${f1(Y - R * 1.25)}V${f1(Y + R * 1.25)}M${f1(X - R * 0.85)} ${f1(Y - R * 0.3)}H${f1(X + R * 0.85)}" stroke="${c}" stroke-width="${f1(1.6 * k)}" fill="none"/>`; break;
        case 'tri': body += `<path d="M${f1(X)} ${f1(Y - R * 1.1)}L${f1(X + R * 1.1)} ${f1(Y + R * 0.8)}L${f1(X - R * 1.1)} ${f1(Y + R * 0.8)}Z" fill="${c}"/>`; break;
        case 'square': body += `<rect x="${f1(X - R * 0.9)}" y="${f1(Y - R * 0.9)}" width="${f1(R * 1.8)}" height="${f1(R * 1.8)}" fill="${c}"/>`; break;
        case 'ring': body += `<circle cx="${f1(X)}" cy="${f1(Y)}" r="${f1(R * 0.85)}" fill="${pal.paper}" stroke="${c}" stroke-width="${f1(1.1 * k)}"/>`; break;
        default: body += `<circle cx="${f1(X)}" cy="${f1(Y)}" r="${f1(R)}" fill="${c}" stroke="${pal.paper}" stroke-width="${f1(1 * k)}"/>`;
      }
    }
  });
  return `<g class="layer-labels" font-family="${esc(family)}"><defs>${defs}</defs>${body}</g>`;
}
