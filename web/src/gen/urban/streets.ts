/** Street registry: every cut of the partition is a street with width, rank, role and phase. */
import type { Vec2, Polyline, Polygon } from '../core/geom';
import { dist } from '../core/geom';
import type { StreetRole } from '../types';
import { GridIndex } from '../geo/spatial';
import { distToSeg } from '../geo/poly';

export const LAB_OPEN = -1;
export const LAB_WALL = -2;
export const LAB_WATER = -3;

export interface StreetRec {
  id: number;
  path: Polyline;
  /** Per-vertex full widths. */
  widths: number[];
  rank: number;
  role: StreetRole;
  phase: number;
  /** false for zero-width guide lines (e.g. none yet). */
  ribbon: boolean;
}

export class Streets {
  list: StreetRec[] = [];
  private idx = new GridIndex<{ s: number; i: number }>(30);

  add(path: Polyline, width: number | number[], rank: number, role: StreetRole, phase: number, ribbon = true): number {
    const id = this.list.length;
    const widths = typeof width === 'number' ? path.map(() => width) : width;
    this.list.push({ id, path, widths, rank, role, phase, ribbon });
    for (let i = 1; i < path.length; i++) this.idx.insertSeg(path[i - 1], path[i], { s: id, i: i - 1 });
    return id;
  }

  /** Nearest street segment to p within r: street id, distance and the local half width. */
  nearest(p: Vec2, r: number, filter?: (s: StreetRec) => boolean): { s: number; d: number; hw: number; seg: number } | null {
    let bs = -1, bd = r, bseg = 0, bt = 0;
    this.idx.forEachIn(p.x - r, p.y - r, p.x + r, p.y + r, (ref) => {
      const st = this.list[ref.s];
      if (filter && !filter(st)) return;
      const a = st.path[ref.i], b = st.path[ref.i + 1];
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
      const d = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
      if (d < bd || (d === bd && bs >= 0 && ref.s < bs)) { bd = d; bs = ref.s; bseg = ref.i; bt = t; }
    });
    if (bs < 0) return null;
    const st = this.list[bs];
    const hw = (st.widths[bseg] * (1 - bt) + st.widths[bseg + 1] * bt) / 2;
    return { s: bs, d: bd, hw, seg: bseg };
  }

  query(poly: Polygon, margin: number): StreetRec[] {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of poly) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    const ids = new Set<number>();
    for (const ref of this.idx.query(x0 - margin, y0 - margin, x1 + margin, y1 + margin)) ids.add(ref.s);
    return [...ids].sort((a, b) => a - b).map((i) => this.list[i]);
  }
}

/** Width jitter along a path: smooth random multiplier in [1 − j, 1 + j]. */
export function jitterWidths(path: Polyline, w: number, j: number, rnd: () => number): number[] {
  if (j <= 0) return path.map(() => w);
  const out: number[] = [];
  let acc = 0;
  const ph = rnd() * 100, f1 = 1 / (40 + rnd() * 50), f2 = 1 / (15 + rnd() * 15);
  for (let i = 0; i < path.length; i++) {
    if (i > 0) acc += dist(path[i - 1], path[i]);
    const m = 1 + j * (0.65 * Math.sin(acc * f1 * 6.283 + ph) + 0.35 * Math.sin(acc * f2 * 6.283 + ph * 1.7));
    out.push(w * m);
  }
  return out;
}
