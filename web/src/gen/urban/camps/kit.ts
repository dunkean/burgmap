/**
 * Camp kit: shared machinery of the settlements planned without streets (camps/index.ts). The same partition
 * principle as the street engine (URBAN_GEOMETRY.md): a quarter (the enclosure, the camp ground) is cut by its
 * trampled paths into blocks (quarter \ path ribbons); blocks are cut into lots by exact cells (wedges of a camp
 * circle, Voronoi yards, strips between lanes); buildings are fitted inside their lot. Every piece of every level
 * is a polygon of the partition, never an object placed over another one.
 */
import type { Vec2, Polygon, Polyline } from '../../core/geom';
import { dist, polygonCentroid } from '../../core/geom';
import type { UrbanStreet, UrbanLine, UrbanWall, UrbanSite, PolyH, UrbanBlockInfo, UrbanBuilding, UrbanParcel, StreetRole } from '../../types';
import { MultiPoly, differenceS, intersectionS, intersection, union, unionS, unionMany, mpArea } from '../../geo/bool';
import { area, orientPos, pointInRing, distToRing, distToSeg, inscribed, cleanRing, bboxOf, interiorAngle, isSimple } from '../../geo/poly';
import { ribbon } from '../../geo/offset';
import { polyInside, isConvex, clipHalfPlaneConvex, segCrossesRing } from '../../geo/split';
import { GridIndex } from '../../geo/spatial';
import { truncateAcute } from '../blocks';

export type BlockKind = UrbanBlockInfo['kind'];
export interface CampBlock { poly: Polygon; kind: BlockKind; compound?: string; quarter: number }
export interface CampParcel { poly: Polygon; use: string; block: number }
export interface CampBuilding extends Omit<UrbanBuilding, 'parcel'> { parcel: number }

/** One camp, village or room-block cluster, with local indices (merged by `assemble`). */
export interface CampOut {
  quarters: Polygon[];
  streets: UrbanStreet[];
  blocks: CampBlock[];
  parcels: CampParcel[];
  buildings: CampBuilding[];
  lines: UrbanLine[];
  walls: UrbanWall[];
  landmarks: { kind: string; poly: Polygon }[];
  water: PolyH[];
  sites: UrbanSite[];
  /** The enclosure or camp outline (phase region, footprint). */
  outline: Polygon[];
  /** Open places drawn as squares (named). */
  squares: Polygon[];
  /** Trees (orchards, the party tree). */
  trees?: { x: number; y: number; r: number }[];
  /** The quarters are disjoint and dry, and there is no outline: the footprint is the quarters themselves (no union). */
  disjoint?: boolean;
}

export const emptyCamp = (): CampOut => ({ quarters: [], streets: [], blocks: [], parcels: [], buildings: [], lines: [], walls: [], landmarks: [], water: [], sites: [], outline: [], squares: [] });

export const street = (path: Polyline, width: number, rank: number, role: StreetRole, phase = 1): UrbanStreet => ({
  path, width, widths: path.map(() => width), kind: rank <= 1 ? 'main' : rank <= 2 ? 'street' : 'alley', rank, role, phase,
});

export const dirOf = (a: number): Vec2 => ({ x: Math.cos(a), y: Math.sin(a) });
export const at = (c: Vec2, a: number, r: number): Vec2 => ({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
/** Normalized angle in [0, 2π). */
export const normA = (a: number): number => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

/** Closed circle polyline (first point repeated) and ring polygon. */
export function circlePts(c: Vec2, r: number, n: number, a0 = 0): Vec2[] {
  return Array.from({ length: n }, (_, i) => at(c, a0 + (i / n) * 2 * Math.PI, r));
}
/** Ellipse ring (semi-axes a along `ang`, b across), optionally wobbled by a radial noise function. */
export function ellipse(c: Vec2, a: number, b: number, ang: number, n = 72, wob?: (t: number) => number): Polygon {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    const k = wob ? 1 + wob(t) : 1;
    const x = Math.cos(t) * a * k, y = Math.sin(t) * b * k;
    pts.push({ x: c.x + x * ca - y * sa, y: c.y + x * sa + y * ca });
  }
  return orientPos(pts);
}

/** Annulus between two radii (a ring path's street space), as a polygon with a hole. */
export function annulus(c: Vec2, r0: number, r1: number, n = 96): PolyH {
  return { outer: orientPos(circlePts(c, r1, n)), holes: [orientPos(circlePts(c, r0, n))] };
}

/**
 * Cuts a polygon with holes into simple polygons: vertical slabs whose boundaries pass through every hole (each hole
 * is opened by the line through its centroid), so no piece keeps a hole, however many there are.
 */
export function splitHoles(ph: PolyH, depth = 0): Polygon[] {
  if (!ph.holes.length || depth > 3) return [ph.outer];
  const bb = bboxOf(ph.outer);
  // (a hole left after the first pass is cut a little off its centroid line)
  const xs = [...new Set(ph.holes.map((h) => Math.round((polygonCentroid(h).x + depth * 0.37) * 1000) / 1000))].sort((a, b) => a - b);
  const bounds = [bb.x0 - 10, ...xs, bb.x1 + 10];
  const out: Polygon[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i], b = bounds[i + 1];
    if (b - a < 1e-6) continue;
    const slab: Polygon = [{ x: a, y: bb.y0 - 10 }, { x: b, y: bb.y0 - 10 }, { x: b, y: bb.y1 + 10 }, { x: a, y: bb.y1 + 10 }];
    for (const piece of intersectionS([ph], slab)) {
      // (a hole whose centroid line misses it: a further split of that piece)
      if (piece.holes.length) out.push(...splitHoles({ outer: piece.outer, holes: piece.holes }, depth + 1));
      else out.push(piece.outer);
    }
  }
  return out;
}

/** A ring on the 1 mm grid of the snapped booleans (quarters: their blocks then never stick out of them). */
export function snapRing(p: Polygon): Polygon {
  // (through the boolean engine once: its ring cleanup — vertices with a turn under 0.5° dropped — is then already
  // applied, so the blocks cut from the quarter keep exactly its boundary)
  const u = unionS([{ outer: orientPos(p.map((q) => ({ x: Math.round(q.x * 1000) / 1000, y: Math.round(q.y * 1000) / 1000 }))), holes: [] }]);
  if (!u.length) return orientPos(p);
  return u.reduce((a, b) => (area(b.outer) > area(a.outer) ? b : a)).outer;
}

/** A polygon is a valid partition piece: no vertex angle < 13°, width ≥ 2.2 m. */
export function goodShape(p: Polygon, minW = 2.2): boolean {
  if (p.length < 3) return false;
  for (let i = 0; i < p.length; i++) if (interiorAngle(p, i) < (13 * Math.PI) / 180) return false;
  return inscribed(p, [], 0.1, minW / 2).r * 2 >= minW;
}

/** Cleaned simple polygons of a MultiPoly (holes cut open), dropping slivers. */
export function pieces(m: MultiPoly, minA = 6): Polygon[] {
  const out: Polygon[] = [];
  for (const ph of m) for (const p of splitHoles(ph)) {
    const r = orientPos(cleanRing(p, 0.01, 0.01, Infinity, false));
    if (r.length >= 3 && area(r) >= minA) out.push(r);
  }
  return out;
}

/** Blocks of a quarter: the quarter minus the street ribbons (and the water), as simple, well-shaped polygons. */
export function carveBlocks(quarter: Polygon, cuts: MultiPoly, water: MultiPoly): Polygon[] {
  let m: MultiPoly = [{ outer: quarter, holes: [] }];
  // (the cuts unioned first, in batches: polygon-clipping is far more robust on one clean operand than on many
  // overlapping ribbons, and a failure would fall back to a coarse 5 cm grid)
  if (cuts.length) m = differenceS(m, cuts.length > 1 ? unionMany(cuts.map((ph) => [ph] as MultiPoly), 16, true) : cuts);
  if (water.length) m = differenceS(m, ...water.map((ph) => [ph] as MultiPoly));
  // (spikes left where path ribbons meet or graze the outline are cut off at 1.5 m width)
  const out = pieces(m, 40).map((p) => (goodShape(p, 2.5) ? p : orientPos(truncateAcute(p, (14 * Math.PI) / 180, 1.5)))).filter((p) => p.length >= 3 && goodShape(p, 2.5));
  // (a boolean that fell back to its coarse grid may leave a block a few cm out of its quarter: clipped back)
  return out.flatMap((p) => (p.every((q) => pointInRing(quarter, q) || distToRing(quarter, q) < 0.002) ? [p] : pieces(intersectionS(p, quarter), 40).filter((x) => goodShape(x, 2.5))));
}

/** Street ribbons of open paths (closed rings are given as annuli by their layouts). */
/** Street ribbons of open paths, one polygon per path (not unioned: booleans take them as a list). */
export function pathRibbons(list: UrbanStreet[]): MultiPoly {
  const rb: MultiPoly = [];
  for (const s of list) {
    const r = ribbon(s.path, s.widths ?? s.width);
    if (r.length >= 3) rb.push({ outer: r, holes: [] });
  }
  return rb;
}

/**
 * Exact cut of a block by cells (convex or not): block ∩ cell for every cell; pieces too small or badly shaped
 * are merged into the neighbouring piece they share most boundary with (the block stays exactly covered).
 */
export function cutByCells(block: Polygon, cells: { poly: Polygon; tag: number }[]): { poly: Polygon; tag: number }[] {
  const bb = bboxOf(block);
  let out: { poly: Polygon; tag: number }[] = [];
  for (const c of cells) {
    const cb = bboxOf(c.poly);
    if (cb.x0 > bb.x1 || cb.x1 < bb.x0 || cb.y0 > bb.y1 || cb.y1 < bb.y0) continue;
    // convex cells: the block clipped by the cell's half-planes (exact and cheap); a concave cell takes a boolean
    if (isConvex(c.poly, 1e-9)) {
      const r = clipConvexCell(block, c.poly);
      if (r.length >= 3 && area(r) > 0.05) for (const p of pieces(resolveRing(r), 0.05)) out.push({ poly: p, tag: c.tag });
    } else for (const p of pieces(intersectionS(block, c.poly), 0.05)) out.push({ poly: p, tag: c.tag });
  }
  out = mergeSmall(out);
  return out;
}

/** cutByCells, then whatever of the block no cell covers as pieces tagged -1 (the block stays exactly covered). */
export function cutExact(block: Polygon, cells: { poly: Polygon; tag: number }[]): { poly: Polygon; tag: number }[] {
  let parts = cutByCells(block, cells);
  const A = area(block), S = parts.reduce((s, p) => s + area(p.poly), 0);
  // (the missing area is only slivers when the cells cover the block: the boolean for them is costly with many
  // cells, and the partition tolerance is 0.5 %)
  if (S < A * 0.997) {
    const rest = pieces(parts.length ? differenceS([{ outer: block, holes: [] }], ...parts.map((p): MultiPoly => [{ outer: p.poly, holes: [] }])) : [{ outer: block, holes: [] }], 0.5);
    parts = mergeSmall([...parts, ...rest.map((poly) => ({ poly, tag: -1 }))]);
  }
  return parts;
}

/** Sutherland–Hodgman: a polygon (any) clipped by a convex polygon (CCW). */
function clipConvexCell(subject: Polygon, clip: Polygon): Polygon {
  let poly = subject;
  const C = orientPos(clip);
  for (let i = 0; i < C.length && poly.length; i++) {
    const a = C[i], b = C[(i + 1) % C.length];
    // inward normal of a CCW ring: left of a→b
    poly = clipHalfPlaneConvex(poly, a, { x: -(b.y - a.y), y: b.x - a.x });
  }
  // (on the 1 mm grid of the snapped booleans: neighbouring pieces and later unions share their vertices exactly)
  return poly.map((q) => ({ x: Math.round(q.x * 1000) / 1000, y: Math.round(q.y * 1000) / 1000 }));
}

/** A clipped ring may hold zero-width bridges (several parts of a concave block): resolved into its parts. */
function resolveRing(r: Polygon): MultiPoly {
  const c = orientPos(cleanRing(r, 0.005, 0.01, Infinity, false));
  if (c.length < 3) return [];
  return isSimple(c) ? [{ outer: c, holes: [] }] : unionS([{ outer: c, holes: [] }]);
}

/** Segment grid of a ring (cached per ring: a merge tests the same large pieces again and again). */
const SEG_GRID = new WeakMap<Polygon, GridIndex<number>>();
function segGrid(b: Polygon): GridIndex<number> {
  let g = SEG_GRID.get(b);
  if (!g) {
    g = new GridIndex<number>(6);
    for (let i = 0; i < b.length; i++) g.insertSeg(b[i], b[(i + 1) % b.length], i);
    SEG_GRID.set(b, g);
  }
  return g;
}

/** Length of the boundary of `a` lying on `b`'s boundary (within 2 cm). */
export function sharedLen(a: Polygon, b: Polygon): number {
  const g = segGrid(b);
  const bb = bboxOf(b);
  let L = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = a[(i + 1) % a.length];
    if (Math.max(p.x, q.x) < bb.x0 - 0.05 || Math.min(p.x, q.x) > bb.x1 + 0.05 || Math.max(p.y, q.y) < bb.y0 - 0.05 || Math.min(p.y, q.y) > bb.y1 + 0.05) continue;
    const l = dist(p, q);
    const n = Math.max(1, Math.ceil(l / 0.5));
    for (let j = 0; j < n; j++) {
      const t = (j + 0.5) / n;
      const m = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
      let on = false;
      for (const k of g.queryPt(m, 0.05)) if (distToSeg(m, b[k], b[(k + 1) % b.length]) < 0.02) { on = true; break; }
      if (on) L += l / n;
    }
  }
  return L;
}

/**
 * Merges pieces that are too small or badly shaped into the neighbour they share most boundary with. A piece that
 * cannot be merged cleanly is kept as it is (the partition stays exact; a rare acute corner is tolerated).
 */
export function mergeSmall<T extends { poly: Polygon }>(list: T[], minA = 14): T[] {
  const out = list.slice();
  // (badness cached per piece: the shape test runs a pole of inaccessibility)
  const badMap = new Map<T, boolean>();
  const bad = (x: T): boolean => { let b = badMap.get(x); if (b === undefined) { b = area(x.poly) < minA || !goodShape(x.poly, 2.2); badMap.set(x, b); } return b; };
  const kept = new Set<T>();
  for (let guard = 0; guard < 300; guard++) {
    const i = out.findIndex((x) => !kept.has(x) && bad(x));
    if (i < 0) break;
    const me = out[i];
    const mb = bboxOf(me.poly);
    let bj = -1, bl = 0.05;
    out.forEach((o, j) => {
      if (j === i) return;
      const ob = bboxOf(o.poly);
      if (ob.x0 > mb.x1 + 0.1 || ob.x1 < mb.x0 - 0.1 || ob.y0 > mb.y1 + 0.1 || ob.y1 < mb.y0 - 0.1) return;
      const l = sharedLen(me.poly, o.poly);
      if (l > bl) { bl = l; bj = j; }
    });
    const u = bj >= 0 ? unionS(out[bj].poly, me.poly) : [];
    if (bj >= 0 && u.length === 1 && !u[0].holes.length) {
      const merged = { ...out[bj], poly: orientPos(cleanRing(u[0].outer, 0.01, 0.01, Infinity, false)) };
      out[bj] = merged;
      out.splice(i, 1);
    } else if (area(me.poly) < 1) out.splice(i, 1);
    else kept.add(me);
  }
  return out;
}

/** Street-edge index replicating the invariant checker's frontage rule (URBAN_GEOMETRY §6.3). */
export class FrontIndex {
  private idx = new GridIndex<{ s: UrbanStreet; i: number }>(30);
  constructor(streets: UrbanStreet[]) {
    for (const s of streets) for (let i = 1; i < s.path.length; i++) this.idx.insertSeg(s.path[i - 1], s.path[i], { s, i });
  }
  on(p: Vec2): boolean {
    for (const { s, i } of this.idx.queryPt(p, 12)) {
      const hw = ((s.widths?.[i - 1] ?? s.width) + (s.widths?.[i] ?? s.width)) / 4;
      const d = distToSeg(p, s.path[i - 1], s.path[i]);
      if (Math.abs(d - hw) < Math.max(0.5, 0.25 * hw) || d < hw) return true;
    }
    return false;
  }
  /** Frontage length of a polygon (sampled every 0.5 m) and the midpoint of its longest frontage run. */
  frontage(P: Polygon): { len: number; mid: Vec2 | null } {
    let len = 0, best = 0, bestMid: Vec2 | null = null;
    for (let k = 0; k < P.length; k++) {
      const a = P[k], b = P[(k + 1) % P.length];
      const L = dist(a, b);
      const n = Math.max(1, Math.ceil(L / 0.5));
      let run = 0;
      for (let j = 0; j < n; j++) {
        const t = (j + 0.5) / n;
        if (this.on({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) { len += L / n; run += L / n; }
      }
      if (run > best) { best = run; bestMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
    }
    return { len, mid: bestMid };
  }
}

// ---------------------------------------------------------------- footprints

/** Oriented rectangle centred at c (length L along `ang`, width W). */
export function rect(c: Vec2, ang: number, L: number, W: number): Polygon {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const pts = [[-L / 2, -W / 2], [L / 2, -W / 2], [L / 2, W / 2], [-L / 2, W / 2]].map(([u, v]) => ({ x: c.x + u * ca - v * sa, y: c.y + u * sa + v * ca }));
  return orientPos(pts);
}

/** Round hut (polygon of `sides`). */
export function hut(c: Vec2, r: number, sides = 14, a0 = 0): Polygon {
  return orientPos(Array.from({ length: sides }, (_, i) => at(c, a0 + ((i + 0.5) / sides) * 2 * Math.PI, r)));
}

/** Long house with rounded (apsidal) ends: length L along `ang`, width W. */
export function apsidal(c: Vec2, ang: number, L: number, W: number, k = 5): Polygon {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const r = W / 2, h = Math.max(0, L / 2 - r);
  const pts: Vec2[] = [];
  for (let i = 0; i <= k; i++) { const t = -Math.PI / 2 + (i / k) * Math.PI; pts.push({ x: h + Math.cos(t) * r, y: Math.sin(t) * r }); }
  for (let i = 0; i <= k; i++) { const t = Math.PI / 2 + (i / k) * Math.PI; pts.push({ x: -h + Math.cos(t) * r, y: Math.sin(t) * r }); }
  return orientPos(pts.map((q) => ({ x: c.x + q.x * ca - q.y * sa, y: c.y + q.x * sa + q.y * ca })));
}

/** Bow-sided (boat-shaped) long house, Viking type: convex long walls, straight gables. */
export function bowSided(c: Vec2, ang: number, L: number, W: number, bow = 0.22): Polygon {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const end = W * (1 - bow) / 2, mid = W / 2;
  const k = 6;
  const side: Vec2[] = [];
  for (let i = 0; i <= k; i++) {
    const u = -L / 2 + (i / k) * L;
    const t = u / (L / 2);
    side.push({ x: u, y: end + (mid - end) * (1 - t * t) });
  }
  const pts = side.concat(side.slice().reverse().map((q) => ({ x: q.x, y: -q.y })));
  return orientPos(pts.map((q) => ({ x: c.x + q.x * ca - q.y * sa, y: c.y + q.x * sa + q.y * ca })));
}

/** Inside the lot with a margin, and clear of the other footprints by `gap`. */
export function fits(lot: Polygon, fp: Polygon, others: Polygon[], margin: number, gap: number): boolean {
  if (!polyInside(lot, fp)) return false;
  for (const q of fp) if (distToRing(lot, q) < margin) return false;
  for (const o of others) {
    const ob = bboxOf(o), fb = bboxOf(fp);
    if (fb.x0 > ob.x1 + gap || fb.x1 < ob.x0 - gap || fb.y0 > ob.y1 + gap || fb.y1 < ob.y0 - gap) continue;
    for (const q of fp) if (pointInRing(o, q) || distToRing(o, q) < gap) return false;
    for (const q of o) if (pointInRing(fp, q)) return false;
    // (crossing shapes, a + or a T, have no vertex inside the other)
    for (let i = 0; i < fp.length; i++) if (segCrossesRing(o, fp[i], fp[(i + 1) % fp.length])) return false;
  }
  return true;
}

/**
 * Fits a footprint family inside a lot: tries the shape built at scale 1 at candidate centres (inscribed centre
 * first, then a grid), shrinking down to `minScale`. Returns the first footprint that fits.
 */
const FIT_CANDS = new WeakMap<Polygon, Map<number, Vec2[]>>();
export function fitIn(lot: Polygon, build: (c: Vec2, s: number) => Polygon, others: Polygon[], o: { margin?: number; gap?: number; minScale?: number; cands?: Vec2[]; step?: number } = {}): Polygon | null {
  const margin = o.margin ?? 1, gap = o.gap ?? 1.5, minS = o.minScale ?? 0.7;
  let cands: Vec2[];
  if (o.cands) cands = o.cands.slice();
  else {
    // the default candidates depend on the lot and the step only (a yard is filled by many calls): kept per lot
    const st = o.step ?? 3;
    let m = FIT_CANDS.get(lot);
    if (!m) { m = new Map(); FIT_CANDS.set(lot, m); }
    let cc = m.get(st);
    if (!cc) {
      const ins = inscribed(lot, [], 0.5);
      cc = [ins.c];
      const bb = bboxOf(lot);
      const grid: Vec2[] = [];
      for (let y = bb.y0 + st / 2; y < bb.y1; y += st) for (let x = bb.x0 + st / 2; x < bb.x1; x += st) {
        const p = { x, y };
        if (pointInRing(lot, p)) grid.push(p);
      }
      // deepest points first (most room); the depths are computed once (same comparisons as computing them in
      // the comparator)
      const depth = new Map<Vec2, number>();
      for (const p of grid) depth.set(p, distToRing(lot, p));
      grid.sort((a, b) => depth.get(b)! - depth.get(a)!);
      cc.push(...grid.slice(0, 60));
      m.set(st, cc);
    }
    cands = cc;
  }
  for (let s = 1; s >= minS - 1e-9; s -= 0.1) {
    for (const c of cands) {
      const fp = build(c, s);
      if (fp.length >= 3 && fits(lot, fp, others, margin, gap)) return fp;
    }
  }
  return null;
}

/** Points along a ring at arclength spacing (for fences and hachures). */
export function ringSamples(ring: Polygon, step: number): { p: Vec2; t: Vec2 }[] {
  const pts = ring.concat([ring[0]]);
  const out: { p: Vec2; t: Vec2 }[] = [];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], L = dist(a, b);
    if (L < 1e-9) continue;
    const t = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
    let s = carry;
    while (s < L) { out.push({ p: { x: a.x + t.x * s, y: a.y + t.y * s }, t }); s += step; }
    carry = s - L;
  }
  return out;
}

/** A closed ring opened at gates: the polyline pieces between the openings (gate centre ± half width). */
export function openRing(ring: Polygon, gates: { p: Vec2; width: number }[]): Polyline[] {
  if (!gates.length) return [ring.concat([ring[0]])];
  const pts = ring.concat([ring[0]]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const L = cum[cum.length - 1];
  const sOf = (g: Vec2): number => {
    let bs = 0, bd = Infinity;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((g.x - a.x) * dx + (g.y - a.y) * dy) / l2));
      const d = Math.hypot(g.x - a.x - t * dx, g.y - a.y - t * dy);
      if (d < bd) { bd = d; bs = cum[i - 1] + t * Math.sqrt(l2); }
    }
    return bs;
  };
  const pAt = (s: number): Vec2 => {
    s = ((s % L) + L) % L;
    let i = 1;
    while (i < pts.length - 1 && cum[i] < s) i++;
    const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
  };
  const gs = gates.map((g) => ({ s: sOf(g.p), h: g.width / 2 })).sort((a, b) => a.s - b.s);
  const out: Polyline[] = [];
  for (let k = 0; k < gs.length; k++) {
    const a = gs[k].s + gs[k].h;
    let b = gs[(k + 1) % gs.length].s - gs[(k + 1) % gs.length].h;
    if (k + 1 >= gs.length) b += L;
    if (b - a < 2) continue;
    const mid: { s: number; p: Vec2 }[] = [];
    for (let i = 0; i < pts.length - 1; i++) for (const off of [0, L]) { const s = cum[i] + off; if (s > a + 0.05 && s < b - 0.05) mid.push({ s, p: pts[i] }); }
    mid.sort((x, y) => x.s - y.s);
    out.push([pAt(a), ...mid.map((x) => x.p), pAt(b)]);
  }
  return out;
}

/** Hachures across a bank or rampart line: ticks of length `len` toward `side` (+1 left, −1 right of the ring). */
export function hachures(ring: Polygon, step: number, len: number, side: 1 | -1, skip?: (p: Vec2) => boolean): UrbanLine[] {
  const out: UrbanLine[] = [];
  for (const { p, t } of ringSamples(ring, step)) {
    if (skip && skip(p)) continue;
    const n = { x: -t.y * side, y: t.x * side };
    out.push({ kind: 'hachure', path: [p, { x: p.x + n.x * len, y: p.y + n.y * len }], width: 0.35 });
  }
  return out;
}

/** Points where the regional roads (ending at the centre) cross a ring, with the road's inward direction. */
export function roadCrossings(ring: Polygon, roads: Polyline[]): { p: Vec2; dir: Vec2; road: number }[] {
  const out: { p: Vec2; dir: Vec2; road: number }[] = [];
  roads.forEach((pl, ri) => {
    // walk from the end (inside) back until the ring is crossed
    for (let i = pl.length - 1; i > 0; i--) {
      const a = pl[i], b = pl[i - 1];
      if (pointInRing(ring, a) && !pointInRing(ring, b)) {
        // bisection for the crossing
        let lo = 0, hi = 1;
        for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; const q = { x: a.x + (b.x - a.x) * m, y: a.y + (b.y - a.y) * m }; if (pointInRing(ring, q)) lo = m; else hi = m; }
        const p = { x: a.x + (b.x - a.x) * lo, y: a.y + (b.y - a.y) * lo };
        const L = dist(a, b) || 1;
        out.push({ p, dir: { x: (a.x - b.x) / L, y: (a.y - b.y) / L }, road: ri });
        break;
      }
    }
  });
  return out;
}

/**
 * Directions (radians, from c) of the regional roads that end at the site centre, taken where each road is at
 * distance `reach` from c (so a street laid along it follows the road); near-duplicates dropped. Empty when c is
 * not the site centre (a camp moved to dry ground, a satellite).
 */
export function roadDirections(cc: { ctx: { center: Vec2 }; roads: Polyline[] }, c: Vec2, reach: number): number[] {
  if (dist(c, cc.ctx.center) > 15) return [];
  const out: number[] = [];
  for (const pl of cc.roads) {
    if (dist(pl[pl.length - 1], cc.ctx.center) > 15) continue;
    let q = pl[0];
    for (let i = pl.length - 1; i >= 0; i--) if (dist(pl[i], c) >= reach) { q = pl[i]; break; }
    const a = Math.atan2(q.y - c.y, q.x - c.x);
    if (out.every((b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) > 0.7)) out.push(a);
  }
  return out;
}

/** Arclength frame of a polyline: points and left normals (interpolated between vertices) at any arclength, the
 * line extended straight beyond both ends. */
export class Curv {
  readonly pts: Vec2[];
  readonly cum: number[];
  readonly L: number;
  private vn: Vec2[];
  constructor(pl: Polyline) {
    const pts: Vec2[] = [pl[0]];
    for (let i = 1; i < pl.length; i++) if (dist(pl[i], pts[pts.length - 1]) > 0.5) pts.push(pl[i]);
    if (pts.length < 2) pts.push({ x: pts[0].x + 1, y: pts[0].y });
    this.pts = pts;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + dist(pts[i - 1], pts[i]));
    this.L = this.cum[this.cum.length - 1];
    const sn: Vec2[] = [];
    for (let i = 1; i < pts.length; i++) { const l = dist(pts[i - 1], pts[i]); sn.push({ x: -(pts[i].y - pts[i - 1].y) / l, y: (pts[i].x - pts[i - 1].x) / l }); }
    this.vn = pts.map((_, i) => {
      const a = sn[Math.max(0, i - 1)], b = sn[Math.min(sn.length - 1, i)];
      const x = a.x + b.x, y = a.y + b.y, l = Math.hypot(x, y) || 1;
      return { x: x / l, y: y / l };
    });
  }
  private loc(s: number): { i: number; t: number } {
    if (s <= 0) return { i: 1, t: s / (this.cum[1] || 1) };
    if (s >= this.L) { const n = this.pts.length - 1; return { i: n, t: 1 + (s - this.L) / ((this.cum[n] - this.cum[n - 1]) || 1) }; }
    let i = 1;
    while (i < this.pts.length - 1 && this.cum[i] < s) i++;
    return { i, t: (s - this.cum[i - 1]) / ((this.cum[i] - this.cum[i - 1]) || 1) };
  }
  at(s: number): Vec2 {
    const { i, t } = this.loc(s);
    const a = this.pts[i - 1], b = this.pts[i];
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  normal(s: number): Vec2 {
    const { i, t } = this.loc(s);
    const tt = Math.max(0, Math.min(1, t));
    const a = this.vn[i - 1], b = this.vn[i];
    const x = a.x + (b.x - a.x) * tt, y = a.y + (b.y - a.y) * tt, l = Math.hypot(x, y) || 1;
    return { x: x / l, y: y / l };
  }
  /** The polyline between arclengths s0 and s1. */
  slice(s0: number, s1: number): Polyline {
    const out: Polyline = [this.at(s0)];
    for (let i = 0; i < this.pts.length; i++) if (this.cum[i] > s0 + 0.5 && this.cum[i] < s1 - 0.5) out.push(this.pts[i]);
    out.push(this.at(s1));
    return out;
  }
}

/** The regional roads passing within `near` m of c, as polylines from c outward (both ways when the road goes on
 * beyond c), each up to `maxLen` long; near-duplicate directions dropped. */
export function roadPolylines(cc: { ctx: { center: Vec2 }; roads: Polyline[] }, c: Vec2, maxLen: number, near = 30): Polyline[] {
  const out: Polyline[] = [];
  const dirs: number[] = [];
  const add = (r: Polyline): void => {
    if (r.length < 2) return;
    let q = r[r.length - 1];
    for (const p of r) if (dist(p, c) > Math.min(60, maxLen / 2)) { q = p; break; }
    if (dist(q, c) < 25) return;
    const a = Math.atan2(q.y - c.y, q.x - c.x);
    if (dirs.some((b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 0.7)) return;
    dirs.push(a);
    out.push(r);
  };
  for (const pl of cc.roads) {
    let bi = -1, bd = near;
    pl.forEach((p, i) => { const d = dist(p, c); if (d < bd) { bd = d; bi = i; } });
    if (bi < 0) continue;
    for (const step of [-1, 1]) {
      const r: Polyline = [c];
      let L = 0;
      for (let i = bi + step; i >= 0 && i < pl.length && L < maxLen; i += step) { if (dist(pl[i], r[r.length - 1]) < 0.5) continue; L += dist(pl[i], r[r.length - 1]); r.push(pl[i]); }
      add(r);
    }
  }
  return out;
}

/** A gently wandering polyline from p, heading a, of length L (steps of `step`, turning up to `turn` per step). */
export function wanderLine(p: Vec2, a: number, L: number, r: { range: (a: number, b: number) => number }, step = 18, turn = 0.07): Polyline {
  const out: Polyline = [p];
  let h = a, q = p;
  for (let s = 0; s < L; s += step) {
    h += r.range(-turn, turn);
    q = { x: q.x + Math.cos(h) * Math.min(step, L - s), y: q.y + Math.sin(h) * Math.min(step, L - s) };
    out.push(q);
  }
  return out;
}

/** Block info of a camp block. */
export const blockInfo = (b: CampBlock, quarter: number, culture: string, morphology: string): UrbanBlockInfo => ({
  quarter, phase: 1, zone: 'village', kind: b.kind, compound: b.compound, culture, morphology,
});

/** Parcel of a camp (global indices are set by the assembler). */
export const parcelOf = (p: CampParcel, block: number): UrbanParcel => ({ poly: p.poly, use: p.use, block, zone: 'village' });

export { mpArea };
