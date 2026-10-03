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
export const ACC_STATS = { calls: 0, cells: 0, ms: 0, msRaster: 0, msStreet: 0 };

/**
 * Reachable flags of the buildings of a block. `streetAt(p)` tells whether a point of the block boundary lies on a
 * street (or place) edge.
 */
/**
 * The rasters of a block that do not depend on its buildings (block mask, street-side cells, their ~1 m reach),
 * kept for the next call on the same block (the access pass asks twice: before and after carving passages).
 */
interface BlockStatic { block: Polygon; streetAt: unknown; cell: number; x0: number; y0: number; w: number; h: number; inB: Uint8Array; streetCell: Uint8Array; near: Uint8Array; streetSeeds: number[] }
let LAST_BLOCK: BlockStatic | null = null;
/** Scratch buffers of blockReach (grown on demand). */
let POOL: { bid: Int32Array; seen: Uint32Array; queue: Int32Array; ep: number } | null = null;

function blockStatic(block: Polygon, streetAt0: StreetAt | ((p: Vec2) => boolean), cell: number): BlockStatic {
  if (LAST_BLOCK && LAST_BLOCK.block === block && LAST_BLOCK.streetAt === streetAt0 && LAST_BLOCK.cell === cell) return LAST_BLOCK;
  const bb = bboxOf(block);
  const sa = streetAt0 as StreetAt;
  const streetAt = sa.local ? sa.local(bb.x0, bb.y0, bb.x1, bb.y1) : streetAt0;
  const x0 = bb.x0 - cell, y0 = bb.y0 - cell;
  const w = Math.ceil((bb.x1 - x0) / cell) + 2, h = Math.ceil((bb.y1 - y0) / cell) + 2;
  const shift = (p: Polygon) => p.map((q) => ({ x: q.x - x0, y: q.y - y0 }));
  const tA = performance.now();
  const inB = rasterizePolys([shift(block)], w, h, cell);
  const N = w * h;
  ACC_STATS.msRaster += performance.now() - tA;
  const tS = performance.now();
  // street side: block-boundary cells (outside the block, a 4-neighbour inside) whose outside neighbour is on a
  // street; the boundary cells are listed once, in raster order
  const streetCell = new Uint8Array(N);
  const bnd: number[] = [];
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (inB[i]) continue;
      if ((x > 0 && inB[i - 1]) || (x < w - 1 && inB[i + 1]) || (y > 0 && inB[i - w]) || (y < h - 1 && inB[i + w])) bnd.push(i);
    }
  }
  const at = (i: number): Vec2 => ({ x: x0 + ((i % w) + 0.5) * cell, y: y0 + (Math.floor(i / w) + 0.5) * cell });
  if (sa.parts) {
    // street ribbons (with the slack) stamped on the raster: only the cells near each segment are visited
    const { segs, places } = sa.parts(bb.x0, bb.y0, bb.x1, bb.y1);
    // segments bucketed on a coarse grid (8 m) over the raster; the block's outer boundary cells test only the
    // segments of their bucket (a long street's box would otherwise be scanned cell by cell)
    const BK = 8, bw = Math.ceil((w * cell) / BK) + 1, bh = Math.ceil((h * cell) / BK) + 1;
    const buckets: number[][] = Array.from({ length: bw * bh }, () => []);
    segs.forEach((sg, si) => {
      const r = sg.hw * 1.15 + 1.2;
      const gx0 = Math.max(0, Math.floor((Math.min(sg.a.x, sg.b.x) - r - x0) / BK)), gx1 = Math.min(bw - 1, Math.floor((Math.max(sg.a.x, sg.b.x) + r - x0) / BK));
      const gy0 = Math.max(0, Math.floor((Math.min(sg.a.y, sg.b.y) - r - y0) / BK)), gy1 = Math.min(bh - 1, Math.floor((Math.max(sg.a.y, sg.b.y) + r - y0) / BK));
      for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) buckets[gy * bw + gx].push(si);
    });
    for (const i of bnd) {
      const p = at(i);
      const bk = buckets[Math.min(bh - 1, Math.floor((p.y - y0) / BK)) * bw + Math.min(bw - 1, Math.floor((p.x - x0) / BK))];
      for (const si of bk) { const sg = segs[si]; if (distToSeg(p, sg.a, sg.b) <= sg.hw * 1.15 + 1.2) { streetCell[i] = 1; break; } }
    }
    if (places.length) {
      const pb = places.map((q) => { const b2 = bboxOf(q); return { q, x0: b2.x0 - 0.8, y0: b2.y0 - 0.8, x1: b2.x1 + 0.8, y1: b2.y1 + 0.8 }; });
      for (const i of bnd) {
        if (streetCell[i]) continue;
        const p = at(i);
        if (pb.some((o) => p.x >= o.x0 && p.x <= o.x1 && p.y >= o.y0 && p.y <= o.y1 && (pointInRing(o.q, p) || distToRing(o.q, p) < 0.8))) streetCell[i] = 1;
      }
    }
  } else {
    for (const i of bnd) if (streetAt(at(i))) streetCell[i] = 1;
  }
  // reach of the street edge (~1 m): the street cells are few, their neighbourhoods are stamped; the interior
  // ones (raster order) seed the flood
  const near = new Uint8Array(N);
  const R = Math.max(1, Math.round(1 / cell));
  const streetSeeds: number[] = [];
  for (const i of bnd) {
    if (!streetCell[i]) continue;
    const x = i % w, y = (i / w) | 0;
    for (let yy = Math.max(0, y - R); yy <= Math.min(h - 1, y + R); yy++) for (let xx = Math.max(0, x - R); xx <= Math.min(w - 1, x + R); xx++) near[yy * w + xx] = 1;
    if (x >= 1 && x < w - 1 && y >= 1 && y < h - 1) streetSeeds.push(i);
  }
  ACC_STATS.msStreet += performance.now() - tS;
  LAST_BLOCK = { block, streetAt: streetAt0, cell, x0, y0, w, h, inB, streetCell, near, streetSeeds };
  return LAST_BLOCK;
}

export function blockReach(block: Polygon, blds: Polygon[], streetAt0: StreetAt | ((p: Vec2) => boolean), cell = ACCESS_CELL): boolean[] {
  if (!blds.length) return [];
  const { x0, y0, w, h, inB, streetCell, near, streetSeeds } = blockStatic(block, streetAt0, cell);
  const shift = (p: Polygon) => p.map((q) => ({ x: q.x - x0, y: q.y - y0 }));
  ACC_STATS.calls++; ACC_STATS.cells += w * h;
  const tA = performance.now();
  const N = w * h;
  // building ids per cell (0 = none; a later footprint overwrites), scanlines over each footprint's own rows
  // (pooled buffers: `bid` is cleared cell by cell before returning, `seen` is epoch-stamped)
  if (!POOL || POOL.bid.length < N) POOL = { bid: new Int32Array(Math.max(N, 1 << 16)), seen: new Uint32Array(Math.max(N, 1 << 16)), queue: new Int32Array(Math.max(N, 1 << 16)), ep: 0 };
  const pool = POOL;
  const bid = pool.bid;
  const cellsOf: number[][] = blds.map(() => []);
  const xs: number[] = [];
  blds.forEach((b0, k) => {
    const b = shift(b0);
    let ya = Infinity, yb = -Infinity;
    for (const q of b) { ya = Math.min(ya, q.y); yb = Math.max(yb, q.y); }
    const r0 = Math.max(0, Math.floor(ya / cell - 0.5)), r1 = Math.min(h - 1, Math.ceil(yb / cell - 0.5));
    const own = cellsOf[k];
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
        for (let c = c0; c <= c1; c++) { bid[r * w + c] = k + 1; own.push(r * w + c); }
      }
    }
  });
  ACC_STATS.msRaster += performance.now() - tA;
  // A building is reached when one of its cells lies within ~1 m of the street edge (`near`) or next to a reached
  // cell (8-neighbourhood). Reached cells: flood from the street side through passable cells (free — inside the
  // block, outside every footprint — with their four neighbours free or the street outside). The flood settles
  // the buildings around each cell it reaches and stops once every building is settled (same verdicts as a full
  // flood followed by a scan of the building cells).
  const ok = blds.map(() => false);
  let left = blds.length;
  const done = (): boolean[] => { for (const own of cellsOf) for (const i of own) bid[i] = 0; ACC_STATS.ms += performance.now() - tA; return ok; };
  cellsOf.forEach((own, k) => { for (const i of own) if (bid[i] === k + 1 && near[i]) { ok[k] = true; left--; break; } });
  if (left === 0) return done();
  const free = (j: number) => inB[j] === 1 && bid[j] === 0;
  const okN = (j: number) => (inB[j] === 1 ? bid[j] === 0 : streetCell[j] === 1);
  const passable = (j: number): boolean => {
    const x = j % w, y = (j / w) | 0;
    return x >= 1 && x < w - 1 && y >= 1 && y < h - 1 && free(j) && okN(j - 1) && okN(j + 1) && okN(j - w) && okN(j + w);
  };
  const settle = (i: number) => { const k = bid[i]; if (k && !ok[k - 1]) { ok[k - 1] = true; left--; } };
  if (++pool.ep === 0xffffffff) { pool.seen.fill(0); pool.ep = 1; }
  const ep = pool.ep, seen = pool.seen, queue = pool.queue;
  let qh = 0, qt = 0;
  const visit = (j: number) => {
    if (seen[j] === ep || !passable(j)) return;
    seen[j] = ep; queue[qt++] = j;
    const x = j % w;
    const l = x > 0, r = x < w - 1, u = j >= w, d = j + w < N;
    if (l) settle(j - 1);
    if (r) settle(j + 1);
    if (u) settle(j - w);
    if (d) settle(j + w);
    if (l && u) settle(j - w - 1);
    if (r && u) settle(j - w + 1);
    if (l && d) settle(j + w - 1);
    if (r && d) settle(j + w + 1);
  };
  for (const i of streetSeeds) {
    visit(i - 1); visit(i + 1); visit(i - w); visit(i + w);
    if (left === 0) break;
  }
  while (qh < qt && left > 0) {
    const i = queue[qh++];
    const x = i % w;
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i + w < N) visit(i + w);
  }
  return done();
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
export function makeStreetAt(streets: { path: Vec2[]; widths?: number[]; width: number }[], places: Polygon[]): StreetAt {
  const sidx = new GridIndex<{ a: Vec2; b: Vec2; hw: number }>(30);
  for (const s of streets) for (let i = 1; i < s.path.length; i++) {
    const hw = ((s.widths?.[i - 1] ?? s.width) + (s.widths?.[i] ?? s.width)) / 4;
    sidx.insertSeg(s.path[i - 1], s.path[i], { a: s.path[i - 1], b: s.path[i], hw });
  }
  const pidx = new GridIndex<Polygon>(60);
  for (const q of places) pidx.insertPts(q, q);
  const test = (segs: { a: Vec2; b: Vec2; hw: number }[], pls: Polygon[]) => (p: Vec2): boolean => {
    for (const sg of segs) if (distToSeg(p, sg.a, sg.b) <= sg.hw * 1.15 + 1.2) return true;
    for (const q of pls) if (pointInRing(q, p) || distToRing(q, p) < 0.8) return true;
    return false;
  };
  const f = ((p: Vec2) => test(sidx.queryPt(p, 14), pidx.queryPt(p, 1))(p)) as StreetAt;
  // the street segments and places near a box, queried once (a block's raster asks thousands of points)
  f.local = (x0, y0, x1, y1) => test(sidx.query(x0 - 14, y0 - 14, x1 + 14, y1 + 14), pidx.query(x0 - 1, y0 - 1, x1 + 1, y1 + 1));
  f.parts = (x0, y0, x1, y1) => ({ segs: sidx.query(x0 - 14, y0 - 14, x1 + 14, y1 + 14), places: pidx.query(x0 - 1, y0 - 1, x1 + 1, y1 + 1) });
  return f;
}
export type StreetAt = ((p: Vec2) => boolean) & {
  local?: (x0: number, y0: number, x1: number, y1: number) => (p: Vec2) => boolean;
  parts?: (x0: number, y0: number, x1: number, y1: number) => { segs: { a: Vec2; b: Vec2; hw: number }[]; places: Polygon[] };
};

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
