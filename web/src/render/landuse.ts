import { bboxOf } from '../gen/geo/poly';
import { NATURAL_LAND_KINDS } from './countryside';
import { isKinded } from './townbridges';
import type { World, LandArea, LandKind, Farmstead, PolyH } from '../gen/types';
import { farmRidges } from './farms';
import { fieldHedges, fieldHedgeStyle } from './hedges';
import { furrowDegrees, furrowOffset, furrowSpacing } from './furrows';
import type { Vec2 } from '../gen/core/geom';
import { type Palette, ruralInk } from './styles';
import { f1, pathD } from './util';
import { regionalBridgeSurface, regionalRoadSurface } from './roadSurfaces';
import { MAP_STROKES, svgMapStroke } from './strokes';

/** Land-use tints multiply over the hillshaded terrain so relief stays readable under them (browsers; resvg falls back to plain alpha). Dark styles blend normally. */
const mul = (pal: Palette): string => (pal.landBlend === 'multiply' ? ' style="mix-blend-mode:multiply"' : '');

const ringsD = (a: LandArea): string => {
  let d = pathD(a.poly, true);
  if (a.holes) for (const h of a.holes) d += pathD(h, true);
  return d;
};

/** SVG <pattern> definitions for land-use textures. `s` scales symbols with map size. */
function patterns(world: World, pal: Palette, s: number, scale: number): string {
  const out: string[] = [];
  const pat = (id: string, w: number, h: number, body: string, extra = '') =>
    out.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" width="${f1(w)}" height="${f1(h)}"${extra}>${body}</pattern>`);

  // forest: canopy (blobs), drawn crowns with trunk and shadow arc, or sparse tiny trees
  {
    const W = 30 * s;
    const pts: [number, number, number][] = [[4, 5, 3.1], [13, 3, 2.7], [22, 6, 3.2], [8, 13, 3.3], [18, 14, 3], [27, 15, 2.6], [3, 22, 2.8], [12, 24, 3.2], [22, 23, 3.1], [29, 27, 2.5], [16, 29, 2.4]];
    let b = '';
    if (pal.treeShape === 'crown') {
      for (const [x, y, r] of pts) {
        const X = x * s, Y = y * s, R = r * s * 0.95;
        b += `<circle cx="${f1(X)}" cy="${f1(Y)}" r="${f1(R)}"/>` +
          `<path d="M${f1(X + R * 0.55)} ${f1(Y - R * 0.55)}A${f1(R * 0.78)} ${f1(R * 0.78)} 0 0 1 ${f1(X - R * 0.55)} ${f1(Y + R * 0.55)}" fill="none"/>` +
          `<path d="M${f1(X)} ${f1(Y + R)}V${f1(Y + R * 1.5)}" fill="none"/>`;
      }
    } else if (pal.treeShape === 'dot') {
      for (const [x, y, r] of pts) b += `<circle cx="${f1(x * s)}" cy="${f1(y * s)}" r="${f1(r * s * 0.5)}"/>`;
    } else for (const [x, y, r] of pts) b += `<circle cx="${f1(x * s)}" cy="${f1(y * s)}" r="${f1(r * s)}"/>`;
    pat('p-forest', W, W, `<g fill="${pal.treeFill}" stroke="${pal.treeInk}" stroke-width="${f1(0.55 * s)}" stroke-linecap="round">${b}</g>`);
  }
  // orchard: regular dot grid with a small stem mark
  {
    const W = 11 * s;
    const R = (pal.treeShape === 'dot' ? 1.5 : 2.3) * s;
    pat('p-orchard', W, W, `<circle cx="${f1(W / 2)}" cy="${f1(W / 2)}" r="${f1(R)}" fill="${pal.treeFill}" stroke="${pal.orchardDot}" stroke-width="${f1(0.5 * s)}"/><circle cx="${f1(W / 2)}" cy="${f1(W / 2)}" r="${f1(0.45 * s)}" fill="${pal.orchardDot}"/>` +
      (pal.treeShape === 'crown' ? `<path d="M${f1(W / 2 + R * 0.5)} ${f1(W / 2 - R * 0.5)}A${f1(R * 0.75)} ${f1(R * 0.75)} 0 0 1 ${f1(W / 2 - R * 0.5)} ${f1(W / 2 + R * 0.5)}" fill="none" stroke="${pal.orchardDot}" stroke-width="${f1(0.4 * s)}"/>` : ''));
  }
  // garden: tiny beds
  {
    const W = 8 * s;
    pat('p-garden', W, W, `<path d="M${f1(1 * s)} ${f1(2 * s)}H${f1(7 * s)}M${f1(1 * s)} ${f1(5 * s)}H${f1(7 * s)}" stroke="${pal.grass}" stroke-width="${f1(0.6 * s)}" fill="none" opacity="0.8"/>`);
  }
  // meadow: short grass ticks
  {
    const W = 17 * s, Hh = 13 * s;
    const tuft = (x: number, y: number) => `M${f1(x * s)} ${f1(y * s)}l${f1(-1.3 * s)} ${f1(-3 * s)}M${f1(x * s)} ${f1(y * s)}v${f1(-3.4 * s)}M${f1(x * s)} ${f1(y * s)}l${f1(1.3 * s)} ${f1(-3 * s)}`;
    pat('p-meadow', W, Hh, `<path d="${tuft(4, 6)}${tuft(12, 12)}" stroke="${pal.grass}" stroke-width="${f1(0.6 * s)}" fill="none" stroke-linecap="round"/>`);
  }
  // pasture: sparse tufts + dots
  {
    const W = 26 * s, Hh = 20 * s;
    pat('p-pasture', W, Hh, `<path d="M${f1(5 * s)} ${f1(8 * s)}l${f1(-1.2 * s)} ${f1(-2.4 * s)}M${f1(5 * s)} ${f1(8 * s)}l${f1(1.2 * s)} ${f1(-2.4 * s)}M${f1(18 * s)} ${f1(17 * s)}l${f1(-1.2 * s)} ${f1(-2.4 * s)}M${f1(18 * s)} ${f1(17 * s)}l${f1(1.2 * s)} ${f1(-2.4 * s)}" stroke="${pal.grass}" stroke-width="${f1(0.55 * s)}" fill="none" stroke-linecap="round" opacity="0.85"/>` +
      `<circle cx="${f1(15 * s)}" cy="${f1(5 * s)}" r="${f1(0.55 * s)}" fill="${pal.grass}" opacity="0.7"/>`);
  }
  // commons / rough grazing: dots and small scrub crosses
  {
    const W = 20 * s;
    pat('p-commons', W, W, `<g fill="${pal.grass}" opacity="0.75"><circle cx="${f1(4 * s)}" cy="${f1(5 * s)}" r="${f1(0.7 * s)}"/><circle cx="${f1(13 * s)}" cy="${f1(9 * s)}" r="${f1(0.7 * s)}"/><circle cx="${f1(8 * s)}" cy="${f1(16 * s)}" r="${f1(0.7 * s)}"/></g>` +
      `<path d="M${f1(15 * s)} ${f1(17 * s)}l${f1(2 * s)} ${f1(-2 * s)}M${f1(15 * s)} ${f1(15 * s)}l${f1(2 * s)} ${f1(2 * s)}" stroke="${pal.grass}" stroke-width="${f1(0.5 * s)}" fill="none"/>`);
  }
  // marsh: reed hatching
  {
    const W = 15 * s, Hh = 11 * s;
    pat('p-marsh', W, Hh, `<path d="M${f1(1 * s)} ${f1(8 * s)}h${f1(5 * s)}M${f1(8 * s)} ${f1(9.5 * s)}h${f1(5 * s)}M${f1(4 * s)} ${f1(8 * s)}v${f1(-3.4 * s)}M${f1(3 * s)} ${f1(8 * s)}l${f1(-1 * s)} ${f1(-2.6 * s)}M${f1(5 * s)} ${f1(8 * s)}l${f1(1 * s)} ${f1(-2.6 * s)}M${f1(11 * s)} ${f1(9.5 * s)}v${f1(-3 * s)}" stroke="${pal.reed}" stroke-width="${f1(0.6 * s)}" fill="none" stroke-linecap="round"/>`);
  }
  // furrows: one rotated pattern per strip angle
  const seen = new Set<number>();
  for (const a of world.landuse?.areas ?? []) {
    if (a.kind !== 'field' || a.stripAngle === undefined) continue;
    seen.add(furrowDegrees(a.stripAngle));
  }
  const sp = furrowSpacing(world.mapSize);
  for (const deg of seen) {
    pat(`p-fur-${deg}`, 40, sp, `<path d="M0 ${f1(furrowOffset(world.mapSize))}H40" stroke="${pal.furrow}" ${svgMapStroke(MAP_STROKES.furrow, scale)} opacity="${pal.furrowAlpha}"/>`, ` patternTransform="rotate(${deg})"`);
  }
  return `<defs>${out.join('')}</defs>`;
}

export function landuseLayer(world: World, pal: Palette, u: number, scale = 1600 / world.mapSize): string {
  const lu = world.landuse;
  if (!lu) return '';
  const s = Math.max(1, u);
  let out = patterns(world, pal, s, scale);
  const order: LandKind[] = ['meadow', 'marsh', 'pasture', 'commons', 'forest', 'garden', 'orchard', 'field'];
  out += `<g class="layer-landuse" stroke-linejoin="round">`;
  for (const kind of order) {
    const list = lu.areas.filter((a) => a.kind === kind);
    if (!list.length) continue;
    out += `<g class="lu-${kind}">`;
    if (kind === 'field') {
      out += `<g fill="${pal.land.field}" fill-opacity="${pal.landOpacity}" fill-rule="evenodd"${mul(pal)}>${list.map((a) => `<path d="${ringsD(a)}"/>`).join('')}</g>`;
      // strips: each holder's strip has its own tone; one furrow-textured path per furlong (its own direction)
      const tone: string[] = ['', '', '', ''];
      let fi = 0;
      for (const a of list) {
        if (!a.strips || a.stripAngle === undefined) continue;
        const deg = furrowDegrees(a.stripAngle);
        let all = '';
        a.strips.forEach((st, i) => { const d = pathD(st, true); all += d; tone[(i * 5 + fi * 3 + (i >> 2)) & 3] += d; });
        fi++;
        out += `<path d="${all}" fill="url(#p-fur-${deg})" stroke="${pal.furrow}" ${svgMapStroke(MAP_STROKES.strip, scale)} stroke-opacity="${Math.min(1, pal.furrowAlpha * 0.9)}"/>`;
      }
      const mk = [0.5, 0.75, 0.3, 0.9];
      tone.forEach((d, k) => { if (d) out += `<path d="${d}" fill="${k & 1 ? pal.stripB : pal.stripA}" fill-opacity="${Math.min(1, pal.stripAlpha[k & 1] * mk[k])}"${mul(pal)}/>`; });
      // furlong edges: a faint line where the strips end (open fields carry no hedges)
      out += `<g fill="none" stroke="${pal.furrow}" ${svgMapStroke(MAP_STROKES.furlong, scale)} stroke-opacity="0.55" stroke-linejoin="round">${list.filter((a) => !(a as Enc).enclosed).map((a) => `<path d="${ringsD(a)}"/>`).join('')}</g>`;
    } else {
      out += coverAreasSvg(kind, list, pal, s);
    }
    out += '</g>';
  }
  out += fieldNetwork(world, pal, s, scale);
  out += '</g>';
  return out;
}

/** Identical cover marks in the base landscape and in restored urban ground; pattern defs live in landuseLayer. */
function coverAreasSvg(kind: LandKind, list: LandArea[], pal: Palette, s: number): string {
  const d = list.map(ringsD).join('');
  const alpha = kind === 'forest' ? 0.7 : pal.landOpacity;
  let out = `<path d="${d}" fill="${pal.land[kind]}" fill-opacity="${alpha}" fill-rule="evenodd" stroke="${pal.land[kind]}" stroke-width="${f1(0.6 * s)}"${mul(pal)}/>`;
  if (pal.tex[kind]) out += `<path d="${d}" fill="url(#p-${kind})" fill-rule="evenodd"/>`;
  if (kind === 'forest') out += `<path d="${d}" fill="none" stroke="${pal.treeInk}" stroke-width="${f1(0.7 * s)}" stroke-opacity="0.55" stroke-linejoin="round"/>`;
  else if (kind === 'orchard' || kind === 'garden') out += `<path d="${d}" fill="none" stroke="${pal.hedge}" stroke-width="${f1(0.8 * s)}" stroke-opacity="0.7"/>`;
  return out;
}

/** Replays actual natural areas under a caller's occupation clip; it never invents forest or draws agriculture. */
export function naturalLanduseLayer(world: World, pal: Palette, u: number, ground?: PolyH[]): string {
  const s = Math.max(1, u), boxes = ground?.map((p) => bboxOf(p.outer));
  const relevant = (a: LandArea): boolean => {
    if (!boxes) return true;
    const b = bboxOf(a.poly);
    return boxes.some((g) => b.x0 <= g.x1 + s && b.x1 >= g.x0 - s && b.y0 <= g.y1 + s && b.y1 >= g.y0 - s);
  };
  let out = '<g class="u-natural-cover" stroke-linejoin="round">';
  for (const kind of NATURAL_LAND_KINDS) {
    const areas = (world.landuse?.areas ?? []).filter((a) => a.kind === kind && relevant(a));
    if (areas.length) out += `<g class="lu-${kind}">${coverAreasSvg(kind, areas, pal, s)}</g>`;
  }
  return out + '</g>';
}

type Enc = LandArea & { enclosed?: boolean };
type Net = { ways?: Vec2[][]; headlands?: Vec2[][] };

/** Field ways (cart tracks), narrow headlands and the hedgerows of the closes, with an occasional tree. */
function fieldNetwork(world: World, pal: Palette, s: number, scale: number): string {
  const lu = world.landuse as (World['landuse'] & Net) | undefined;
  if (!lu) return '';
  let out = '';
  const ways = lu.ways ?? [];
  if (ways.length) {
    const d = ways.map((w) => pathD(w, false)).join('');
    // subtle earth-toned dashed hairlines, never paper-white bands across the fields
    out += `<g class="lu-ways" fill="none" stroke-linecap="butt" stroke-linejoin="round"><path d="${d}" stroke="${ruralInk(pal)}" stroke-width="${f1(Math.max(1.4, 0.55 * s))}" stroke-opacity="${pal.rural.way}" stroke-dasharray="${f1(4 * s)} ${f1(2.5 * s)}"/></g>`;
  }
  const hl = lu.headlands ?? [];
  if (hl.length) {
    const d = hl.map((w) => pathD(w, false)).join('');
    out += `<g class="lu-headlands" fill="none"><path d="${d}" stroke="${pal.furrow}" ${svgMapStroke(MAP_STROKES.headland, scale)} stroke-opacity="${pal.rural.headland}"/></g>`;
  }
  if (pal.hedgeOn) {
    const hedges = fieldHedges(lu.areas, s), style = fieldHedgeStyle(pal, s);
    const d = hedges.lines.map((line) => pathD(line, false)).join('');
    const trees = hedges.trees.map(({ center: p, radius }) => `<circle cx="${f1(p.x)}" cy="${f1(p.y)}" r="${f1(radius)}"/>`).join('');
    out += `<g class="lu-hedges"><path d="${d}" fill="none" stroke="${style.color}" stroke-width="${f1(style.width)}" stroke-opacity="${style.alpha}" stroke-linecap="round"/>` +
      `<g fill="${pal.treeFill}" fill-opacity="0.75" stroke="${pal.treeInk}" stroke-width="${f1(0.3 * s)}" stroke-opacity="0.5">${trees}</g></g>`;
  }
  return out;
}

/** One farmstead at true size: lot pieces (garden, orchard, paddock, pond), hedged lot, yard, walls, trees, buildings with ridges. */
function farmSvg(f: Farmstead, pal: Palette): string {
  const plots = (k: string) => (f.plots ?? []).filter((p) => p.kind === k).map((p) => pathD(p.poly, true)).join('');
  const fill = (k: string, c: string, extra = '') => { const d = plots(k); return d ? `<path d="${d}" fill="${c}"${extra}/>` : ''; };
  let o = `<g class="farm" data-type="${f.type ?? ''}" data-size="${f.size ?? ''}">`;
  o += fill('garden', pal.land.garden, ` stroke="${pal.hedge}" stroke-width="0.4"`) + fill('orchard', pal.land.orchard) + fill('paddock', pal.land.pasture);
  o += fill('platform', 'none', ` stroke="${pal.farmInk}" stroke-width="0.5" stroke-dasharray="1.6 1.2" stroke-opacity="0.7"`);
  o += `<path d="${pathD(f.lot!, true)}" fill="none" stroke="${pal.hedge}" stroke-width="0.9" stroke-opacity="0.85"/>`;
  o += `<path d="${pathD(f.yard, true)}" fill="${pal.farmYard}" fill-opacity="0.9"/>`;
  o += fill('pen', pal.farmYard, ` stroke="${pal.farmInk}" stroke-width="0.3"`) + fill('threshing-floor', pal.farmYard, ` stroke="${pal.farmInk}" stroke-width="0.4"`);
  o += fill('pond', pal.lakeFill, ` stroke="${pal.waterEdge}" stroke-width="0.5"`);
  if (f.walls?.length) o += `<path d="${f.walls.map((w) => pathD(w, false)).join('')}" fill="none" stroke="${pal.farmInk}" stroke-width="0.9" stroke-linecap="butt"/>`;
  if (f.trees?.length) o += `<g fill="${pal.treeFill}" stroke="${pal.treeInk}" stroke-width="0.3">${f.trees.map((t) => `<circle cx="${f1(t.x)}" cy="${f1(t.y)}" r="2.2"/>`).join('')}</g>`;
  o += `<g fill="${pal.farmRoof}" stroke="${pal.farmInk}" stroke-width="0.5">${f.buildings.map((b) => `<path d="${pathD(b, true)}"/>`).join('')}</g>`;
  const rg = farmRidges(f);
  if (rg.length) o += `<path d="${rg.map((r) => pathD(r, false)).join('')}" fill="none" stroke="${pal.farmInk}" stroke-width="0.35" stroke-opacity="0.8"/>`;
  return o + '</g>';
}

function bridgeShape(a: Vec2, b: Vec2, w: number, pad: number): { deck: string; rails: string; ends: string } {
  const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
  const tx = dx / l, ty = dy / l, nx = -ty, ny = tx;
  const h = w / 2;
  const a2 = { x: a.x - tx * pad, y: a.y - ty * pad }, b2 = { x: b.x + tx * pad, y: b.y + ty * pad };
  const P = (p: Vec2, s: number): Vec2 => ({ x: p.x + nx * h * s, y: p.y + ny * h * s });
  const deck = pathD([P(a2, 1), P(b2, 1), P(b2, -1), P(a2, -1)], true);
  const rails = pathD([P(a2, 1), P(b2, 1)], false) + pathD([P(a2, -1), P(b2, -1)], false);
  const e = 0.9;
  const ends = pathD([P(a2, e + 0.25), P(a2, -e - 0.25)], false) + pathD([P(b2, e + 0.25), P(b2, -e - 0.25)], false);
  return { deck, rails, ends };
}

export function roadsLayer(world: World, pal: Palette, u: number): string {
  const roads = world.roads;
  if (!roads || !roads.length) return '';
  const s = Math.max(1, u * 0.85);
  const kinds: ('track' | 'minor' | 'major')[] = ['track', 'minor', 'major'];
  const by = (k: string) => roads.filter((r) => r.kind === k).map((r) => pathD(r.path, false)).join('');
  let out = '<g class="layer-roads" fill="none" stroke-linecap="round" stroke-linejoin="round">';
  // farm drives + farmsteads first (below roads)
  const farms = world.landuse?.farmsteads ?? [];
  if (farms.length) {
    out += `<g class="farmsteads">`;
    for (const f of farms) {
      const dl = f.drive.length > 1 ? Math.hypot(f.drive[f.drive.length - 1].x - f.drive[0].x, f.drive[f.drive.length - 1].y - f.drive[0].y) : 0;
      if (dl > 0.5) out += `<path d="${pathD(f.drive, false)}" stroke="${pal.trackFill}" stroke-width="${f1(Math.min(2 * s, 3.2))}" stroke-opacity="0.7" stroke-linecap="butt"/>`;
      if (!f.lot) {
        out += `<path d="${pathD(f.yard, true)}" fill="${pal.farmYard}" fill-opacity="0.9" stroke="${pal.farmInk}" stroke-width="${f1(0.5 * s)}" stroke-dasharray="${f1(2.5 * s)} ${f1(1.5 * s)}"/>`;
        out += `<g fill="${pal.farmRoof}" stroke="${pal.farmInk}" stroke-width="${f1(0.7 * s)}">${f.buildings.map((b) => `<path d="${pathD(b, true)}"/>`).join('')}</g>`;
        continue;
      }
      out += farmSvg(f, pal);
    }
    out += '</g>';
  }
  for (const k of kinds) {
    const d = by(k);
    if (!d) continue;
    // hierarchy: cased major roads, thinner minor roads, tracks as thin dashed earth lines
    if (k === 'track') {
      out += `<path d="${d}" stroke="${ruralInk(pal)}" stroke-width="${f1(Math.max(1.6, 0.6 * s))}" stroke-dasharray="${f1(6 * s)} ${f1(3.5 * s)}" stroke-linecap="butt" stroke-opacity="${pal.rural.track}"/>`;
    } else {
      const road = regionalRoadSurface(k, 1 / u);
      out += `<path d="${d}" stroke="${pal.roadEdge}" stroke-width="${f1(road.casing)}"/>`;
      out += `<path d="${d}" stroke="${pal.roadFill}" stroke-width="${f1(road.fill)}"/>`;
    }
  }
  // bridges
  const br = world.bridges ?? [];
  if (br.length) {
    out += '<g class="layer-bridges">';
    for (const b of br) {
      // (small town bridges, footbridges, arches and fords, are drawn at true size over the street space: urban.ts)
      if (isKinded(b)) continue;
      const bridge = regionalBridgeSurface(b.width, 1 / u);
      const sh = bridgeShape(b.a, b.b, bridge.deck, bridge.pad);
      out += `<path d="${sh.deck}" fill="${pal.bridgeDeck}" stroke="none"/>` +
        `<path d="${sh.rails}" stroke="${pal.bridgeInk}" stroke-width="${f1(bridge.rail)}" stroke-linecap="butt"/>` +
        `<path d="${sh.ends}" stroke="${pal.bridgeInk}" stroke-width="${f1(Math.max(1.4, u))}" stroke-linecap="butt"/>`;
    }
    out += '</g>';
  }
  out += '</g>';
  return out;
}

/** Placeholder for the town: reserve outline and center marker (M3 replaces this with the town). */
export function siteLayer(world: World, pal: Palette, u: number, debug: boolean): string {
  const site = world.site;
  if (!site) return '';
  const c = site.center;
  let out = `<g class="layer-site" fill="none">`;
  for (const p of world.landuse?.reserve ?? []) out += `<path d="${pathD(p, true)}" stroke="${pal.ink}" stroke-width="${f1(1.5 * u)}" stroke-dasharray="${f1(9 * u)} ${f1(6 * u)}" opacity="0.7"/>`;
  out += `<circle cx="${f1(c.x)}" cy="${f1(c.y)}" r="${f1(9 * u)}" fill="none" stroke="${pal.ink}" stroke-width="${f1(1.6 * u)}"/>`;
  out += `<circle cx="${f1(c.x)}" cy="${f1(c.y)}" r="${f1(3.4 * u)}" fill="${pal.ink}"/>`;
  if (debug) {
    const mk = (p: Vec2 | undefined, label: string) => {
      if (!p) return '';
      return `<circle cx="${f1(p.x)}" cy="${f1(p.y)}" r="${f1(6 * u)}" stroke="${pal.marker}" stroke-width="${f1(1.6 * u)}"/><text x="${f1(p.x + 8 * u)}" y="${f1(p.y)}" font-size="${f1(11 * u)}" fill="${pal.marker}" stroke="none" font-family="sans-serif">${label}</text>`;
    };
    out += mk(site.crossing, 'crossing') + mk(site.harbor, 'harbor') + mk(site.citadelSpot, 'citadel');
  }
  out += '</g>';
  return out;
}
