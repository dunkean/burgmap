/** Routes lagoon outlets inside existing public street space, never through occupied lots. */
import type { Vec2, Polyline } from '../core/geom';
import { dist } from '../core/geom';
import { MinHeap } from '../core/pq';
import type { Streets, StreetRec } from './streets';

interface Edge { a: number; b: number; street: StreetRec; width: number; cost: number; connector?: boolean }
interface Segment { street: StreetRec; i: number; a: Vec2; b: Vec2; cuts: { t: number; node: number }[] }
export interface WaterwayNetwork { canals: StreetRec[]; connectors: { path: Polyline; width: number; street: number; outlet?: boolean }[] }

function project(p: Vec2, a: Vec2, b: Vec2) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return { t, q: { x: a.x + t * dx, y: a.y + t * dy } };
}

/** A canal needs a real wet outlet. Prefer existing canals, then short narrow channels along wide streets. */
export function connectedWaterways(streets: Streets, candidates: StreetRec[], isWater: (p: Vec2) => boolean,
  canOutlet: (path: Polyline, width: number) => boolean = () => true): WaterwayNetwork {
  const navigable = candidates.filter((c) => c.ribbon && c.path.length >= 2 && Math.min(...c.widths) >= 4.6);
  const canalIds = new Set(navigable.map((c) => c.id));
  const eligible = streets.list.filter((s) => s.ribbon && s.path.length >= 2 &&
    (canalIds.has(s.id) || (s.rank <= 2 && Math.min(...s.widths) >= 5)));
  const allowed = new Set(eligible.map((s) => s.id));
  const points: Vec2[] = [], lookup = new Map<string, number>(), wet = new Set<number>();
  const node = (p: Vec2): number => {
    const key = `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;
    const old = lookup.get(key);
    if (old !== undefined) return old;
    const id = points.length; points.push(p); lookup.set(key, id);
    if (isWater(p)) wet.add(id);
    return id;
  };
  const segments: Segment[] = [], bySegment = new Map<string, Segment>();
  for (const s of eligible) for (let i = 1; i < s.path.length; i++) {
    const a = s.path[i - 1], b = s.path[i];
    const seg: Segment = { street: s, i: i - 1, a, b, cuts: [{ t: 0, node: node(a) }, { t: 1, node: node(b) }] };
    // Include wet crossings within long roads, not just their endpoints. Three metres resolves town channels.
    const steps = Math.ceil(dist(a, b) / 3);
    for (let j = 1; j < steps; j++) {
      const t = j / steps, p = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
      if (isWater(p)) seg.cuts.push({ t, node: node(p) });
    }
    segments.push(seg); bySegment.set(`${s.id}:${i - 1}`, seg);
  }
  const joins: Edge[] = [];
  // Split hosts at actual street junctions. A cut can end in the middle of a long arterial.
  for (const s of eligible) for (const p of s.path) {
    const from = node(p), seen = new Set<string>();
    streets.forEachSeg(p.x - 1.2, p.y - 1.2, p.x + 1.2, p.y + 1.2, (host, i) => {
      const key = `${host.id}:${i}`;
      if (host === s || !allowed.has(host.id) || seen.has(key)) return;
      seen.add(key);
      const seg = bySegment.get(key)!;
      const r = project(p, seg.a, seg.b);
      if (dist(p, r.q) > 1.2) return;
      const to = node(r.q); seg.cuts.push({ t: r.t, node: to });
      if (from !== to) joins.push({ a: from, b: to, street: s, width: 2.2, cost: dist(p, r.q), connector: true });
    });
  }
  const outlets: Edge[] = [];
  for (const c of navigable) for (const k of [0, 1] as const) {
    const p = k ? c.path[c.path.length - 1] : c.path[0], back = k ? c.path[c.path.length - 2] : c.path[1];
    if (isWater(p)) continue;
    const length = dist(p, back);
    if (length < 0.01) continue;
    // A bank can be a few metres past the cut endpoint. Only dig an explicitly clear, short outlet.
    for (let d = 1; d <= 12; d++) {
      const q = { x: p.x + (p.x - back.x) * d / length, y: p.y + (p.y - back.y) * d / length };
      if (!isWater(q)) continue;
      if (canOutlet([p, q], 2.2)) outlets.push({ a: node(p), b: node(q), street: c, width: 2.2, cost: d * 0.08, connector: true });
      break;
    }
  }
  const edges: Edge[] = [...joins, ...outlets], adj: { to: number; edge: number }[][] = points.map(() => []);
  for (const seg of segments) {
    seg.cuts.sort((a, b) => a.t - b.t || a.node - b.node);
    const width = Math.min(4, Math.min(...seg.street.widths) - 2.4);
    for (let i = 1; i < seg.cuts.length; i++) {
      const a = seg.cuts[i - 1].node, b = seg.cuts[i].node;
      if (a === b || dist(points[a], points[b]) < 0.01) continue;
      edges.push({ a, b, street: seg.street, width, cost: dist(points[a], points[b]) * (canalIds.has(seg.street.id) ? 0.08 : 4), connector: !canalIds.has(seg.street.id) });
    }
  }
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]; adj[e.a].push({ to: e.b, edge: i }); adj[e.b].push({ to: e.a, edge: i });
  }
  const distance = points.map(() => Infinity), previous = points.map(() => -1), heap = new MinHeap<number>();
  for (const id of wet) { distance[id] = 0; heap.push(id, 0); }
  const done = new Set<number>();
  while (heap.size) {
    const from = heap.pop()!;
    if (done.has(from)) continue;
    done.add(from);
    for (const link of adj[from]) {
      const d = distance[from] + edges[link.edge].cost;
      if (d < distance[link.to]) { distance[link.to] = d; previous[link.to] = link.edge; heap.push(link.to, d); }
    }
  }
  const selected = new Set<number>(), canals: StreetRec[] = [];
  for (const c of navigable) {
    const a = node(c.path[0]), b = node(c.path[c.path.length - 1]);
    let at = distance[a] <= distance[b] ? a : b;
    if (!Number.isFinite(distance[at])) continue; // Dry disconnected cuts remain ordinary streets.
    canals.push(c);
    while (previous[at] >= 0) {
      const id = previous[at], e = edges[id]; selected.add(id);
      at = e.a === at ? e.b : e.a;
    }
  }
  const connectors: WaterwayNetwork['connectors'] = [];
  for (const id of [...selected].sort((a, b) => a - b)) {
    const e = edges[id];
    if (e.connector) connectors.push({ path: [points[e.a], points[e.b]], width: e.width, street: e.street.id, outlet: id >= joins.length && id < joins.length + outlets.length });
  }
  return { canals, connectors };
}
