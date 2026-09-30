import type { Rng } from '../core/rng';
import { Noise2D } from '../core/noise';
import { MinHeap } from '../core/pq';
import { Grid, createGrid, blurGrid, D8, D8_DIST } from '../core/grid';
import { Vec2, dist, polygonContains, polygonArea, polylineLength } from '../core/geom';
import { distanceField, forCellsNearPolyline, smoothstep } from '../core/field';
import { nearestOn, lengths, pointAt, tangentAt } from '../core/pline';
import { SITE_ARCHETYPES } from '../options';
import type { Options, SizeName, SiteArchetype } from '../options';
import type { TerrainLayer, SiteLayer, SiteFields, River } from '../types';

export const RESERVE_RADIUS: Record<SizeName, number> = { hamlet: 90, village: 170, town: 380, city: 700, capital: 1150 };
/** Channels at least this wide (m) count as real rivers (bridged, fronted by towns); narrower ones are brooks. */
export const BIG_RIVER_W = 4.5;

/** Passability classes: 0 blocked, 1 land, 2 brook (ford/small bridge), 3 bridgeable main river. */
export function passability(terrain: TerrainLayer, f: SiteFields): Uint8Array {
  const N = terrain.water.length;
  const p = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const wv = terrain.water[i];
    if (wv === 0) p[i] = 1;
    else if (wv === 3) p[i] = f.riverMask[i] === 1 ? (f.bridgeZone[i] ? 3 : 0) : (f.wide && f.wide[i] ? 3 : 2);
  }
  return p;
}

export function dijkstra(
  w: number, h: number, start: number, stepCost: (from: number, to: number, dist: number) => number,
): Float32Array {
  const N = w * h;
  const d = new Float64Array(N).fill(Infinity);
  const heap = new MinHeap<number>();
  d[start] = 0; heap.push(start, 0);
  while (heap.size) {
    const key = heap.peekKey();
    const c = heap.pop()!;
    if (key > d[c]) continue;
    const cx = c % w, cy = (c / w) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = cx + D8[k][0], ny = cy + D8[k][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      const sc = stepCost(c, n, D8_DIST[k]);
      if (sc === Infinity) continue;
      const nd = key + sc;
      if (nd < d[n]) { d[n] = nd; heap.push(n, nd); }
    }
  }
  return Float32Array.from(d);
}

interface Cand { i: number; q: number; crossing?: Vec2; harbor?: Vec2; feature?: Vec2 }
interface Need { habMin: number; habMax?: number; slopeMax: number; smoothMax: number; bfracMin: number; rb: number }
interface Anchor { p: Vec2; q: number; s: number; total: number; r: River; w: number; t: Vec2; nrm: Vec2 }

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const SIDE: Record<'N' | 'E' | 'S' | 'W', Vec2> = { N: { x: 0, y: -1 }, S: { x: 0, y: 1 }, E: { x: 1, y: 0 }, W: { x: -1, y: 0 } };

/** Base probability weight of each archetype by settlement size (hilltop rarer for big cities). */
const SIZE_IDX: Record<SizeName, number> = { hamlet: 0, village: 1, town: 2, city: 3, capital: 4 };
const HILLTOP_BY_SIZE = [1.5, 1.15, 0.7, 0.28, 0.1];
const RELIEF_HILL = { flat: 0.3, hills: 1, valley: 0.85, mountains: 1.5 } as const;

export function chooseSite(terrain: TerrainLayer, opts: Options, mapSize: number, rng: Rng): SiteLayer {
  const { w: n, cell } = terrain.height;
  const N = n * n;
  const H = terrain.height.data;
  const water = terrain.water;
  const r = rng.fork('site');
  const S = mapSize;
  const prefs = opts.sitePrefs ?? {};

  // ---- river masks (1 main, 2 brook), restricted to water cells
  const riverMask = new Uint8Array(N);
  const main = terrain.rivers.find((rv) => rv.main);
  const markRiver = (rv: typeof terrain.rivers[number], val: number) => {
    for (let i = 1; i < rv.path.length; i++) {
      const rad = Math.max(rv.width[i] / 2, cell * 0.6) + cell * 0.8;
      forCellsNearPolyline([rv.path[i - 1], rv.path[i]], n, n, cell, rad, (idx) => {
        if (water[idx] === 3 && (val === 1 || riverMask[idx] === 0)) riverMask[idx] = val;
      });
    }
  };
  for (const rv of terrain.rivers) if (!rv.main) markRiver(rv, 2);
  if (main) markRiver(main, 1);
  // any river-water cell not claimed by a stroke counts as a brook
  for (let i = 0; i < N; i++) if (water[i] === 3 && !riverMask[i]) riverMask[i] = 2;
  // channels wider than a brook need a bridge (fords are for brooks only); `bigM` = real rivers (towns front them)
  const wide = new Uint8Array(N);
  const bigM = new Uint8Array(N);
  for (const rv of terrain.rivers) {
    for (let i = 1; i < rv.path.length; i++) {
      const wd = Math.max(rv.width[i - 1], rv.width[i]);
      if (wd <= 3.7) continue;
      forCellsNearPolyline([rv.path[i - 1], rv.path[i]], n, n, cell, wd / 2 + cell * 0.8, (idx) => { if (water[idx] === 3) { wide[idx] = 1; if (wd >= BIG_RIVER_W) bigM[idx] = 1; } });
    }
  }

  // ---- distance fields
  const anyW = new Uint8Array(N), seaM = new Uint8Array(N), mainM = new Uint8Array(N);
  const carry = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (water[i]) { anyW[i] = 1; carry[i] = water[i] === 1 ? 0 : H[i]; }
    if (water[i] === 1) seaM[i] = 1;
    if (riverMask[i] === 1) mainM[i] = 1;
  }
  if (main && Math.max(...main.width) < 9) for (const rv of [main]) forCellsNearPolyline(rv.path, n, n, cell, 2 * cell, (idx) => { if (water[idx] === 3) mainM[idx] = 1; });
  // a small "main" river is just a brook: it can be forded/bridged anywhere
  if (main && Math.max(...main.width) < 9) for (let i = 0; i < N; i++) if (riverMask[i] === 1) riverMask[i] = 2;
  const dw = distanceField(anyW, n, n, cell, carry);
  const dSea = distanceField(seaM, n, n, cell).dist;
  const dMain = distanceField(mainM, n, n, cell).dist;
  const dBig = distanceField(bigM, n, n, cell).dist;
  const hab = new Float32Array(N);
  for (let i = 0; i < N; i++) hab[i] = dw.val ? H[i] - dw.val[i] : 99;
  const slopeS = blurGrid(terrain.slope, Math.max(1, Math.round(100 / cell)), 2).data;
  const slopeRaw = terrain.slope.data;
  const hc = new Float32Array(N);
  for (let i = 0; i < N; i++) hc[i] = Math.max(0, H[i]);
  const hb = blurGrid({ ...terrain.height, data: hc }, Math.max(2, Math.round(280 / cell)), 2).data;

  const at = (x: number, y: number) => Math.min(n - 1, Math.max(0, Math.floor(y / cell))) * n + Math.min(n - 1, Math.max(0, Math.floor(x / cell)));
  const pos = (i: number): Vec2 => ({ x: ((i % n) + 0.5) * cell, y: (((i / n) | 0) + 0.5) * cell });

  // ---- how steep is "flat" on this map? (mountain maps only have gentle ground on valley floors)
  const zr: number[] = [], zs: number[] = [];
  {
    const lo = Math.floor(0.2 * n), hi = Math.ceil(0.8 * n), st = 3;
    for (let y = lo; y < hi; y += st) for (let x = lo; x < hi; x += st) { const i = y * n + x; if (water[i] === 0) { zr.push(slopeRaw[i]); zs.push(slopeS[i]); } }
    zr.sort((a, b) => a - b); zs.sort((a, b) => a - b);
  }
  const pct = (a: number[], q: number): number => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : 0);
  const capRaw = Math.max(0.09, Math.min(0.22, pct(zr, 0.12) * 1.15));
  const capSmooth = Math.max(0.11, Math.min(0.3, pct(zs, 0.12) * 1.15));
  const buildSlope = Math.max(0.15, Math.min(0.3, pct(zr, 0.3)));

  // ---- buildable land (summed-area table): dry, not steep, above the water table
  const build = new Uint8Array(N), flatM = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (water[i] === 0 && slopeRaw[i] < buildSlope && hab[i] >= 1.0) build[i] = 1;
    if (water[i] === 0 && slopeRaw[i] < capRaw) flatM[i] = 1;
  }
  const makeSat = (m: Uint8Array): Int32Array => {
    const sat = new Int32Array((n + 1) * (n + 1));
    for (let y = 0; y < n; y++) {
      let row = 0;
      for (let x = 0; x < n; x++) { row += m[y * n + x]; sat[(y + 1) * (n + 1) + x + 1] = sat[y * (n + 1) + x + 1] + row; }
    }
    return sat;
  };
  const satB = makeSat(build), satF = makeSat(flatM);
  const frac = (sat: Int32Array, x: number, y: number, rad: number): number => {
    const x0 = Math.max(0, Math.floor((x - rad) / cell)), x1 = Math.min(n - 1, Math.floor((x + rad) / cell));
    const y0 = Math.max(0, Math.floor((y - rad) / cell)), y1 = Math.min(n - 1, Math.floor((y + rad) / cell));
    const cnt = (x1 - x0 + 1) * (y1 - y0 + 1);
    const s = sat[(y1 + 1) * (n + 1) + x1 + 1] - sat[y0 * (n + 1) + x1 + 1] - sat[(y1 + 1) * (n + 1) + x0] + sat[y0 * (n + 1) + x0];
    // the window is clipped at the map edge: missing land counts as unbuildable
    const full = Math.max(1, Math.round((2 * rad) / cell) + 1) ** 2;
    return s / Math.max(cnt, full);
  };

  const Rres = RESERVE_RADIUS[opts.size];
  const margin = 0.2 * S;
  const inM = (x: number, y: number, slack = 0): boolean => x >= margin - slack && x <= S - margin + slack && y >= margin - slack && y <= S - margin + slack;
  const C0: Vec2 = { x: S / 2, y: S / 2 };
  const jit = new Noise2D(r.fork('jitter'));
  const flatW = prefs.flatness ?? 1;

  // ---- preference hooks (cultures)
  const rays: Vec2[] = [];
  for (let k = 0; k < 8; k++) rays.push({ x: Math.cos((k / 8) * 6.2832), y: Math.sin((k / 8) * 6.2832) });
  const waterDirScore = (x: number, y: number, want: Vec2): number => {
    let sc = 0, tot = 0;
    for (const d of rays) {
      let hit = 0;
      for (const rad of [80, 160, 260, 400]) {
        const px = x + d.x * rad, py = y + d.y * rad;
        if (px < 0 || py < 0 || px > S || py > S) break;
        if (water[at(px, py)]) { hit = 1 - rad / 600; break; }
      }
      const al = d.x * want.x + d.y * want.y;
      sc += al * hit; tot += Math.max(0, al);
    }
    return tot > 0 ? sc / tot : 0;
  };
  const hillDirScore = (x: number, y: number, want: Vec2): number => {
    const d = 260;
    const gx = (H[at(x + d, y)] - H[at(x - d, y)]) / (2 * d), gy = (H[at(x, y + d)] - H[at(x, y - d)]) / (2 * d);
    const g = Math.hypot(gx, gy);
    if (g < 1e-6) return 0;
    return ((gx * want.x + gy * want.y) / g) * Math.min(1, g / 0.05);
  };
  const prefBonus = (i: number, x: number, y: number): number => {
    let b = 0;
    if (prefs.waterSide) b += 1.1 * waterDirScore(x, y, SIDE[prefs.waterSide]);
    if (prefs.hillSide) b += 1.1 * hillDirScore(x, y, SIDE[prefs.hillSide]);
    if (prefs.mountainFace) b += 1.4 * prefs.mountainFace * smoothstep(slopeS[i] + 0.4 * Math.max(0, (hb[i] - H[i]) * -0.01), 0.04, 0.2) * (1 - smoothstep(slopeRaw[i], 0.05, 0.12));
    return b;
  };

  // ---- cell evaluation: hard constraints (dry, flat, margin, buildable land around) then a soft score
  const NOMINAL = 2.2 + 1 + 1 + 1.8 + 0.8;
  // required share of buildable land around the center: scaled down on maps that have little of it (mountains)
  let bfracCap = 0.55;
  {
    const vals: number[] = [];
    const lo = Math.floor(0.2 * n), hi = Math.ceil(0.8 * n), st = 4;
    for (let y = lo; y < hi; y += st) for (let x = lo; x < hi; x += st) { const i = y * n + x; if (water[i] === 0) vals.push(frac(satB, (x + 0.5) * cell, (y + 0.5) * cell, 0.6 * Rres)); }
    vals.sort((a, b) => a - b);
    bfracCap = Math.max(0.2, Math.min(0.55, 0.8 * pct(vals, 0.85)));
  }
  const needDef = (): Need => ({ habMin: 1.8, slopeMax: capRaw, smoothMax: capSmooth, bfracMin: bfracCap, rb: 0.6 * Rres });
  const evalCell = (i: number, nd: Need): number => {
    if (water[i]) return -Infinity;
    const p = pos(i);
    if (!inM(p.x, p.y)) return -Infinity;
    if (slopeRaw[i] > nd.slopeMax || slopeS[i] > nd.smoothMax) return -Infinity;
    if (dw.dist[i] < 200 && hab[i] < nd.habMin) return -Infinity;
    if (nd.habMax !== undefined && hab[i] > nd.habMax) return -Infinity;
    const bf = frac(satB, p.x, p.y, nd.rb);
    if (bf < nd.bfracMin) return -Infinity;
    const flatA = 1 - smoothstep(slopeS[i], 0.15 * nd.smoothMax, 0.9 * nd.smoothMax);
    const flatP = 1 - smoothstep(slopeRaw[i], 0.3 * nd.slopeMax, 1.1 * nd.slopeMax);
    const dry = dw.dist[i] < 150 ? smoothstep(hab[i], 1, 5) : 1;
    const central = 1 - Math.min(1, dist(p, C0) / (0.3 * S)) * 0.6;
    return 2.2 * flatW * flatA + flatW * flatP + dry + 1.8 * bf + 0.8 * central + 0.25 * jit.fbm(p.x / 450, p.y / 450, 2) + prefBonus(i, p.x, p.y);
  };
  /** Best cell around `anchor` (within `rad`); `extra` adds an archetype term or vetoes (-Infinity). */
  const refine = (anchor: Vec2, rad: number, nd: Need, extra: (i: number, p: Vec2) => number): { i: number; score: number } | null => {
    const x0 = Math.max(0, Math.floor((anchor.x - rad) / cell)), x1 = Math.min(n - 1, Math.floor((anchor.x + rad) / cell));
    const y0 = Math.max(0, Math.floor((anchor.y - rad) / cell)), y1 = Math.min(n - 1, Math.floor((anchor.y + rad) / cell));
    let best = -Infinity, bi = -1;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * n + x;
      const p = pos(i);
      if (Math.hypot(p.x - anchor.x, p.y - anchor.y) > rad) continue;
      const e = evalCell(i, nd);
      if (e === -Infinity) continue;
      const ex = extra(i, p);
      if (ex === -Infinity) continue;
      if (e + ex > best) { best = e + ex; bi = i; }
    }
    return bi < 0 ? null : { i: bi, score: best };
  };
  const spaced = <T extends { p: Vec2; q: number }>(list: T[], gap: number, k: number): T[] => {
    const out: T[] = [];
    for (const c of [...list].sort((a, b) => b.q - a.q)) {
      if (out.length >= k) break;
      if (out.every((o) => dist(o.p, c.p) >= gap)) out.push(c);
    }
    return out;
  };

  // ---- river anchors (bridging points)
  const bigRivers = terrain.rivers.filter((rv) => Math.max(...rv.width) >= BIG_RIVER_W && rv.path.length > 8 && polylineLength(rv.path) > 500);
  const Rb = 0.6 * Rres;
  const riverAnchors = (filter?: (rv: River, sFromMouth: number) => boolean): Anchor[] => {
    const out: Anchor[] = [];
    for (const rv of bigRivers) {
      const L = lengths(rv.path), total = L[L.length - 1];
      const wmin = Math.min(...rv.width), wmax = Math.max(...rv.width);
      for (let s = 40; s < total - 40; s += 25) {
        if (filter && !filter(rv, total - s)) continue;
        const pp = pointAt(rv.path, s);
        const P = pp.pt;
        if (!inM(P.x, P.y, 0.05 * S)) continue;
        const t = tangentAt(rv.path, s, 12);
        const nrm = { x: -t.y, y: t.x };
        const w = rv.width[Math.min(rv.width.length - 1, pp.i)];
        let tq = 0;
        for (const side of [1, -1]) {
          const B = { x: P.x + side * nrm.x * (w / 2 + 45), y: P.y + side * nrm.y * (w / 2 + 45) };
          if (!inM(B.x, B.y, 0.05 * S)) continue;
          const bi = at(B.x, B.y);
          if (water[bi]) continue;
          tq = Math.max(tq, smoothstep(hab[bi], 1.5, 5) * (1 - smoothstep(slopeS[bi], 0.03, 0.12)) * Math.sqrt(frac(satB, B.x, B.y, Rb)));
        }
        if (tq <= 0.02) continue;
        const narrow = 0.6 * (1 - smoothstep(w, 10, 50)) + 0.4 * ((wmax - w) / (wmax - wmin + 1e-6));
        const central = 1 - Math.min(1, dist(P, C0) / (0.35 * S));
        const q = tq * (0.12 + 0.42 * narrow + 0.33 * central + 0.13 * (s / total));
        out.push({ p: P, q, s, total, r: rv, w, t, nrm });
      }
    }
    return out;
  };
  const distRiver = (rv: River, p: Vec2): number => nearestOn(rv.path, p).d;

  // ---- archetype locators ---------------------------------------------------------------
  const cands: Partial<Record<SiteArchetype, Cand>> = {};
  const setBest = (a: SiteArchetype, c: Cand | null): void => { if (c && (!cands[a] || c.q > cands[a]!.q)) cands[a] = c; };
  const q01 = (score: number, exMax: number, anchorQ: number): number => clamp01(0.5 * (score / (NOMINAL + exMax)) + 0.5 * clamp01(anchorQ));

  // bridge town: narrow, firm terrace bank near the center; the center fronts the river
  const allAnchors = riverAnchors((rv) => !(rv.mouth === 'sea' && polylineLength(rv.path) < 1) );
  const frontR = 0.3 * Rres + 45;
  const anchorCand = (an: Anchor, nd: Need, bonus: (i: number, p: Vec2) => number, exMax: number): Cand | null => {
    const res = refine(an.p, frontR, nd, (i, p) => {
      const dr = distRiver(an.r, p);
      if (dr > frontR || dr < an.w / 2 + 14) return -Infinity;
      return 0.7 * (1 - smoothstep(dr, 25, frontR)) + bonus(i, p);
    });
    if (!res) return null;
    return { i: res.i, q: q01(res.score, exMax, an.q / 0.42), crossing: an.p, feature: an.p };
  };
  {
    const inland = spaced(allAnchors.filter((a) => dSea[at(a.p.x, a.p.y)] > 110), 140, 10);
    for (const an of inland) setBest('bridge', anchorCand(an, { ...needDef(), habMin: 2.4 }, (i) => 0.5 * smoothstep(hab[i], 2, 6), 1.2));
  }
  // estuary: first bridging point a little upstream of the river mouth
  if (main && main.mouth === 'sea') {
    const s0 = 230 + 0.25 * Rres, s1 = 500 + 1.5 * Rres;
    const est = allAnchors.filter((a) => a.r === main && a.total - a.s >= s0 && a.total - a.s <= s1)
      .map((a) => ({ ...a, q: a.q * (1 - 0.45 * smoothstep(a.total - a.s, s0, s1)) }));
    for (const an of spaced(est, 120, 8)) {
      const c = anchorCand(an, { ...needDef(), habMin: 1.8, bfracMin: Math.min(0.45, bfracCap) }, (i) => 0.4 * smoothstep(hab[i], 1.8, 5), 1.1);
      if (!c) continue;
      // quay: the river bank nearest to the center
      const cp = pos(c.i);
      const nn = nearestOn(main.path, cp);
      const wq = main.width[Math.min(main.width.length - 1, nn.i)] / 2;
      const dd = dist(cp, nn.pt) || 1;
      c.harbor = { x: nn.pt.x + ((cp.x - nn.pt.x) / dd) * wq, y: nn.pt.y + ((cp.y - nn.pt.y) / dd) * wq };
      setBest('estuary', c);
    }
  }

  // confluence: the tongue of land between two rivers just upstream of their junction; valley junction: terrace edge beside it
  const tribs = terrain.rivers.filter((rv) => rv.mouth === 'river' && rv.host !== undefined && Math.max(...rv.width) >= 2.8 && polylineLength(rv.path) >= 250);
  for (const tr of tribs) {
    const host = terrain.rivers.find((q) => q.id === tr.host);
    if (!host) continue;
    const J = tr.path[tr.path.length - 1];
    if (!inM(J.x, J.y, 0.12 * S)) continue;
    const nn = nearestOn(host.path, J);
    const th = tangentAt(host.path, lengths(host.path)[nn.i] + nn.t * dist(host.path[nn.i], host.path[nn.i + 1]), 14);
    const Lt = polylineLength(tr.path);
    const Q = pointAt(tr.path, Math.max(0, Lt - 30)).pt;
    const ut = { x: (J.x - Q.x) / (dist(J, Q) || 1), y: (J.y - Q.y) / (dist(J, Q) || 1) };
    let bis = { x: -th.x - ut.x, y: -th.y - ut.y };
    const bl = Math.hypot(bis.x, bis.y);
    bis = bl < 0.25 ? { x: -th.x, y: -th.y } : { x: bis.x / bl, y: bis.y / bl };
    const wt = Math.max(...tr.width), wh = Math.max(...host.width);
    const aq = (0.5 + 0.5 * smoothstep(wt, 2.8, 9)) * (0.55 + 0.45 * (1 - Math.min(1, dist(J, C0) / (0.4 * S))));
    const dmax = 0.35 * Rres + 75;
    for (const d of [45, 80, 115]) {
      const P = { x: J.x + bis.x * d, y: J.y + bis.y * d };
      if (!inM(P.x, P.y, 0.05 * S) || water[at(P.x, P.y)]) continue;
      const res = refine(P, 55, { ...needDef(), habMin: 2.0 }, (i, p) => {
        const d1 = distRiver(host, p), d2 = distRiver(tr, p);
        if (d1 > dmax || d2 > dmax || d1 < wh / 2 + 14 || d2 < 10 || dist(p, J) > 150) return -Infinity;
        return 0.8 * (1 - Math.abs(d1 - d2) / dmax) + 0.3 * (1 - smoothstep(Math.max(d1, d2), 60, dmax));
      });
      if (!res) continue;
      const cpos = pos(res.i);
      const crossing = wh >= BIG_RIVER_W ? nearestOn(host.path, cpos).pt : undefined;
      setBest('confluence', { i: res.i, q: q01(res.score, 1.1, aq), crossing, feature: J });
    }
    // valley junction: on the terrace at the mouth of the side valley, above the floodplain
    if (wh >= BIG_RIVER_W) {
      const side = th.x * (Q.y - J.y) - th.y * (Q.x - J.x) >= 0 ? 1 : -1;
      const nrm = { x: -th.y * side, y: th.x * side };
      for (const off of [wh / 2 + 120 + 0.1 * Rres, wh / 2 + 190 + 0.1 * Rres]) {
        const P = { x: J.x + nrm.x * off - th.x * 30, y: J.y + nrm.y * off - th.y * 30 };
        if (!inM(P.x, P.y, 0.05 * S)) continue;
        const res = refine(P, 95, { ...needDef(), habMin: 3, habMax: 18 }, (i, p) => {
          const d1 = distRiver(host, p), d2 = distRiver(tr, p);
          if (d1 < 55 || d1 > 330 || d2 > 300) return -Infinity;
          return 0.5 * smoothstep(hab[i], 3, 6) * (1 - smoothstep(hab[i], 10, 18)) + 0.5 * (1 - smoothstep(d2, 60, 300));
        });
        if (!res) continue;
        setBest('valley', { i: res.i, q: q01(res.score, 1.0, aq * 0.9), crossing: nearestOn(host.path, pos(res.i)).pt, feature: J });
      }
    }
  }

  // meander neck: a tight loop of a real river enclosing dry, high-ish ground
  for (const rv of bigRivers) {
    const L = lengths(rv.path), total = L[L.length - 1];
    const step = 12;
    const samples: Vec2[] = [];
    for (let s = 0; s <= total; s += step) samples.push(pointAt(rv.path, s).pt);
    const Amin = Math.max(2.5e4, 0.3 * Math.PI * (0.5 * Rres) * (0.5 * Rres));
    for (let i = 0; i + 8 < samples.length; i += 2) {
      for (let j = i + 10; j < Math.min(samples.length, i + 140); j += 2) {
        const arc = (j - i) * step;
        const chord = dist(samples[i], samples[j]);
        if (arc < 260 || chord > 240 || chord > 0.42 * arc) continue;
        const loop = samples.slice(i, j + 1);
        const A = Math.abs(polygonArea(loop));
        if (A < Amin) continue;
        let cx = 0, cy = 0;
        for (const p of loop) { cx += p.x; cy += p.y; }
        const cen = { x: cx / loop.length, y: cy / loop.length };
        if (!polygonContains(loop, cen) || !inM(cen.x, cen.y, 0.05 * S)) continue;
        const ci = at(cen.x, cen.y);
        if (water[ci] || hab[ci] < 1.8) continue;
        const aq = 0.6 * smoothstep(A, Amin, 4 * Amin) + 0.4 * (1 - smoothstep(chord, 60, 240));
        const rad = 0.45 * Math.sqrt(A);
        const res = refine(cen, rad, { ...needDef(), bfracMin: Math.min(0.4, bfracCap), habMin: 2.0 }, (_i, p) => {
          if (!polygonContains(loop, p)) return -Infinity;
          const dr = distRiver(rv, p);
          if (dr < 30) return -Infinity;
          return 0.9 * (1 - smoothstep(dist(p, cen), 0.2 * rad, rad)) + 0.4 * smoothstep(hab[_i], 2, 8);
        });
        if (!res) continue;
        const apex = samples[Math.round((i + j) / 2)];
        const neck = { x: (samples[i].x + samples[j].x) / 2, y: (samples[i].y + samples[j].y) / 2 };
        setBest('meander', { i: res.i, q: q01(res.score, 1.3, aq * 1.3), crossing: apex, feature: neck });
      }
    }
  }

  // harbor: sheltered cove with a gentle shore; the center is within ~100 m of the quay
  const harbors: { p: Vec2; q: number }[] = [];
  if (terrain.seaFraction > 0.02) {
    const raw: { p: Vec2; q: number }[] = [];
    for (let y = Math.floor(n * 0.12); y < n * 0.88; y++) for (let x = Math.floor(n * 0.12); x < n * 0.88; x++) {
      const i = y * n + x;
      if (water[i] || dSea[i] > cell * 1.6) continue;
      const wx = (x + 0.5) * cell, wy = (y + 0.5) * cell;
      let land = 0, tot = 0;
      for (let a = 0; a < 12; a++) for (const rad of [70, 140, 210]) {
        const px = wx + Math.cos((a / 12) * 6.2832) * rad, py = wy + Math.sin((a / 12) * 6.2832) * rad;
        if (px < 0 || py < 0 || px > S || py > S) continue;
        tot++;
        if (water[at(px, py)] !== 1) land++;
      }
      const shelter = smoothstep(land / Math.max(1, tot), 0.5, 0.85);
      const flat = 1 - smoothstep(slopeS[i], 0.03, 0.16);
      raw.push({ p: { x: wx, y: wy }, q: (0.25 + 0.75 * shelter) * flat });
    }
    raw.sort((a, b) => b.q - a.q);
    for (const c of raw) {
      if (harbors.length >= 40) break;
      if (harbors.every((o) => dist(o.p, c.p) > 90)) harbors.push(c);
    }
    const hd = Math.min(160, 60 + 0.08 * Rres);
    const usable = harbors.filter((h) => inM(h.p.x, h.p.y, 0.06 * S));
    for (const hb0 of spaced(usable, 140, 10)) {
      const res = refine(hb0.p, hd, { habMin: 1.2, slopeMax: capRaw, smoothMax: capSmooth, bfracMin: Math.min(0.25, bfracCap), rb: Rb }, (i, p) => {
        if (dSea[i] < 12 || dist(p, hb0.p) > hd) return -Infinity;
        return 0.8 * (1 - smoothstep(dSea[i], 20, hd));
      });
      if (!res) continue;
      // the quay is the shore nearest to the chosen center
      const cp = pos(res.i);
      let bq: Vec2 = hb0.p, bd = Infinity;
      const x0 = Math.max(0, Math.floor((cp.x - hd * 1.6) / cell)), x1 = Math.min(n - 1, Math.floor((cp.x + hd * 1.6) / cell));
      const y0 = Math.max(0, Math.floor((cp.y - hd * 1.6) / cell)), y1 = Math.min(n - 1, Math.floor((cp.y + hd * 1.6) / cell));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const i = y * n + x;
        if (water[i] || dSea[i] > cell * 1.5) continue;
        const p = pos(i);
        const d = dist(p, cp);
        if (d < bd) { bd = d; bq = p; }
      }
      if (bd > hd) continue;
      setBest('harbor', { i: res.i, q: q01(res.score, 0.8, hb0.q), harbor: bq, feature: bq });
    }
  }

  // hilltop / spur: prominent ground with a flattish top and steep flanks
  {
    const rTop = Math.max(45, 0.28 * Rres);
    const promV: { p: Vec2; q: number; i: number }[] = [];
    const lo = Math.floor(0.2 * n), hi = Math.ceil(0.8 * n);
    const stride = Math.max(2, Math.round(16 / cell));
    for (let y = lo; y < hi; y += stride) for (let x = lo; x < hi; x += stride) {
      const i = y * n + x;
      if (water[i]) continue;
      const prom = H[i] - hb[i];
      if (prom < 6) continue;
      const p = pos(i);
      const ff = frac(satF, p.x, p.y, rTop);
      if (ff < 0.6) continue;
      let ring = 0, cnt = 0;
      for (const d of rays) {
        const px = p.x + d.x * rTop * 1.8, py = p.y + d.y * rTop * 1.8;
        if (px < 0 || py < 0 || px > S || py > S) continue;
        ring += slopeS[at(px, py)]; cnt++;
      }
      ring = cnt ? ring / cnt : 0;
      const q = 0.45 * smoothstep(prom, 6, 30) + 0.3 * ff + 0.25 * smoothstep(ring, 0.05, 0.18);
      promV.push({ p, q, i });
    }
    for (const a of spaced(promV, 200, 6)) {
      const res = refine(a.p, rTop, { habMin: 0, slopeMax: capRaw * 0.8, smoothMax: capSmooth * 0.9, bfracMin: Math.min(0.42, bfracCap), rb: 0.45 * Rres }, (i) => ((bigRivers.length > 0 || terrain.seaFraction > 0.02) && dw.dist[i] > 450 ? -Infinity : 0.6 * smoothstep(H[i] - hb[i], 4, 26)));
      if (res) setBest('hilltop', { i: res.i, q: q01(res.score, 0.6, a.q), feature: pos(res.i) });
    }
  }

  // plain / springline: flat dry ground with a spring or brook a short walk away (always available)
  {
    const lo = Math.floor(0.25 * n), hi = Math.ceil(0.75 * n);
    const stride = Math.max(1, Math.round(10 / cell));
    const nd = needDef();
    let best = -Infinity, bi = -1, bs = 0;
    for (let y = lo; y < hi; y += stride) for (let x = lo; x < hi; x += stride) {
      const i = y * n + x;
      let e = evalCell(i, nd);
      if (e === -Infinity) continue;
      const d = dw.dist[i];
      const spring = d > 40 && d < 350 ? Math.exp(-Math.max(0, d - 60) / 140) : 0;
      e += 0.8 * spring;
      if (e > best) { best = e; bi = i; bs = spring; }
    }
    if (bi >= 0 && pct(zs, 0.5) < 0.045) setBest('plain', { i: bi, q: clamp01(0.5 * (best / (NOMINAL + 0.8)) + 0.5 * (0.6 + 0.4 * bs)), feature: pos(bi) });
  }

  // ---- choose an archetype: probabilities from availability, size, relief, water, prefs ----
  const offers: Partial<Record<SiteArchetype, number>> = {};
  for (const a of SITE_ARCHETYPES) if (cands[a]) offers[a] = Math.round(cands[a]!.q * 1000) / 1000;
  const hasCoast = terrain.seaFraction > 0.02 && harbors.length > 0;
  const hasRiver = bigRivers.length > 0;
  const baseW = (a: SiteArchetype): number => {
    switch (a) {
      case 'bridge': return (hasCoast ? 0.45 : 1.0);
      case 'confluence': return 0.65;
      case 'meander': return 0.9;
      case 'harbor': return 2.4;
      case 'estuary': return 1.8;
      case 'valley': return 0.55 * (opts.relief === 'valley' || opts.relief === 'mountains' ? 1.6 : 1);
      case 'hilltop': return HILLTOP_BY_SIZE[SIZE_IDX[opts.size]] * RELIEF_HILL[opts.relief] * (hasCoast || hasRiver ? 0.3 : 1);
      default: return hasCoast || hasRiver ? 0.03 : 1.0;
    }
  };
  const QMIN = 0.22;
  const weights: { a: SiteArchetype; w: number }[] = [];
  for (const a of SITE_ARCHETYPES) {
    const c = cands[a];
    if (!c || c.q < QMIN) continue;
    const w = baseW(a) * (prefs.weights?.[a] ?? 1) * Math.pow(c.q, 1.5);
    if (w > 0) weights.push({ a, w });
  }
  const pr = r.fork('archetype');
  let chosen: SiteArchetype | null = null;
  const forced = opts.siteType && opts.siteType !== 'auto' ? opts.siteType : null;
  if (forced && cands[forced] && cands[forced]!.q >= 0.1) chosen = forced;
  else if (weights.length) {
    let tot = 0;
    for (const w of weights) tot += w.w;
    let x = pr.float() * tot;
    chosen = weights[weights.length - 1].a;
    for (const w of weights) { x -= w.w; if (x <= 0) { chosen = w.a; break; } }
  } else {
    // nothing passes the hard constraints: take the best remaining candidate (relaxed below if there is none)
    let bq = -1;
    for (const a of SITE_ARCHETYPES) if (cands[a] && cands[a]!.q > bq) { bq = cands[a]!.q; chosen = a; }
  }
  let pick: Cand | null = chosen ? cands[chosen]! : null;
  if (!pick) {
    // last resort: relaxed constraints anywhere in the 20 % margin
    const nd: Need = { habMin: 1, slopeMax: Math.max(0.16, capRaw * 1.3), smoothMax: Math.max(0.2, capSmooth * 1.3), bfracMin: 0.1, rb: 0.5 * Rres };
    let best = -Infinity, bi = -1;
    const lo = Math.floor(0.2 * n), hi = Math.ceil(0.8 * n);
    for (let y = lo; y < hi; y += 2) for (let x = lo; x < hi; x += 2) {
      const i = y * n + x;
      const e = evalCell(i, nd);
      if (e > best) { best = e; bi = i; }
    }
    if (bi < 0) bi = Math.floor(n / 2) * n + Math.floor(n / 2);
    pick = { i: bi, q: 0.05, feature: pos(bi) };
    chosen = 'plain';
  }
  const best = pick.i;
  const center: Vec2 = pos(best);
  const archetype: SiteArchetype = chosen!;

  // ---- derived site features (consistent with the archetype)
  let crossing: Vec2 | undefined = pick.crossing;
  if (!crossing && allAnchors.length) {
    let bs = Infinity;
    for (const a of allAnchors) {
      const s = dist(a.p, center) + 700 * (1 - Math.min(1, a.q / 0.42));
      if (s < bs) { bs = s; crossing = a.p; }
    }
  }
  if (!crossing && main) {
    let bd = Infinity;
    for (const p of main.path) {
      const d = dist(p, center);
      if (d < bd && p.x > 0.05 * S && p.y > 0.05 * S && p.x < 0.95 * S && p.y < 0.95 * S) { bd = d; crossing = p; }
    }
  }
  let harbor: Vec2 | undefined = pick.harbor;
  if (!harbor) {
    let bs = -Infinity;
    for (const c of harbors) {
      const d = dist(c.p, center);
      if (d > 1300) continue;
      const s = c.q * Math.exp(-d / 400);
      if (s > bs && c.q > 0.08) { bs = s; harbor = c.p; }
    }
  }
  // citadel: most defensible high ground 300..600 m away
  let citadelSpot: Vec2 | undefined;
  {
    const promVals: number[] = [];
    const lo = Math.floor(n * 0.3), hi = Math.ceil(n * 0.7);
    for (let y = lo; y < hi; y += 2) for (let x = lo; x < hi; x += 2) { const p = H[y * n + x] - hb[y * n + x]; if (p > 0) promVals.push(p); }
    promVals.sort((a, b) => a - b);
    const promN = Math.max(3, promVals.length ? promVals[Math.floor(promVals.length * 0.9)] : 5);
    const wrapAt = (wx: number, wy: number): number => {
      let c = 0;
      for (let a = 0; a < 8; a++) {
        const ca = Math.cos((a / 8) * 6.2832), sa = Math.sin((a / 8) * 6.2832);
        for (const rad of [60, 120, 180]) {
          const px = wx + ca * rad, py = wy + sa * rad;
          if (px < 0 || py < 0 || px > S || py > S) break;
          if (water[at(px, py)]) { c++; break; }
        }
      }
      return c;
    };
    let bs = -Infinity;
    const rMin = 300, rMax = 600;
    const x0 = Math.max(0, Math.floor((center.x - rMax) / cell)), x1 = Math.min(n - 1, Math.floor((center.x + rMax) / cell));
    const y0 = Math.max(0, Math.floor((center.y - rMax) / cell)), y1 = Math.min(n - 1, Math.floor((center.y + rMax) / cell));
    const hC = H[best];
    for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) {
      const wx = (x + 0.5) * cell, wy = (y + 0.5) * cell;
      const d = Math.hypot(wx - center.x, wy - center.y);
      if (d < rMin || d > rMax) continue;
      const i = y * n + x;
      if (water[i] || hab[i] < 4 || wx < 0.12 * S || wy < 0.12 * S || wx > 0.88 * S || wy > 0.88 * S) continue;
      const prom = Math.max(0, (H[i] - hb[i]) / promN);
      const wrap = wrapAt(wx, wy);
      const s = Math.min(1.4, prom) + 0.35 * Math.min(1, wrap / 4) + 0.5 * smoothstep(H[i] - hC, 0, 25)
        - 1.5 * smoothstep(slopeRaw[i], 0.18, 0.4) - 0.8 * smoothstep(slopeS[i], 0.06, 0.2) - 0.3 * (d - rMin) / (rMax - rMin);
      if (s > bs) { bs = s; citadelSpot = { x: wx, y: wy }; }
    }
    if (bs < 0.5) citadelSpot = undefined;
  }

  // ---- bridge zone + travel cost
  const bridgeZone = new Uint8Array(N);
  if (crossing) {
    const R = 260;
    const x0 = Math.max(0, Math.floor((crossing.x - R) / cell)), x1 = Math.min(n - 1, Math.floor((crossing.x + R) / cell));
    const y0 = Math.max(0, Math.floor((crossing.y - R) / cell)), y1 = Math.min(n - 1, Math.floor((crossing.y + R) / cell));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (Math.hypot((x + 0.5) * cell - crossing.x, (y + 0.5) * cell - crossing.y) <= R && riverMask[y * n + x] === 1) bridgeZone[y * n + x] = 1;
    }
  }
  const fields: SiteFields = { dWater: dw.dist, dSea, dMain, hab, slopeS, riverMask, bridgeZone, wide };
  const pass = passability(terrain, fields);
  const costArr = dijkstra(n, n, best, (from, to, d) => {
    const pt = pass[to];
    if (!pt) return Infinity;
    const g = pt >= 2 || pass[from] >= 2 ? 0 : Math.abs(H[to] - H[from]) / (d * cell);
    return d * cell * (1 + 100 * g * g) * (pt === 1 ? 1 : pt === 2 ? 4 : 3);
  });
  const cost: Grid = createGrid(n, n, cell);
  cost.data.set(costArr);

  return { center, crossing, harbor, citadelSpot, archetype, feature: pick.feature, offers, cost, reserveRadius: Rres, fields };
}
