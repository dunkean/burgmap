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
export function fromGeom(g: Geom, minArea = 0.01, snapped = false): MultiPoly {
  const out: MultiPoly = [];
  const me = 0.005;
  for (const pg of g) {
    const outer = cleanRing(fromRing(pg[0] as Ring), me, 0.5, 0.002, false);
    if (outer.length < 3 || area(outer) < minArea) continue;
    const holes: Polygon[] = [];
    for (let i = 1; i < pg.length; i++) {
      const h = cleanRing(fromRing(pg[i] as Ring), me, 0.5, 0.002, false);
      if (h.length >= 3 && area(h) >= minArea) holes.push(orientPos(h));
    }
    out.push({ outer: orientPos(outer), holes });
  }
  return out;
}

type Operand = MultiPoly | PolyH | Polygon;

/** Debug hook: called with the inputs of boolean operations slower than 300 ms. */
export let SLOW_LOG: ((op: string, snapped: boolean, a: unknown, b: unknown, ms: number) => void) | null = null;
export const setSlowLog = (f: typeof SLOW_LOG) => { SLOW_LOG = f; };

/** Grid of the snapped booleans (1 mm: robust, while a snapped T-vertex moves a shared edge by < 0.7 mm). */
export const BOOL_GRID = 1000;
const snapGeom = (g: Geom): Geom => g.map((pg) => pg.map((r) => r.map(([x, y]) => [Math.round(x * BOOL_GRID) / BOOL_GRID, Math.round(y * BOOL_GRID) / BOOL_GRID] as [number, number])));

function run(op: 'union' | 'intersection' | 'difference', a: Operand, rest: Operand[], snapped = false): MultiPoly {
  let ga = toGeom(a);
  let gr = rest.map(toGeom).filter((g) => g.length);
  if (snapped) { ga = snapGeom(ga); gr = gr.map(snapGeom); }
  if (!ga.length) return op === 'union' && gr.length ? run('union', rest[0], rest.slice(1), snapped) : [];
  if (!gr.length) return op === 'intersection' ? [] : fromGeom(ga, 0.01, snapped);
  const f = polygonClipping[op] as (g: Geom, ...r: Geom[]) => Geom;
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  try {
    const res = fromGeom(f(ga, ...gr), 0.01, snapped);
    if (SLOW_LOG && performance.now() - t0 > 300) SLOW_LOG(op, snapped, ga, gr, performance.now() - t0);
    return res;
  } catch {
    if (SLOW_LOG) SLOW_LOG(op + '-THROW', snapped, ga, gr, performance.now() - t0);
    // retry on coarser snapping (polygon-clipping can fail on nearly coincident edges)
    const q = (g: Geom): Geom => g.map((pg) => pg.map((r) => r.map(([x, y]) => [Math.round(x * 20) / 20, Math.round(y * 20) / 20] as [number, number])));
    try { return fromGeom(f(q(ga), ...gr.map(q)), 0.01, true); } catch {
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
