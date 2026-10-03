import polygonClipping from 'polygon-clipping';
import { Delaunay } from 'd3-delaunay';
import type { Rng } from '../../src/gen/core/rng';
import { Noise2D } from '../../src/gen/core/noise';
import { blurGrid, gradientAt, D8 } from '../../src/gen/core/grid';
import { Vec2, Polygon, Polyline, chaikin, simplify, polygonArea, polygonCentroid, polygonContains, bbox, dist } from '../../src/gen/core/geom';
import { distanceField, forCellsNearPolyline, smoothstep } from '../../src/gen/core/field';
import { marchingSquares } from '../../src/gen/terrain/contour';
import { rasterizePolys } from '../../src/gen/geo/raster';
import type { World, LandArea, LandKind, Farmstead, LandUseLayer } from '../../src/gen/types';

type Ring = [number, number][];

const K_NONE = 0;
const KINDS: (LandKind | null)[] = [null, 'field', 'meadow', 'pasture', 'forest', 'orchard', 'garden', 'marsh', 'commons'];
const C = { NONE: 0, FIELD: 1, MEADOW: 2, PASTURE: 3, FOREST: 4, ORCHARD: 5, GARDEN: 6, MARSH: 7, COMMONS: 8 } as const;

/** Rectangle polygon centered at (cx, cy) with long axis at `ang`. */
function rect(cx: number, cy: number, len: number, wid: number, ang: number): Polygon {
  const c = Math.cos(ang), s = Math.sin(ang);
  const pts: [number, number][] = [[-len / 2, -wid / 2], [len / 2, -wid / 2], [len / 2, wid / 2], [-len / 2, wid / 2]];
  return pts.map(([u, v]) => ({ x: cx + u * c - v * s, y: cy + u * s + v * c }));
}

const toRing = (p: Polygon): Ring => {
  const r = p.map((q) => [q.x, q.y] as [number, number]);
  r.push([p[0].x, p[0].y]);
  return r;
};
const fromRing = (r: Ring): Polygon => {
  const out = r.map(([x, y]) => ({ x, y }));
  if (out.length > 1 && out[0].x === out[out.length - 1].x && out[0].y === out[out.length - 1].y) out.pop();
  return out;
};

interface Region { outer: Polygon; holes: Polygon[] }

/** Smooth region polygons (with holes) of the cells where `ind` is 1. */
function vectorize(ind: Float32Array, w: number, h: number, cell: number, minArea: number): Region[] {
  const bl = blurGrid({ w, h, cell, data: ind }, 1, 1).data;
  const pw = w + 2, ph = h + 2;
  const pad = new Float32Array(pw * ph);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pad[(y + 1) * pw + x + 1] = bl[y * w + x];
  const paths = marchingSquares(pad, pw, ph, 0.5, cell, -0.5 * cell, -0.5 * cell);
  const loops: Polygon[] = [];
  for (const p of paths) {
    if (!p.closed || p.pts.length < 4) continue;
    let pts = chaikin(p.pts, 2, true);
    pts = simplify(pts, 0.1 * cell);
    if (pts.length >= 3 && Math.abs(polygonArea(pts)) >= minArea * 0.4) loops.push(pts);
  }
  const areas = loops.map((l) => Math.abs(polygonArea(l)));
  const depth = loops.map((l, i) => {
    let d = 0;
    for (let j = 0; j < loops.length; j++) if (j !== i && areas[j] > areas[i] && polygonContains(loops[j], l[0])) d++;
    return d;
  });
  const out: Region[] = [];
  const outerIdx: number[] = [];
  loops.forEach((l, i) => { if (depth[i] % 2 === 0 && areas[i] >= minArea) { outerIdx.push(i); out.push({ outer: l, holes: [] }); } });
  loops.forEach((l, i) => {
    if (depth[i] % 2 === 1 && areas[i] >= minArea * 0.5) {
      let bi = -1, ba = Infinity;
      outerIdx.forEach((oi, k) => { if (areas[oi] > areas[i] && areas[oi] < ba && polygonContains(loops[oi], l[0])) { ba = areas[oi]; bi = k; } });
      if (bi >= 0) out[bi].holes.push(l);
    }
  });
  return out;
}

function circleRing(c: Vec2, r: number): Polygon {
  const out: Polygon = [];
  for (let i = 0; i < 12; i++) { const a = (i / 12) * 2 * Math.PI; out.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }); }
  return out;
}

/** Scale (m) of a settlement's rural rings: the preset map extents for the legacy sizes (hamlet 1.2 km … capital 5 km). */
export function ringScale(pop: number): number {
  return pop < 15 ? 450 : 1200 * Math.pow(Math.max(15, pop) / 100, 0.23);
}

/**
 * Rural land use (`stripLod`: cut the furlong strips only within that disc). With a settlement system (M3c) the von Thünen rings are computed from every settlement: the
 * main town's rings (scaled by the map extent on the legacy presets, by its population otherwise), each village's
 * and hamlet's own fields, commons and woods, and the planner's farmsteads sitting in their fields.
 * `mainRoads`: number of leading roads that belong to the main town (the legacy roadside farmsteads use only those).
 */
export function generateRural(world: World, root: Rng, mainRoads?: number, stripLod?: { center: Vec2; radius: number }): { layer: LandUseLayer; stats: Record<string, number> } {
  const terrain = world.terrain, site = world.site!;
  const roads = world.roads ?? [];
  const S = world.mapSize;
  const { w: n, cell } = terrain.height;
  const N = n * n;
  const H = terrain.height.data;
  const f = site.fields;
  const rr = root.fork('rural');
  const noise = new Noise2D(rr.fork('noise'));
  const stats: Record<string, number> = {};

  // ---- road distance + direction field, road exclusion
  const roadM = new Uint8Array(N);
  const roadAngC = new Float32Array(N);
  const excl = new Uint8Array(N);
  for (const rd of roads) {
    const R = rd.width / 2 + 0.75 * cell + 3;
    for (let i = 1; i < rd.path.length; i++) {
      const a = rd.path[i - 1], b = rd.path[i];
      const ang = ((Math.atan2(b.y - a.y, b.x - a.x) % Math.PI) + Math.PI) % Math.PI;
      forCellsNearPolyline([a, b], n, n, cell, cell * 0.7, (idx) => { roadM[idx] = 1; roadAngC[idx] = ang; });
    }
    forCellsNearPolyline(rd.path, n, n, cell, R, (idx) => { excl[idx] = 1; });
  }
  const dRoadF = distanceField(roadM, n, n, cell, roadAngC);
  const dRoad = dRoadF.dist, roadAng = dRoadF.val!;

  // ---- urban reserve: the actual urban footprint (plus a margin for walls, ditches and lanes) when the town
  // exists, else the old travel-cost disc. `uDist` = travel cost beyond the footprint edge (von Thünen rings).
  const secondary = (world.settlements ?? []).filter((st) => !st.main);
  // ring scale of the main settlement: the map extent on the legacy presets (unchanged maps), else its population
  const Lm = world.options.mapSize === undefined ? S : Math.min(S, ringScale(world.urban?.population ?? 100));
  const reserveCost = 1.25 * site.reserveRadius;
  const costC = site.cost.data;
  const reserve = new Uint8Array(N);
  const uDist = new Float32Array(N);
  const foot = world.urban?.footprintH ?? [];
  if (foot.length) {
    const rings: Polygon[] = [];
    for (const ph of foot) { rings.push(ph.outer); for (const hl of ph.holes) rings.push(hl); }
    rasterizePolys(rings, n, n, cell, reserve);
    const margin = (world.urban?.walls?.length ? 14 : 5) + 0.5 * cell;
    const dRes = distanceField(reserve, n, n, cell, costC);
    for (let i = 0; i < N; i++) {
      if (dRes.dist[i] <= margin) reserve[i] = 1;
      uDist[i] = Math.max(0, Math.min(1e5, costC[i]) - (dRes.val![i] || 0));
    }
  } else {
    for (let i = 0; i < N; i++) { if (costC[i] <= reserveCost) reserve[i] = 1; uDist[i] = Math.min(1e5, costC[i]) - reserveCost; }
  }

  // ---- other settlements: their footprints (or projected extents) are reserved; their own rings join the main ones
  // (distance from the nearest settlement edge, rescaled to the main ring scale by the settlement's own ring scale)
  if (secondary.length) {
    const src = new Uint8Array(N), resSec = new Uint8Array(N);
    const scale = new Float32Array(N);
    const own = new Uint8Array(N);
    for (const st of secondary) {
      const k = Lm / ringScale(st.population);
      const rings: Polygon[] = [];
      if (st.detail === 'farmstead') rings.push(circleRing(st.center, 20));
      else if (st.urban?.footprintH.length) for (const ph of st.urban.footprintH) { rings.push(ph.outer); for (const hl of ph.holes) rings.push(hl); }
      else if (st.extent.length >= 3) rings.push(st.extent);
      if (!rings.length) continue;
      rasterizePolys(rings, n, n, cell, own);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const rg of rings) for (const q of rg) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
      const cx0 = Math.max(0, Math.floor(x0 / cell) - 1), cx1 = Math.min(n - 1, Math.ceil(x1 / cell) + 1);
      const cy0 = Math.max(0, Math.floor(y0 / cell) - 1), cy1 = Math.min(n - 1, Math.ceil(y1 / cell) + 1);
      for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) {
        const i = y * n + x;
        if (!own[i]) continue;
        own[i] = 0;
        src[i] = 1; scale[i] = k;
        if (st.detail !== 'farmstead') resSec[i] = 1;
      }
    }
    const dRes = distanceField(resSec, n, n, cell);
    const dSec = distanceField(src, n, n, cell, scale);
    // clearings are not circles: the reach of the fields varies with soil and access (low-frequency warp)
    const warp = new Noise2D(rr.fork('clearing'));
    for (let i = 0; i < N; i++) {
      if (dRes.dist[i] <= 5 + 0.5 * cell) reserve[i] = 1;
      const wx = ((i % n) + 0.5) * cell, wy = (((i / n) | 0) + 0.5) * cell;
      const u2 = dSec.dist[i] * dSec.val![i] * (1 + 0.38 * warp.fbm(wx / 650, wy / 650, 3));
      if (u2 < uDist[i]) uDist[i] = u2;
    }
  }

  // slope thresholds adapt to the relief: the best-drained/flattest ground near the town is always the arable
  const slopeL = blurGrid(terrain.slope, Math.max(1, Math.round(45 / cell)), 1).data;
  const nearSl: number[] = [];
  for (let i = 0; i < N; i += 3) if (!terrain.water[i] && costC[i] < 0.5 * Lm) nearSl.push(slopeL[i]);
  nearSl.sort((a, b) => a - b);
  const qs = (p: number) => (nearSl.length ? nearSl[Math.floor(nearSl.length * p)] : 0.05);
  const fieldCap = world.options.relief === 'mountains' ? 0.26 : 0.15; // terraced fields in the mountains
  const fieldMax = Math.max(0.06, Math.min(fieldCap, qs(0.42)));
  const pastureMax = Math.max(fieldMax + 0.03, Math.min(world.options.relief === 'mountains' ? 0.5 : 0.3, qs(0.82)));
  stats['fieldMaxSlope'] = Math.round(fieldMax * 1000) / 1000;

  // ---- farmsteads along roads
  const farmCount = ({ hamlet: 0, village: 2, town: 4, city: 7, capital: 10 } as const)[world.options.size];
  const farmsteads: Farmstead[] = [];
  const farmR = 30;
  const farmMask = new Uint8Array(N); // 1 = exclusion, 2 = garden/orchard halo
  {
    const fr = rr.fork('farm');
    const cand: { p: Vec2; t: Vec2; score: number }[] = [];
    for (const rd of mainRoads === undefined ? roads : roads.slice(0, mainRoads)) {
      if (rd.kind === 'track') continue;
      let acc = 0;
      for (let i = 1; i < rd.path.length; i++) {
        const a = rd.path[i - 1], b = rd.path[i];
        const L = dist(a, b);
        acc += L;
        if (acc < 50) continue;
        acc = 0;
        const t = { x: (b.x - a.x) / (L || 1), y: (b.y - a.y) / (L || 1) };
        const side = fr.chance(0.5) ? 1 : -1;
        const off = rd.width / 2 + 24 + fr.float() * 10;
        const p = { x: b.x - t.y * off * side, y: b.y + t.x * off * side };
        if (p.x < 0.06 * S || p.y < 0.06 * S || p.x > 0.94 * S || p.y > 0.94 * S) continue;
        const idx = Math.floor(p.y / cell) * n + Math.floor(p.x / cell);
        if (terrain.water[idx] || f.dWater[idx] < 60 || f.hab[idx] < 2.5 || slopeL[idx] > fieldMax || reserve[idx] || uDist[idx] < 0.1 * Lm || uDist[idx] > 0.42 * Lm) continue;
        cand.push({ p, t: { x: t.x * side, y: t.y * side }, score: fr.float() });
      }
    }
    cand.sort((a, b) => b.score - a.score);
    const minSp = 0.13 * Lm;
    for (const c of cand) {
      if (farmsteads.length >= farmCount) break;
      if (farmsteads.some((o) => dist(o.pos, c.p) < minSp)) continue;
      const ang = Math.atan2(c.t.y, c.t.x) + (fr.chance(0.5) ? 0 : Math.PI / 2) * 0; // aligned with the road
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const at = (u: number, v: number) => ({ x: c.p.x + u * ca - v * sa, y: c.p.y + u * sa + v * ca });
      const fw = fr.range(26, 34), fh = fr.range(22, 28);
      const yard = rect(c.p.x, c.p.y, fw, fh, ang);
      const bl: Polygon[] = [];
      const house = at(0, -fh / 2 - 5);
      bl.push(rect(house.x, house.y, fr.range(11, 15), fr.range(6.5, 8), ang));
      const barn = at(fw / 2 + 6, 0);
      bl.push(rect(barn.x, barn.y, fr.range(8, 10), fr.range(16, 22), ang));
      if (fr.chance(0.75)) { const sh = at(-fw / 2 - 5, fh * 0.15); bl.push(rect(sh.x, sh.y, fr.range(6, 9), fr.range(5, 7), ang)); }
      if (fr.chance(0.55)) { const o = at(-fw * 0.15, fh / 2 + 4.5); bl.push(rect(o.x, o.y, fr.range(9, 13), fr.range(5, 6.5), ang)); }
      // drive to the road
      let bestD = Infinity, bp: Vec2 = c.p;
      for (const rd of roads) for (let i = 1; i < rd.path.length; i++) {
        const a = rd.path[i - 1], b = rd.path[i];
        const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((c.p.x - a.x) * dx + (c.p.y - a.y) * dy) / l2));
        const q = { x: a.x + t * dx, y: a.y + t * dy };
        const d = dist(q, c.p);
        if (d < bestD) { bestD = d; bp = q; }
      }
      farmsteads.push({ pos: c.p, angle: ang, buildings: bl, yard, drive: [bp, c.p] });
      forCellsNearPolyline([c.p, c.p], n, n, cell, farmR + cell, (idx) => { farmMask[idx] = 1; });
      forCellsNearPolyline([c.p, c.p], n, n, cell, farmR + 45, (idx) => { if (!farmMask[idx]) farmMask[idx] = 2; });
      forCellsNearPolyline([bp, c.p], n, n, cell, 3 + 0.75 * cell, (idx) => { farmMask[idx] = 1; });
    }
  }
  // farmsteads of the settlement system: the farm on its track, in the middle of its own fields
  for (const st of secondary) {
    if (st.detail !== 'farmstead') continue;
    const fr = root.fork('settlement:' + st.key).fork('farm');
    let bestD = Infinity, bp: Vec2 = st.center, bt: Vec2 = { x: 1, y: 0 };
    for (const rd of roads) for (let i = 1; i < rd.path.length; i++) {
      const a = rd.path[i - 1], b = rd.path[i];
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((st.center.x - a.x) * dx + (st.center.y - a.y) * dy) / l2));
      const q = { x: a.x + t * dx, y: a.y + t * dy };
      const d = dist(q, st.center);
      if (d < bestD) { bestD = d; bp = q; const l = Math.sqrt(l2); bt = { x: dx / l, y: dy / l }; }
    }
    // the yard beside the track end, the house facing it
    const side = fr.chance(0.5) ? 1 : -1;
    const off = 22 + fr.float() * 8;
    const pos = bestD < 60 ? { x: bp.x - bt.y * off * side, y: bp.y + bt.x * off * side } : st.center;
    const pi = Math.min(n - 1, Math.max(0, Math.floor(pos.y / cell))) * n + Math.min(n - 1, Math.max(0, Math.floor(pos.x / cell)));
    const c = terrain.water[pi] ? st.center : pos;
    const ang = Math.atan2(bt.y, bt.x);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const at = (u: number, v: number) => ({ x: c.x + u * ca - v * sa, y: c.y + u * sa + v * ca });
    const fw = fr.range(24, 34), fh = fr.range(20, 28);
    const yard = rect(c.x, c.y, fw, fh, ang);
    const bl: Polygon[] = [];
    const house = at(0, -fh / 2 - 5);
    bl.push(rect(house.x, house.y, fr.range(11, 15), fr.range(6.5, 8), ang));
    const barn = at(fw / 2 + 6, 0);
    bl.push(rect(barn.x, barn.y, fr.range(8, 10), fr.range(16, 22), ang));
    if (fr.chance(0.7)) { const sh = at(-fw / 2 - 5, fh * 0.15); bl.push(rect(sh.x, sh.y, fr.range(6, 9), fr.range(5, 7), ang)); }
    const drive: Polyline = bestD < 400 ? [bp, c] : [c, c];
    farmsteads.push({ pos: c, angle: ang, buildings: bl, yard, drive });
    forCellsNearPolyline([c, c], n, n, cell, farmR + cell, (idx) => { farmMask[idx] = 1; });
    forCellsNearPolyline([c, c], n, n, cell, farmR + 45, (idx) => { if (!farmMask[idx]) farmMask[idx] = 2; });
    if (bestD < 400) forCellsNearPolyline([bp, c], n, n, cell, 3 + 0.75 * cell, (idx) => { farmMask[idx] = 1; });
  }

  // ---- class grid
  const cls = new Uint8Array(N);
  const hb = blurGrid(terrain.height, Math.max(2, Math.round(300 / cell)), 2).data;
  const promVals: number[] = [];
  for (let i = 0; i < N; i += 5) { const p = H[i] - hb[i]; if (p > 0 && !terrain.water[i]) promVals.push(p); }
  promVals.sort((a, b) => a - b);
  const promHi = Math.max(4, promVals.length ? promVals[Math.floor(promVals.length * 0.75)] : 8);
  const sea = terrain.seaFraction > 0.02;
  const multi = secondary.length > 0;
  const u1 = 0.05 * Lm + 30, u2 = 0.11 * Lm, u3 = 0.42 * Lm, u4 = 0.55 * Lm;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    if (terrain.water[i] || f.dWater[i] < 1.45 * cell || excl[i] || reserve[i] || farmMask[i] === 1) continue;
    const wx = (x + 0.5) * cell, wy = (y + 0.5) * cell;
    const sl = slopeL[i];
    const hab = f.hab[i], dW = f.dWater[i];
    const u = uDist[i];
    const soil = noise.fbm(wx / 380, wy / 380, 3); // -1..1
    const nB = noise.fbm(wx / 110 + 40, wy / 110 - 17, 2);
    const nC = noise.fbm(wx / 70 - 9, wy / 70 + 5, 2);
    const prom = H[i] - hb[i];
    let k: number;
    if (hab < 1.4 && sl < 0.02 && dW < 150 && nB > -0.15 - (sea && f.dSea[i] < 200 ? 0.25 : 0)) k = C.MARSH;
    else if (hab < 4.5 && dW < 240 && sl < 0.5 * fieldMax && (dW < 130 || soil < 0.1)) k = C.MEADOW;
    else if (sl > pastureMax || (prom > promHi * 1.15 && sl > fieldMax)) k = C.FOREST;
    else if (farmMask[i] === 2) k = nC > 0 ? C.ORCHARD : C.GARDEN;
    else if (u < u1 && sl < fieldMax) k = dRoad[i] < 80 && nC > -0.05 ? C.GARDEN : C.ORCHARD;
    else if (u < u2 && sl < fieldMax) k = nC > 0.05 ? C.ORCHARD : nC > -0.35 ? C.FIELD : C.MEADOW;
    // settlement system: the land between the village territories is woodland (with some heath), not a patchwork
    else if (multi && u > u4 * (1 + 0.2 * soil)) k = soil > -0.45 ? C.FOREST : C.COMMONS;
    else if (sl > fieldMax) k = soil > 0.15 ? C.FOREST : C.PASTURE;
    else {
      const arable = u3 * (1 + 0.28 * soil);
      if (u < arable && soil > -0.6) k = C.FIELD;
      else if (u < u4 * (1 + 0.2 * soil)) k = soil < -0.05 || nB > 0.35 ? C.COMMONS : C.PASTURE;
      else k = soil > 0 ? C.FOREST : C.PASTURE;
    }
    cls[i] = k;
  }
  // majority filter + small-component cleanup
  const tmp = new Uint8Array(N);
  const cnt = new Uint8Array(9);
  for (let pass = 0; pass < 2; pass++) {
    tmp.set(cls);
    for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      if (!cls[i]) continue;
      cnt.fill(0);
      for (const [dx, dy] of D8) cnt[cls[i + dy * n + dx]]++;
      let bk = cls[i], bc = cnt[cls[i]];
      for (let k = 1; k < 9; k++) if (cnt[k] > bc) { bc = cnt[k]; bk = k; }
      if (bk !== cls[i] && bc >= 5) tmp[i] = bk;
    }
    cls.set(tmp);
  }
  {
    const seen = new Uint8Array(N);
    const stack: number[] = [];
    const minCells = Math.max(6, Math.round(1500 / (cell * cell)));
    for (let s = 0; s < N; s++) {
      if (!cls[s] || seen[s]) continue;
      const k = cls[s];
      const comp: number[] = [];
      seen[s] = 1; stack.push(s);
      while (stack.length) {
        const c = stack.pop()!; comp.push(c);
        const cx = c % n, cy = (c / n) | 0;
        for (let d = 0; d < 8; d += 2) {
          const nx = cx + D8[d][0], ny = cy + D8[d][1];
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          const j = ny * n + nx;
          if (!seen[j] && cls[j] === k) { seen[j] = 1; stack.push(j); }
        }
      }
      if (comp.length >= minCells) continue;
      cnt.fill(0);
      for (const c of comp) {
        const cx = c % n, cy = (c / n) | 0;
        for (const [dx, dy] of D8) { const nx = cx + dx, ny = cy + dy; if (nx >= 0 && ny >= 0 && nx < n && ny < n) { const v = cls[ny * n + nx]; if (v !== k) cnt[v]++; } }
      }
      let bk = 0, bc = 0;
      for (let v = 1; v < 9; v++) if (cnt[v] > bc) { bc = cnt[v]; bk = v; }
      for (const c of comp) cls[c] = bk;
    }
  }

  // ---- vectorize
  const areas: LandArea[] = [];
  const fieldRegions: Region[] = [];
  const minArea = Math.max(1200, 2.2 * cell * cell);
  const counts: Record<string, number> = {};
  for (let k = 1; k < 9; k++) {
    const ind = new Float32Array(N);
    let any = 0;
    for (let i = 0; i < N; i++) if (cls[i] === k) { ind[i] = 1; any++; }
    if (!any) continue;
    const regions = vectorize(ind, n, n, cell, minArea);
    for (const rg of regions) {
      if (KINDS[k] === 'field') fieldRegions.push(rg);
      else areas.push({ kind: KINDS[k]!, poly: rg.outer, holes: rg.holes.length ? rg.holes : undefined });
    }
    counts[KINDS[k]!] = regions.length;
  }

  // ---- furlongs and strips
  const hSm = blurGrid(terrain.height, 2, 2);
  const ftRng = rr.fork('furlong');
  const angNoise = new Noise2D(rr.fork('angle'));
  let stripCount = 0, furlongCount = 0, fieldArea = 0;
  const idxAt = (p: Vec2) => Math.min(n - 1, Math.max(0, Math.floor(p.y / cell))) * n + Math.min(n - 1, Math.max(0, Math.floor(p.x / cell)));
  for (const rg of fieldRegions) {
    const area = Math.abs(polygonArea(rg.outer)) - rg.holes.reduce((s, hl) => s + Math.abs(polygonArea(hl)), 0);
    fieldArea += area;
    const bb = bbox(rg.outer);
    const sp = ftRng.range(190, 250);
    const pts: Vec2[] = [];
    const ox = ftRng.float() * sp, oy = ftRng.float() * sp;
    for (let row = -1, y = bb.minY - sp + oy; y < bb.maxY + sp; y += sp * 0.88, row++) {
      for (let x = bb.minX - sp + ox + (row & 1 ? sp / 2 : 0); x < bb.maxX + sp; x += sp) {
        pts.push({ x: x + (ftRng.float() - 0.5) * sp * 0.55, y: y + (ftRng.float() - 0.5) * sp * 0.55 });
      }
    }
    const regMP: [Ring[]] = [[toRing(rg.outer), ...rg.holes.map(toRing)]];
    const pieces: Ring[][] = [];
    if (area < 2.2 * sp * sp || pts.length < 4) {
      pieces.push(...(regMP as unknown as Ring[][]));
    } else {
      const del = Delaunay.from(pts, (p) => p.x, (p) => p.y);
      const vor = del.voronoi([bb.minX - 5, bb.minY - 5, bb.maxX + 5, bb.maxY + 5]);
      for (let i = 0; i < pts.length; i++) {
        const cp = vor.cellPolygon(i);
        if (!cp || cp.length < 4) continue;
        let res: ReturnType<typeof polygonClipping.intersection>;
        try { res = polygonClipping.intersection(regMP, [[cp as Ring]]); } catch { continue; }
        for (const pg of res) pieces.push(pg as Ring[]);
      }
    }
    for (const pg of pieces) {
      const outer = fromRing(pg[0]);
      const holes = pg.slice(1).map(fromRing);
      const a = Math.abs(polygonArea(outer));
      if (a < 1400) continue;
      const cen = polygonCentroid(outer);
      const ci = idxAt(cen);
      // strip direction: along contours on slopes, perpendicular to a nearby road on the flat
      let ang: number;
      const sl = slopeL[ci];
      if (sl > 0.03) {
        const [gx, gy] = gradientAt(hSm, Math.min(n - 1, Math.floor(cen.x / cell)), Math.min(n - 1, Math.floor(cen.y / cell)));
        ang = Math.atan2(gy, gx) + Math.PI / 2;
      } else if (dRoad[ci] < 260) ang = roadAng[ci] + Math.PI / 2;
      else ang = angNoise.fbm(cen.x / 700, cen.y / 700, 2) * 2.4;
      ang += ftRng.range(-0.12, 0.12);
      ang = Math.round(ang / (Math.PI / 18)) * (Math.PI / 18);
      ang = ((ang % Math.PI) + Math.PI) % Math.PI;
      // strips: slice the furlong with parallel slabs
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const bbf = bbox(outer);
      // rotated extents
      let vmin = Infinity, vmax = -Infinity, umin = Infinity, umax = -Infinity;
      for (const q of outer) {
        const v = -q.x * sa + q.y * ca, u = q.x * ca + q.y * sa;
        vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); umin = Math.min(umin, u); umax = Math.max(umax, u);
      }
      void bbf;
      const ws = ftRng.range(11, 22);
      const strips: Polygon[] = [];
      const furlongMP = [pg as Ring[]];
      const slabs = Math.ceil((vmax - vmin) / ws);
      // level of detail (big lazy maps): the strips are cut only near the main town
      const stripsHere = !stripLod || dist(cen, stripLod.center) < stripLod.radius;
      if (stripsHere && slabs >= 2 && slabs <= 60 && a > 2500) {
        for (let s = 0; s < slabs; s++) {
          const v0 = vmin + s * ws, v1 = v0 + ws * ftRng.range(0.92, 1.0);
          const slab: Ring = [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]];
          const cornerU = [umin - 5, umax + 5, umax + 5, umin - 5];
          const cornerV = [v0, v0, v1, v1];
          for (let c = 0; c < 4; c++) slab[c] = [cornerU[c] * ca - cornerV[c] * sa, cornerU[c] * sa + cornerV[c] * ca];
          slab[4] = slab[0];
          let res: ReturnType<typeof polygonClipping.intersection>;
          try { res = polygonClipping.intersection(furlongMP, [[slab]]); } catch { continue; }
          for (const sp2 of res) {
            const poly = fromRing(sp2[0] as Ring);
            if (Math.abs(polygonArea(poly)) >= 120) strips.push(poly);
          }
        }
      }
      stripCount += strips.length;
      furlongCount++;
      areas.push({ kind: 'field', poly: outer, holes: holes.length ? holes : undefined, stripAngle: ang, strips: strips.length ? strips : undefined });
    }
  }

  // reserve outline
  const resInd = new Float32Array(N);
  for (let i = 0; i < N; i++) resInd[i] = reserve[i] ? 1 : 0;
  const reservePolys = foot.length ? foot.map((ph) => ph.outer) : vectorize(resInd, n, n, cell, 4000).map((rg) => rg.outer);

  stats['furlongs'] = furlongCount;
  stats['strips'] = stripCount;
  stats['areas'] = areas.length;
  stats['farmsteads'] = farmsteads.length;
  stats['fieldHa'] = Math.round(fieldArea / 1e4);
  for (const [k, v] of Object.entries(counts)) stats['n.' + k] = v;
  void K_NONE; void smoothstep; void ({} as Polyline);
  return { layer: { areas, farmsteads, reserve: reservePolys }, stats };
}
