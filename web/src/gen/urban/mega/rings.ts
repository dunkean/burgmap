/**
 * Growth lines of the megacity plan as polygons (URBAN_MORPHOLOGY §3d, URBAN_GEOMETRY §3.9).
 *
 * - Eccentric growth: each line encloses the land area its phase needs, but the city grows more along the river or
 *   the shore and along the main roads, and every phase leans to its own side (history): the cost isoline is
 *   weighted per direction, so the lines are not concentric.
 * - Partial lines: a later enclosure may take in one side only. On that sector the line *is* the older line (same
 *   vertices, same coordinates), like Charles V's wall on the right bank of Paris with Philippe Auguste's wall still
 *   standing on the left bank.
 * - Polygonal curtains: each line is fitted with a max-deviation polygon (long straight runs), its vertices snapped
 *   to the local high ground; towers go at the vertices and along the runs (wallFeatures).
 *
 * The lines are star-shaped about the center and sampled on M rays. Vertices are always ray points, so a shared
 * stretch has exactly the same vertices on both lines; consecutive lines never cross (refined where a chord would).
 */
import type { Vec2, Polygon } from '../../core/geom';
import { segSegT } from '../../geo/poly';

const TAU = Math.PI * 2;

/** Ramer–Douglas–Peucker on an open point run: keep flags (both ends kept). */
export function rdpKeep(pts: Vec2[], tol: number): boolean[] {
  const n = pts.length;
  const keep = new Array<boolean>(n).fill(false);
  if (n === 0) return keep;
  keep[0] = true; keep[n - 1] = true;
  const st: [number, number][] = [[0, n - 1]];
  while (st.length) {
    const [a, b] = st.pop()!;
    if (b - a < 2) continue;
    const A = pts[a], B = pts[b];
    const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy);
    let bi = -1, bd = tol;
    for (let i = a + 1; i < b; i++) {
      const p = pts[i];
      const d = L < 1e-9 ? Math.hypot(p.x - A.x, p.y - A.y) : Math.abs((p.x - A.x) * dy - (p.y - A.y) * dx) / L;
      if (d > bd) { bd = d; bi = i; }
    }
    if (bi >= 0) { keep[bi] = true; st.push([a, bi], [bi, b]); }
  }
  return keep;
}

export interface RingFit {
  /** Radius per ray of every line (exactly equal to the line below on a merged ray). */
  radii: number[][];
  /** merged[k][j]: line k lies on line k − 1 at ray j (k ≥ 1). */
  merged: Uint8Array[];
  /** Polygon of every line (ray order). */
  polys: Polygon[];
  /** Ray index of every polygon vertex. */
  rays: number[][];
}

/**
 * Polygons of the lines `radii` (index 0 = innermost) about `c` on M rays. Lines flagged `fixed` keep the polygon
 * given (planned figures) and take part in no merge. `tol[k]` is the fit tolerance (m); `snap(k, j, r)` may move a
 * vertex radially (high ground) and returns the new radius.
 */
export function fitRings(c: Vec2, radii: number[][], merged: Uint8Array[], tol: number[], fixed: (Polygon | null)[], snap?: (k: number, j: number, r: number) => number): RingFit {
  const nL = radii.length, M = radii[0].length;
  const dir = Array.from({ length: M }, (_, j) => ({ x: Math.cos((j / M) * TAU), y: Math.sin((j / M) * TAU) }));
  const at = (k: number, j: number): Vec2 => ({ x: c.x + dir[j].x * radii[k][j], y: c.y + dir[j].y * radii[k][j] });
  const isM = (k: number, j: number) => k >= 1 && merged[k][j] === 1;
  const forced = radii.map(() => new Uint8Array(M));
  // merge boundaries are vertices of every line of the chain sharing them
  for (let k = 1; k < nL; k++) for (let j = 0; j < M; j++) {
    const pj = (j - 1 + M) % M;
    if (merged[k][j] === merged[k][pj]) continue;
    const b = merged[k][j] ? j : pj;
    let l = k;
    forced[l][b] = 1;
    while (isM(l, b)) { l--; forced[l][b] = 1; }
  }
  const keep = radii.map(() => new Uint8Array(M));
  const selectOwn = (k: number): void => {
    const K = keep[k];
    K.fill(0);
    if (fixed[k]) return;
    const own = (j: number) => !isM(k, j);
    // anchors: forced rays, merged runs' ends; a closed line with none gets two
    const anchors: number[] = [];
    for (let j = 0; j < M; j++) if (forced[k][j] || (!own(j) && (own((j + 1) % M) || own((j - 1 + M) % M)))) anchors.push(j);
    if (!anchors.length) {
      let jm = 0;
      for (let j = 1; j < M; j++) if (radii[k][j] > radii[k][jm]) jm = j;
      anchors.push(jm, (jm + M / 2) % M);
      anchors.sort((a, b) => a - b);
    }
    for (const a of anchors) K[a] = 1;
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i], b = i + 1 < anchors.length ? anchors[i + 1] : anchors[0] + M;
      // only stretches of own rays are fitted (a merged stretch copies the line below)
      let allOwn = true;
      for (let j = a + 1; j < b; j++) if (!own(j % M)) { allOwn = false; break; }
      if (!allOwn || b - a < 2) continue;
      const pts: Vec2[] = [];
      for (let j = a; j <= b; j++) pts.push(at(k, j % M));
      const kf = rdpKeep(pts, tol[k]);
      for (let t = 1; t < kf.length - 1; t++) if (kf[t]) K[(a + t) % M] = 1;
    }
  };
  /** Final vertex rays of line k: own keeps, the line below's vertices on merged rays. */
  const fin = radii.map(() => new Uint8Array(M));
  const finalize = (k: number): void => {
    for (let j = 0; j < M; j++) fin[k][j] = isM(k, j) ? (fin[k - 1][j] | forced[k][j]) : (keep[k][j] | forced[k][j]);
  };
  for (let k = 0; k < nL; k++) {
    selectOwn(k);
    // high ground: own vertices move radially, the lines above follow on their merged rays
    if (snap && !fixed[k]) for (let j = 0; j < M; j++) {
      if (!keep[k][j] || forced[k][j] || isM(k, j)) continue;
      radii[k][j] = snap(k, j, radii[k][j]);
      for (let l = k + 1; l < nL && isM(l, j); l++) radii[l][j] = radii[k][j];
      for (let l = k + 1; l < nL; l++) if (!isM(l, j)) radii[l][j] = Math.max(radii[l][j], radii[l - 1][j] + 1);
    }
    finalize(k);
  }
  const build = (k: number): { poly: Polygon; rays: number[] } => {
    if (fixed[k]) return { poly: fixed[k]!, rays: [] };
    const rs: number[] = [];
    for (let j = 0; j < M; j++) if (fin[k][j]) rs.push(j);
    return { poly: rs.map((j) => at(k, j)), rays: rs };
  };
  // no two consecutive lines cross: a crossing chord gets the middle ray of its span as a new vertex
  for (let round = 0; round < 8; round++) {
    let added = 0;
    for (let k = 1; k < nL; k++) {
      if (fixed[k] || fixed[k - 1]) continue;
      const A = build(k), B = build(k - 1);
      const nA = A.rays.length, nB = B.rays.length;
      for (let i = 0; i < nA; i++) {
        const a0 = A.poly[i], a1 = A.poly[(i + 1) % nA];
        const ja = A.rays[i], jb = A.rays[(i + 1) % nA];
        const spanA = (jb - ja + M) % M || M;
        for (let q = 0; q < nB; q++) {
          const b0 = B.poly[q], b1 = B.poly[(q + 1) % nB];
          const ia = B.rays[q], ib = B.rays[(q + 1) % nB];
          // (angular overlap first: cheap rejection)
          const spanB = (ib - ia + M) % M || M;
          const off = (ia - ja + M) % M;
          if (off >= spanA && (ja - ia + M) % M >= spanB) continue;
          if ((a0.x === b0.x && a0.y === b0.y) || (a0.x === b1.x && a0.y === b1.y) || (a1.x === b0.x && a1.y === b0.y) || (a1.x === b1.x && a1.y === b1.y)) continue;
          const r = segSegT(a0, a1, b0, b1);
          if (!r || r.t < -1e-9 || r.t > 1 + 1e-9 || r.u < -1e-9 || r.u > 1 + 1e-9) continue;
          if (spanA > 1) { const m = (ja + (spanA >> 1)) % M; if (isM(k, m)) { let l = k; while (isM(l, m)) l--; keep[l][m] = 1; } else keep[k][m] = 1; added++; }
          if (spanB > 1) { const m = (ia + (spanB >> 1)) % M; let l = k - 1; while (isM(l, m)) l--; keep[l][m] = 1; added++; }
        }
      }
    }
    if (!added) break;
    for (let k = 0; k < nL; k++) finalize(k);
  }
  const polys: Polygon[] = [], rays: number[][] = [];
  for (let k = 0; k < nL; k++) { const b = build(k); polys.push(b.poly); rays.push(b.rays); }
  return { radii, merged, polys, rays };
}

/** Exact key of a segment (either direction). */
export const segKey = (a: Vec2, b: Vec2): string => (a.x < b.x || (a.x === b.x && a.y < b.y) ? `${a.x},${a.y},${b.x},${b.y}` : `${b.x},${b.y},${a.x},${a.y}`);
