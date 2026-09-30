import type { World, LandArea, LandKind } from '../gen/types';
import type { Vec2 } from '../gen/core/geom';
import type { Palette } from './styles';
import { f1, pathD } from './util';

const ringsD = (a: LandArea): string => {
  let d = pathD(a.poly, true);
  if (a.holes) for (const h of a.holes) d += pathD(h, true);
  return d;
};

/** SVG <pattern> definitions for land-use textures. `s` scales symbols with map size. */
function patterns(world: World, pal: Palette, s: number): string {
  const out: string[] = [];
  const pat = (id: string, w: number, h: number, body: string, extra = '') =>
    out.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" width="${f1(w)}" height="${f1(h)}"${extra}>${body}</pattern>`);

  // forest: dense canopy circles (irregular)
  {
    const W = 30 * s;
    const pts: [number, number, number][] = [[4, 5, 3.1], [13, 3, 2.7], [22, 6, 3.2], [8, 13, 3.3], [18, 14, 3], [27, 15, 2.6], [3, 22, 2.8], [12, 24, 3.2], [22, 23, 3.1], [29, 27, 2.5], [16, 29, 2.4]];
    let b = '';
    for (const [x, y, r] of pts) b += `<circle cx="${f1(x * s)}" cy="${f1(y * s)}" r="${f1(r * s)}"/>`;
    pat('p-forest', W, W, `<g fill="${pal.treeFill}" stroke="${pal.treeInk}" stroke-width="${f1(0.55 * s)}">${b}</g>`);
  }
  // orchard: regular dot grid with a small stem mark
  {
    const W = 11 * s;
    pat('p-orchard', W, W, `<circle cx="${f1(W / 2)}" cy="${f1(W / 2)}" r="${f1(2.3 * s)}" fill="${pal.treeFill}" stroke="${pal.orchardDot}" stroke-width="${f1(0.5 * s)}"/><circle cx="${f1(W / 2)}" cy="${f1(W / 2)}" r="${f1(0.45 * s)}" fill="${pal.orchardDot}"/>`);
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
    seen.add(Math.round((a.stripAngle * 180) / Math.PI) % 180);
  }
  const sp = Math.max(2.4, 1.5 * s);
  for (const deg of seen) {
    pat(`p-fur-${deg}`, 40, sp, `<path d="M0 ${f1(sp / 2)}H40" stroke="${pal.furrow}" stroke-width="${f1(Math.max(0.35, 0.3 * s))}" opacity="0.6"/>`, ` patternTransform="rotate(${deg})"`);
  }
  return `<defs>${out.join('')}</defs>`;
}

export function landuseLayer(world: World, pal: Palette, u: number): string {
  const lu = world.landuse;
  if (!lu) return '';
  const s = Math.max(1, u);
  let out = patterns(world, pal, s);
  const order: LandKind[] = ['meadow', 'marsh', 'pasture', 'commons', 'forest', 'garden', 'orchard', 'field'];
  out += `<g class="layer-landuse" stroke-linejoin="round">`;
  for (const kind of order) {
    const list = lu.areas.filter((a) => a.kind === kind);
    if (!list.length) continue;
    out += `<g class="lu-${kind}">`;
    if (kind === 'field') {
      out += `<g fill="${pal.land.field}" fill-opacity="${pal.landOpacity}" fill-rule="evenodd">${list.map((a) => `<path d="${ringsD(a)}"/>`).join('')}</g>`;
      // strips: alternate tints, thin dividing lines and furrow texture
      for (const a of list) {
        if (!a.strips || a.stripAngle === undefined) continue;
        const deg = Math.round((a.stripAngle * 180) / Math.PI) % 180;
        let dA = '', dB = '', all = '';
        a.strips.forEach((st, i) => { const d = pathD(st, true); all += d; if (i & 1) dB += d; else dA += d; });
        out += `<path d="${dA}" fill="${pal.stripA}" fill-opacity="0.55"/><path d="${dB}" fill="${pal.stripB}" fill-opacity="0.5"/>` +
          `<path d="${all}" fill="url(#p-fur-${deg})" stroke="${pal.furrow}" stroke-width="${f1(0.28 * s)}" stroke-opacity="0.55"/>`;
      }
      // hedges along furlong edges
      out += `<g fill="none" stroke="${pal.hedge}" stroke-width="${f1(0.9 * s)}" stroke-opacity="0.75" stroke-dasharray="${f1(4 * s)} ${f1(1.2 * s)}" stroke-linecap="round">${list.map((a) => `<path d="${ringsD(a)}"/>`).join('')}</g>`;
    } else {
      const d = list.map(ringsD).join('');
      const alpha = kind === 'forest' ? 0.7 : pal.landOpacity;
      out += `<path d="${d}" fill="${pal.land[kind]}" fill-opacity="${alpha}" fill-rule="evenodd" stroke="${pal.land[kind]}" stroke-width="${f1(0.6 * s)}"/>`;
      out += `<path d="${d}" fill="url(#p-${kind})" fill-rule="evenodd"/>`;
      if (kind === 'forest') out += `<path d="${d}" fill="none" stroke="${pal.treeInk}" stroke-width="${f1(0.7 * s)}" stroke-opacity="0.55" stroke-linejoin="round"/>`;
      else if (kind === 'orchard' || kind === 'garden') out += `<path d="${d}" fill="none" stroke="${pal.hedge}" stroke-width="${f1(0.8 * s)}" stroke-opacity="0.7"/>`;
    }
    out += '</g>';
  }
  out += '</g>';
  return out;
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
  const edge = 1.3 * Math.max(0.8, s);
  const kinds: ('track' | 'minor' | 'major')[] = ['track', 'minor', 'major'];
  const by = (k: string) => roads.filter((r) => r.kind === k).map((r) => pathD(r.path, false)).join('');
  let out = '<g class="layer-roads" fill="none" stroke-linecap="round" stroke-linejoin="round">';
  // farm drives + farmsteads first (below roads)
  const farms = world.landuse?.farmsteads ?? [];
  if (farms.length) {
    out += `<g class="farmsteads">`;
    for (const f of farms) {
      out += `<path d="${pathD(f.drive, false)}" stroke="${pal.trackFill}" stroke-width="${f1(2 * s)}" stroke-opacity="0.7" stroke-linecap="butt"/>`;
      out += `<path d="${pathD(f.yard, true)}" fill="${pal.farmYard}" fill-opacity="0.9" stroke="${pal.farmInk}" stroke-width="${f1(0.5 * s)}" stroke-dasharray="${f1(2.5 * s)} ${f1(1.5 * s)}"/>`;
      out += `<g fill="${pal.farmRoof}" stroke="${pal.farmInk}" stroke-width="${f1(0.7 * s)}">${f.buildings.map((b) => `<path d="${pathD(b, true)}"/>`).join('')}</g>`;
    }
    out += '</g>';
  }
  for (const k of kinds) {
    const d = by(k);
    if (!d) continue;
    const w = k === 'major' ? 8 : k === 'minor' ? 5 : 3;
    if (k === 'track') {
      out += `<path d="${d}" stroke="${pal.roadEdge}" stroke-width="${f1(Math.max(1.6, w * 0.5 * s))}" stroke-dasharray="${f1(7 * s)} ${f1(4 * s)}" stroke-linecap="butt" opacity="0.85"/>`;
    } else {
      out += `<path d="${d}" stroke="${pal.roadEdge}" stroke-width="${f1(w * s + 2 * edge)}"/>`;
      out += `<path d="${d}" stroke="${pal.roadFill}" stroke-width="${f1(w * s)}"/>`;
    }
  }
  // bridges
  const br = world.bridges ?? [];
  if (br.length) {
    out += '<g class="layer-bridges">';
    for (const b of br) {
      const sh = bridgeShape(b.a, b.b, b.width * s + 1, 1.5 * s);
      out += `<path d="${sh.deck}" fill="${pal.bridgeDeck}" stroke="none"/>` +
        `<path d="${sh.rails}" stroke="${pal.bridgeInk}" stroke-width="${f1(1.1 * s)}" stroke-linecap="butt"/>` +
        `<path d="${sh.ends}" stroke="${pal.bridgeInk}" stroke-width="${f1(1.4 * s)}" stroke-linecap="butt"/>`;
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
  out += `<circle cx="${f1(c.x)}" cy="${f1(c.y)}" r="${f1(9 * u)}" fill="${pal.paper}" fill-opacity="0.85" stroke="${pal.ink}" stroke-width="${f1(1.6 * u)}"/>`;
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
