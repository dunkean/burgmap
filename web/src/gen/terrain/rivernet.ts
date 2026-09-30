import type { Rng } from '../core/rng';
import { Vec2, Polyline, dist, polylineLength, chaikin, resample } from '../core/geom';
import {
  nearestOn, firstCrossing, selfIntersects, pointAt, tangentAt, bezier, insertVertex, blendEnd, rot, lengths, slicePolyline,
} from '../core/pline';
import type { River, RiverClass } from '../types';

/**
 * River network model.
 *
 * Every channel carries a contributing area (virtual m2, including a catchment that lies outside the map).
 * Width follows the hydraulic-geometry law  w = WIDTH_K * sqrt(area).  Channels whose head sits inside the map
 * are brooks (width capped at `scale.brook`); anything wider must be fed from a map edge (`edgeFed`), directly or
 * through a tributary that is.  Confluences are cut to an acute angle pointing downstream.
 */

export const WIDTH_K = 0.0024;
export const widthOfArea = (a: number): number => WIDTH_K * Math.sqrt(Math.max(0, a));
export const areaOfWidth = (w: number): number => (w / WIDTH_K) * (w / WIDTH_K);

export interface RiverScale { brook: number; stream: number; river: number }
export function scaleFor(widthK: number): RiverScale {
  const k = Math.max(0.85, Math.min(2, widthK));
  return { brook: 3.6 * k, stream: 9.5 * k, river: 26 * k };
}
export function classOfWidth(w: number, sc: RiverScale): RiverClass {
  return w <= sc.brook * 1.001 ? 'brook' : w <= sc.stream ? 'stream' : w <= sc.river ? 'river' : 'major';
}
export const CLASS_RANK: Record<RiverClass, number> = { brook: 0, stream: 1, river: 2, major: 3 };

export interface RawChan {
  path: Polyline;
  forced: boolean;
  end: 'host' | 'sea' | 'lake' | 'edge' | 'none';
  /** index into the raw list of the channel this one runs into, -1 = main river, -2 = none */
  hostRaw: number;
  lakeSrc: number;
  endLake: number;
  /** grid accumulation (cells) at the last cell: ranks edge-feed candidates */
  endAcc: number;
}

export interface GeoChan {
  id: number;
  raw: number;
  path: Polyline;
  host: number; // id of receiving channel, -1 none
  edgeFed: boolean;
  w0: number; // edge width when edgeFed
  forced: boolean;
  end: RawChan['end'];
  lakeSrc: number;
  endLake: number;
}

export interface AssembleInput {
  chans: RawChan[];
  main: Polyline | null;
  mapSize: number;
  cell: number;
  scale: RiverScale;
  rng: Rng;
  /** how many edge-fed tributaries to create (0 = none) */
  nEdge: number;
  /** width (m) of an edge-fed tributary at the map edge, range */
  edgeW: [number, number];
  /** widths used for the proximity test */
  mainMaxW: number;
  minLen: number;
  isWet: (p: Vec2) => boolean;
}

const MAIN_ID = 0;

function toEdge(p: Vec2, S: number): { e: Vec2; d: number } {
  const ds = [p.x, p.y, S - p.x, S - p.y];
  let k = 0;
  for (let i = 1; i < 4; i++) if (ds[i] < ds[k]) k = i;
  const e = k === 0 ? { x: 0, y: p.y } : k === 1 ? { x: p.x, y: 0 } : k === 2 ? { x: S, y: p.y } : { x: p.x, y: S };
  return { e, d: ds[k] };
}

const DEG = Math.PI / 180;

/** Geometry of the natural channels: host snapping, confluence angles, no crossings / parallel runs. */
export function assembleChannels(inp: AssembleInput): GeoChan[] {
  const { chans, mapSize: S, rng, scale } = inp;
  const out: GeoChan[] = [];
  const fin = new Map<number, { path: Polyline; wEst: number }>();
  if (inp.main) fin.set(MAIN_ID, { path: inp.main, wEst: inp.mainMaxW });

  // ---- edge-fed tributary candidates: heads close to a map edge
  const edgeSet = new Map<number, { ext: Polyline; w0: number }>();
  if (inp.nEdge > 0 && inp.main) {
    const dMax = 0.14 * S;
    const cands = chans.map((c, i) => ({ c, i })).filter(({ c }) => !c.forced && c.lakeSrc < 0 && c.end !== 'lake' && c.path.length > 3 && (c.end === 'host' || c.end === 'sea' || dist(c.path[0], c.path[c.path.length - 1]) > 0.5 * S))
      .map(({ c, i }) => ({ c, i, ...toEdge(c.path[0], S) })).filter((e) => e.d < dMax && e.d > 8);
    cands.sort((a, b) => b.c.endAcc - a.c.endAcc || a.i - b.i);
    const erng = rng.fork('edgefed');
    for (const cd of cands) {
      if (edgeSet.size >= inp.nEdge) break;
      // tangent-continuous lead-in: Bezier from the edge (leaving perpendicular to it) into the natural channel
      const Lh = polylineLength(cd.c.path);
      const sH = Math.min(70, Lh * 0.4);
      const Hk = pointAt(cd.c.path, sH).pt;
      const dirH = tangentAt(cd.c.path, sH, 10);
      const nE = cd.e.x === 0 ? { x: 1, y: 0 } : cd.e.x === S ? { x: -1, y: 0 } : cd.e.y === 0 ? { x: 0, y: 1 } : { x: 0, y: -1 };
      const D = dist(cd.e, Hk);
      const c1 = { x: cd.e.x + nE.x * D * 0.4, y: cd.e.y + nE.y * D * 0.4 };
      const c2 = { x: Hk.x - dirH.x * D * 0.4, y: Hk.y - dirH.y * D * 0.4 };
      const ext: Polyline = [{ ...cd.e }, ...bezier(cd.e, c1, c2, Hk, Math.max(6, Math.round(D / 9)))];
      let acc0 = 0;
      for (let i = 1; i < cd.c.path.length; i++) { acc0 += dist(cd.c.path[i - 1], cd.c.path[i]); if (acc0 > sH + 1e-6) ext.push(cd.c.path[i]); }
      if (selfIntersects(ext)) continue;
      if (ext.slice(0, Math.max(2, Math.round(D / 9) + 2)).some((p, i) => i > 0 && inp.isWet(p))) continue;
      if (inp.main && firstCrossing(ext, inp.main)) continue;
      edgeSet.set(cd.i, { ext, w0: erng.range(inp.edgeW[0], inp.edgeW[1]) });
    }
  }

  // ---- processing order: hosts before tributaries
  const depth = new Array<number>(chans.length).fill(-1);
  const depthOf = (i: number, guard = 0): number => {
    if (depth[i] >= 0) return depth[i];
    const h = chans[i].hostRaw;
    const d = h < 0 || guard > 60 ? 0 : 1 + depthOf(h, guard + 1);
    depth[i] = d;
    return d;
  };
  const order = chans.map((_, i) => i).sort((a, b) => depthOf(a) - depthOf(b) || a - b);
  const idOfRaw = new Map<number, number>();
  let nextId = 1;
  const brookW = scale.brook;

  for (const ri of order) {
    const c = chans[ri];
    const ed = edgeSet.get(ri);
    let path: Polyline = ed ? ed.ext.slice() : c.path.slice();
    if (path.length < 2) continue;
    const wEst = ed ? ed.w0 : brookW;
    const crng = rng.fork('conf:' + ri);

    // ---- first contact with a finalized channel (crossing or running alongside)
    const rs = resample(path, 3);
    rs[0] = path[0];
    let contact: { s: number; id: number } | null = null;
    const skip = ed ? 70 : 45;
    for (let k = 0; k < rs.length && !contact; k++) {
      const s = k * 3;
      if (s < skip) continue;
      for (const [id, f] of fin) {
        const thr = 9 + 0.5 * (wEst + f.wEst);
        if (nearestOn(f.path, rs[k]).d < thr) { contact = { s, id }; break; }
      }
    }
    let hostId = -1;
    let hostPath: Polyline | null = null;
    let J: Vec2 | null = null;
    let end = c.end;
    if (contact) {
      hostId = contact.id;
      hostPath = fin.get(hostId)!.path;
      const cp = pointAt(path, Math.min(contact.s, polylineLength(path))).pt;
      J = nearestOn(hostPath, cp).pt;
      path = slicePolyline(path, 0, Math.max(3, contact.s - 6));
      end = 'host';
    } else if (c.end === 'host' || (c.end === 'none' && toEdge(path[path.length - 1], S).d >= 40)) {
      // intended host, else nearest finalized channel within reach
      const want = c.hostRaw === -1 ? MAIN_ID : idOfRaw.get(c.hostRaw);
      const last = path[path.length - 1];
      let best: { id: number; d: number } | null = null;
      for (const [id, f] of fin) {
        const d = nearestOn(f.path, last).d - (id === want ? 40 : 0);
        if (!best || d < best.d) best = { id, d };
      }
      if (!best) continue;
      const f = fin.get(best.id)!;
      const nn = nearestOn(f.path, last);
      if (nn.d > 170) continue;
      hostId = best.id; hostPath = f.path; J = nn.pt;
    }
    if (!hostPath && (end === 'edge' || end === 'none')) {
      const te = toEdge(path[path.length - 1], S);
      if (te.d < 40) { path = path.concat([te.e]); end = 'edge'; } else continue;
    }

    // ---- shape the confluence
    if (hostPath && J) {
      const nn = nearestOn(hostPath, J);
      const vi = insertVertex(hostPath, nn.i, nn.t);
      const Jv = hostPath[vi];
      const sJ = lengths(hostPath)[vi];
      const th = tangentAt(hostPath, sJ, 14);
      const Lp = polylineLength(path);
      const qPt = pointAt(path, Math.max(0, Lp - 28)).pt;
      const side = th.x * (qPt.y - Jv.y) - th.y * (qPt.x - Jv.x) >= 0 ? 1 : -1;
      const approachAng = (() => {
        const dx = Jv.x - qPt.x, dy = Jv.y - qPt.y, l = Math.hypot(dx, dy) || 1;
        return Math.acos(Math.max(-1, Math.min(1, (dx * th.x + dy * th.y) / l)));
      })();
      const cur = path.slice();
      cur.push({ x: Jv.x, y: Jv.y });
      let result: Polyline = cur;
      void approachAng;
      {
        const theta = crng.range(40, 60) * DEG;
        // flow direction at the junction: host tangent rotated towards the host, away from the tributary's side
        const u = rot(th, -side * theta);
        const ok = (cand: Polyline): boolean => {
          if (selfIntersects(cand)) return false;
          for (const [id, f] of fin) {
            const probe = id === hostId ? cand.slice(0, -1) : cand;
            if (probe.length >= 2 && firstCrossing(probe, f.path)) return false;
          }
          return true;
        };
        const b = blendEnd(cur.slice(0, -1).concat([{ x: Jv.x, y: Jv.y }]), Jv, u, 38, ok);
        if (b) result = b;
      }
      path = result;
      path[path.length - 1] = { x: Jv.x, y: Jv.y };
    }

    if (!c.forced && !ed && polylineLength(path) < inp.minLen) continue;
    if (polylineLength(path) < 40) continue;
    const id = nextId++;
    idOfRaw.set(ri, id);
    fin.set(id, { path, wEst });
    out.push({ id, raw: ri, path, host: hostPath ? hostId : -1, edgeFed: !!ed, w0: ed ? ed.w0 : 0, forced: c.forced, end: hostPath ? 'host' : end, lakeSrc: c.lakeSrc, endLake: c.endLake });
  }
  return out;
}

// ---------------------------------------------------------------- hydraulics

const movingAvg = (a: number[], r: number): number[] => {
  const out = new Array<number>(a.length);
  for (let i = 0; i < a.length; i++) {
    let s = 0, n = 0;
    for (let k = -r; k <= r; k++) { const j = i + k; if (j >= 0 && j < a.length) { s += a[j]; n++; } }
    out[i] = s / n;
  }
  return out;
};
const cummax = (a: number[]): number[] => { const o = a.slice(); for (let i = 1; i < o.length; i++) o[i] = Math.max(o[i], o[i - 1]); return o; };

export interface HydraulicsInput {
  rivers: River[];
  scale: RiverScale;
  /** internal catchment (cells * cell^2, unscaled) around a point, before any runoff scaling */
  aint: (p: Vec2, r: River) => number;
  /** external catchment of the main river at its head (m2) and runoff multiplier for internal area */
  mainAext: number;
  lam: number;
  lamBrook: number;
  lamEdge: number;
  mainMouthW: number;
  mainHeadW: number;
  /** estuary widening factor (>=1) at the last vertex of the main river, 1 = none */
  estuary: number;
  minBrookW: number;
}

/** Assign width / class / contributing areas to every river (in place). */
export function assignHydraulics(inp: HydraulicsInput): void {
  const { rivers, scale } = inp;
  const byId = new Map<number, River>();
  for (const r of rivers) if (r.id !== undefined) byId.set(r.id, r);
  // drop rivers whose host vanished (e.g. clipped away)
  for (let k = rivers.length - 1; k >= 0; k--) {
    const r = rivers[k];
    if (r.mouth === 'river' && r.host !== undefined && !byId.has(r.host)) { byId.delete(r.id!); rivers.splice(k, 1); }
  }
  const children = new Map<number, { r: River; at: number }[]>();
  const lakeIn = new Map<number, River[]>();
  for (const r of rivers) {
    if (r.mouth === 'river' && r.host !== undefined) {
      const h = byId.get(r.host);
      if (!h) continue;
      const nn = nearestOn(h.path, r.path[r.path.length - 1]);
      const at = nn.t >= 0.5 ? nn.i + 1 : nn.i;
      (children.get(h.id!) ?? children.set(h.id!, []).get(h.id!)!).push({ r, at });
    } else if (r.mouth === 'lake' && r.endLake !== undefined && r.endLake >= 0) {
      (lakeIn.get(r.endLake) ?? lakeIn.set(r.endLake, []).get(r.endLake)!).push(r);
    }
  }
  const memo = new Map<River, { extEnd: number; areaEnd: number }>();
  const extMin = areaOfWidth(scale.brook) * 0.3;
  const calc = (r: River, guard = 0): { extEnd: number; areaEnd: number } => {
    const m = memo.get(r);
    if (m) return m;
    const n = r.path.length;
    const ext = new Array<number>(n).fill(0);
    let base = 0;
    if (r.main) base = inp.mainAext;
    else if (r.edgeFed) base = areaOfWidth(r.w0 ?? scale.brook * 1.5);
    if (r.source === 'lake' && r.lakeId !== undefined && r.lakeId >= 0 && guard < 30) {
      for (const inflow of lakeIn.get(r.lakeId) ?? []) if (inflow !== r) base += calc(inflow, guard + 1).extEnd;
    }
    for (let i = 0; i < n; i++) ext[i] = base;
    if (guard < 30) {
      for (const { r: ch, at } of children.get(r.id!) ?? []) {
        const e = calc(ch, guard + 1).extEnd;
        if (e > 0) for (let v = Math.min(n - 1, at); v < n; v++) ext[v] += e;
      }
    }
    const lam = r.main ? inp.lam : r.edgeFed ? Math.min(inp.lam, inp.lamEdge) : inp.lamBrook;
    let intA = r.path.map((p) => lam * inp.aint(p, r));
    intA = movingAvg(cummax(intA), 6);
    const extS = ext;
    const sumTrib = new Array<number>(n).fill(0);
    for (const { r: ch, at } of children.get(r.id!) ?? []) {
      const ca = memo.get(ch)?.areaEnd ?? 0;
      for (let v = Math.min(n - 1, at); v < n; v++) sumTrib[v] += ca;
    }
    let area = cummax(intA.map((a, i) => Math.max(a + extS[i], base + sumTrib[i])));
    let width = area.map((a, i) => {
      const wa = widthOfArea(a);
      if (r.main) return Math.max(inp.mainHeadW, Math.min(wa, inp.mainMouthW * 1.6));
      if (extS[i] >= extMin) return wa;
      return Math.max(inp.minBrookW, Math.min(wa, scale.brook));
    });
    const clsW = Math.max(...width);
    if (r.main && inp.estuary > 1) {
      const L = lengths(r.path);
      const T = L[n - 1] || 1;
      const k = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
      width = width.map((w, i) => w * (1 + (inp.estuary - 1) * k((L[i] / T - 0.88) / 0.12)));
    }
    width = cummax(width);
    // the stored area is the one the width is a function of (covers the floors and the tidal prism)
    area = area.map((a, i) => Math.max(a, areaOfWidth(width[i])));
    r.width = width;
    r.area = area;
    r.ext = extS;
    r.cls = classOfWidth(clsW, scale);
    const res = { extEnd: extS[n - 1], areaEnd: area[n - 1] };
    memo.set(r, res);
    return res;
  };
  for (const r of rivers) calc(r);
}
