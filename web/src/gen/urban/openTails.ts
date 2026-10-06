/** Public street ends of open settlements. All decisions use geometry in world metres. */
import type { Polygon, Polyline, Vec2 } from '../core/geom';
import { dist } from '../core/geom';
import type { PolyH, UrbanLayer, UrbanStreet, UrbanStreetTail } from '../types';
import { differenceSafeS, intersectionS } from '../geo/bool';
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
  const occupied = new Set(urban.buildings.map((b) => b.parcel).filter((i): i is number => i !== undefined));
  const accept = (p: Vec2, extra = 0): void => {
    const pr = pathProjection(path, p);
    if (pr.offset > width / 2 + 3 + extra) return;
    const d = end === 'start' ? pr.distance : L - pr.distance;
    best = Math.min(best, d);
  };
  for (let i = 0; i < urban.parcels.length; i++) {
    const parcel = urban.parcels[i];
    if (!parcel.front || !occupied.has(i)) continue;
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
  if (path.length < 2) return false;
  for (const [a, b] of segments(path, false)) {
    if (dist(a, b) < 0.1 || project(edge, a, b).d > width / 2 + 2.5) continue;
    for (const ph of owner) for (const [c, d] of segments(ph.outer, true)) {
      const hit = segSegT(a, b, c, d);
      if (!hit || dist(edge, at(a, b, hit.t)) > width / 2 + 2.5) continue;
      const eps = Math.min(0.05, 1 / dist(a, b));
      const before = at(a, b, Math.max(0, hit.t - eps));
      const after = at(a, b, Math.min(1, hit.t + eps));
      if (inside(before, owner) !== inside(after, owner)) return true;
      // A regional road may be stored only on its exterior side and meet the urban street at an exact border node.
      if ((hit.t <= 1e-8 || hit.t >= 1 - 1e-8) && !inside(a, owner) && !inside(b, owner)
        && dist(edge, at(a, b, hit.t)) <= 0.5) return true;
    }
  }
  return false;
}

/** Deterministic diagnosis. It does not mutate paths, lots or rural land use. */
export function classifyStreetTails(urban: UrbanLayer, context: StreetTailContext = {}): UrbanStreetTail[] {
  // The macro host has no detailed lots or public-space partition yet. Its arterials remain intact until detail arrives.
  if (!urban.parcels.length && !urban.buildings.length && urban.quarters.every((q) => !q.streetSpace.length)) return [];
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
      let kind: UrbanStreetTail['kind'];
      if (context.regionalRoads?.some((r) => externalCrossing(r.path, r.width, point, owner))) kind = 'regionalContinuation';
      else if (urban.streets.some((other, i) => i !== street && other.path.length >= 2
        && pathProjection(other.path, point).offset <= (st.width + other.width) / 2 + 0.5)) kind = 'urbanJunction';
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
function publicProtection(urban: UrbanLayer, tails: UrbanStreetTail[], context: StreetTailContext): Polygon[] {
  const keep: Polygon[] = [];
  const add = (path: Polyline, width: number): void => { if (path.length >= 2) keep.push(ribbon(path, Math.max(1, width))); };
  for (let i = 0; i < urban.streets.length; i++) add(servedStreetPath(urban.streets[i], tails.filter((t) => t.street === i)), urban.streets[i].width + 2);
  for (const r of context.regionalRoads ?? []) add(r.path, r.width + 3);
  for (const r of context.accessWays ?? []) add(r.path, r.width + 2);
  for (const p of urban.squares) keep.push(p);
  for (const p of urban.parcels) if (p.use === 'place' || p.use === 'market' || p.use === 'church') keep.push(p.poly);
  for (const s of urban.sites ?? []) keep.push(s.lot);
  for (const wall of urban.walls ?? []) add(wall.path, wall.thickness + 2);
  return keep;
}

function safeGround(subject: Polygon, urban: UrbanLayer, owner: PolyH[] | undefined, protection: Polygon[], context: StreetTailContext): PolyH[] {
  const space = urban.quarters.flatMap((q) => q.streetSpace);
  if (!space.length) return [];
  let pieces = intersectionS(subject, space);
  if (owner) pieces = intersectionS(pieces, owner);
  const bounds = (p: Polygon): [number, number, number, number] => p.reduce((b, v) => [Math.min(b[0], v.x), Math.min(b[1], v.y), Math.max(b[2], v.x), Math.max(b[3], v.y)], [Infinity, Infinity, -Infinity, -Infinity]);
  const sb = bounds(subject);
  const close = (p: Polygon): boolean => {
    const b = bounds(p);
    return b[0] <= sb[2] + 2 && b[2] >= sb[0] - 2 && b[1] <= sb[3] + 2 && b[3] >= sb[1] - 2;
  };
  const cuts: (Polygon | PolyH)[] = [...protection.filter(close), ...(urban.water ?? []).filter((p) => close(p.outer)),
    ...(context.barriers ?? []).filter((p) => close(p.outer)), ...(context.protectedGround ?? []).filter((p) => close(p.outer))];
  if (cuts.length) pieces = differenceSafeS(pieces, ...cuts);
  return pieces;
}

/** Border street-space residue not belonging to any needed ribbon; it has no service or carriage function. */
export function openEdgeResidualGround(urban: UrbanLayer, tails: UrbanStreetTail[], context: StreetTailContext = {}): PolyH[] {
  const owner = context.owner ?? urban.footprintH;
  const protection = publicProtection(urban, tails, context);
  const out: PolyH[] = [];
  for (const ph of owner) {
    const ring = ph.outer;
    // Process local chunks: a full megacity outline in one boolean is needlessly expensive.
    for (let i = 0; i < ring.length; i += 8) {
      const chunk: Polyline = [];
      for (let j = i; j <= Math.min(ring.length, i + 8); j++) chunk.push(ring[j % ring.length]);
      if (chunk.length < 2) continue;
      out.push(...safeGround(ribbon(chunk, 60), urban, owner, protection, context));
    }
  }
  return out;
}

export function openTailGround(urban: UrbanLayer, tails: UrbanStreetTail[], context: StreetTailContext = {}): PolyH[] {
  const protection = publicProtection(urban, tails, context);
  const streetSpace = urban.quarters.flatMap((q) => q.streetSpace);
  if (!streetSpace.length) return [];
  const out: PolyH[] = openEdgeResidualGround(urban, tails, context);
  for (const tail of tails) {
    if (tail.kind !== 'unservedOpenEdge' || tail.excess < 1) continue;
    const st = urban.streets[tail.street];
    const stub = endStub(st.path, tail.end, tail.excess);
    if (stub.length < 2) continue;
    const pieces = safeGround(ribbon(stub, Math.max(1, st.width)), urban, context.owner, protection, context);
    if (pieces.length) out.push(...pieces);
  }
  return out;
}
