/** Public street ends of open settlements. All decisions use geometry in world metres. */
import type { Polygon, Polyline, Vec2 } from '../core/geom';
import { dist } from '../core/geom';
import type { PolyH, UrbanLayer, UrbanStreet, UrbanStreetTail } from '../types';
import { differenceS, intersectionS } from '../geo/bool';
import { pointInRing, segSegT } from '../geo/poly';
import { ribbon } from '../geo/offset';

export interface StreetTailContext {
  /** True regional carriageways, with an actual path across the settlement boundary. */
  regionalRoads?: { path: Polyline; width: number }[];
  /** Existing field ways or farm drives, never an administrative outline. */
  accessWays?: { path: Polyline; width: number }[];
  /** Exact owner extent for clipped secondary settlements; defaults to footprintH. */
  owner?: PolyH[];
  /** Water and physical obstructions; a border label alone is not a barrier. */
  barriers?: PolyH[];
  /** Extra public surfaces that must retain their material, such as bridge landings. */
  protectedGround?: PolyH[];
}

const at = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const project = (p: Vec2, a: Vec2, b: Vec2): { t: number; d: number } => {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return { t, d: dist(p, at(a, b, t)) };
};
const pathLength = (p: Polyline): number => p.slice(1).reduce((s, q, i) => s + dist(p[i], q), 0);
const inPolyH = (p: Vec2, poly: PolyH): boolean => pointInRing(poly.outer, p) && !poly.holes.some((h) => pointInRing(h, p));
const inside = (p: Vec2, polys: PolyH[]): boolean => polys.some((poly) => inPolyH(p, poly));
const segments = (p: Polygon, closed: boolean): [Vec2, Vec2][] => {
  const out: [Vec2, Vec2][] = [];
  for (let i = 1; i < p.length; i++) out.push([p[i - 1], p[i]]);
  if (closed && p.length > 2) out.push([p[p.length - 1], p[0]]);
  return out;
};

/** The fraction of a street centreline closest to a point, in metres from its start. */
export function pathProjection(path: Polyline, p: Vec2): { distance: number; offset: number } {
  let length = 0, best = { distance: 0, offset: Infinity };
  for (let i = 1; i < path.length; i++) {
    const L = dist(path[i - 1], path[i]);
    const q = project(p, path[i - 1], path[i]);
    if (q.d < best.offset) best = { distance: length + q.t * L, offset: q.d };
    length += L;
  }
  return best;
}

/** Polyline/ribbon contact has to be real; a broad candidate radius is not a connection. */
export function pathsConnect(a: Polyline, aw: number, b: Polyline, bw: number): boolean {
  if (a.length < 2 || b.length < 2) return false;
  const reach = (aw + bw) / 2 + 0.5;
  for (const [p, q] of segments(a, false)) for (const [u, v] of segments(b, false)) {
    if (segSegT(p, q, u, v)) return true;
    for (const end of [p, q]) if (project(end, u, v).d <= reach) return true;
    for (const end of [u, v]) if (project(end, p, q).d <= reach) return true;
  }
  return false;
}

/** Real exterior edge, excluding holes and interior LAB_OPEN edges of quarters. */
function onExterior(p: Vec2, footprint: PolyH[], width: number): boolean {
  const tolerance = Math.max(0.7, Math.min(2.5, width / 3));
  for (const ph of footprint) for (const [a, b] of segments(ph.outer, true)) {
    if (project(p, a, b).d <= tolerance) return true;
  }
  return false;
}

function servedDistance(street: UrbanStreet, end: 'start' | 'end', urban: UrbanLayer): number {
  const path = street.path, L = pathLength(path);
  let best = Infinity;
  const width = Math.max(street.width, 2);
  const accept = (p: Vec2, extra = 0): void => {
    const pr = pathProjection(path, p);
    if (pr.offset > width / 2 + 3 + extra) return;
    const d = end === 'start' ? pr.distance : L - pr.distance;
    best = Math.min(best, d);
  };
  for (const parcel of urban.parcels) {
    if (!parcel.front || parcel.use !== 'plot') continue;
    const [a, b] = parcel.front;
    // The whole facade must be reachable; its midpoint alone can leave a visible cut before a corner entrance.
    accept(a); accept(b); accept(at(a, b, 0.5));
  }
  for (const site of urban.sites ?? []) if (site.entrance) accept(site.entrance, 2);
  return best;
}

function endStub(path: Polyline, end: 'start' | 'end', length: number): Polyline {
  if (path.length < 2) return [];
  const ordered = end === 'start' ? path : path.slice().reverse();
  const out: Vec2[] = [ordered[0]];
  let remaining = length;
  for (let i = 1; i < ordered.length; i++) {
    const L = dist(ordered[i - 1], ordered[i]);
    if (L <= remaining) { out.push(ordered[i]); remaining -= L; }
    else { out.push(at(ordered[i - 1], ordered[i], remaining / L)); break; }
    if (remaining <= 0) break;
  }
  return out;
}

function externalCrossing(path: Polyline, width: number, edge: Vec2, owner: PolyH[]): boolean {
  if (path.length < 2 || !pathsConnect([edge, edge], width, path, width)) return false;
  // A genuine continuation must have a segment beyond the owner, not just touch its outline.
  for (const p of path) if (!inside(p, owner)) return true;
  return false;
}

/** Deterministic diagnosis. It does not mutate paths, lots or rural land use. */
export function classifyStreetTails(urban: UrbanLayer, context: StreetTailContext = {}): UrbanStreetTail[] {
  const owner = context.owner ?? urban.footprintH;
  const tails: UrbanStreetTail[] = [];
  for (let street = 0; street < urban.streets.length; street++) {
    const st = urban.streets[street];
    if (st.path.length < 2 || st.role === 'boundary' || st.role === 'wall-lane') continue;
    for (const end of ['start', 'end'] as const) {
      const point = st.path[end === 'start' ? 0 : st.path.length - 1];
      if (!onExterior(point, owner, st.width)) continue;
      const L = pathLength(st.path);
      const served = servedDistance(st, end, urban);
      const stub = endStub(st.path, end, Math.min(L, Math.max(5, st.width * 1.5)));
      let kind: UrbanStreetTail['kind'];
      if (context.regionalRoads?.some((r) => externalCrossing(r.path, r.width, point, owner))) kind = 'regionalContinuation';
      else if (urban.streets.some((other, i) => i !== street && pathsConnect(stub, st.width, other.path, other.width))) kind = 'urbanJunction';
      else if (context.accessWays?.some((r) => externalCrossing(r.path, r.width, point, owner))) kind = 'fieldOrFarmAccess';
      else if (context.barriers?.some((b) => inPolyH(point, b))) kind = 'physicalBarrier';
      else if (Number.isFinite(served) && served <= Math.max(12, st.width * 2)) kind = 'servedDeadEnd';
      else kind = 'unservedOpenEdge';
      const preserved = kind !== 'unservedOpenEdge';
      const excess = Number.isFinite(served) ? Math.max(0, served - Math.max(3, st.width)) : L;
      tails.push({ street, end, kind, point, servedFromEnd: Number.isFinite(served) ? served : L, excess: preserved ? 0 : excess });
    }
  }
  return tails;
}

/** Visible axis after service is accounted for. The original street path remains the access reference. */
export function servedStreetPath(urban: UrbanLayer, streetIndex: number): Polyline;
export function servedStreetPath(street: UrbanStreet, tails: UrbanStreetTail[]): Polyline;
export function servedStreetPath(source: UrbanLayer | UrbanStreet, ref: number | UrbanStreetTail[]): Polyline {
  const street = 'streets' in source ? source.streets[ref as number] : source;
  const tails = 'streets' in source ? (source.openTails ?? []).filter((t) => t.street === ref) : ref as UrbanStreetTail[];
  if (!street) return [];
  const path = street.path;
  if (path.length < 2) return path;
  const L = pathLength(path);
  const trim = (end: 'start' | 'end') => tails.find((t) => t.end === end && t.kind === 'unservedOpenEdge')?.excess ?? 0;
  const lo = Math.min(L, trim('start')), hi = Math.max(0, L - trim('end'));
  if (hi - lo < 0.5) return [];
  const out: Vec2[] = [];
  let s = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], len = dist(a, b);
    if (len <= 0) continue;
    if (s + len >= lo && s <= hi) {
      if (!out.length) out.push(at(a, b, Math.max(0, (lo - s) / len)));
      if (s + len >= hi) { out.push(at(a, b, Math.min(1, (hi - s) / len))); break; }
      out.push(b);
    }
    s += len;
  }
  return out;
}

/** Marks frontage near the last occupied portion of a terminal street, before house generation. */
export function markTerminalPlots<T extends { front: [Vec2, Vec2]; terminal?: boolean }>(plots: T[], tails: UrbanStreetTail[], streets: UrbanStreet[]): void {
  const terminals = tails.filter((t) => t.kind === 'servedDeadEnd' || t.kind === 'unservedOpenEdge');
  for (const plot of plots) {
    const midpoint = at(plot.front[0], plot.front[1], 0.5);
    plot.terminal = terminals.some((tail) => {
      const st = streets[tail.street];
      if (!st) return false;
      const pr = pathProjection(st.path, midpoint);
      const d = tail.end === 'start' ? pr.distance : pathLength(st.path) - pr.distance;
      return pr.offset <= st.width / 2 + 4 && d <= Math.max(18, st.width * 3);
    });
  }
}

/** Exact public surface of discarded tails. Reuse for SVG and Canvas material decisions. */
export function openTailGround(urban: UrbanLayer, tails: UrbanStreetTail[], context: StreetTailContext = {}): PolyH[] {
  const protectedGround = context.protectedGround ?? [];
  const streetSpace = urban.quarters.flatMap((q) => q.streetSpace);
  if (!streetSpace.length) return [];
  const out: PolyH[] = [];
  for (const tail of tails) {
    if (tail.kind !== 'unservedOpenEdge' || tail.excess < 1) continue;
    const st = urban.streets[tail.street];
    const stub = endStub(st.path, tail.end, tail.excess);
    if (stub.length < 2) continue;
    let pieces = intersectionS(ribbon(stub, Math.max(1, st.width)), streetSpace);
    if (context.owner) pieces = intersectionS(pieces, context.owner);
    if (urban.water?.length) pieces = differenceS(pieces, urban.water);
    if (protectedGround.length) pieces = differenceS(pieces, protectedGround);
    if (urban.squares.length) pieces = differenceS(pieces, ...urban.squares);
    if (pieces.length) out.push(...pieces);
  }
  return out;
}
