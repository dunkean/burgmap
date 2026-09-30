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
import { segSegT } from '../geo/poly';

const TAU = Math.PI * 2;

export class GuidanceField {
  private noise: Noise2D;
  constructor(
    private ctx: UrbanCtx, private nucleus: Vec2, private streets: Streets, private gridAngle: number, rng: Rng,
  ) { this.noise = new Noise2D(rng.fork('fieldNoise')); }

  /** Base angle θ of the cross-field at p (the field is defined modulo 90°). */
  angle(p: Vec2): number {
    const P = this.ctx.params;
    const nz = ((P.fieldNoise * Math.PI) / 180) * this.noise.fbm(p.x / P.fieldWavelength, p.y / P.fieldWavelength, 2);
    if (P.streetOp === 'grid') return this.gridAngle + nz + P.gridSkew * this.noise.fbm(p.x / 600 + 9, p.y / 600 - 3, 2);
    const dx = p.x - this.nucleus.x, dy = p.y - this.nucleus.y;
    const r = Math.hypot(dx, dy);
    let th = Math.atan2(dy, dx);
    // blend (in 4θ space) with the tangent of the nearest primary street
    let cx = Math.cos(4 * th), cy = Math.sin(4 * th);
    const ns = this.streets.nearest(p, 70, (s) => s.rank <= 1);
    if (ns) {
      const st = this.streets.list[ns.s];
      const a = st.path[ns.seg], b = st.path[ns.seg + 1];
      const ts = Math.atan2(b.y - a.y, b.x - a.x);
      const w = Math.exp(-ns.d / 35) * 0.85;
      cx = (1 - w) * cx + w * Math.cos(4 * ts);
      cy = (1 - w) * cy + w * Math.sin(4 * ts);
    }
    // contours on slopes: streets follow the contour, lanes climb
    const g = this.ctx.terrain.height;
    const ix = Math.min(g.w - 1, Math.max(0, Math.floor(p.x / g.cell))), iy = Math.min(g.h - 1, Math.max(0, Math.floor(p.y / g.cell)));
    const [gx, gy] = gradientAt(g, ix, iy);
    const sl = Math.hypot(gx, gy);
    if (sl > 0.06) {
      const tc = Math.atan2(gy, gx) + Math.PI / 2;
      const w = 0.75 * smoothstep(sl, 0.06, 0.14);
      cx = (1 - w) * cx + w * Math.cos(4 * tc);
      cy = (1 - w) * cy + w * Math.sin(4 * tc);
    }
    th = Math.atan2(cy, cx) / 4;
    // near the nucleus the radial field is singular: fade the noise in with distance
    return th + nz * smoothstep(r, 20, 120);
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
    for (let s = 0; s < maxLen; s += step) {
      const target = this.follow(cur, head);
      let d = target - head;
      d = Math.max(-maxTurn, Math.min(maxTurn, d));
      head += d;
      const nx = { x: cur.x + Math.cos(head) * step, y: cur.y + Math.sin(head) * step };
      // exit test
      let bt = Infinity;
      for (let i = 0; i < ring.length; i++) {
        const r = segSegT(cur, nx, ring[i], ring[(i + 1) % ring.length]);
        if (r && r.t > 1e-9 && r.t < bt) bt = r.t;
      }
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
