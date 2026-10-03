/**
 * Planar street graph: nodes, polyline edges with attributes, robust polyline insertion (splitting at
 * crossings, endpoint snapping to nodes/edges, merging of near-parallel overlaps) and face extraction.
 */
import type { Vec2, Polygon } from '../core/geom';
import { dist, polygonArea } from '../core/geom';
import { segSegT, snapPt } from './poly';
import { GridIndex } from './spatial';

export type StreetKind = 'radial' | 'ring' | 'street' | 'lane' | 'close' | 'quay' | 'wall-lane' | 'track' | 'boundary';

export interface EdgeAttrs { width: number; rank: number; phase: number; kind: StreetKind; street: number }
export interface GNode { id: number; p: Vec2; edges: number[] }
export interface GEdge extends EdgeAttrs { id: number; a: number; b: number; pts: Vec2[]; alive: boolean }

interface SegRef { e: number; i: number }

export interface InsertOpts { snapR?: number; mergeDist?: number; mergeAngleDeg?: number }

export class StreetGraph {
  nodes: GNode[] = [];
  edges: GEdge[] = [];
  private nodeIdx = new GridIndex<number>(16);
  private segIdx = new GridIndex<SegRef>(24);
  /** `thinSegs`: segments indexed by the cells they cross (long straight lines: megacity plans). */
  constructor(private opts: { thinSegs?: boolean } = {}) {}

  private addNode(p: Vec2): number {
    const id = this.nodes.length;
    this.nodes.push({ id, p, edges: [] });
    this.nodeIdx.insertBox(p.x, p.y, p.x, p.y, id);
    return id;
  }

  nodeNear(p: Vec2, r: number): number {
    let best = -1, bd = r;
    for (const id of this.nodeIdx.queryPt(p, r)) {
      const d = dist(this.nodes[id].p, p);
      if (d <= bd) { bd = d; best = id; }
    }
    return best;
  }

  private addEdge(a: number, b: number, pts: Vec2[], at: EdgeAttrs): number {
    const id = this.edges.length;
    const e: GEdge = { id, a, b, pts, alive: true, ...at };
    this.edges.push(e);
    this.nodes[a].edges.push(id);
    if (b !== a) this.nodes[b].edges.push(id);
    if (this.opts.thinSegs) for (let i = 1; i < pts.length; i++) this.segIdx.insertSegThin(pts[i - 1], pts[i], { e: id, i: i - 1 });
    else for (let i = 1; i < pts.length; i++) this.segIdx.insertSeg(pts[i - 1], pts[i], { e: id, i: i - 1 });
    return id;
  }

  private killEdge(id: number): void {
    const e = this.edges[id];
    e.alive = false;
    this.nodes[e.a].edges = this.nodes[e.a].edges.filter((x) => x !== id);
    this.nodes[e.b].edges = this.nodes[e.b].edges.filter((x) => x !== id);
  }

  /** Splits edge `id` at point p lying on its segment `seg`; returns the new node id. */
  private splitEdgeAt(id: number, seg: number, p: Vec2): number {
    const e = this.edges[id];
    // reuse an endpoint when very close
    if (dist(p, this.nodes[e.a].p) < 1e-6) return e.a;
    if (dist(p, this.nodes[e.b].p) < 1e-6) return e.b;
    const n = this.addNode(p);
    const left = e.pts.slice(0, seg + 1).concat([p]);
    const right = [p].concat(e.pts.slice(seg + 1));
    this.killEdge(id);
    const at: EdgeAttrs = { width: e.width, rank: e.rank, phase: e.phase, kind: e.kind, street: e.street };
    if (left.length >= 2 && dist(left[0], left[left.length - 1]) > 0) this.addEdge(e.a, n, left, at);
    if (right.length >= 2 && dist(right[0], right[right.length - 1]) > 0) this.addEdge(n, e.b, right, at);
    return n;
  }

  /** Nearest point on any alive edge within r: {edge, seg, p, d}. */
  nearestOnEdges(p: Vec2, r: number): { e: number; seg: number; p: Vec2; d: number } | null {
    let best: { e: number; seg: number; p: Vec2; d: number } | null = null;
    for (const s of this.segIdx.queryPt(p, r)) {
      const e = this.edges[s.e];
      if (!e.alive) continue;
      const a = e.pts[s.i], b = e.pts[s.i + 1];
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
      const q = { x: a.x + t * dx, y: a.y + t * dy };
      const d = dist(p, q);
      if (d <= r && (!best || d < best.d)) best = { e: s.e, seg: s.i, p: q, d };
    }
    return best;
  }

  /** Node for endpoint p: an existing node within snapR, else a split of a nearby edge, else a new node. */
  private endpointNode(p: Vec2, snapR: number): number {
    const nd = this.nodeNear(p, snapR);
    if (nd >= 0) return nd;
    const on = this.nearestOnEdges(p, snapR);
    if (on) return this.splitEdgeAt(on.e, on.seg, snapPt(on.p));
    return this.addNode(p);
  }

  /**
   * Inserts a polyline. Crossings with existing edges become nodes; endpoints snap to nodes/edges within
   * snapR; segments running within mergeDist of an existing edge at an angle below mergeAngle are merged
   * (not duplicated). Returns the ids of the created edges.
   */
  insertPolyline(pts0: Vec2[], at: EdgeAttrs, o: InsertOpts = {}): number[] {
    const snapR = o.snapR ?? 3, mergeDist = o.mergeDist ?? 4, mergeSin = Math.sin(((o.mergeAngleDeg ?? 15) * Math.PI) / 180);
    const pts = pts0.map(snapPt).filter((p, i, arr) => i === 0 || dist(p, arr[i - 1]) > 1e-6);
    if (pts.length < 2) return [];
    // 1. mark segments that duplicate existing edges
    const dup: boolean[] = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const la = dist(a, b);
      let isDup = false;
      if (mergeDist > 0) {
        const na = this.nearestOnEdges(a, mergeDist), nb = this.nearestOnEdges(b, mergeDist);
        if (na && nb && (na.e === nb.e || this.edges[na.e].street === this.edges[nb.e].street)) {
          const e = this.edges[na.e];
          const s0 = e.pts[na.seg], s1 = e.pts[na.seg + 1];
          const ex = s1.x - s0.x, ey = s1.y - s0.y, el = Math.hypot(ex, ey) || 1;
          const sn = Math.abs(((b.x - a.x) * ey - (b.y - a.y) * ex) / (la * el || 1));
          if (sn < mergeSin) isDup = true;
        }
      }
      dup.push(isDup);
    }
    // 2. split the polyline into runs of non-duplicate segments
    const created: number[] = [];
    let i = 0;
    while (i < dup.length) {
      if (dup[i]) { i++; continue; }
      let j = i;
      while (j + 1 < dup.length && !dup[j + 1]) j++;
      created.push(...this.insertRun(pts.slice(i, j + 2), at, snapR));
      i = j + 1;
    }
    return created;
  }

  private insertRun(pts: Vec2[], at: EdgeAttrs, snapR: number): number[] {
    const startNode = this.endpointNode(pts[0], snapR);
    const endNode0 = this.endpointNode(pts[pts.length - 1], snapR);
    const P = pts.slice();
    P[0] = this.nodes[startNode].p;
    P[P.length - 1] = this.nodes[endNode0].p;
    // collect crossings along P
    type Hit = { s: number; t: number; p: Vec2; node: number };
    const hits: Hit[] = [];
    for (let s = 1; s < P.length; s++) {
      const a = P[s - 1], b = P[s];
      const cands = this.segIdx.query(Math.min(a.x, b.x) - 1e-6, Math.min(a.y, b.y) - 1e-6, Math.max(a.x, b.x) + 1e-6, Math.max(a.y, b.y) + 1e-6);
      const local: { t: number; e: number; seg: number; u: number }[] = [];
      for (const ref of cands) {
        const e = this.edges[ref.e];
        if (!e.alive) continue;
        const r = segSegT(a, b, e.pts[ref.i], e.pts[ref.i + 1]);
        if (!r) continue;
        if ((s === 1 && r.t < 1e-6) || (s === P.length - 1 && r.t > 1 - 1e-6)) continue;
        local.push({ t: r.t, e: ref.e, seg: ref.i, u: r.u });
      }
      local.sort((x, y) => x.t - y.t);
      for (const h of local) {
        const e = this.edges[h.e];
        if (!e.alive) continue; // split already by an earlier hit on the same segment
        const p = snapPt({ x: a.x + (b.x - a.x) * h.t, y: a.y + (b.y - a.y) * h.t });
        let node = this.nodeNear(p, 0.05);
        if (node < 0) {
          // re-find the segment on the (possibly re-split) edge
          const on = this.nearestOnEdges(p, 0.05);
          if (!on) continue;
          node = this.splitEdgeAt(on.e, on.seg, p);
        }
        hits.push({ s, t: h.t, p: this.nodes[node].p, node });
      }
    }
    // existing nodes lying within snapR of a new segment (T-junctions of earlier streets onto this one)
    for (let s = 1; s < P.length; s++) {
      const a = P[s - 1], b = P[s];
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      if (l2 < 1e-12) continue;
      for (const id of this.nodeIdx.query(Math.min(a.x, b.x) - snapR, Math.min(a.y, b.y) - snapR, Math.max(a.x, b.x) + snapR, Math.max(a.y, b.y) + snapR)) {
        const nd = this.nodes[id];
        if (!nd.edges.length || id === startNode || id === endNode0) continue;
        const t = ((nd.p.x - a.x) * dx + (nd.p.y - a.y) * dy) / l2;
        if (t <= 1e-6 || t >= 1 - 1e-6) continue;
        const d = Math.hypot(nd.p.x - a.x - t * dx, nd.p.y - a.y - t * dy);
        if (d > snapR || hits.some((h) => h.node === id)) continue;
        hits.push({ s, t, p: nd.p, node: id });
      }
    }
    hits.sort((x, y) => x.s - y.s || x.t - y.t);
    // cut points along P: start node, crossings, end node; one edge between consecutive cut points
    const cuts: { s: number; t: number; node: number }[] = [{ s: 1, t: 0, node: startNode }];
    for (const h of hits) cuts.push({ s: h.s, t: h.t, node: h.node });
    cuts.push({ s: P.length - 1, t: 1, node: endNode0 });
    const created: number[] = [];
    for (let k = 1; k < cuts.length; k++) {
      const c0 = cuts[k - 1], c1 = cuts[k];
      const poly: Vec2[] = [this.nodes[c0.node].p];
      // P vertices strictly between the two cut points: vertex index v sits at (s = v, t = 0) ≡ (s = v−1, t = 1)
      for (let v = c0.s; v < c1.s; v++) if (v > 0 && v < P.length - 1) poly.push(P[v]);
      poly.push(this.nodes[c1.node].p);
      const clean = poly.filter((p, i, arr) => i === 0 || dist(p, arr[i - 1]) > 1e-6);
      if (clean.length < 2) continue;
      if (c0.node === c1.node && clean.length < 4) continue;
      created.push(this.addEdge(c0.node, c1.node, clean, at));
    }
    return created;
  }

  aliveEdges(): GEdge[] { return this.edges.filter((e) => e.alive); }

  /** Number of connected components among nodes that have at least one edge. */
  components(): { count: number; comp: Int32Array } {
    const parent = new Int32Array(this.nodes.length).map((_, i) => i);
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (const e of this.edges) if (e.alive) { const ra = find(e.a), rb = find(e.b); if (ra !== rb) parent[ra] = rb; }
    const roots = new Set<number>();
    const comp = new Int32Array(this.nodes.length).fill(-1);
    for (const nd of this.nodes) if (nd.edges.length) { const r = find(nd.id); roots.add(r); comp[nd.id] = r; }
    return { count: roots.size, comp };
  }

  /**
   * Bounded faces (positive area). Half-edges are walked with next = previous outgoing half-edge in CCW
   * order at the target node, which keeps the face on the left. Dangling edges are walked around.
   */
  faces(): { ring: Polygon; area: number }[] {
    const alive = this.aliveEdges();
    type HE = { e: GEdge; fwd: boolean; ang: number };
    const out = new Map<number, HE[]>();
    const heOf = (e: GEdge, fwd: boolean): HE => {
      const p0 = fwd ? e.pts[0] : e.pts[e.pts.length - 1];
      const p1 = fwd ? e.pts[1] : e.pts[e.pts.length - 2];
      return { e, fwd, ang: Math.atan2(p1.y - p0.y, p1.x - p0.x) };
    };
    const all: HE[] = [];
    for (const e of alive) {
      for (const fwd of [true, false]) {
        const h = heOf(e, fwd);
        const from = fwd ? e.a : e.b;
        let l = out.get(from);
        if (!l) { l = []; out.set(from, l); }
        l.push(h); all.push(h);
      }
    }
    for (const l of out.values()) l.sort((x, y) => x.ang - y.ang);
    const key = (h: HE) => h.e.id * 2 + (h.fwd ? 0 : 1);
    const used = new Set<number>();
    const faces: { ring: Polygon; area: number }[] = [];
    for (const h0 of all) {
      if (used.has(key(h0))) continue;
      const ring: Vec2[] = [];
      let h = h0;
      let guard = 0;
      while (!used.has(key(h)) && guard++ < 100000) {
        used.add(key(h));
        const pts = h.fwd ? h.e.pts : h.e.pts.slice().reverse();
        for (let i = 0; i < pts.length - 1; i++) ring.push(pts[i]);
        const to = h.fwd ? h.e.b : h.e.a;
        const l = out.get(to)!;
        const twinKey = h.e.id * 2 + (h.fwd ? 1 : 0);
        const ti = l.findIndex((x) => key(x) === twinKey);
        h = l[(ti - 1 + l.length) % l.length];
      }
      const a = polygonArea(ring);
      if (a > 1e-6) faces.push({ ring, area: a });
    }
    return faces;
  }
}
