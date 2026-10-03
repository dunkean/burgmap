/** Wet moats occupy reserved land outside the actual curtain, with dry causeways at roads and gates. */
import type { Polygon, Polyline } from '../core/geom';
import type { Tri } from '../options';
import type { UrbanCtx } from './context';
import type { WallLine } from './primary';
import { dilate, isoRegions } from './phases';
import { differenceSafeS, intersectionS, unionMany, type MultiPoly } from '../geo/bool';
import { area, bboxOf, distToSeg, pointInRing, segSegT } from '../geo/poly';
import { ribbon } from '../geo/offset';
import { outerRing } from './m4/castle';
import { GridIndex } from '../geo/spatial';

export interface MoatRoad { path: Polyline; widths: number[] }

/** Shared by reservation and rendering, so a double enceinte uses exactly the same external curtain. */
export function offsetCurtain(wall: WallLine, gap: number): WallLine | null {
  const ring = outerRing(wall.ring, gap);
  if (!ring) return null;
  const gates: WallLine['gates'] = [];
  for (const g of wall.gates) {
    const sign = pointInRing(wall.ring, { x: g.p.x + g.dir.x * 2, y: g.p.y + g.dir.y * 2 }) ? -1 : 1;
    const end = { x: g.p.x + g.dir.x * sign * (gap * 4 + 40), y: g.p.y + g.dir.y * sign * (gap * 4 + 40) };
    let t = Infinity;
    for (let k = 0; k < ring.length; k++) {
      const hit = segSegT(g.p, end, ring[k], ring[(k + 1) % ring.length]);
      if (hit && hit.t < t) t = hit.t;
    }
    if (Number.isFinite(t)) gates.push({ ...g, p: { x: g.p.x + (end.x - g.p.x) * t, y: g.p.y + (end.y - g.p.y) * t },
      dir: { x: -sign * g.dir.x, y: -sign * g.dir.y } });
  }
  return { ring, gates };
}

/** Natural-bank membership, used for activities that require a real river rather than a defensive ditch. */
export function naturalBank(water: MultiPoly): (p: { x: number; y: number }) => boolean {
  const idx = new GridIndex<{ a: { x: number; y: number }; b: { x: number; y: number } }>(40);
  for (const ph of water) for (const r of [ph.outer, ...ph.holes]) for (let i = 0; i < r.length; i++) {
    idx.insertSegThin(r[i], r[(i + 1) % r.length], { a: r[i], b: r[(i + 1) % r.length] });
  }
  return (p) => idx.queryPt(p, 0.3).some((s) => distToSeg(p, s.a, s.b) < 0.3);
}

/** The ditch and its dry berm are defensive land, not another disconnected piece of built-up town. */
export function moatReserve(walls: WallLine[]): MultiPoly {
  if (!walls.length) return [];
  const enclosure = unionMany(walls.map((w) => w.ring), 24, true);
  return differenceSafeS(dilate(enclosure, 19), enclosure);
}

export function moatBand(walls: WallLine[]): MultiPoly {
  if (!walls.length) return [];
  const enclosure = unionMany(walls.map((w) => w.ring), 24, true);
  return differenceSafeS(dilate(enclosure, 19), dilate(enclosure, 8));
}

export function planMoat(ctx: UrbanCtx, walls: WallLine[], roads: MoatRoad[], lots: Polygon[],
  option: Tri | undefined, customary = false): MultiPoly {
  if (!walls.length || option === 'no' || (option !== 'yes' && !customary)) return [];
  if (option !== 'yes' && (ctx.world.options.biome === 'desert' || ctx.world.options.biome === 'tundra')) return [];
  const band = moatBand(walls);
  if (!band.length || !moatReserve(walls).length) return [];
  // A gravity-fed wet ditch belongs on low, gently sloping land near water. Explicit On allows a longer
  // feeder, but never a blue border on a dry hill. Work only in the local window of the terrain grid.
  const bb = bboxOf(band.flatMap((p) => p.outer)), { n, cell } = ctx;
  const x0 = Math.max(0, Math.floor(bb.x0 / cell) - 2), y0 = Math.max(0, Math.floor(bb.y0 / cell) - 2);
  const w = Math.min(n, Math.ceil(bb.x1 / cell) + 3) - x0, h = Math.min(n, Math.ceil(bb.y1 / cell) + 3) - y0;
  if (w <= 0 || h <= 0) return [];
  const mask = new Float32Array(w * h), fields = ctx.site.fields;
  const nearCurtain = new GridIndex<{ a: { x: number; y: number }; b: { x: number; y: number } }>(40);
  for (const wall of walls) for (let k = 0; k < wall.ring.length; k++) {
    const a = wall.ring[k], b = wall.ring[(k + 1) % wall.ring.length];
    nearCurtain.insertSegThin(a, b, { a, b });
  }
  const nearBand = (x: number, y: number) => {
    const p = { x: (x0 + x + 0.5) * cell, y: (y0 + y + 0.5) * cell }, reach = 19 + cell;
    return nearCurtain.queryPt(p, reach).some((s) => distToSeg(p, s.a, s.b) <= reach);
  };
  const maxDist = option === 'yes' ? 1000 : 550, maxHeight = option === 'yes' ? 12 : 6;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y0 + y) * n + x0 + x;
    const p = { x: (x0 + x + 0.5) * cell, y: (y0 + y + 0.5) * cell };
    mask[y * w + x] = fields.dWater[i] < maxDist && fields.hab[i] < maxHeight
      && ctx.slopeAt(p) < 0.12 ? 1 : 0;
  }
  let moat = intersectionS(band, isoRegions(mask, n, cell, 0.5, 180, { x0, y0, w, h }));
  if (!moat.length) return [];
  const dry: Polygon[] = lots.slice();
  // Smoothed terrain contours discard small holes; conservatively retain EVERY rejected cell. Row runs
  // keep the number of clipping polygons bounded, rather than adding one polygon per terrain cell.
  for (let y = 0; y < h; y++) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      if (x < w && !mask[y * w + x] && nearBand(x, y)) { if (start < 0) start = x; }
      else if (start >= 0) {
        const a = (x0 + start) * cell, b = (x0 + x) * cell, c = (y0 + y) * cell;
        dry.push([{ x: a, y: c }, { x: b, y: c }, { x: b, y: c + cell }, { x: a, y: c + cell }]);
        start = -1;
      }
    }
  }
  for (const road of roads) {
    const r = ribbon(road.path, road.widths.map((v) => v + 8));
    if (r.length >= 3) dry.push(r);
  }
  // Axis streets may stop on the wall; extend their gate's causeway across the ditch.
  for (const wall of walls) for (const g of wall.gates) {
    const r = ribbon([-28, 28].map((d) => ({ x: g.p.x + g.dir.x * d, y: g.p.y + g.dir.y * d })), g.width + 16);
    if (r.length >= 3) dry.push(r);
  }
  const boxes = moat.map((ph) => bboxOf(ph.outer));
  const near = dry.filter((r) => {
    const b = bboxOf(r);
    return boxes.some((a) => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0);
  });
  moat = differenceSafeS(moat, ctx.water, unionMany(near, 24, true));
  moat = intersectionS(moat, [{ x: 0, y: 0 }, { x: ctx.mapSize, y: 0 }, { x: ctx.mapSize, y: ctx.mapSize }, { x: 0, y: ctx.mapSize }]);
  return moat.filter((ph) => area(ph.outer) - ph.holes.reduce((s, p) => s + area(p), 0) > 180);
}
