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
import { MultiPoly, differenceS, intersectionS, intersection, unionS, mpArea } from '../../geo/bool';
import { area, orientPos, pointInRing, distToRing, distToSeg, inscribed, cleanRing, bboxOf, interiorAngle } from '../../geo/poly';
import { ribbon } from '../../geo/offset';
import { polyInside } from '../../geo/split';
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

/** Cuts a polygon with holes into simple polygons (a cut line through each hole). */
export function splitHoles(ph: PolyH, depth = 0): Polygon[] {
  if (!ph.holes.length || depth > 6) return [ph.outer];
  const h = ph.holes[0];
  const hc = polygonCentroid(h);
  const bb = bboxOf(ph.outer);
  const big = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) * 3 + 10;
  // a vertical cut through the hole: the two half-planes as big rectangles
  const left: Polygon = [{ x: hc.x - big, y: hc.y - big }, { x: hc.x, y: hc.y - big }, { x: hc.x, y: hc.y + big }, { x: hc.x - big, y: hc.y + big }];
  const right: Polygon = [{ x: hc.x, y: hc.y - big }, { x: hc.x + big, y: hc.y - big }, { x: hc.x + big, y: hc.y + big }, { x: hc.x, y: hc.y + big }];
  const out: Polygon[] = [];
  for (const half of [left, right]) for (const piece of intersectionS([ph], half)) out.push(...splitHoles(piece, depth + 1));
  return out;
}

/** A polygon is a valid partition piece: no vertex angle < 13°, width ≥ 2.2 m. */
export function goodShape(p: Polygon, minW = 2.2): boolean {
  if (p.length < 3) return false;
  for (let i = 0; i < p.length; i++) if (interiorAngle(p, i) < (13 * Math.PI) / 180) return false;
  return inscribed(p, [], 0.1).r * 2 >= minW;
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
  if (cuts.length) m = differenceS(m, cuts);
  if (water.length) m = differenceS(m, water);
  // (spikes left where path ribbons meet or graze the outline are cut off at 1.5 m width)
  return pieces(m, 20).map((p) => (goodShape(p, 2.5) ? p : orientPos(truncateAcute(p, (14 * Math.PI) / 180, 1.5)))).filter((p) => p.length >= 3 && goodShape(p, 2.5));
}

/** Street ribbons of open paths (closed rings are given as annuli by their layouts). */
export function pathRibbons(list: UrbanStreet[]): MultiPoly {
  const rb: MultiPoly = [];
  for (const s of list) {
    const r = ribbon(s.path, s.widths ?? s.width);
    if (r.length >= 3) rb.push({ outer: r, holes: [] });
  }
  return rb.length ? unionS(rb) : [];
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
    for (const p of pieces(intersection(block, c.poly), 0.05)) out.push({ poly: p, tag: c.tag });
  }
  out = mergeSmall(out);
  return out;
}

/** Length of the boundary of `a` lying on `b`'s boundary (within 2 cm). */
export function sharedLen(a: Polygon, b: Polygon): number {
  let L = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = a[(i + 1) % a.length];
    const l = dist(p, q);
    const n = Math.max(1, Math.ceil(l / 0.5));
    for (let j = 0; j < n; j++) {
      const t = (j + 0.5) / n;
      if (distToRing(b, { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }) < 0.02) L += l / n;
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
  const kept = new Set<T>();
  for (let guard = 0; guard < 300; guard++) {
    const i = out.findIndex((x) => !kept.has(x) && (area(x.poly) < minA || !goodShape(x.poly, 2.2)));
    if (i < 0) break;
    const me = out[i];
    let bj = -1, bl = 0.05;
    out.forEach((o, j) => { if (j !== i) { const l = sharedLen(me.poly, o.poly); if (l > bl) { bl = l; bj = j; } } });
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
  }
  return true;
}

/**
 * Fits a footprint family inside a lot: tries the shape built at scale 1 at candidate centres (inscribed centre
 * first, then a grid), shrinking down to `minScale`. Returns the first footprint that fits.
 */
export function fitIn(lot: Polygon, build: (c: Vec2, s: number) => Polygon, others: Polygon[], o: { margin?: number; gap?: number; minScale?: number; cands?: Vec2[]; step?: number } = {}): Polygon | null {
  const margin = o.margin ?? 1, gap = o.gap ?? 1.5, minS = o.minScale ?? 0.7;
  const ins = inscribed(lot, [], 0.5);
  const cands: Vec2[] = o.cands ? o.cands.slice() : [ins.c];
  if (!o.cands) {
    const bb = bboxOf(lot), st = o.step ?? 3;
    const grid: Vec2[] = [];
    for (let y = bb.y0 + st / 2; y < bb.y1; y += st) for (let x = bb.x0 + st / 2; x < bb.x1; x += st) {
      const p = { x, y };
      if (pointInRing(lot, p)) grid.push(p);
    }
    // deepest points first (most room)
    grid.sort((a, b) => distToRing(lot, b) - distToRing(lot, a));
    cands.push(...grid.slice(0, 60));
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

/** Block info of a camp block. */
export const blockInfo = (b: CampBlock, quarter: number, culture: string, morphology: string): UrbanBlockInfo => ({
  quarter, phase: 1, zone: 'village', kind: b.kind, compound: b.compound, culture, morphology,
});

/** Parcel of a camp (global indices are set by the assembler). */
export const parcelOf = (p: CampParcel, block: number): UrbanParcel => ({ poly: p.poly, use: p.use, block, zone: 'village' });

export { mpArea };
