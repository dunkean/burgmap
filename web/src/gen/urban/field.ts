/**
 * Guidance cross-field θ(p) (URBAN_GEOMETRY.md §2.1) and streamline tracing (§2.2.3).
 * european-organic: radial/tangential cross-field around the nucleus, locally aligned to nearby primary
 * streets, bent towards contours on slopes, with low-frequency angular noise.
 * grid: constant orientation plus skew noise.
 */
import type { Vec2, Polyline } from '../core/geom';
import { Noise2D } from '../core/noise';
import type { Rng } from '../core/rng';
import { gradientAt } from '../core/grid';
import { smoothstep } from '../core/field';
import type { UrbanCtx } from './context';
import type { Streets } from './streets';
import type { MorphologyParams } from './morphology';
import { segSegT } from '../geo/poly';
import { GridIndex } from '../geo/spatial';

const TAU = Math.PI * 2;

/** Edge grid of a ring (the streamlines of a split test it every 5 m); kept while the ring is unchanged. */
const RING_EDGES = new WeakMap<Vec2[], { n: number; sum: number; idx: GridIndex<number> }>();
function ringEdges(ring: Vec2[]): { idx: GridIndex<number> } {
  // (validated by a coordinate checksum: a ring edited in place is re-indexed)
  let sum = 0;
  for (let i = 0; i < ring.length; i++) sum += ring[i].x * (i + 1) + ring[i].y * (i + 7);
  let e = RING_EDGES.get(ring);
  if (!e || e.n !== ring.length || e.sum !== sum) {
    const idx = new GridIndex<number>(16);
    for (let i = 0; i < ring.length; i++) idx.insertSeg(ring[i], ring[(i + 1) % ring.length], i);
    e = { n: ring.length, sum, idx };
    RING_EDGES.set(ring, e);
  }
  return e;
}

export class GuidanceField {
  private noise: Noise2D;
  constructor(
    private ctx: UrbanCtx, private nucleus: Vec2, private streets: Streets, private gridAngle: number, rng: Rng,
  ) { this.noise = new Noise2D(rng.fork('fieldNoise')); }

  /** Morphology of the quarter being split (defaults to the context's). */
  P: MorphologyParams | null = null;
  /** Contour direction at the site (terrain-oriented lattices: terraces). */
  terrainAngle = 0;

  /** Base angle θ of the cross-field at p (the field is defined modulo 90°). */
  angle(p: Vec2): number {
    const P = this.P ?? this.ctx.params;
    const nz = ((P.fieldNoise * Math.PI) / 180) * this.noise.fbm(p.x / P.fieldWavelength, p.y / P.fieldWavelength, 2);
    if (P.streetOp === 'grid') return (P.orientation === 'cardinal' ? 0 : P.orientation === 'terrain' ? this.terrainAngle : this.gridAngle) + nz + P.gridSkew * this.noise.fbm(p.x / 600 + 9, p.y / 600 - 3, 2);
    // terraces (dwarven holds): streets cut along the local contours where the ground slopes, straight rows
    // across the site's contour direction where it is flat; the other family climbs (ramps, stairs)
    if (P.contourFollow) return this.localContour(p, P.contourFollow);
    const dx = p.x - this.nucleus.x, dy = p.y - this.nucleus.y;
    const r = Math.hypot(dx, dy);
    // spiral twist: both families rotate with the distance angle (log-spiral streets)
    let th = Math.atan2(dy, dx) + (P.fieldTwist ?? 0);
    let cx = Math.cos(4 * th), cy = Math.sin(4 * th);
    // a random low-frequency orientation field breaks the dartboard (regular concentric arcs and spokes)
    const wr = P.fieldRandom ?? 0;
    if (wr > 0) {
      const psi = Math.PI * this.noise.fbm(p.x / 260 + 31.7, p.y / 260 - 12.3, 2);
      cx = (1 - wr) * cx + wr * Math.cos(4 * psi);
      cy = (1 - wr) * cy + wr * Math.sin(4 * psi);
    }
    // blend (in 4θ space) with the tangent of the nearest primary street
    const al = this.primaryAlign(p);
    if (al) {
      cx = (1 - al.w) * cx + al.w * al.c;
      cy = (1 - al.w) * cy + al.w * al.s;
    }
    // contours on slopes: streets follow the contour, lanes climb
    const g = this.ctx.terrain.height;
    const ix = Math.min(g.w - 1, Math.max(0, Math.floor(p.x / g.cell))), iy = Math.min(g.h - 1, Math.max(0, Math.floor(p.y / g.cell)));
    const [gx, gy] = gradientAt(g, ix, iy);
    const sl = Math.hypot(gx, gy);
    // (hill towns: `contourBlend` makes the contours win from gentler slopes on)
    const cb = P.contourBlend ?? 0;
    if (sl > (cb ? 0.025 : 0.06)) {
      const tc = Math.atan2(gy, gx) + Math.PI / 2;
      const w = cb ? Math.max(0.75 * smoothstep(sl, 0.06, 0.14), cb * smoothstep(sl, 0.025, 0.08)) : 0.75 * smoothstep(sl, 0.06, 0.14);
      cx = (1 - w) * cx + w * Math.cos(4 * tc);
      cy = (1 - w) * cy + w * Math.sin(4 * tc);
    }
    th = Math.atan2(cy, cx) / 4;
    // near the nucleus the radial field is singular: fade the noise in with distance
    return th + nz * (0.5 + 0.5 * smoothstep(r, 20, 120));
  }

  /**
   * Terrain-oriented lattices (terraces cut along the contours): the contour direction of the ground smoothed over
   * ~70 m at p where the slope is felt, the site's contour direction on flat ground (blended in 4θ space).
   */
  localContour(p: Vec2, k = 1): number {
    const g = this.ctx.terrain.height;
    let gx = 0, gy = 0;
    const R = 70;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * TAU, dx = Math.cos(a), dy = Math.sin(a);
      const ix = Math.min(g.w - 1, Math.max(0, Math.floor((p.x + dx * R) / g.cell))), iy = Math.min(g.h - 1, Math.max(0, Math.floor((p.y + dy * R) / g.cell)));
      const h = g.data[iy * g.w + ix];
      gx += dx * h; gy += dy * h;
    }
    // (12 samples at R: the gradient magnitude is |Σ h d| / (6 R))
    const sl = Math.hypot(gx, gy) / (6 * R);
    if (sl < 1e-6) return this.terrainAngle;
    const tc = Math.atan2(gy, gx) + Math.PI / 2;
    const w = k * smoothstep(sl, 0.02, 0.06);
    const cx = (1 - w) * Math.cos(4 * this.terrainAngle) + w * Math.cos(4 * tc), cy = (1 - w) * Math.sin(4 * this.terrainAngle) + w * Math.sin(4 * tc);
    // (back to an angle near the local contour, modulo 90°)
    const th = Math.atan2(cy, cx) / 4;
    let d = th - tc;
    d = ((d % (Math.PI / 2)) + Math.PI * 0.75) % (Math.PI / 2) - Math.PI / 4;
    return tc + d;
  }

  /**
   * Alignment to the nearest primary street (rank ≤ 1): weight and the street tangent in 4θ form. The primary
   * network is complete before level 2, so it is rasterized once (5 m) on first use.
   */
  private tiles = new Map<number, Float32Array>();
  private primaryAlign(p: Vec2): { w: number; c: number; s: number } | null {
    const R = 6, T = 16;
    const gi = Math.round(p.x / R), gj = Math.round(p.y / R);
    const ti = Math.floor(gi / T), tj = Math.floor(gj / T);
    const key = (ti + 4096) * 8192 + (tj + 4096);
    let tile = this.tiles.get(key);
    if (!tile) {
      tile = new Float32Array(T * T * 3);
      for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) {
        const q = { x: (ti * T + i) * R, y: (tj * T + j) * R };
        const ns = this.streets.nearest(q, 70, (st) => st.rank <= 1);
        if (!ns) continue;
        const st = this.streets.list[ns.s];
        const a = st.path[ns.seg], b = st.path[ns.seg + 1];
        const ts = Math.atan2(b.y - a.y, b.x - a.x);
        const k = (j * T + i) * 3;
        tile[k] = Math.exp(-ns.d / 35) * 0.85; tile[k + 1] = Math.cos(4 * ts); tile[k + 2] = Math.sin(4 * ts);
      }
      this.tiles.set(key, tile);
    }
    const k = ((gj - tj * T) * T + (gi - ti * T)) * 3;
    if (tile[k] <= 0) return null;
    return { w: tile[k], c: tile[k + 1], s: tile[k + 2] };
  }

  /** Of the four cross directions at p, the one closest to heading h. */
  follow(p: Vec2, h: number): number {
    const th = this.angle(p);
    let best = th, bd = Infinity;
    for (let k = 0; k < 4; k++) {
      const c = th + (k * Math.PI) / 2;
      let d = c - h;
      d = ((d % TAU) + TAU + Math.PI) % TAU - Math.PI;
      if (Math.abs(d) < bd) { bd = Math.abs(d); best = h + d; }
    }
    return best;
  }

  /**
   * Streamline from p in heading h until it crosses the ring boundary (the crossing point is the last vertex).
   * Heading changes are limited to `maxTurnPer10m` radians per 10 m. Returns null if it never exits.
   */
  trace(ring: Vec2[], p: Vec2, h: number, maxTurnPer10m: number, step = 5, maxLen = 1500): Polyline | null {
    const out: Vec2[] = [p];
    let cur = p, head = h;
    const maxTurn = (maxTurnPer10m * step) / 10;
    const re = ringEdges(ring);
    for (let s = 0; s < maxLen; s += step) {
      const target = this.follow(cur, head);
      let d = target - head;
      d = Math.max(-maxTurn, Math.min(maxTurn, d));
      head += d;
      const nx = { x: cur.x + Math.cos(head) * step, y: cur.y + Math.sin(head) * step };
      // exit test (the ring edges near the step, from a grid of the edges kept per ring: the same first hit)
      let bt = Infinity;
      const x0 = Math.min(cur.x, nx.x) - 1e-6, x1 = Math.max(cur.x, nx.x) + 1e-6, y0 = Math.min(cur.y, nx.y) - 1e-6, y1 = Math.max(cur.y, nx.y) + 1e-6;
      re.idx.forEachIn(x0, y0, x1, y1, (i) => {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        if (Math.max(a.x, b.x) < x0 || Math.min(a.x, b.x) > x1 || Math.max(a.y, b.y) < y0 || Math.min(a.y, b.y) > y1) return;
        const r = segSegT(cur, nx, a, b);
        if (r && r.t > 1e-9 && r.t < bt) bt = r.t;
      });
      if (bt < Infinity) {
        out.push({ x: cur.x + (nx.x - cur.x) * bt, y: cur.y + (nx.y - cur.y) * bt });
        return out;
      }
      out.push(nx);
      cur = nx;
    }
    return null;
  }
}
