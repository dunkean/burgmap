import type { Vec2 } from '../core/geom';

export interface ContourPath { pts: Vec2[]; closed: boolean }

/** Reusable topology and cell-block bounds for levels of one immutable FP32 field. */
export class ContourWorkspace {
  readonly first: Int32Array;
  readonly second: Int32Array;
  readonly stamps: Uint32Array;
  readonly minimum: Float32Array;
  readonly maximum: Float32Array;
  readonly columns: number;
  epoch = 0;
  constructor(f: Float32Array, readonly w: number, readonly h: number) {
    this.first = new Int32Array(w * h * 2); this.second = new Int32Array(w * h * 2);
    this.stamps = new Uint32Array(w * h * 2);
    this.columns = Math.ceil((w - 1) / 16);
    const rows = Math.ceil((h - 1) / 16);
    this.minimum = new Float32Array(this.columns * rows); this.maximum = new Float32Array(this.minimum.length);
    this.minimum.fill(Infinity); this.maximum.fill(-Infinity);
    for (let by = 0; by < rows; by++) for (let bx = 0; bx < this.columns; bx++) {
      const block = by * this.columns + bx;
      for (let y = by * 16; y <= Math.min(h - 1, by * 16 + 16); y++) for (let x = bx * 16; x <= Math.min(w - 1, bx * 16 + 16); x++) {
        const value = f[y * w + x];
        this.minimum[block] = Math.min(this.minimum[block], value); this.maximum[block] = Math.max(this.maximum[block], value);
      }
    }
  }
}

/**
 * Marching squares on a scalar field. `origin` is the world position of sample (0,0),
 * `cell` the spacing. Returns chained polylines (closed if they loop).
 * Values strictly greater than `level` count as "inside".
 */
export function marchingSquares(
  f: ArrayLike<number>, w: number, h: number, level: number, cell: number, ox = 0, oy = 0, ix = 0, iy = 0, workspace?: ContourWorkspace,
): ContourPath[] {
  // (ix, iy): integer offset of this raster in a larger one (a window): points are computed exactly as there
  // segments as pairs of edge ids
  const segA: number[] = [], segB: number[] = [];
  const pos = workspace ? undefined : new Map<number, Vec2>();

  const edgePoint = (id: number): Vec2 => {
    let p = pos?.get(id);
    if (p) return p;
    const vertical = id & 1;
    const base = id >> 1;
    const x = base % w, y = (base / w) | 0;
    let a: number, b: number, x2: number, y2: number;
    if (vertical) { a = f[y * w + x]; b = f[(y + 1) * w + x]; x2 = x; y2 = y + 1; }
    else { a = f[y * w + x]; b = f[y * w + x + 1]; x2 = x + 1; y2 = y; }
    const t = a === b ? 0.5 : (level - a) / (b - a);
    const tt = t < 0 ? 0 : t > 1 ? 1 : t;
    p = { x: ox + ((x + ix) + (x2 - x) * tt) * cell, y: oy + ((y + iy) + (y2 - y) * tt) * cell };
    pos?.set(id, p);
    return p;
  };

  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      if (workspace && x % 16 === 0) {
        const block = Math.floor(y / 16) * workspace.columns + Math.floor(x / 16);
        if (workspace.maximum[block] <= level || workspace.minimum[block] > level) { x += 15; continue; }
      }
      const v0 = f[y * w + x], v1 = f[y * w + x + 1], v2 = f[(y + 1) * w + x + 1], v3 = f[(y + 1) * w + x];
      const c = (v0 > level ? 1 : 0) | (v1 > level ? 2 : 0) | (v2 > level ? 4 : 0) | (v3 > level ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const base = y * w + x;
      const E0 = base * 2; // top
      const E1 = (base + 1) * 2 + 1; // right
      const E2 = (base + w) * 2; // bottom
      const E3 = base * 2 + 1; // left
      const push = (a: number, b: number) => { segA.push(a); segB.push(b); };
      switch (c) {
        case 1: case 14: push(E3, E0); break;
        case 2: case 13: push(E0, E1); break;
        case 3: case 12: push(E3, E1); break;
        case 4: case 11: push(E1, E2); break;
        case 6: case 9: push(E0, E2); break;
        case 7: case 8: push(E3, E2); break;
        case 5: {
          const center = (v0 + v1 + v2 + v3) / 4 > level;
          if (center) { push(E0, E1); push(E2, E3); } else { push(E3, E0); push(E1, E2); }
          break;
        }
        case 10: {
          const center = (v0 + v1 + v2 + v3) / 4 > level;
          if (center) { push(E3, E0); push(E1, E2); } else { push(E0, E1); push(E2, E3); }
          break;
        }
      }
    }
  }

  // Chain
  const nSeg = segA.length;
  if (workspace) {
    // Grid edges have degree at most two. Preserve Map insertion order using
    // touched edges, and avoid clearing the dense arrays between levels.
    if (++workspace.epoch === 0xffffffff) { workspace.stamps.fill(0); workspace.epoch = 1; }
    const { first, second, stamps, epoch } = workspace, touched: number[] = [];
    const add = (id: number, segment: number) => {
      if (stamps[id] !== epoch) { stamps[id] = epoch; first[id] = segment; second[id] = -1; touched.push(id); }
      else second[id] = segment;
    };
    for (let i = 0; i < nSeg; i++) { add(segA[i], i); add(segB[i], i); }
    const used = new Uint8Array(nSeg), out: ContourPath[] = [];
    const walk = (startSeg: number, startId: number): number[] => {
      const ids: number[] = []; let segment = startSeg, from = startId;
      for (;;) {
        used[segment] = 1;
        const to = segA[segment] === from ? segB[segment] : segA[segment]; ids.push(to);
        const a = first[to], b = second[to];
        const next = !used[a] ? a : b >= 0 && !used[b] ? b : -1;
        if (next < 0) break;
        segment = next; from = to;
      }
      return ids;
    };
    for (const id of touched) if (second[id] < 0 && !used[first[id]]) {
      out.push({ pts: [id, ...walk(first[id], id)].map(edgePoint), closed: false });
    }
    for (let segment = 0; segment < nSeg; segment++) if (!used[segment]) {
      const start = segA[segment], ids = [start, ...walk(segment, start)];
      if (ids.length > 1 && ids[ids.length - 1] === start) ids.pop();
      out.push({ pts: ids.map(edgePoint), closed: true });
    }
    return out;
  }
  const adj = new Map<number, number[]>();
  for (let i = 0; i < nSeg; i++) {
    for (const id of [segA[i], segB[i]]) {
      const l = adj.get(id);
      if (l) l.push(i); else adj.set(id, [i]);
    }
  }
  const used = new Uint8Array(nSeg);
  const out: ContourPath[] = [];

  const walk = (startSeg: number, startId: number): number[] => {
    // walk from startSeg leaving via the endpoint that is not startId
    const ids: number[] = [];
    let seg = startSeg, from = startId;
    for (;;) {
      used[seg] = 1;
      const to = segA[seg] === from ? segB[seg] : segA[seg];
      ids.push(to);
      const cand = adj.get(to)!;
      let next = -1;
      for (const s of cand) if (!used[s]) { next = s; break; }
      if (next < 0) break;
      seg = next; from = to;
    }
    return ids;
  };

  // open paths first: start at endpoints with degree 1
  for (const [id, l] of adj) {
    if (l.length !== 1) continue;
    const s = l[0];
    if (used[s]) continue;
    const ids = [id, ...walk(s, id)];
    out.push({ pts: ids.map(edgePoint), closed: false });
  }
  for (let s = 0; s < nSeg; s++) {
    if (used[s]) continue;
    const start = segA[s];
    const ids = [start, ...walk(s, start)];
    // closed loop: last id == start
    if (ids.length > 1 && ids[ids.length - 1] === start) ids.pop();
    out.push({ pts: ids.map(edgePoint), closed: true });
  }
  return out;
}
