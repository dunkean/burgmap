/**
 * Boolean operations (polygon-clipping) on polygons with holes, with 1 cm snapping and ring cleanup of
 * every result, as required by URBAN_GEOMETRY.md §0.
 */
import polygonClipping from 'polygon-clipping';
import type { Vec2, Polygon } from '../core/geom';
import { cleanRing, orientPos, area } from './poly';

export interface PolyH { outer: Polygon; holes: Polygon[] }
export type MultiPoly = PolyH[];

type Ring = [number, number][];
type Geom = Ring[][];

const toRing = (p: Polygon): Ring => {
  const r: Ring = p.map((q) => [q.x, q.y] as [number, number]);
  if (r.length) r.push([p[0].x, p[0].y]);
  return r;
};
const fromRing = (r: Ring): Polygon => {
  const out: Vec2[] = r.map(([x, y]) => ({ x, y }));
  if (out.length > 1 && out[0].x === out[out.length - 1].x && out[0].y === out[out.length - 1].y) out.pop();
  return out;
};

export const toGeom = (m: MultiPoly | PolyH | Polygon): Geom => {
  if (Array.isArray(m) && (m.length === 0 || 'x' in (m[0] as object))) {
    const p = m as Polygon;
    return p.length >= 3 ? [[toRing(p)]] : [];
  }
  const list = Array.isArray(m) ? (m as MultiPoly) : [m as PolyH];
  return list.filter((ph) => ph.outer.length >= 3).map((ph) => [toRing(ph.outer), ...ph.holes.filter((h) => h.length >= 3).map(toRing)]);
};

/** Converts a polygon-clipping result into cleaned, positively oriented PolyH list (holes negative → stored positive). */
export function fromGeom(g: Geom, minArea = 0.01, snapped = false, preserveEdges = false): MultiPoly {
  const out: MultiPoly = [];
  const me = 0.005;
  for (const pg of g) {
    const outer = preserveEdges ? fromRing(pg[0] as Ring) : cleanRing(fromRing(pg[0] as Ring), me, 0.5, 0.002, false);
    if (outer.length < 3 || area(outer) < minArea) continue;
    const holes: Polygon[] = [];
    for (let i = 1; i < pg.length; i++) {
      const h = preserveEdges ? fromRing(pg[i] as Ring) : cleanRing(fromRing(pg[i] as Ring), me, 0.5, 0.002, false);
      // Removing land slivers is conservative; filling even a tiny water hole is not.
      if (h.length >= 3 && area(h) >= (preserveEdges ? Number.MIN_VALUE : minArea)) holes.push(orientPos(h));
    }
    out.push({ outer: orientPos(outer), holes });
  }
  return out;
}

type Operand = MultiPoly | PolyH | Polygon;
/** Floating-point area noise floor (m²), separate from the millimetre coordinate grid. */
export const BOOL_AREA_EPS = 1e-6;

/** Debug hook: called with the inputs of boolean operations slower than 300 ms. */
export let SLOW_LOG: ((op: string, snapped: boolean, a: unknown, b: unknown, ms: number) => void) | null = null;
export const setSlowLog = (f: typeof SLOW_LOG) => { SLOW_LOG = f; };

/** Grid of the snapped booleans (1 mm: robust, while a snapped T-vertex moves a shared edge by < 0.7 mm). */
export const BOOL_GRID = 1000;
const snapGeom = (g: Geom): Geom => g.map((pg) => pg.map((r) => r.map(([x, y]) => [Math.round(x * BOOL_GRID) / BOOL_GRID, Math.round(y * BOOL_GRID) / BOOL_GRID] as [number, number])));

type Box = { x0: number; y0: number; x1: number; y1: number };
const ringBox = (r: Ring): Box => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { x0, y0, x1, y1 };
};
const geomBox = (g: Geom): Box => {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const pg of g) { const r = ringBox(pg[0]); b.x0 = Math.min(b.x0, r.x0); b.y0 = Math.min(b.y0, r.y0); b.x1 = Math.max(b.x1, r.x1); b.y1 = Math.max(b.y1, r.y1); }
  return b;
};
/** Boxes overlap or touch (a margin keeps the test conservative). */
const boxMeets = (a: Box, b: Box): boolean => !(a.x0 > b.x1 + 1e-6 || a.x1 < b.x0 - 1e-6 || a.y0 > b.y1 + 1e-6 || a.y1 < b.y0 - 1e-6);

/** Sutherland–Hodgman clip of a closed ring ([first] repeated last) to a box; open vertex list out. */
function clipRingBox(r: Ring, b: Box): [number, number][] {
  let pts: [number, number][] = r.slice(0, -1);
  const planes: [(p: [number, number]) => number][] = [[(p) => p[0] - b.x0], [(p) => b.x1 - p[0]], [(p) => p[1] - b.y0], [(p) => b.y1 - p[1]]];
  for (const [side] of planes) {
    if (!pts.length) break;
    const out: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      const P = pts[i], Q = pts[(i + 1) % pts.length];
      const sp = side(P), sq = side(Q);
      if (sp >= 0) out.push(P);
      if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]); }
    }
    pts = out;
  }
  const dedup: [number, number][] = [];
  for (const p of pts) { const l = dedup[dedup.length - 1]; if (!l || l[0] !== p[0] || l[1] !== p[1]) dedup.push(p); }
  while (dedup.length > 1 && dedup[0][0] === dedup[dedup.length - 1][0] && dedup[0][1] === dedup[dedup.length - 1][1]) dedup.pop();
  return dedup;
}

const TRIM_MIN = 96, TRIM_MARGIN = 60;
/**
 * A clip polygon with many vertices is replaced by its rings clipped to the subject's box grown by TRIM_MARGIN,
 * when that is exact for the boolean: every edge reaching within 1 m of the subject's box lies wholly inside the
 * clip box (so the edges that can meet the subject keep their original endpoints), and the clipped rings cover the
 * same points inside the box. Edges changed or added by the clip stay ≥ ~59 m from the subject. Null = polygon
 * outside the box (it cannot touch the result).
 */
function trimPolygon(pg: Ring[], sb: Box): Ring[] | null {
  let nv = 0;
  for (const r of pg) nv += r.length;
  if (nv < TRIM_MIN) return pg;
  const cb: Box = { x0: sb.x0 - TRIM_MARGIN, y0: sb.y0 - TRIM_MARGIN, x1: sb.x1 + TRIM_MARGIN, y1: sb.y1 + TRIM_MARGIN };
  const nb: Box = { x0: sb.x0 - 1, y0: sb.y0 - 1, x1: sb.x1 + 1, y1: sb.y1 + 1 };
  const ob = ringBox(pg[0]);
  // (only worth it when the polygon reaches well beyond the box)
  if (ob.x0 >= cb.x0 && ob.y0 >= cb.y0 && ob.x1 <= cb.x1 && ob.y1 <= cb.y1) return pg;
  for (const r of pg) {
    for (let i = 0; i + 1 < r.length; i++) {
      const [ax, ay] = r[i], [bx, by] = r[i + 1];
      const sx0 = Math.min(ax, bx), sx1 = Math.max(ax, bx), sy0 = Math.min(ay, by), sy1 = Math.max(ay, by);
      if (sx0 > nb.x1 || sx1 < nb.x0 || sy0 > nb.y1 || sy1 < nb.y0) continue;
      if (sx0 < cb.x0 || sx1 > cb.x1 || sy0 < cb.y0 || sy1 > cb.y1) return pg;
    }
  }
  const out: Ring[] = [];
  for (let k = 0; k < pg.length; k++) {
    const c = clipRingBox(pg[k], cb);
    if (c.length < 3) { if (k === 0) return null; continue; }
    out.push([...c, [c[0][0], c[0][1]]]);
  }
  return out;
}

function run(op: 'union' | 'intersection' | 'difference', a: Operand, rest: Operand[], snapped = false, failClosed = false, onFailure?: () => void, retryCoarse = true, preserveEdges = false, areaFloor = BOOL_AREA_EPS): MultiPoly {
  const result = (g: Geom) => fromGeom(g, preserveEdges ? areaFloor : 0.01, snapped, preserveEdges);
  let ga = toGeom(a);
  let gr = rest.map(toGeom).filter((g) => g.length);
  if (snapped) { ga = snapGeom(ga); gr = gr.map(snapGeom); }
  if (!ga.length) return op === 'union' && gr.length ? run('union', rest[0], rest.slice(1), snapped) : [];
  if (!gr.length) return op === 'intersection' ? [] : result(ga);
  if (op !== 'union') {
    // polygons of the clip operands whose box misses the subject's box cannot touch the result (each operand keeps
    // its order; an operand left empty is dropped, as the engine would): huge operands such as the town's water
    // shrink to the few pieces near a lot. (The engine still runs when nothing is left to subtract: it normalizes
    // the subject's rings.)
    const sb = geomBox(ga);
    gr = gr.map((g) => (g.length > 1 ? g.filter((pg) => boxMeets(ringBox(pg[0]), sb)) : g));
    if (op === 'difference') gr = gr.filter((g) => g.length);
    else if (gr.some((g) => !g.length)) return [];
    // long clip rings far larger than the subject (river ribbons, coastlines) are cut down to a box around it
    gr = gr.map((g) => g.map((pg) => trimPolygon(pg, sb)).filter((pg): pg is Ring[] => pg !== null));
    if (op === 'difference') gr = gr.filter((g) => g.length);
    else if (gr.some((g) => !g.length)) return [];
  }
  const f = polygonClipping[op] as (g: Geom, ...r: Geom[]) => Geom;
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  try {
    const res = result(f(ga, ...gr));
    if (SLOW_LOG && performance.now() - t0 > 300) SLOW_LOG(op, snapped, ga, gr, performance.now() - t0);
    return res;
  } catch {
    if (SLOW_LOG) SLOW_LOG(op + '-THROW', snapped, ga, gr, performance.now() - t0);
    if (!retryCoarse && preserveEdges && op === 'intersection') {
      // Coincident banks far from the origin can make the sweep tree inconsistent. Retry in local coordinates
      // without snapping or moving one operand relative to another; area remains an exact-frame measurement.
      const bb = geomBox(ga);
      const move = (g: Geom, dx: number, dy: number): Geom => g.map((pg) => pg.map((r) => r.map(([x, y]) => [x + dx, y + dy] as [number, number])));
      try { return result(move(f(move(ga, -bb.x0, -bb.y0), ...gr.map((g) => move(g, -bb.x0, -bb.y0))), bb.x0, bb.y0)); } catch { /* Still unproved: fail closed below. */ }
    }
    if (!retryCoarse) { onFailure?.(); return []; }
    // retry on coarser snapping (polygon-clipping can fail on nearly coincident edges)
    const q = (g: Geom): Geom => g.map((pg) => pg.map((r) => r.map(([x, y]) => [Math.round(x * 20) / 20, Math.round(y * 20) / 20] as [number, number])));
    try { return fromGeom(f(q(ga), ...gr.map(q)), 0.01, true); } catch {
      onFailure?.();
      if (failClosed) return [];
      if (op === 'union') return fromGeom(ga).concat(...gr.map((g) => fromGeom(g)));
      return op === 'difference' ? fromGeom(ga) : [];
    }
  }
}

/** Exact booleans: partition levels (T-vertices stay exactly on their lines). */
export const union = (a: Operand, ...rest: Operand[]): MultiPoly => run('union', a, rest);
export const intersection = (a: Operand, ...rest: Operand[]): MultiPoly => run('intersection', a, rest);
export const difference = (a: Operand, ...rest: Operand[]): MultiPoly => run('difference', a, rest);
/** Snapped booleans (1 cm grid in and out): coarse region geometry, robust against near-degeneracies. */
export const unionS = (a: Operand, ...rest: Operand[]): MultiPoly => run('union', a, rest, true);

/**
 * Resolves a single (possibly degenerate: folded, collinear-overlapping) ring through the boolean engine, so that
 * its area is the one every later boolean sees. Returns the cleaned pieces.
 */
export function resolve(p: Polygon): MultiPoly {
  const g = toGeom(p);
  if (!g.length) return [];
  try { return fromGeom(polygonClipping.union(g as never) as unknown as Geom); } catch { return fromGeom(g); }
}
export const intersectionS = (a: Operand, ...rest: Operand[]): MultiPoly => run('intersection', a, rest, true);
export const differenceS = (a: Operand, ...rest: Operand[]): MultiPoly => run('difference', a, rest, true);
/** Added water must disappear if clipping fails, rather than covering protected roads or dry land. */
export const differenceSafeS = (a: Operand, ...rest: Operand[]): MultiPoly => run('difference', a, rest, true, true);

/** Checked operations distinguish an empty geometric result from an engine failure, without returning unsafe land. */
export function tryDifference(a: Operand, ...rest: Operand[]): { pieces: MultiPoly; failed: boolean } {
  let failed = false;
  const pieces = run('difference', a, rest, false, true, () => { failed = true; }, false, true);
  return { pieces, failed };
}
export function tryDifferenceS(a: Operand, ...rest: Operand[]): { pieces: MultiPoly; failed: boolean } {
  let failed = false;
  const pieces = run('difference', a, rest, true, true, () => { failed = true; }, false, true);
  return { pieces, failed };
}
export function tryIntersection(a: Operand, ...rest: Operand[]): { pieces: MultiPoly; failed: boolean } {
  let failed = false;
  // Keep raw positive areas here: callers must measure aggregate residue before applying any numerical floor.
  const pieces = run('intersection', a, rest, false, true, () => { failed = true; }, false, true, Number.MIN_VALUE);
  return { pieces, failed };
}

export const mpArea = (m: MultiPoly): number => m.reduce((s, ph) => s + area(ph.outer) - ph.holes.reduce((t, h) => t + area(h), 0), 0);

/** Repairs a possibly self-intersecting ring: union with itself, keep the largest piece (outer only). */
export function repairRing(p: Polygon): Polygon {
  const r = unionS(p);
  if (!r.length) return [];
  let best = r[0];
  for (const ph of r) if (area(ph.outer) > area(best.outer)) best = ph;
  return best.outer;
}

/** Union of many polygons in balanced batches (much faster than one huge call for hundreds of inputs). */
export function unionMany(list: Operand[], batch = 24, snapped = false): MultiPoly {
  let cur: MultiPoly[] = list.map((o) => (Array.isArray(o) && (o.length === 0 || 'x' in (o[0] as object)) ? (o as Polygon).length >= 3 ? [{ outer: orientPos(o as Polygon), holes: [] }] : [] : Array.isArray(o) ? (o as MultiPoly) : [o as PolyH])).filter((m) => m.length);
  if (!cur.length) return [];
  while (cur.length > 1) {
    const next: MultiPoly[] = [];
    for (let i = 0; i < cur.length; i += batch) {
      const grp = cur.slice(i, i + batch);
      next.push(grp.length === 1 ? grp[0] : (snapped ? unionS : union)(grp[0], ...grp.slice(1)));
    }
    cur = next;
  }
  return cur[0];
}
