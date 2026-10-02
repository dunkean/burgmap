/**
 * Access to every building (level 4): a building must touch the street, or open ground (yard, court, passage at
 * least ~1.5 m wide) connected to the street through unbuilt space of its block.
 *
 * Reachability is computed on a raster of the block (0.5 m cells): free = inside the block and outside every
 * footprint; a cell is passable when its four neighbours are free (or outside the block on the street side), so a
 * passage narrower than ~1.5 m does not count; passable cells next to the street edge are the seeds of a flood fill.
 * A building is reachable when it touches the street edge or a reached passable cell.
 *
 * Plots whose rear buildings are cut off get a passage along one side line, shared with the neighbouring plot of
 * the same frontage run (each gives half its width, like the allées and closes of medieval towns), cut through the
 * front range from the street to the deepest building; buildings still unreachable are dropped.
 */
import type { Vec2, Polygon } from '../core/geom';
import { dist } from '../core/geom';
import { bboxOf, pointInRing, area, distToSeg, distToRing, obb as obbOf } from '../geo/poly';
import { GridIndex } from '../geo/spatial';
import { rasterizePolys } from '../geo/raster';
import type { Plot } from './plots';
import { clipPlot, shapeOf, MIN_BW, MAX_ASPECT, type HalfPlane } from './buildings';
import { isConvex } from '../geo/split';

export const ACCESS_CELL = 0.5;

/**
 * Reachable flags of the buildings of a block. `streetAt(p)` tells whether a point of the block boundary lies on a
 * street (or place) edge.
 */
export function blockReach(block: Polygon, blds: Polygon[], streetAt: (p: Vec2) => boolean, cell = ACCESS_CELL): boolean[] {
  if (!blds.length) return [];
  const bb = bboxOf(block);
  const x0 = bb.x0 - cell, y0 = bb.y0 - cell;
  const w = Math.ceil((bb.x1 - x0) / cell) + 2, h = Math.ceil((bb.y1 - y0) / cell) + 2;
  const shift = (p: Polygon) => p.map((q) => ({ x: q.x - x0, y: q.y - y0 }));
  const inB = rasterizePolys([shift(block)], w, h, cell);
  // building ids per cell (0 = none): scanlines over each footprint's own rows
  const bid = new Int32Array(w * h);
  const xs: number[] = [];
  blds.forEach((b0, k) => {
    const b = shift(b0);
    let ya = Infinity, yb = -Infinity;
    for (const q of b) { ya = Math.min(ya, q.y); yb = Math.max(yb, q.y); }
    const r0 = Math.max(0, Math.floor(ya / cell - 0.5)), r1 = Math.min(h - 1, Math.ceil(yb / cell - 0.5));
    for (let r = r0; r <= r1; r++) {
      const y = (r + 0.5) * cell;
      xs.length = 0;
      for (let i = 0, j = b.length - 1; i < b.length; j = i++) {
        const p = b[i], q = b[j];
        if ((p.y > y) !== (q.y > y)) xs.push(p.x + ((y - p.y) * (q.x - p.x)) / (q.y - p.y));
      }
      xs.sort((u, v) => u - v);
      for (let t = 0; t + 1 < xs.length; t += 2) {
        const c0 = Math.max(0, Math.ceil(xs[t] / cell - 0.5)), c1 = Math.min(w - 1, Math.floor(xs[t + 1] / cell - 0.5));
        for (let c = c0; c <= c1; c++) bid[r * w + c] = k + 1;
      }
    }
  });
  const free = (i: number) => inB[i] === 1 && bid[i] === 0;
  // street side: block-boundary cells whose outside neighbour is on a street
  const streetCell = new Uint8Array(w * h);
  const at = (i: number): Vec2 => ({ x: x0 + ((i % w) + 0.5) * cell, y: y0 + (Math.floor(i / w) + 0.5) * cell });
  for (let i = 0; i < w * h; i++) {
    if (inB[i]) continue;
    const x = i % w, y = Math.floor(i / w);
    if (!((x > 0 && inB[i - 1]) || (x < w - 1 && inB[i + 1]) || (y > 0 && inB[i - w]) || (y < h - 1 && inB[i + w]))) continue;
    if (streetAt(at(i))) streetCell[i] = 1;
  }
  const passable = (i: number): boolean => {
    if (!free(i)) return false;
    const x = i % w, y = Math.floor(i / w);
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (j < 0) return false;
      if (!free(j) && !(inB[j] === 0 && streetCell[j])) return false;
    }
    return true;
  };
  const seen = new Uint8Array(w * h);
  const queue: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!streetCell[i]) continue;
    const x = i % w, y = Math.floor(i / w);
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && !seen[j] && passable(j)) { seen[j] = 1; queue.push(j); }
  }
  while (queue.length) {
    const i = queue.pop()!;
    const x = i % w, y = Math.floor(i / w);
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && !seen[j] && passable(j)) { seen[j] = 1; queue.push(j); }
  }
  // a building is reached when one of its cells borders a reached cell (8-neighbourhood) or stands within ~1 m of
  // the street edge (a front set back by a narrow apron still opens on the street)
  const ok = blds.map(() => false);
  const R = Math.max(1, Math.round(1 / cell));
  for (let i = 0; i < w * h; i++) {
    const k = bid[i];
    if (!k || ok[k - 1]) continue;
    const x = i % w, y = Math.floor(i / w);
    for (let dy = -R; dy <= R && !ok[k - 1]; dy++) for (let dx = -R; dx <= R; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if ((Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && seen[j]) || streetCell[j]) { ok[k - 1] = true; break; }
    }
  }
  void pointInRing;
  return ok;
}

/** Side line half-plane of a plot (pointing into the plot). */
function sideHP(pl: Plot, which: 'A' | 'B'): HalfPlane {
  const s = which === 'A' ? pl.sideA : pl.sideB;
  const [fa, fb] = pl.front;
  const L = dist(fa, fb) || 1;
  const t = { x: (fb.x - fa.x) / L, y: (fb.y - fa.y) / L };
  const towards = which === 'A' ? t : { x: -t.x, y: -t.y };
  let m = { x: -s.d.y, y: s.d.x };
  if (m.x * towards.x + m.y * towards.y < 0) m = { x: -m.x, y: -m.y };
  return { p: s.p, n: m };
}

/**
 * Cuts a passage of width `w` along one side line of the plot through its buildings (from the street to the back):
 * every footprint keeps only its part beyond the passage; pieces that are no longer proper footprints are dropped.
 */
export function carvePassage<T extends { poly: Polygon; kind: string }>(pl: Plot, blds: T[], which: 'A' | 'B', w: number, dMax = Infinity): T[] {
  const h = sideHP(pl, which);
  const keep: HalfPlane = { p: { x: h.p.x + h.n.x * w, y: h.p.y + h.n.y * w }, n: h.n };
  const { fa, n } = frontFrame(pl);
  const out: T[] = [];
  const ok = (r: Polygon) => { const s = shapeOf(r); return area(r) >= 12 && s.w >= MIN_BW && s.asp <= MAX_ASPECT + 0.05 && shapeOkObb(r); };
  for (const b of blds) {
    // untouched footprints stay as they are
    if (b.poly.every((q) => (q.x - keep.p.x) * keep.n.x + (q.y - keep.p.y) * keep.n.y >= -1e-6)) { out.push(b); continue; }
    const conv = isConvex(b.poly, 1e-3);
    if (dMax < Infinity && b.poly.some((q) => (q.x - fa.x) * n.x + (q.y - fa.y) * n.y > dMax + 0.01)) {
      // a gateway through the front range only: the part beyond dMax keeps its full width
      const cut: HalfPlane = { p: { x: fa.x + n.x * dMax, y: fa.y + n.y * dMax }, n };
      const back = clipPlot(b.poly, [cut], conv);
      const front = clipPlot(b.poly, [{ p: cut.p, n: { x: -n.x, y: -n.y } }, keep], conv);
      for (const r of [...back, ...front]) if (ok(r)) out.push({ ...b, poly: r });
      continue;
    }
    for (const r of clipPlot(b.poly, [keep], conv)) if (ok(r)) out.push({ ...b, poly: r });
  }
  return out;
}

/** Frontage frame of a plot: origin, unit tangent and inward normal. */
export function frontFrame(pl: Plot): { fa: Vec2; t: Vec2; n: Vec2 } {
  const [fa, fb] = pl.front;
  const L = dist(fa, fb) || 1;
  const t = { x: (fb.x - fa.x) / L, y: (fb.y - fa.y) / L };
  let n = { x: -t.y, y: t.x };
  if (n.x * pl.nrm.x + n.y * pl.nrm.y < 0) n = { x: -n.x, y: -n.y };
  return { fa, t, n };
}

/** Depth of the back face of the plot's street-front buildings (those reaching within 1 m of the frontage). */
export function frontRangeDepth(pl: Plot, blds: { poly: Polygon }[]): number {
  const { fa, n } = frontFrame(pl);
  let d = 0;
  for (const b of blds) {
    const ds = b.poly.map((q) => (q.x - fa.x) * n.x + (q.y - fa.y) * n.y);
    if (Math.min(...ds) < 1.2) d = Math.max(d, Math.max(...ds));
  }
  return d;
}

/** Street-edge predicate shared by the generator and the tests: within the (jittered) half width of a street + slack, or on a place. */
export function makeStreetAt(streets: { path: Vec2[]; widths?: number[]; width: number }[], places: Polygon[]): (p: Vec2) => boolean {
  const sidx = new GridIndex<{ a: Vec2; b: Vec2; hw: number }>(30);
  for (const s of streets) for (let i = 1; i < s.path.length; i++) {
    const hw = ((s.widths?.[i - 1] ?? s.width) + (s.widths?.[i] ?? s.width)) / 4;
    sidx.insertSeg(s.path[i - 1], s.path[i], { a: s.path[i - 1], b: s.path[i], hw });
  }
  const pidx = new GridIndex<Polygon>(60);
  for (const q of places) pidx.insertPts(q, q);
  return (p: Vec2) => {
    for (const sg of sidx.queryPt(p, 14)) if (distToSeg(p, sg.a, sg.b) <= sg.hw * 1.15 + 1.2) return true;
    return pidx.queryPt(p, 1).some((q) => pointInRing(q, p) || distToRing(q, p) < 0.8);
  };
}

/**
 * No matchsticks: a dwelling footprint longer than 3 × its width (ranges of courtyard houses, side halls) is cut
 * across its long axis into equal parts of aspect ≤ 3 (party walls between rooms / houses).
 */
export function splitLong<T extends { poly: Polygon; kind: string }>(list: T[], maxAsp = 2.95): T[] {
  const out: T[] = [];
  for (const b of list) {
    const o = obbOf(b.poly);
    const asp = o.hu / Math.max(1e-6, o.hv);
    if (b.kind === 'landmark' || asp <= maxAsp || o.hv * 2 < 1) { out.push(b); continue; }
    const k = Math.ceil(asp / (maxAsp * 0.95));
    const conv = isConvex(b.poly, 1e-3);
    let okAll = true;
    const parts: T[] = [];
    for (let j = 0; j < k; j++) {
      const s0 = -o.hu + (2 * o.hu * j) / k, s1 = -o.hu + (2 * o.hu * (j + 1)) / k;
      const hps: HalfPlane[] = [];
      if (j > 0) hps.push({ p: { x: o.c.x + o.u.x * s0, y: o.c.y + o.u.y * s0 }, n: o.u });
      if (j < k - 1) hps.push({ p: { x: o.c.x + o.u.x * s1, y: o.c.y + o.u.y * s1 }, n: { x: -o.u.x, y: -o.u.y } });
      for (const r of clipPlot(b.poly, hps, conv)) { if (area(r) >= 4 && shapeOkObb(r)) parts.push({ ...b, poly: r }); else okAll = false; }
    }
    if (okAll && parts.length) out.push(...parts); else out.push(b);
  }
  return out;
}

/** The no-matchstick rule as the density test measures it: oriented-box width ≥ 4.5 m and aspect ≤ 3. */
export function shapeOkObb(p: Polygon): boolean {
  const o = obbOf(p);
  return 2 * o.hv >= 4.45 && o.hu / Math.max(1e-6, o.hv) <= 3.0;
}
