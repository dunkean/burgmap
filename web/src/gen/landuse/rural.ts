import polygonClipping from 'polygon-clipping';
import { Delaunay } from 'd3-delaunay';
import type { Rng } from '../core/rng';
import { Noise2D } from '../core/noise';
import { gradientAt, sampleGrid, D8 } from '../core/grid';
import { blurFast as blurGrid } from './blur';
import { Vec2, Polygon, Polyline, chaikin, simplify, polygonArea, polygonCentroid, polygonContains, bbox, dist } from '../core/geom';
import { distanceField, forCellsNearPolyline, smoothstep } from '../core/field';
import { marchingSquares } from '../terrain/contour';
import { rasterizePolys } from '../geo/raster';
import { differenceSafeS, intersectionS, mpArea, unionS } from '../geo/bool';
import { urbanNaturalGround } from './urbanGround';
import { partitionRegion, pruneWays, FieldCtx, FieldNet } from './fields';
import type { World, LandArea, LandKind, Farmstead, LandUseLayer, PolyH } from '../types';
import { FARM_SIZES, farmSize, farmType, layoutFarm, placeFarm, frameOf, segRectDist, type FarmContext, type LocalFarm } from './farms';
import { biomeName, biomeLandKind } from '../biomes';

type Ring = [number, number][];

/** Extra layer data (field ways = cart tracks between furlongs, headlands = narrow baulks/hedges); closes carry `enclosed` on their LandArea. */
export interface FieldNetExtras { ways: Polyline[]; headlands: Polyline[] }

const K_NONE = 0;
const KINDS: (LandKind | null)[] = [null, 'field', 'meadow', 'pasture', 'forest', 'orchard', 'garden', 'marsh', 'commons', 'field'];
/** CLOSE: enclosed ground (hedged closes: bocage, farm closes, assarts); it becomes fields or pasture. */
const C = { NONE: 0, FIELD: 1, MEADOW: 2, PASTURE: 3, FOREST: 4, ORCHARD: 5, GARDEN: 6, MARSH: 7, COMMONS: 8, CLOSE: 9 } as const;
const NATURAL_CLASSES: readonly number[] = [C.FOREST, C.MEADOW, C.PASTURE, C.COMMONS, C.MARSH];

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

/** Drops vertices closer than `d` to the last kept one (O(n); the loops are already smooth). */
function decimate(pts: Polygon, d: number): Polygon {
  if (pts.length < 8) return pts;
  const out: Polygon = [pts[0]];
  const d2 = d * d;
  for (let i = 1; i < pts.length - 1; i++) {
    const q = out[out.length - 1];
    if ((pts[i].x - q.x) ** 2 + (pts[i].y - q.y) ** 2 >= d2) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Smooth region polygons (with holes) of the cells where `ind` is 1 (only the window `win` of cells is processed). */
function vectorize(ind: Float32Array, w: number, h: number, cell: number, minArea: number, win: { x0: number; y0: number; x1: number; y1: number }): Region[] {
  // crop to the cells of the class, with a margin for the blur and the closing border
  const X0 = Math.max(0, win.x0 - 2), Y0 = Math.max(0, win.y0 - 2), X1 = Math.min(w - 1, win.x1 + 2), Y1 = Math.min(h - 1, win.y1 + 2);
  const cw = X1 - X0 + 1, ch = Y1 - Y0 + 1;
  const sub = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) sub[y * cw + x] = ind[(y + Y0) * w + x + X0];
  const bl = blurGrid({ w: cw, h: ch, cell, data: sub }, 1, 1).data;
  const pw = cw + 2, ph = ch + 2;
  const pad = new Float32Array(pw * ph);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) pad[(y + 1) * pw + x + 1] = bl[y * cw + x];
  const paths = marchingSquares(pad, pw, ph, 0.5, cell, (X0 - 0.5) * cell, (Y0 - 0.5) * cell);
  const loops: Polygon[] = [];
  for (const p of paths) {
    if (!p.closed || p.pts.length < 4) continue;
    const pts = decimate(chaikin(p.pts, 2, true), 0.3 * cell);
    if (pts.length >= 3 && Math.abs(polygonArea(pts)) >= minArea * 0.4) loops.push(pts);
  }
  const areas = loops.map((l) => Math.abs(polygonArea(l)));
  const boxes = loops.map((l) => bbox(l));
  const inside = (j: number, p: Vec2): boolean => { const b = boxes[j]; return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY && polygonContains(loops[j], p); };
  const depth = loops.map((l, i) => {
    let d = 0;
    for (let j = 0; j < loops.length; j++) if (j !== i && areas[j] > areas[i] && inside(j, l[0])) d++;
    return d;
  });
  const out: Region[] = [];
  const outerIdx: number[] = [];
  loops.forEach((l, i) => { if (depth[i] % 2 === 0 && areas[i] >= minArea) { outerIdx.push(i); out.push({ outer: l, holes: [] }); } });
  loops.forEach((l, i) => {
    if (depth[i] % 2 === 1 && areas[i] >= minArea * 0.5) {
      let bi = -1, ba = Infinity;
      outerIdx.forEach((oi, k) => { if (areas[oi] > areas[i] && areas[oi] < ba && inside(oi, l[0])) { ba = areas[oi]; bi = k; } });
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
  const tStart = performance.now();
  const rr = root.fork('rural');
  const noise = new Noise2D(rr.fork('noise'));
  const stats: Record<string, number> = {};
  const biome = biomeName(world.options.biome);

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
  // Farm placement keeps its full safety reserve. Vegetation can meet an open town much more closely.
  const openTown = world.urban?.archetype === 'town' && !world.urban.renderHints?.openGround && !world.urban.renderHints?.stilts
    && !(world.urban.walls ?? []).some((w) => !w.role || w.role === 'town' || w.role === 'outer')
    && !world.urban.phases.some((p) => p.walled) && !(world.urban.lines ?? []).some((l) => l.kind === 'hedge');
  let coverReserve: Uint8Array | null = null;
  const uDist = new Float32Array(N);
  const builtFoot = world.urban?.footprintH ?? [];
  const foot = world.urban?.ruralReserve?.length ? unionS(builtFoot, world.urban.ruralReserve) : builtFoot;
  if (foot.length) {
    const rings: Polygon[] = [];
    for (const ph of foot) { rings.push(ph.outer); for (const hl of ph.holes) rings.push(hl); }
    rasterizePolys(rings, n, n, cell, reserve);
    if (openTown) coverReserve = reserve.slice();
    const margin = (world.urban?.walls?.length ? 14 : 5) + 0.5 * cell;
    const dRes = distanceField(reserve, n, n, cell, costC);
    for (let i = 0; i < N; i++) {
      if (dRes.dist[i] <= margin) reserve[i] = 1;
      if (coverReserve && dRes.dist[i] <= margin) {
        const wx = ((i % n) + 0.5) * cell, wy = (((i / n) | 0) + 0.5) * cell;
        const coverMargin = 0.5 * cell + 2 + noise.noise(wx / 40, wy / 40);
        if (dRes.dist[i] <= coverMargin) coverReserve[i] = 1;
      }
      uDist[i] = Math.max(0, Math.min(1e5, costC[i]) - (dRes.val![i] || 0));
    }
  } else {
    for (let i = 0; i < N; i++) { if (costC[i] <= reserveCost) reserve[i] = 1; uDist[i] = Math.min(1e5, costC[i]) - reserveCost; }
  }

  const coverFootprints: PolyH[] = [...foot];
  // ---- other settlements: their footprints (or projected extents) are reserved; their own rings join the main ones
  // (distance from the nearest settlement edge, rescaled to the main ring scale by the settlement's own ring scale)
  if (secondary.length) {
    const src = new Uint8Array(N), resSec = new Uint8Array(N);
    const scale = new Float32Array(N);
    const own = new Uint8Array(N);
    for (const st of secondary) {
      const k = Lm / ringScale(st.population);
      const rings: Polygon[] = [];
      let ownFoot: PolyH[] = st.detail === 'farmstead' ? [{ outer: circleRing(st.center, 20), holes: [] }]
        : st.urban?.footprintH.length ? st.urban.footprintH : st.extent.length >= 3 ? [{ outer: st.extent, holes: [] }] : [];
      if (st.urban?.ruralReserve?.length) ownFoot = unionS(ownFoot, st.urban.ruralReserve);
      coverFootprints.push(...ownFoot);
      for (const ph of ownFoot) rings.push(ph.outer, ...ph.holes);
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
      if (dRes.dist[i] <= 5 + 0.5 * cell) { reserve[i] = 1; if (coverReserve) coverReserve[i] = 1; }
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

  // ---- farmsteads (landuse/farms.ts): typed by culture and region, sized by wealth, each on its own lot by its track
  const tFarm = performance.now();
  const farmsteads: Farmstead[] = [];
  const farmMask = new Uint8Array(N); // 1 = exclusion, 2 = garden/orchard halo
  const lotsC: { c: Vec2; r: number }[] = [];
  const pays = new Noise2D(rr.fork('pays'));
  const allSt = world.settlements ?? [];
  const cellAt = (p: Vec2): number => Math.min(n - 1, Math.max(0, Math.floor(p.y / cell))) * n + Math.min(n - 1, Math.max(0, Math.floor(p.x / cell)));
  /** Culture of the countryside at p: that of the nearest settlement (by its ring scale). */
  const cultureAt = (p: Vec2): string => {
    let best: string = world.options.culture, bd = Infinity;
    for (const st of allSt) {
      if (st.detail === 'farmstead') continue;
      const d = dist(p, st.center) / ringScale(st.population);
      if (d < bd) { bd = d; best = st.culture; }
    }
    return best;
  };
  const ctxAt = (p: Vec2, culture: string, pop?: number): FarmContext => {
    const i = cellAt(p), g = 35;
    const hx = sampleGrid(terrain.height, p.x + g, p.y) - sampleGrid(terrain.height, p.x - g, p.y);
    const hy = sampleGrid(terrain.height, p.x, p.y + g) - sampleGrid(terrain.height, p.x, p.y - g);
    const gl = Math.hypot(hx, hy);
    let mean = 0;
    for (let k = 0; k < 8; k++) mean += sampleGrid(terrain.height, p.x + 260 * Math.cos(k * 0.785), p.y + 260 * Math.sin(k * 0.785));
    const prom = sampleGrid(terrain.height, p.x, p.y) - mean / 8;
    const cl = (x: number) => Math.max(0, Math.min(1, x));
    return {
      culture, pop,
      soil: noise.fbm(p.x / 380, p.y / 380, 3),
      slope: slopeL[i],
      downhill: gl / (2 * g) > 0.012 ? { x: -hx / gl, y: -hy / gl } : null,
      wet: cl((5 - f.hab[i]) / 3.5) * cl((450 - f.dWater[i]) / 300),
      exposed: cl(prom / 18 + (terrain.seaFraction > 0.02 && f.dSea[i] < 350 ? 0.35 : 0)),
      market: cl(uDist[i] / (0.42 * Lm)),
      west: 0.5 - p.x / S + 0.35 * pays.fbm(p.x / 3000, p.y / 3000, 2),
    };
  };
  // roads and rivers in buckets for the exact lot clearance test
  const BK = 200, bw = Math.ceil(S / BK) + 1;
  const buckets = new Map<number, number[]>();
  const segs: number[] = []; // ax ay bx by pad
  const addSeg = (a: Vec2, b: Vec2, pad: number) => {
    const k = segs.length / 5;
    segs.push(a.x, a.y, b.x, b.y, pad);
    const x0 = Math.floor(Math.min(a.x, b.x) / BK), x1 = Math.floor(Math.max(a.x, b.x) / BK), y0 = Math.floor(Math.min(a.y, b.y) / BK), y1 = Math.floor(Math.max(a.y, b.y) / BK);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const key = y * bw + x; const l = buckets.get(key); if (l) l.push(k); else buckets.set(key, [k]); }
  };
  for (const rd of roads) for (let i = 1; i < rd.path.length; i++) addSeg(rd.path[i - 1], rd.path[i], rd.width / 2 + 1.5);
  for (const rv of terrain.rivers) for (let i = 1; i < rv.path.length; i++) addSeg(rv.path[i - 1], rv.path[i], Math.max(rv.width[i - 1] ?? 2, rv.width[i] ?? 2) / 2 + 3);
  /** The lot (front middle o, inward V, W × D) is on dry free land, clear of roads, rivers, settlements and other lots. */
  const lotOk = (o: Vec2, V: Vec2, W: number, D: number): boolean => {
    const U = { x: V.y, y: -V.x };
    const P = (u: number, v: number): Vec2 => ({ x: o.x + u * U.x + v * V.x, y: o.y + u * U.y + v * V.y });
    const c = P(0, D / 2), rad = 0.5 * Math.hypot(W, D);
    if (biome === 'desert' && f.dWater[cellAt(c)] > 350) return false;
    if (c.x - rad < 0.01 * S || c.y - rad < 0.01 * S || c.x + rad > 0.99 * S || c.y + rad > 0.99 * S) return false;
    for (const l of lotsC) if (dist(l.c, c) < l.r + rad + 12) return false;
    const st = Math.min(4, 0.45 * cell);
    for (let v = 0.5; v <= D; v += st) for (let u = -W / 2 + 0.5; u <= W / 2; u += st) {
      const i = cellAt(P(u, v));
      if (terrain.water[i] || reserve[i] || f.dWater[i] < cell) return false;
    }
    const seen = new Set<number>();
    for (let y = Math.floor((c.y - rad - 20) / BK); y <= Math.floor((c.y + rad + 20) / BK); y++) for (let x = Math.floor((c.x - rad - 20) / BK); x <= Math.floor((c.x + rad + 20) / BK); x++) {
      for (const k of buckets.get(y * bw + x) ?? []) {
        if (seen.has(k)) continue;
        seen.add(k);
        const q = k * 5;
        const ax = segs[q] - o.x, ay = segs[q + 1] - o.y, bx = segs[q + 2] - o.x, by = segs[q + 3] - o.y;
        if (segRectDist(ax * U.x + ay * U.y, ax * V.x + ay * V.y, bx * U.x + by * U.y, bx * V.x + by * V.y, -W / 2, 0, W / 2, D) < segs[q + 4]) return false;
      }
    }
    return true;
  };
  type Place = { o: Vec2; V: Vec2 };
  /** Plan the farm (type from the culture and the site, size from its wealth), shrinking it until its lot fits one of the placements. */
  const planOn = (ctx: FarmContext, fr: Rng, places: (D: number) => Place[]): { lf: LocalFarm; o: Vec2; V: Vec2 } | null => {
    const size0 = farmSize(ctx, fr);
    const type = farmType(ctx, size0, fr);
    const dirs = places(0).map((p) => p.V);
    for (let s = FARM_SIZES.indexOf(size0); s >= 0; s--) {
      const lr = fr.fork('plan' + s);
      for (let k = 0; k < dirs.length; k++) {
        const lf = layoutFarm(type, FARM_SIZES[s], ctx, frameOf(dirs[k], ctx.downhill), lr.fork('l' + k));
        const q = places(lf.D)[k];
        if (lotOk(q.o, q.V, lf.W, lf.D)) return { lf, o: q.o, V: q.V };
      }
    }
    return null;
  };
  const accept = (pl: { lf: LocalFarm; o: Vec2; V: Vec2 }, culture: string, bp: Vec2 | null) => {
    const g = placeFarm(pl.lf, pl.lf.type, pl.o, pl.V);
    const c = { x: pl.o.x + (pl.V.x * pl.lf.D) / 2, y: pl.o.y + (pl.V.y * pl.lf.D) / 2 };
    lotsC.push({ c, r: 0.5 * Math.hypot(pl.lf.W, pl.lf.D) });
    farmsteads.push({
      pos: c, angle: g.angle, buildings: g.parts.map((p) => p.poly), yard: g.yard, drive: bp ? [bp, g.gate] : [g.gate, g.gate],
      type: pl.lf.type, size: pl.lf.size, culture, lot: g.lot, parts: g.parts, plots: g.plots, walls: g.walls, trees: g.trees, gate: g.gate, entry: g.entry, tags: pl.lf.tags,
    });
  };
  const nearestRoad = (p: Vec2): { d: number; bp: Vec2; t: Vec2; w: number } => {
    let d = Infinity, bp = p, bt = { x: 1, y: 0 }, bwid = 3;
    for (const rd of roads) for (let i = 1; i < rd.path.length; i++) {
      const a = rd.path[i - 1], b = rd.path[i];
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
      const q = { x: a.x + t * dx, y: a.y + t * dy };
      const dd = dist(q, p);
      if (dd < d) { d = dd; bp = q; const l = Math.sqrt(l2); bt = { x: dx / l, y: dy / l }; bwid = rd.width; }
    }
    return { d, bp, t: bt, w: bwid };
  };
  // farmsteads of the settlement system first: the farm on its track, in the middle of its own fields
  for (const st of secondary) {
    if (st.detail !== 'farmstead') continue;
    const fr = root.fork('settlement:' + st.key).fork('farm');
    const nr = nearestRoad(st.center);
    const ctx = ctxAt(st.center, st.culture, st.population);
    const sideFirst = fr.chance(0.5) ? 1 : -1;
    const d0 = nr.d > 1 ? { x: (st.center.x - nr.bp.x) / nr.d, y: (st.center.y - nr.bp.y) / nr.d } : { x: 0, y: 1 };
    const places = (D: number): Place[] => {
      const out: Place[] = [];
      // beside the track end, the lot running back from it
      if (nr.d < 60) for (const sd of [sideFirst, -sideFirst]) {
        const V = { x: -nr.t.y * sd, y: nr.t.x * sd };
        out.push({ o: { x: nr.bp.x + V.x * (nr.w / 2 + 3), y: nr.bp.y + V.y * (nr.w / 2 + 3) }, V });
      }
      // in its fields, facing the track (then the other ways round)
      for (const [cx, cy] of [[1, 0], [0, 1], [0, -1], [-1, 0]]) {
        const V = { x: d0.x * cx - d0.y * cy, y: d0.x * cy + d0.y * cx };
        out.push({ o: { x: st.center.x - (V.x * D) / 2, y: st.center.y - (V.y * D) / 2 }, V });
      }
      return out;
    };
    let pl = planOn(ctx, fr, places);
    if (pl && dist({ x: pl.o.x + (pl.V.x * pl.lf.D) / 2, y: pl.o.y + (pl.V.y * pl.lf.D) / 2 }, st.center) > 75) pl = null;
    if (!pl) {
      // last resort: the smallest farm in the middle of its fields
      stats['farm.forced'] = (stats['farm.forced'] ?? 0) + 1;
      const lf = layoutFarm('l-yard', 'cottage', ctx, frameOf(d0, ctx.downhill), fr.fork('forced'));
      pl = { lf, o: { x: st.center.x - (d0.x * lf.D) / 2, y: st.center.y - (d0.y * lf.D) / 2 }, V: d0 };
    }
    accept(pl, st.culture, nr.d < 400 ? nr.bp : null);
  }
  // farmsteads along the roads: dispersed farms of the main town's farmland (and, on custom maps, of the whole country)
  {
    const custom = world.options.mapSize !== undefined;
    const farmCount = ({ hamlet: 0, village: 2, town: 4, city: 7, capital: 10 } as const)[world.options.size] + (custom ? Math.min(90, Math.round(0.2 * (S / 1000) ** 2)) : 0);
    const fr = rr.fork('farm');
    const cand: { o: Vec2; V: Vec2; score: number }[] = [];
    const rds = custom ? roads : mainRoads === undefined ? roads : roads.slice(0, mainRoads);
    for (const rd of rds) {
      if (rd.kind === 'track' && !custom) continue;
      let acc = 0;
      for (let i = 1; i < rd.path.length; i++) {
        const a = rd.path[i - 1], b = rd.path[i];
        const L = dist(a, b);
        acc += L;
        if (acc < 50) continue;
        acc = 0;
        const t = { x: (b.x - a.x) / (L || 1), y: (b.y - a.y) / (L || 1) };
        const side = fr.chance(0.5) ? 1 : -1;
        const V = { x: -t.y * side, y: t.x * side };
        const o = { x: b.x + V.x * (rd.width / 2 + 3), y: b.y + V.y * (rd.width / 2 + 3) };
        const p = { x: o.x + V.x * 25, y: o.y + V.y * 25 };
        if (p.x < 0.06 * S || p.y < 0.06 * S || p.x > 0.94 * S || p.y > 0.94 * S) continue;
        const idx = cellAt(p);
        if (terrain.water[idx] || f.dWater[idx] < 40 || f.hab[idx] < 0.8 || slopeL[idx] > pastureMax || reserve[idx] || uDist[idx] < (custom ? 0.07 : 0.1) * Lm || uDist[idx] > 0.42 * Lm) continue;
        cand.push({ o, V, score: fr.float() });
      }
    }
    cand.sort((a, b) => b.score - a.score);
    const minSp = custom ? Math.max(200, 0.09 * Lm) : 0.13 * Lm;
    let made = 0;
    for (const c of cand) {
      if (made >= farmCount) break;
      if (lotsC.some((l) => dist(l.c, c.o) < minSp)) continue;
      const p = { x: c.o.x + c.V.x * 25, y: c.o.y + c.V.y * 25 };
      const culture = cultureAt(p);
      const pl = planOn(ctxAt(p, culture), fr.fork('f' + made), () => [c]);
      if (!pl) continue;
      // the drive from the road to the gate
      const nr = nearestRoad(placeFarm(pl.lf, pl.lf.type, pl.o, pl.V).gate);
      accept(pl, culture, nr.bp);
      made++;
    }
  }
  for (const fm of farmsteads) stats['farm.' + fm.type] = (stats['farm.' + fm.type] ?? 0) + 1;
  // exclusion masks: the lots (and their drives); the halo round them is gardens and orchards
  if (farmsteads.length) {
    const lm = rasterizePolys(farmsteads.map((fm) => fm.lot!), n, n, cell);
    for (let i = 0; i < N; i++) if (lm[i]) farmMask[i] = 1;
    for (const fm of farmsteads) {
      const ring = [...fm.lot!, fm.lot![0]];
      forCellsNearPolyline(ring, n, n, cell, 0.75 * cell, (idx) => { farmMask[idx] = 1; });
      forCellsNearPolyline(ring, n, n, cell, 40, (idx) => { if (!farmMask[idx]) farmMask[idx] = 2; });
      if (dist(fm.drive[0], fm.drive[fm.drive.length - 1]) > 0.5) forCellsNearPolyline(fm.drive, n, n, cell, 3 + 0.75 * cell, (idx) => { farmMask[idx] = 1; });
    }
  }
  stats['ms.lu.farms'] = Math.round(performance.now() - tFarm);

  // ---- class grid
  const tClass = performance.now();
  stats['ms.lu.pre'] = Math.round(tClass - tStart);
  const dFarm = new Float32Array(N).fill(1e9);
  for (const fm of farmsteads) {
    const cx = Math.floor(fm.pos.x / cell), cy = Math.floor(fm.pos.y / cell), r = Math.ceil(200 / cell) + 1;
    for (let y = Math.max(0, cy - r); y <= Math.min(n - 1, cy + r); y++) for (let x = Math.max(0, cx - r); x <= Math.min(n - 1, cx + r); x++) {
      const d = Math.hypot((x + 0.5) * cell - fm.pos.x, (y + 0.5) * cell - fm.pos.y);
      if (d < dFarm[y * n + x]) dFarm[y * n + x] = d;
    }
  }
  const bocNoise = new Noise2D(rr.fork('bocage'));
  const bocage = (wx: number, wy: number, dW: number): number => {
    const base = 0.35 * (1 - Math.min(1, dW / 450)) + 0.45 * (0.5 - wx / S) - (world.options.relief === 'mountains' ? 0.2 : 0);
    return base + 0.5 <= 0.4 ? -1 : base + 0.5 * bocNoise.fbm(wx / 900, wy / 900, 2);
  };
  const cls = new Uint8Array(N);
  const hb = blurGrid(terrain.height, Math.max(2, Math.round(300 / cell)), 2).data;
  const promVals: number[] = [];
  for (let i = 0; i < N; i += 5) { const p = H[i] - hb[i]; if (p > 0 && !terrain.water[i]) promVals.push(p); }
  promVals.sort((a, b) => a - b);
  const promHi = Math.max(4, promVals.length ? promVals[Math.floor(promVals.length * 0.75)] : 8);
  const sea = terrain.seaFraction > 0.02;
  const multi = secondary.length > 0;
  // low-frequency noise on a coarse grid (bilinear): the soil field varies over hundreds of metres
  const sStride = Math.max(1, Math.min(8, Math.floor(380 / (4 * cell))));
  const sgw = Math.ceil((n - 1) / sStride) + 2;
  const soilG = new Float32Array(sgw * sgw);
  for (let gy = 0; gy < sgw; gy++) for (let gx = 0; gx < sgw; gx++) soilG[gy * sgw + gx] = noise.fbm(((gx * sStride + 0.5) * cell) / 380, ((gy * sStride + 0.5) * cell) / 380, 3);
  const soilAt = (x: number, y: number): number => {
    const fx = x / sStride, fy = y / sStride, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const o = y0 * sgw + x0;
    return (soilG[o] * (1 - tx) + soilG[o + 1] * tx) * (1 - ty) + (soilG[o + sgw] * (1 - tx) + soilG[o + sgw + 1] * tx) * ty;
  };
  let cwx = 0, cwy = 0;
  const gB = (): number => noise.fbm(cwx / 110 + 40, cwy / 110 - 17, 2);
  const gC = (): number => noise.fbm(cwx / 70 - 9, cwy / 70 + 5, 2);
  const u1 = 0.05 * Lm + 30, u2 = 0.11 * Lm, u3 = 0.42 * Lm, u4 = 0.55 * Lm;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    if (terrain.water[i] || f.dWater[i] < 1.45 * cell || excl[i] || (coverReserve ?? reserve)[i] || farmMask[i] === 1) continue;
    const wx = (x + 0.5) * cell, wy = (y + 0.5) * cell;
    const sl = slopeL[i];
    const hab = f.hab[i], dW = f.dWater[i];
    const u = uDist[i];
    cwx = wx; cwy = wy;
    const soil = soilAt(x, y); // -1..1
    const prom = H[i] - hb[i];
    let k: number;
    if (hab < 1.4 && sl < 0.02 && dW < 150 && gB() > -0.15 - (sea && f.dSea[i] < 200 ? 0.25 : 0)) k = C.MARSH;
    else if (hab < 4.5 && dW < 240 && sl < 0.5 * fieldMax && (dW < 130 || soil < 0.1)) k = C.MEADOW;
    else if (sl > pastureMax || (prom > promHi * 1.15 && sl > fieldMax)) k = C.FOREST;
    else if (farmMask[i] === 2) k = gC() > 0 ? C.ORCHARD : C.GARDEN;
    else if (u < u1 && sl < fieldMax) k = dRoad[i] < 80 && gC() > -0.05 ? C.GARDEN : C.ORCHARD;
    else if (u < u2 && sl < fieldMax) k = gC() > 0.05 ? C.ORCHARD : gC() > -0.35 ? C.FIELD : C.MEADOW;
    // settlement system: the land between the village territories is woodland (with some heath), not a patchwork
    else if (multi && u > u4 * (1 + 0.2 * soil)) k = soil > -0.45 ? C.FOREST : C.COMMONS;
    else if (sl > fieldMax) k = soil > 0.15 ? C.FOREST : C.PASTURE;
    else {
      const arable = u3 * (1 + 0.28 * soil);
      if (u < arable && soil > -0.6) k = C.FIELD;
      else if (u < u4 * (1 + 0.2 * soil)) k = soil < -0.05 || gB() > 0.35 ? C.COMMONS : C.PASTURE;
      else k = soil > 0 ? C.FOREST : C.PASTURE;
    }
    if (biome !== 'temperate') {
      const kind = biomeLandKind(KINDS[k]!, biome, { water: dW, hab, slope: sl, soil, settlement: u, arableRadius: u3 });
      k = KINDS.indexOf(kind);
    }
    // enclosed ground: closes around the farmsteads and the village edge, bocage in the wet and western country
    if (k === C.FIELD) {
      const cl = (dFarm[i] < 190 && dFarm[i] < 115 + 75 * gC()) || (u < 0.17 * Lm && gB() > -0.3) || bocage(wx, wy, dW) > 0.4;
      if (cl) k = C.CLOSE;
    }
    cls[i] = k;
  }
  // assarts: clearings cut out of the wood along its edge with the fields
  {
    const fm = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (cls[i] === C.FIELD || cls[i] === C.CLOSE) fm[i] = 1;
    const dF = distanceField(fm, n, n, cell).dist;
    for (let i = 0; i < N; i++) {
      if (cls[i] !== C.FOREST || dF[i] > 95) continue;
      const wx = ((i % n) + 0.5) * cell, wy = (((i / n) | 0) + 0.5) * cell;
      const a = noise.fbm(wx / 95 + 200, wy / 95 + 77, 2);
      if (a > 0.05 && dF[i] < 30 + 90 * a && slopeL[i] < fieldMax * 1.15 && f.hab[i] > 2.5) cls[i] = C.CLOSE;
    }
  }
  // majority filter + small-component cleanup
  const tmp = new Uint8Array(N);
  const cnt = new Uint8Array(10);
  for (let pass = 0; pass < 2; pass++) {
    tmp.set(cls);
    for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      if (!cls[i]) continue;
      const ci = cls[i];
      if (cls[i - 1] === ci && cls[i + 1] === ci && cls[i - n] === ci && cls[i + n] === ci && cls[i - n - 1] === ci && cls[i - n + 1] === ci && cls[i + n - 1] === ci && cls[i + n + 1] === ci) continue;
      cnt.fill(0);
      for (const [dx, dy] of D8) cnt[cls[i + dy * n + dx]]++;
      let bk = cls[i], bc = cnt[cls[i]];
      for (let k = 1; k < 10; k++) if (cnt[k] > bc) { bc = cnt[k]; bk = k; }
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
      for (let v = 1; v < 10; v++) if (cnt[v] > bc) { bc = cnt[v]; bk = v; }
      for (const c of comp) cls[c] = bk;
    }
  }

  // Keep the existing rural/agricultural classification intact, then extend neighbouring natural cover
  // into the shared permission. Whole-footprint reserve still excludes farms, gardens and field networks.
  const naturalGround = urbanNaturalGround(world);
  if (naturalGround.length) {
    if (!coverReserve) coverReserve = reserve.slice();
    const naturalMask = new Uint8Array(N);
    // Rasterise each rectangle independently: overlapping permissions must combine by union, never XOR.
    for (const piece of naturalGround) rasterizePolys([piece.outer], n, n, cell, naturalMask);
    const sources = Uint8Array.from(cls, (k) => k ? 1 : 0);
    const nearest = distanceField(sources, n, n, cell, cls).val!;
    for (let i = 0; i < N; i++) {
      if (!naturalMask[i] || cls[i] || terrain.water[i] || f.dWater[i] < 1.45 * cell || excl[i] || farmMask[i] === 1) continue;
      const nearby = nearest[i];
      if (!nearby) continue;
      const sl = slopeL[i], dW = f.dWater[i], hab = f.hab[i], prom = H[i] - hb[i];
      let kind = nearby === C.FOREST || nearby === C.MEADOW || nearby === C.PASTURE || nearby === C.COMMONS || nearby === C.MARSH
        ? KINDS[nearby]! : 'pasture' as LandKind;
      if (sl > pastureMax || (prom > promHi * 1.15 && sl > fieldMax)) kind = 'forest';
      else if (kind === 'marsh' && (hab >= 4.5 || dW >= 240)) kind = 'meadow';
      if (biome !== 'temperate') {
        const wx = ((i % n) + 0.5) * cell, wy = (((i / n) | 0) + 0.5) * cell;
        kind = biomeLandKind(kind, biome, { water: dW, hab, slope: sl, soil: soilAt((wx / cell) - 0.5, (wy / cell) - 0.5), settlement: uDist[i], arableRadius: u3 });
      }
      if (['forest', 'meadow', 'pasture', 'commons', 'marsh'].includes(kind)) cls[i] = KINDS.indexOf(kind);
    }
  }

  stats['ms.lu.classes'] = Math.round(performance.now() - tClass);
  // ---- vectorize (polygon edges get a position-based domain warp: natural, wavering edges that stay shared between classes)
  const areas: LandArea[] = [];
  const fieldRegions: Region[] = [];
  const closeRegions: Region[] = [];
  const minArea = Math.max(1200, 2.2 * cell * cell);
  const counts: Record<string, number> = {};
  const tVec = performance.now();
  const wnA = new Noise2D(rr.fork('warp'));
  const wAmp = Math.max(2, Math.min(4, 0.5 * cell));
  const exM = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (!cls[i]) exM[i] = 1;
  const exDist = (x: number, y: number): number => {
    const cx = Math.min(n - 1, Math.max(0, Math.floor(x / cell))), cy = Math.min(n - 1, Math.max(0, Math.floor(y / cell)));
    let best = 3 * cell;
    for (let yy = Math.max(0, cy - 3); yy <= Math.min(n - 1, cy + 3); yy++) for (let xx = Math.max(0, cx - 3); xx <= Math.min(n - 1, cx + 3); xx++) {
      if (!exM[yy * n + xx]) continue;
      const d = Math.hypot((xx + 0.5) * cell - x, (yy + 0.5) * cell - y);
      if (d < best) best = d;
    }
    return best;
  };
  const warpRing = (r: Polygon): Polygon => {
    const dense: Polygon = [];
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      const L = dist(a, b), m = Math.max(1, Math.ceil(L / 14));
      for (let k = 0; k < m; k++) dense.push({ x: a.x + ((b.x - a.x) * k) / m, y: a.y + ((b.y - a.y) * k) / m });
    }
    return simplify(dense, 0.35).map((q) => {
      // no displacement next to water, roads and the reserve (they keep their margins)
      const a = wAmp * smoothstep(exDist(q.x, q.y), 0.8 * cell, 2.4 * cell);
      return {
        x: q.x + a * (wnA.noise(q.x / 48, q.y / 48) + 0.25 * wnA.noise(q.x / 20 + 5, q.y / 20)),
        y: q.y + a * (wnA.noise(q.x / 48 + 31, q.y / 48 - 7) + 0.25 * wnA.noise(q.x / 20, q.y / 20 + 9)),
      };
    });
  };
  const coverFoot = coverReserve ? coverFootprints.map((poly) => ({ poly, box: bbox(poly.outer) })) : [];
  const naturalPieces = naturalGround.map((poly) => ({ poly, box: bbox(poly.outer) }));
  const warpRegion = (rg: Region, kind: number): Region[] => {
    const warped = { outer: warpRing(rg.outer), holes: rg.holes.map(warpRing) };
    if (!coverReserve) return [warped];
    const box = bbox(warped.outer);
    const near = coverFoot.filter(({ box: b }) => b.minX <= box.maxX && b.maxX >= box.minX && b.minY <= box.maxY && b.maxY >= box.minY).map(({ poly }) => poly);
    if (!near.length) return [warped];
    // Raster centres and smoothing cannot protect tiny lots or holes exactly. Clip before field partitioning.
    const clipped = differenceSafeS([warped], near);
    if (!clipped.length) {
      // A fail-closed cut must not silently erase countryside. Look for actual interior land that was lost.
      let lost = false;
      for (let y = 0; y < 16 && !lost; y++) for (let x = 0; x < 16; x++) {
        const p = { x: box.minX + (x + 0.5) * (box.maxX - box.minX) / 16, y: box.minY + (y + 0.5) * (box.maxY - box.minY) / 16 };
        if (polygonContains(warped.outer, p) && !warped.holes.some((h) => polygonContains(h, p)) && !near.some((ph) => polygonContains(ph.outer, p) && !ph.holes.some((h) => polygonContains(h, p)))) { lost = true; break; }
      }
      if (lost) stats['lu.clipDropped'] = Number(stats['lu.clipDropped'] ?? 0) + 1;
    }
    const outside = clipped.filter((ph) => mpArea([ph]) >= 0.4 * minArea);
    if (!NATURAL_CLASSES.includes(kind)) return outside;
    const permission = naturalPieces.filter(({ box: b }) => b.minX <= box.maxX && b.maxX >= box.minX && b.minY <= box.maxY && b.maxY >= box.minY).map(({ poly }) => poly);
    // The permission is inside residential plots, disjoint from outside. Keep small run rectangles:
    // their decomposition must not create an accidental minimum-area threshold for vegetation.
    return [...outside, ...intersectionS([warped], permission).filter((ph) => mpArea([ph]) > 0.01)];
  };
  const wins = Array.from({ length: 10 }, () => ({ x0: n, y0: n, x1: -1, y1: -1, any: 0 }));
  for (let y = 0, i = 0; y < n; y++) for (let x = 0; x < n; x++, i++) {
    const k = cls[i];
    if (!k) continue;
    const wn = wins[k];
    wn.any++;
    if (x < wn.x0) wn.x0 = x; if (x > wn.x1) wn.x1 = x; if (y < wn.y0) wn.y0 = y; if (y > wn.y1) wn.y1 = y;
  }
  for (let k = 1; k < 10; k++) {
    if (!wins[k].any) continue;
    const ind = new Float32Array(N);
    for (let i = 0; i < N; i++) if (cls[i] === k) ind[i] = 1;
    const regions = vectorize(ind, n, n, cell, minArea, wins[k]).flatMap((rg) => warpRegion(rg, k));
    for (const rg of regions) {
      if (k === C.FIELD) fieldRegions.push(rg);
      else if (k === C.CLOSE) closeRegions.push(rg);
      else areas.push({ kind: KINDS[k]!, poly: rg.outer, holes: rg.holes.length ? rg.holes : undefined });
    }
    counts[KINDS[k]! + (k === C.CLOSE ? '.close' : '')] = regions.length;
  }
  stats['ms.lu.vector'] = Math.round(performance.now() - tVec);

  // ---- furlongs, closes and strips
  const tFields = performance.now();
  const hSm = blurGrid(terrain.height, 2, 2);
  const ftRng = rr.fork('furlong');
  const angNoise = new Noise2D(rr.fork('angle'));
  const idxAt = (x: number, y: number) => Math.min(n - 1, Math.max(0, Math.floor(y / cell))) * n + Math.min(n - 1, Math.max(0, Math.floor(x / cell)));
  // strip direction field, as doubled-angle vectors so that it blends without the pi ambiguity:
  // contours on slopes (strips lie across the slope), perpendicular to the nearest road, else a slow noise
  const dirAt = (x: number, y: number): number => {
    const ci = idxAt(x, y);
    const sl = slopeL[ci];
    const wS = smoothstep(sl, 0.022, 0.05);
    const gxy = gradientAt(hSm, Math.min(n - 2, Math.max(1, Math.floor(x / cell))), Math.min(n - 2, Math.max(1, Math.floor(y / cell))));
    const aS = Math.atan2(gxy[1], gxy[0]) + Math.PI / 2;
    const wR = 1 - smoothstep(dRoad[ci], 110, 300);
    const aR = roadAng[ci] + Math.PI / 2;
    const aN = angNoise.fbm(x / 700, y / 700, 2) * 2.4;
    const fx = (1 - wR) * Math.cos(2 * aN) + wR * Math.cos(2 * aR);
    const fy = (1 - wR) * Math.sin(2 * aN) + wR * Math.sin(2 * aR);
    const vx = wS * Math.cos(2 * aS) + (1 - wS) * fx, vy = wS * Math.sin(2 * aS) + (1 - wS) * fy;
    return Math.atan2(vy, vx) / 2;
  };
  const net: FieldNet = { furlongs: [], ways: [], headlands: [] };
  const mkCtx = (closed: boolean): FieldCtx => ({
    dirAt, slopeAt: (x, y) => slopeL[idxAt(x, y)], closeAt: () => closed, noise: angNoise, rng: ftRng,
    stripsAt: stripLod ? (c) => dist(c, stripLod.center) < stripLod.radius : undefined,
  });
  let fieldArea = 0;
  for (const rg of fieldRegions) {
    fieldArea += Math.abs(polygonArea(rg.outer)) - rg.holes.reduce((s, hl) => s + Math.abs(polygonArea(hl)), 0);
    partitionRegion(rg.outer, rg.holes, mkCtx(false), net);
  }
  for (const rg of closeRegions) {
    fieldArea += Math.abs(polygonArea(rg.outer)) - rg.holes.reduce((s, hl) => s + Math.abs(polygonArea(hl)), 0);
    partitionRegion(rg.outer, rg.holes, mkCtx(true), net);
  }
  {
    // only connected, non-duplicate field ways are cart tracks (the others become headlands)
    const edges = [world.urban, ...(world.settlements ?? []).filter((st) => !st.main).map((st) => st.urban)]
      .flatMap((u) => u?.footprintH ?? []).map((ph) => [...ph.outer, ph.outer[0]]);
    const pr = pruneWays(net, [...roads.map((r) => r.path), ...farmsteads.map((f) => f.drive), ...edges], 1.6 * cell + 20);
    stats['ways.dropped'] = pr.dropped;
    stats['ways.demoted'] = pr.demoted;
  }
  let stripCount = 0, furlongCount = 0, closeCount = 0;
  for (const fl of net.furlongs) {
    if (fl.enclosed) {
      closeCount++;
      // enclosed ground: ploughed closes and hedged pasture (a close is never cut into strips)
      const pasture = ftRng.chance(0.42);
      const ar: LandArea & { enclosed?: boolean } = pasture
        ? { kind: 'pasture', poly: fl.outer, holes: fl.holes.length ? fl.holes : undefined }
        : { kind: 'field', poly: fl.outer, holes: fl.holes.length ? fl.holes : undefined, stripAngle: fl.angle };
      ar.enclosed = true;
      areas.push(ar);
      continue;
    }
    stripCount += fl.strips?.length ?? 0;
    furlongCount++;
    areas.push({ kind: 'field', poly: fl.outer, holes: fl.holes.length ? fl.holes : undefined, stripAngle: fl.angle, strips: fl.strips });
  }
  stats['ms.lu.fields'] = Math.round(performance.now() - tFields);

  // reserve outline
  const resInd = new Float32Array(N);
  for (let i = 0; i < N; i++) resInd[i] = reserve[i] ? 1 : 0;
  const reservePolys = foot.length ? foot.map((ph) => ph.outer) : vectorize(resInd, n, n, cell, 4000, { x0: 0, y0: 0, x1: n - 1, y1: n - 1 }).map((rg) => rg.outer);

  stats['furlongs'] = furlongCount;
  stats['closes'] = closeCount;
  stats['ways'] = net.ways.length;
  stats['strips'] = stripCount;
  stats['areas'] = areas.length;
  stats['farmsteads'] = farmsteads.length;
  stats['fieldHa'] = Math.round(fieldArea / 1e4);
  for (const [k, v] of Object.entries(counts)) stats['n.' + k] = v;
  void K_NONE; void smoothstep; void ({} as Polyline);
  const layer: LandUseLayer & FieldNetExtras = { areas, farmsteads, reserve: reservePolys, ways: net.ways, headlands: net.headlands,
    ...(naturalGround.length ? { naturalGround } : {}) };
  return { layer, stats };
}
