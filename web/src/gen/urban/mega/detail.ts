/**
 * Lazy quarter detail of the megacity plan (URBAN_MORPHOLOGY §3d, "detail level"): streets, blocks, plots and
 * buildings of ONE macro quarter, made by the same level 2–4 engine as an eager town (splitQuarter, carveBlocks,
 * cutPlots / cutCourtyards, buildOn, access, masses).
 *
 * Independence of the generation order: the quarter sees only the macro plan (its own polygon and labels, the
 * arterials around it, the wall lines) and its own stream `fork('quarter:' + id)`. Nothing another quarter adds is
 * visible, so the result is the same whether the quarters are generated one by one on zoom, all at once, or in any
 * order. Quarter boundaries are arterial centre lines fixed by the macro graph, so neighbouring tiles always meet.
 */
import type { Vec2, Polygon, Polyline } from '../../core/geom';
import { dist } from '../../core/geom';
import { Rng } from '../../core/rng';
import { optionsForMainSettlement, optionsForSettlement } from '../../options';
import type { World, UrbanLayer, UrbanBuilding, UrbanParcel, UrbanSite, UrbanLine, UrbanTree, UrbanWall, PolyH, UrbanStreet } from '../../types';
import type { MorphologyParams } from '../morphology';
import { makeCtx, type UrbanCtx } from '../context';
import { Streets, LAB_OPEN } from '../streets';
import { GuidanceField } from '../field';
import { splitQuarter, addCloses, carveBlocks, buildRibbonIndex, type CarvedBlock } from '../blocks';
import { culDeSacTree } from '../culdesac';
import { cutPlots, type Plot } from '../plots';
import { cutCourtyards } from '../courtyards';
import { retainBlockPlot } from '../perimeterBlock';
import { buildOn, type ArchBldg } from '../bops';
import { chamferPersianHouse } from '../persianhouse';
import { finishEdgeRoofs } from '../edgeRoofs';
import { finalizeFootprints } from '../footprintFinal';
import { privatePassageAccess, type PrivatePassage } from '../privatePassage';
import { finishOpenEdges, markPlannedTerminalPlots, physicalTipConstraint, openQuarterEdge, footprintPlacementGuard, quarterRoofCollar } from '../edgeFinish';
import { naturalGroundEligible } from '../../landuse/urbanGround';
import { streetStrips } from '../openfringe';
import { blockReach, carvePassage, makeStreetAt, splitLong, frontRangeDepth, shapeOkObb } from '../access';
import { buildCompound, pickBlock, type ClaimBlock } from '../compounds';
import { wallFeatures } from '../walls';
import type { Quarter } from '../primary';
import { GridIndex } from '../../geo/spatial';
import { polyInside } from '../../geo/split';
import { area as areaOf, pointInRing, distToSeg, bboxOf, orientPos } from '../../geo/poly';
import { unionMany } from '../../geo/bool';
import { openRing } from '../camps/kit';
import { marketHall } from '../m4/market';
import { embedChurch } from '../m4/churches';
import { registerM4 } from '../m4/index';
import { registerInca } from '../inca';
import { registerAztec } from '../aztec';
import { registerRussian } from '../russian';
import { registerFantasy } from '../fantasy';
import { registerByzantine } from '../byzantine';
import { registerVenice } from '../venice';
import { registerPersian } from '../persian';
import { registerOttoman } from '../ottoman';
import { registerSwahili, swahiliDoorLines } from '../swahili';
import { registerPrimitiveFeatures, primitiveGardenLines, halflingGardenTrees } from '../primitive_features';
import { registerSahel } from '../sahel';
import { registerHanse } from '../hanse';
import { registerKorea } from '../korea';
import { innerPoint } from './plan';
import { MEGA_KEY, type MacroPlan } from './types';

interface Runtime {
  ctx: UrbanCtx;
  base: Rng;
  morphs: MorphologyParams[];
  /** Street boxes (macro ids). */
  sbox: { x0: number; y0: number; x1: number; y1: number }[];
  /** Standing wall edges (faubourg fade, ribbons along the walls). */
  wallIdx: GridIndex<{ a: Vec2; b: Vec2 }>;
}
const RT = new WeakMap<MacroPlan, Runtime>();

/** Shared, order-independent context of the plan's quarters (built once per World, never mutated). */
function runtime(world: World, M: MacroPlan): Runtime {
  let rt = RT.get(M);
  if (rt) return rt;
  const morphs = M.morphs as MorphologyParams[];
  const ctx = makeCtx(world, morphs[0], M.ctxRadius);
  const sbox = M.streets.map((s) => bboxOf(s.path));
  const wallIdx = new GridIndex<{ a: Vec2; b: Vec2 }>(60);
  for (const r of M.wallRings) for (let i = 0; i < r.length; i++) wallIdx.insertSeg(r[i], r[(i + 1) % r.length], { a: r[i], b: r[(i + 1) % r.length] });
  registerM4(); registerInca(); registerAztec(); registerRussian(); registerFantasy(); registerByzantine(); registerVenice();
  registerPersian(); registerOttoman(); registerSwahili(); registerSahel(); registerHanse(); registerKorea();
  registerPrimitiveFeatures();
  rt = { ctx, base: new Rng(M.seedKey), morphs, sbox, wallIdx };
  RT.set(M, rt);
  return rt;
}

/** Parts of a closed ring within a box (as polylines). */
function ringNear(ring: Polygon, b: { x0: number; y0: number; x1: number; y1: number }): Polyline[] {
  const n = ring.length;
  const inB = (p: Vec2) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;
  const keep = ring.map((p, i) => inB(p) || inB(ring[(i + 1) % n]) || inB(ring[(i - 1 + n) % n]));
  if (keep.every((k) => k)) return [ring.concat([ring[0]])];
  const out: Polyline[] = [];
  let s0 = keep.findIndex((k, i) => !k && keep[(i + 1) % n]);
  if (s0 < 0) return out;
  let cur: Vec2[] = [];
  for (let k = 1; k <= n; k++) {
    const i = (s0 + k) % n;
    if (keep[i]) cur.push(ring[i]);
    else { if (cur.length >= 2) out.push(cur); cur = []; }
  }
  if (cur.length >= 2) out.push(cur);
  return out;
}

export const megaKey = (si: number, q: number): number => si * MEGA_KEY + q;

/** The urban layers holding a macro plan: the main settlement (index 0) and big secondary settlements. */
export function megaHosts(world: World): { si: number; u: UrbanLayer; M: MacroPlan }[] {
  const out: { si: number; u: UrbanLayer; M: MacroPlan }[] = [];
  if (world.urban?.macro) out.push({ si: 0, u: world.urban, M: world.urban.macro });
  for (const s of world.settlements ?? []) if (!s.main && s.index > 0 && s.urban?.macro) out.push({ si: s.index, u: s.urban, M: s.urban.macro });
  return out;
}

const RANK_W = [0.26, 0.18, 0.02, -0.12, -0.2];
const LOT_SITE: Record<string, UrbanSite['role']> = { 'm4-palace': 'power', 'm4-cathedral-close': 'worship', 'm4-monastery': 'worship', 'swahili-juma-mosque': 'worship', 'swahili-mosque': 'worship', 'swahili-fort': 'power', 'swahili-merchant-house': 'civic', 'cattle-kraal': 'civic', 'chieftain-hall': 'power', 'kiva-plaza': 'worship' };

/**
 * The detail of macro quarter `id` of the World's megacity plan: an urban layer holding only that quarter's own
 * streets, blocks, parcels, buildings, masses and plan lines (the arterials, walls and quarters stay in the macro
 * layer). Null when the World has no macro plan or no such quarter.
 */
export function megaQuarterDetail(world: World, key: number): UrbanLayer | null {
  if (world.options.biome === 'underdark-caverns') world = { ...world, options: { ...world.options, biome: 'underdark' } };
  const si = Math.floor(key / MEGA_KEY), id = key - si * MEGA_KEY;
  const host = si === 0 ? world.urban : world.settlements?.[si]?.urban;
  const M = host?.macro;
  const mq = M?.quarters[id];
  if (!M || !mq || !host) return null;
  // (a secondary settlement's context is centred on its own plan)
  const secondary = si > 0 ? world.settlements?.[si] : undefined;
  const hostOptions = si === 0 ? optionsForMainSettlement(world.options) : secondary && world.options.workflow === 'list'
    ? optionsForSettlement(world.options, { population: secondary.population, culture: secondary.culture,
      siteType: secondary.archetype, position: secondary.center, options: secondary.options })
    : world.options;
  const rt = runtime(si === 0 ? { ...world, options: hostOptions } : { ...world, options: hostOptions, site: { ...world.site!, center: M.center } }, M);
  const ctx = rt.ctx;
  const rng = rt.base.fork('quarter:' + id);
  const P = rt.morphs[mq.morph];
  const pop = M.population;
  const nucleus = M.nuclei[mq.nucleus]?.p ?? M.center;

  // ---- the streets this quarter can see: the arterials around it (same ids as the macro labels)
  const local = new Streets();
  local.thin = true;
  const [qx0, qy0, qx1, qy1] = mq.bb;
  const MG = 260;
  M.streets.forEach((st, i) => {
    const b = rt.sbox[i];
    const near = st.widths[0] > 0 && !(b.x0 > qx1 + MG || b.x1 < qx0 - MG || b.y0 > qy1 + MG || b.y1 < qy0 - MG);
    if (near) local.add(st.path, st.widths, st.rank, st.role, st.phase, true);
    else local.list.push({ id: i, path: st.path, widths: st.widths, rank: st.rank, role: st.role, phase: st.phase, ribbon: false });
    local.connected.add(i);
  });
  const nMacro = local.list.length;
  const box = { x0: qx0 - MG, y0: qy0 - MG, x1: qx1 + MG, y1: qy1 + MG };
  const wallLines = M.wallRings.flatMap((r) => ringNear(r, box)).map((path) => ({ path, width: 2.6 + 3 }));

  // ---- level 2: blocks
  const q: Quarter = {
    lp: { pts: mq.pts.slice(), lab: mq.lab.slice() }, phase: mq.phase, zone: mq.zone, age: mq.age,
    kind: mq.kind === 'lot' ? 'lot' : mq.kind, morph: P, culture: mq.culture,
    lot: mq.kind === 'lot' ? 'lot:' + id : undefined, compound: mq.compound,
  };
  const field = new GuidanceField(ctx, nucleus, local, M.mainAngle, rt.base.fork('field'));
  field.terrainAngle = M.terrainAngle;
  field.waterAngle = M.waterAngle;
  // the anchors of the arterials around the quarter (shared with the quarters across them)
  const anchors: Vec2[] = [];
  for (const l of new Set(mq.lab)) if (l >= 0 && M.streets[l]?.anchors) anchors.push(...M.streets[l].anchors!);
  const pieces = splitQuarter(ctx, q, id, local, field, { nucleus, gridAngle: M.mainAngle, terrainAngle: M.terrainAngle, waterAngle: M.waterAngle, anchors }, rng.fork('split'));
  field.P = null;
  // ---- the landmarks the macro plan asked for, on the best piece
  const wantData = new Map<string, unknown>();
  const sites: UrbanSite[] = [];
  if (mq.wants.length && mq.kind === 'quarter') {
    const qc = innerPoint(mq.pts);
    const cb: ClaimBlock[] = pieces.map((pc) => ({ poly: pc.lp.pts, kind: pc.kind, phase: pc.phase, zone: pc.zone, quarter: id, height: ctx.heightAt(innerPoint(pc.lp.pts)) }));
    const taken = new Set<number>();
    const R = Math.sqrt(mq.area / Math.PI);
    mq.wants.forEach((w, k) => {
      const nuc = w.kind === 'm4-cathedral-close' ? (M.nuclei[mq.nucleus]?.p ?? M.center) : qc;
      const pi = pickBlock(cb, w.place, w.area, nuc, R, {
        frontsNucleus: () => 0, edgeDist: (p) => Math.min(...mq.pts.map((a, i) => distToSeg(p, a, mq.pts[(i + 1) % mq.pts.length]))), gates: [], rng: rng.fork('lm:' + k), taken,
      });
      if (pi < 0) return;
      taken.add(pi);
      if (w.data !== undefined) wantData.set(w.kind, w.data);
      if (w.kind === 'parish-church' && P.plotOp === 'burgage' && rng.fork('emb:' + k).chance(0.65)) { pieces[pi].compound = 'embedded-church'; cb[pi].kind = 'church'; return; }
      pieces[pi].kind = w.kind === 'parish-church' ? 'church' : 'compound';
      pieces[pi].compound = w.kind;
      cb[pi].kind = pieces[pi].kind;
    });
  }
  const closes = addCloses(ctx, pieces, local, rng.fork('closes'));
  const derbs = culDeSacTree(pieces, local, rng.fork('derbs'));
  const ribIdx = buildRibbonIndex(local, wallLines);
  const cr = carveBlocks(q, pieces, ribIdx, local, (2.6 + 3) / 2);
  const carved: CarvedBlock[] = cr.blocks;

  // ---- compounds and landmarks, claimed before plots
  const landmarks: UrbanLayer['landmarks'] = [];
  const parcels: UrbanParcel[] = [];
  const buildings: UrbanBuilding[] = [];
  const waterPieces: PolyH[] = [];
  const lines: UrbanLine[] = [];
  const trees: UrbanTree[] = [];
  const compoundOf: (string | undefined)[] = carved.map(() => undefined);
  const extraWalls: NonNullable<ReturnType<typeof buildCompound>['walls']> = [];
  const claim = (bi: number, kind: string, ang: number, data?: unknown): boolean => {
    const out = buildCompound(kind, carved[bi].poly, { angle: ang, pop, rng: rng.fork('cmp:' + bi), center: M.center, data });
    // (the citadel's curtain is drawn by the macro plan)
    if (out.walls) extraWalls.push(...out.walls.filter((w) => !(w.role === 'castle' && mq.compound === 'm4-castle')));
    if (out.trees) trees.push(...out.trees);
    if (!out.parcels.length) return false;
    const first = parcels.length;
    for (const p of out.parcels) parcels.push({ poly: p.poly, use: p.use, block: bi, zone: carved[bi].zone });
    for (const b of out.buildings) buildings.push({ poly: b.poly, kind: b.kind, parcel: first + b.parcel, arch: b.arch, roof: b.roof, storeys: b.storeys, material: b.material, courtyards: b.courtyards, orientation: b.orientation, ...(b.ring ? { ring: true } : {}) });
    lines.push(...out.lines);
    for (const w of out.water) waterPieces.push({ outer: w, holes: [] });
    landmarks.push(...out.landmarks);
    carved[bi].kind = kind === 'church' || kind === 'parish-church' ? 'church' : out.parcels[0].use === 'place' ? 'place' : 'compound';
    compoundOf[bi] = kind;
    if (Object.prototype.hasOwnProperty.call(LOT_SITE, kind)) sites.push({ id: kind.replace(/^m4-/, '') + ':' + id + ':' + bi, kind: kind.replace(/^m4-/, ''), role: LOT_SITE[kind], lot: carved[bi].poly, anchor: innerPoint(carved[bi].poly), culture: mq.culture });
    return true;
  };
  const orient = P.orientation === 'cardinal' ? 0 : P.orientation === 'terrain' ? M.terrainAngle : P.orientation === 'water' ? M.waterAngle : M.mainAngle;
  carved.forEach((b, bi) => {
    if (b.kind === 'market' && mq.nucleus === 0 && M.nucleusCompound) claim(bi, M.nucleusCompound, M.mainAngle);
    else if (b.compound && b.compound !== 'embedded-church' && !compoundOf[bi]) claim(bi, b.compound, b.compound === 'great-mosque' ? 0.2 : orient, mq.kind === 'lot' ? mq.data : wantData.get(b.compound));
  });

  // ---- level 3: plots
  const wealthR = Math.max(150, Math.sqrt(areaOf(M.rings[0]) / Math.PI));
  const wealthAt = (p: Vec2, rank: number): number => Math.max(0, Math.min(1, 0.66 * (1 - dist(p, M.center) / (1.25 * wealthR)) + (RANK_W[Math.min(4, Math.max(0, rank))] ?? -0.2) + 0.08));
  const faubFade = (p: Vec2): number => {
    let d = Infinity;
    rt.wallIdx.forEachIn(p.x - 381, p.y - 381, p.x + 381, p.y + 381, (sg) => { const e = distToSeg(p, sg.a, sg.b); if (e < d) d = e; });
    if (!M.wallRings.length || d > 381) d = 1e9;
    return Math.max(0, Math.min(1, (d - 50) / 330));
  };
  const plots: Plot[] = [];
  const blockInfill: number[] = [];
  carved.forEach((b, bi) => {
    const br = rng.fork('blk:' + bi);
    const [c0, c1] = P.coverage[b.zone];
    const infill = c0 + (c1 - c0) * br.float();
    blockInfill.push(infill);
    if (compoundOf[bi]) return;
    if (b.kind !== 'block') {
      const use = mq.district === 'gardens' ? 'green' : b.kind === 'market' ? (mq.district === 'market' || mq.nucleus === 0 ? 'market' : 'green') : b.kind === 'church' ? 'church' : mq.kind === 'place' ? 'green' : 'place';
      if (use === 'green') b.kind = 'green';
      parcels.push({ poly: b.poly, use, block: bi, zone: b.zone });
      return;
    }
    const fade = b.zone === 'faubourg' && P.faubFade !== false ? faubFade(innerPoint(b.poly)) : 0;
    const Pb = fade > 0 ? { ...P, frontage: { ...P.frontage, faubourg: [P.frontage.faubourg[0] * (1 + 0.9 * fade), P.frontage.faubourg[1] * (1 + 1.3 * fade)] as [number, number] } } : P;
    const r = Pb.plotOp === 'wholeBlock' ? retainBlockPlot(b.poly, bi, b.zone, local)
      : Pb.plotOp === 'courtyard' || P.plotOp === 'compound' ? cutCourtyards(b.poly, bi, b.zone, P, local, br)
      : P.plotOp === 'garden' ? { plots: [], back: [b.poly] }
      : cutPlots(b.poly, bi, b.zone, infill, Pb, local, br, wealthAt);
    for (const p of r.plots) p.wealth = wealthAt({ x: (p.front[0].x + p.front[1].x) / 2, y: (p.front[0].y + p.front[1].y) / 2 }, p.rank);
    if (fade > 0) for (const p of r.plots) p.fade = faubFade({ x: (p.front[0].x + p.front[1].x) / 2, y: (p.front[0].y + p.front[1].y) / 2 });
    let rplots = r.plots;
    if (b.compound === 'embedded-church' && rplots.length > 3) {
      const ec = embedChurch(rplots, pop, rng.fork('ech:' + bi));
      if (ec) {
        rplots = rplots.filter((pl) => !ec.plots.includes(pl));
        const pi = parcels.length;
        parcels.push({ poly: ec.lot, use: 'place', block: bi, front: ec.front, zone: b.zone });
        for (const part of ec.parts) { buildings.push({ poly: part, kind: 'church', parcel: pi, arch: 'parish-church', roof: 'gable', material: 'stone', storeys: 1 }); landmarks.push({ kind: 'church', poly: part }); }
      }
    }
    for (const p of rplots) { plots.push(p); parcels.push({ poly: p.poly, use: 'plot', block: bi, front: p.front, zone: b.zone }); }
    for (const gp of r.back) parcels.push({ poly: gp, use: 'garden', block: bi, zone: b.zone });
  });
  // the market hall (or town hall with its belfry) on the main square
  if (!host.renderHints?.primitive && host.culture !== 'swahili-stone-town') {
    const mi = parcels.findIndex((p) => p.use === 'market');
    if (mi >= 0) { const hb = marketHall(parcels[mi].poly, mq.nucleus === 0 ? pop : 9000, rng.fork('hall')); if (hb) buildings.push({ ...hb, parcel: mi }); }
  }
  const plotted = new Set(parcels.filter((p) => p.use === 'plot').map((p) => p.block));
  carved.forEach((b, bi) => { if (b.kind === 'block' && !compoundOf[bi] && !plotted.has(bi)) b.kind = 'green'; });
  {
    const plotA = new Float64Array(carved.length);
    for (const p of parcels) if (p.use === 'plot') plotA[p.block] += areaOf(p.poly);
    carved.forEach((b, bi) => { if (b.kind === 'block' && !compoundOf[bi]) { const A = areaOf(b.poly); if (A > 12000 && plotA[bi] < 0.3 * A) b.kind = 'green'; } });
  }

  // ---- level 4: buildings
  const plotGardens: Polygon[] = [];
  const parcelIndexOfPlot: number[] = [];
  parcels.forEach((pc, i) => { if (pc.use === 'plot') parcelIndexOfPlot.push(i); });
  const courtHint = (pl: Plot) => {
    const cr2 = rng.fork('court:' + pl.block + ':' + pl.run);
    const phase = cr2.int(0, 8), f = cr2.range(0.35, 0.65);
    return { court: (pl.order + phase) % 9 < 1, f };
  };
  const port = mq.district === 'port', craft = mq.district === 'craft';
  const plotBld: ArchBldg[][] = plots.map(() => []);
  if (naturalGroundEligible(host)) {
    markPlannedTerminalPlots(plots, local.list.filter((s) => s.ribbon).map((s) => ({
      path: s.path, width: s.widths.reduce((a, b) => a + b, 0) / s.widths.length,
      widths: s.widths, kind: s.rank <= 1 ? 'main' : s.rank <= 2 ? 'street' : 'alley',
      rank: s.rank, role: s.role, phase: s.phase,
    })), host.footprintH, { regionalRoads: [...(world.roads ?? []), ...host.streets], barriers: ctx.water });
  }
  plots.forEach((pl, pi) => {
    const pr = rng.fork('pl:' + pi);
    const cov = Math.max(0, Math.min(1, (blockInfill[pl.block] + pr.range(-0.03, 0.03)) * (1 - 0.4 * (pl.fade ?? 0))));
    const fm = { x: (pl.front[0].x + pl.front[1].x) / 2, y: (pl.front[0].y + pl.front[1].y) / 2 };
    const onQuay = port && !!local.nearest(fm, 10, (st) => st.role === 'quay');
    for (const b of buildOn(pl, cov, P, pr, courtHint(pl))) {
      if (b.kind === 'garden') { plotGardens.push(b.poly); continue; }
      if (onQuay && b.kind === 'house' && P.buildingOp !== 'venetian' && P.buildingOp !== 'primitive') { b.arch = b.arch === 'swahili-stone-house' ? 'swahili-seafront-house' : 'warehouse'; b.storeys = 3; }
      else if (craft && b.kind === 'house' && P.buildingOp !== 'primitive') b.arch = 'craft-workshop';
      plotBld[pi].push(b);
    }
    plotBld[pi] = splitLong(plotBld[pi].filter((b) => !b.ring)).filter((b) => b.kind === 'landmark' || shapeOkObb(b.poly)).concat(plotBld[pi].filter((b) => b.ring));
  });
  // ---- access: every building touches the street or open ground reached from it (as in the town stage)
  {
    const places = parcels.filter((p) => ['place', 'market', 'quay', 'green'].includes(String(p.use))).map((p) => p.poly);
    const streetAt = makeStreetAt(local.list.filter((st) => st.ribbon).map((st) => ({ path: st.path, widths: st.widths, width: st.widths[0] })), places);
    const byBlock = new Map<number, number[]>();
    plots.forEach((pl, pi) => { if (!byBlock.has(pl.block)) byBlock.set(pl.block, []); byBlock.get(pl.block)!.push(pi); });
    const others = new Map<number, number[]>();
    buildings.forEach((b, i) => { if (b.parcel !== undefined) { const bk = parcels[b.parcel].block; if (!others.has(bk)) others.set(bk, []); others.get(bk)!.push(i); } });
    const touchesFront = (pl: Plot, poly: Polygon): boolean => {
      const segs = [pl.front, ...pl.sideFronts];
      return poly.some((qq) => segs.some(([a, b]) => distToSeg(qq, a, b) < 0.6));
    };
    for (const [bk, pis] of byBlock) {
      const block = carved[bk].poly;
      if (!others.has(bk) && pis.every((pi) => plotBld[pi].every((b) => touchesFront(plots[pi], b.poly)))) continue;
      const reach = (): boolean[][] => {
        const list: Polygon[] = [], own: [number, number][] = [];
        pis.forEach((pi) => plotBld[pi].forEach((b, k) => { list.push(b.poly); own.push([pi, k]); }));
        const extra = others.get(bk) ?? [];
        const ok = blockReach(block, [...list, ...extra.map((i) => buildings[i].poly)], streetAt);
        const res: boolean[][] = pis.map((pi) => plotBld[pi].map(() => true));
        own.forEach(([pi, k], j) => { res[pis.indexOf(pi)][k] = ok[j]; });
        return res;
      };
      for (const pi of pis) {
        if (plots[pi].gated || plotBld[pi].every((b) => touchesFront(plots[pi], b.poly))) continue;
        const dF = frontRangeDepth(plots[pi], plotBld[pi]);
        if (dF > 0) plotBld[pi] = carvePassage(plots[pi], plotBld[pi], 'A', 1.6, dF + 0.05);
      }
      let r = reach();
      const need = pis.filter((_, j) => r[j].some((v) => !v));
      if (!need.length) continue;
      const done = new Set<string>();
      const key = (a: number, b: number) => Math.min(a, b) + ':' + Math.max(a, b);
      const share = (a: number, sa: 'A' | 'B', b: number, sb: 'A' | 'B'): boolean => {
        if (done.has(key(a, b))) return true;
        plotBld[a] = carvePassage(plots[a], plotBld[a], sa, 0.8);
        plotBld[b] = carvePassage(plots[b], plotBld[b], sb, 0.8);
        done.add(key(a, b));
        return true;
      };
      for (const pi of need) {
        const pl = plots[pi];
        const nb = pis.find((qq) => qq !== pi && plots[qq].run === pl.run && dist(plots[qq].sideA.p, pl.sideB.p) < 0.05);
        const pv = pis.find((qq) => qq !== pi && plots[qq].run === pl.run && dist(plots[qq].sideB.p, pl.sideA.p) < 0.05);
        let ok = false;
        if (nb !== undefined) ok = share(pi, 'B', nb, 'A');
        if (!ok && pv !== undefined) ok = share(pi, 'A', pv, 'B');
        if (!ok) plotBld[pi] = carvePassage(plots[pi], plotBld[pi], 'A', 1.6);
      }
      r = reach();
      pis.forEach((pi, j) => { plotBld[pi] = plotBld[pi].filter((_, k) => r[j][k]); });
    }
  }
  plots.forEach((_pl, pi) => {
    for (const b of plotBld[pi]) {
      // Match the eager path: bevel final roofs after access, before read-only containment/mass assembly.
      const poly = b.kind === 'house' && b.arch === 'persian-courtyard-house' ? chamferPersianHouse(b.poly) : b.poly;
      buildings.push({ poly, kind: b.kind, parcel: parcelIndexOfPlot[pi], arch: b.arch, roof: b.roof, storeys: b.storeys, material: b.material, courtyards: b.courtyards, orientation: b.orientation, ...(b.ring ? { ring: true } : {}) });
    }
  });
  for (let i = buildings.length - 1; i >= 0; i--) {
    const b = buildings[i];
    if (b.parcel !== undefined && !polyInside(parcels[b.parcel].poly, b.poly)) buildings.splice(i, 1);
  }
  // ---- plan lines: walled compound lots (yashiki, siheyuan, kancha...), ward walls
  const hints = (host.renderHints ?? {}) as { compoundWalls?: boolean; wardWalls?: boolean };
  if (hints.compoundWalls) {
    plots.forEach((pl, pi) => {
      const op = P.buildingOp;
      if ((op !== 'yashiki' && op !== 'pavilionCompound' && op !== 'kancha' && op !== 'yardHouse' && op !== 'sahelCompound' && op !== 'hanok') || !plotBld[pi].length) return;
      const p = pl.poly;
      const fm = { x: (pl.front[0].x + pl.front[1].x) / 2, y: (pl.front[0].y + pl.front[1].y) / 2 };
      if (op === 'yardHouse') { for (const w of openRing(orientPos(p), [{ p: fm, width: 3.2 }])) lines.push({ kind: 'yard-fence', path: w, width: 0.45 }); return; }
      if (op === 'kancha' || op === 'sahelCompound' || op === 'hanok') { for (const w of openRing(orientPos(p), [{ p: fm, width: 3.4 }])) lines.push({ kind: 'compound-wall', path: w, width: 1 }); return; }
      for (let k = 0; k < p.length; k++) {
        const a = p[k], c = p[(k + 1) % p.length];
        if (distToSeg(fm, a, c) < 0.3) continue;
        if (dist(a, c) > 1) lines.push({ kind: 'compound-wall', path: [a, c], width: 0.8 });
      }
    });
  }
  if (hints.wardWalls && P.streets.includes('wardWalls')) {
    carved.forEach((b) => {
      if (b.kind !== 'block') return;
      const p = b.poly;
      for (let k = 0; k < p.length; k++) {
        const a = p[k], c = p[(k + 1) % p.length];
        const ns = local.nearest({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 }, 12);
        if (ns && local.list[ns.s].rank <= 2 && dist(a, c) > 3) lines.push({ kind: 'ward-wall', path: [a, c], width: 1.2 });
      }
    });
  }
  const walls: UrbanWall[] = extraWalls.map((w, wi) => {
    const wf = wallFeatures(w.ring, w.gates, rng.fork('xwall:' + wi), ctx.isWater, (p) => ctx.isWater(p), 40);
    return { path: w.ring, closed: true, towers: wf.towers, gates: w.gates.map((g) => g.p), thickness: 3.2, gateInfo: w.gates, pieces: wf.pieces, gateTowers: wf.gateTowers, towerScale: wf.towerScale.map((x) => x * 1.15), curtains: wf.curtains, towerShape: host.renderHints?.towerShape ?? 'round', role: w.role === 'castle' ? 'castle' : 'quarter' };
  });
  // Macro frames stay immutable. Finish only after the actual fences, ward walls and lot curtains exist,
  // so moving a rectangle inside its lot cannot occupy their reserved ground.
  // Every independent claim stays in its fixed 16 m collar and outside its neighbours' 18 m collars.
  // Thus two quarters cannot both claim the same free outer land, even when detail order changes.
  const neighbourReach = 36;
  const detailProtectedLand: PolyH[] = [
      ...ctx.water, ...waterPieces,
      ...M.quarters.filter((other) => other.id !== id && other.bb[0] <= mq.bb[2] + neighbourReach && other.bb[2] >= mq.bb[0] - neighbourReach
        && other.bb[1] <= mq.bb[3] + neighbourReach && other.bb[3] >= mq.bb[1] - neighbourReach).flatMap((other) => quarterRoofCollar(other.pts, 18)),
      ...(world.roads ?? []).flatMap((s) => streetStrips(s.path, s.width)),
      ...local.list.filter((s) => s.ribbon).flatMap((s) => streetStrips(s.path, s.widths)),
      ...[...(host.walls ?? []), ...walls].flatMap((w) => streetStrips(w.closed && w.path.length ? w.path.concat([w.path[0]]) : w.path, w.thickness)),
      ...lines.filter((l) => /wall|fence|palisade|rampart|barbican|hedge/.test(l.kind)).flatMap((l) => streetStrips(l.closed && l.path.length ? l.path.concat([l.path[0]]) : l.path, l.width ?? 1)),
    ];
  const detailPartition = {
    ctx, quarters: [q], blocks: carved, quarterOf: () => 0, parcels, buildings, streetSpace: [cr.streetSpace],
    footprint: [{ outer: q.lp.pts, holes: [] }], gardens: plotGardens, streets: local,
    protectedLand: detailProtectedLand,
    growthLimit: quarterRoofCollar(mq.pts, 16),
    allowGrowth: q.lp.lab.includes(LAB_OPEN),
    eligible: (pi: number) => parcels[pi].use === 'plot' && ['streetFrontRow', 'detached', 'machiya', 'giebelhaus', 'yardHouse', 'shopRow'].includes(P.buildingOp),
  };
  finishEdgeRoofs(detailPartition);
  const releasedFootprintLand: PolyH[] = [];
  const privatePassages: PrivatePassage[] = [];
  const placementClear = footprintPlacementGuard(detailProtectedLand, p => ctx.isWater(p) || ctx.slopeAt(p) > 0.28);
  const privateAccess = privatePassageAccess({ buildings, parcels, blocks: carved.map(b => b.poly),
    streets: local.list.filter(s => s.ribbon).map(s => ({ path: s.path, widths: s.widths, width: s.widths[0] })),
    places: parcels.filter(p => ['place', 'market', 'quay', 'green'].includes(String(p.use))).map(p => p.poly),
    publicGround: detailPartition.streetSpace.flat(), footprint: detailPartition.footprint,
    passages: privatePassages, placementClear });
  finalizeFootprints({ buildings, parcels, backLand: releasedFootprintLand, gardens: plotGardens,
    placementClear, privatePassages, ...privateAccess, proposePrivatePassage: privateAccess.connectPrivatePassage,
    allowFillRemoval: true,
    tipConstrained: physicalTipConstraint(detailProtectedLand, ctx.isWater),
    openQuarterEdge: openQuarterEdge(M.quarters) });
  for (const passage of privatePassages) {
    const phase = carved[parcels[passage.parcel].block]?.phase ?? mq.phase;
    const sid = local.add(passage.path, passage.width, 4, 'close', phase);
    local.list[sid].private = true;
    local.connected.add(sid);
  }
  const perBlock: Polygon[][] = carved.map(() => []);
  for (const b of buildings) if (b.parcel !== undefined) perBlock[parcels[b.parcel].block].push(b.poly);
  const masses: PolyH[] = [];
  perBlock.forEach((list) => { if (list.length) for (const ph of unionMany(list, 24, true)) masses.push({ outer: ph.outer, holes: ph.holes }); });
  const streets: UrbanStreet[] = local.list.slice(nMacro).filter((s) => s.ribbon).map((s) => ({
    path: s.path, width: s.widths.reduce((a, b) => a + b, 0) / s.widths.length, widths: s.widths,
    kind: s.rank <= 1 ? 'main' : s.rank <= 2 ? 'street' : 'alley', rank: s.rank, role: s.role, phase: s.phase,
    ...(s.private ? { private: true } : {}),
  }));
  if (host.renderHints?.carvedDoors) lines.push(...swahiliDoorLines(buildings, parcels));
  if (host.renderHints?.primitive) lines.push(...primitiveGardenLines(mq.culture, parcels));
  if (world.options.biome !== 'underdark' && host.renderHints?.primitive && mq.culture === 'halfling') trees.push(...halflingGardenTrees(parcels, buildings));
  if (world.options.biome === 'underdark') trees.length = 0;
  const layer: UrbanLayer = {
    footprint: [], footprintH: [], streets, blocks: carved.map((b) => b.poly), parcels, buildings, walls, landmarks, squares: [],
    archetype: 'town', population: mq.pop, morphology: P.id, phases: [], quarters: [],
    blockInfo: carved.map((b, bi) => ({ quarter: id, phase: b.phase, zone: b.zone, kind: b.kind, compound: compoundOf[bi], culture: mq.culture, morphology: P.id })),
    masses, backLand: [...parcels.filter((p) => p.use === 'garden').map((p) => p.poly).concat(plotGardens).map((p): PolyH => ({ outer: p, holes: [] })), ...releasedFootprintLand],
    lines, trees, water: waterPieces, sites,
  };
  const groundView: UrbanLayer = { ...layer, quarters: [{ poly: { outer: q.lp.pts, holes: [] }, phase: q.phase, zone: q.zone, streetSpace: detailPartition.streetSpace[0] }] };
  finishOpenEdges(groundView, {
    seed: world.seed,
    owner: host.footprintH,
    regionalRoads: [...(world.roads ?? []), ...host.streets],
    barriers: [...ctx.water, ...(host.ruralReserve ?? [])],
    protectedGround: [...host.streets.flatMap((s) => streetStrips(s.path, s.widths ?? s.width)),
      ...[...(host.walls ?? []), ...walls].flatMap((w) => streetStrips(w.closed ? [...w.path, w.path[0]] : w.path, w.thickness + 2)),
      ...lines.filter((l) => /wall|fence|palisade|rampart|barbican|hedge/.test(l.kind)).flatMap((l) => streetStrips(l.closed && l.path.length ? [...l.path, l.path[0]] : l.path, l.width ?? 1))],
  }, host);
  layer.openTails = groundView.openTails;
  layer.openEdgeGround = groundView.openEdgeGround;
  void closes; void derbs; void pointInRing;
  return layer;
}
