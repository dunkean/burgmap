/**
 * Urban stage orchestrator: partition, never place (URBAN_GEOMETRY.md).
 * plan (culture) → region → quarters (level 1) → blocks (level 2) → compounds, plots (level 3) → built / unbuilt
 * (level 4). The culture (URBAN_MORPHOLOGY.md) chooses the phases and their enclosures, the nucleus, the street
 * operators, the plot and building operators per quarter, and the landmark catalogue.
 */
import type { Vec2, Polygon } from '../core/geom';
import { dist } from '../core/geom';
import type { Rng } from '../core/rng';
import type { World, UrbanLayer, UrbanStreet, PolyH as PolyHT, UrbanLine, UrbanTree } from '../types';
import type { MorphologyParams, Zone } from './morphology';
import { resolveMorph } from './morphology';
import { resolvePlan, getCulture, ResolvedPlan, EnclosureSpec, NucleusSpec } from './culture';
import { planRibbonVillage } from './villages';
import { makeCtx } from './context';
import { choosePopulation, chooseArchetype, planServedPhases, planFaubourgs, EnclosurePlan, zonesFor, PhaseInput } from './phases';
import { buildPrimary, Quarter } from './primary';
import { Streets, LAB_OPEN } from './streets';
import { mpArea, MultiPoly } from '../geo/bool';
import { GuidanceField } from './field';
import { splitQuarter, addCloses, carveBlocks, buildRibbonIndex, Piece, CarvedBlock } from './blocks';
import { culDeSacTree } from './culdesac';
import { polygonCentroid } from '../core/geom';
import { cutPlots, Plot } from './plots';
import { cutCourtyards } from './courtyards';
import { buildOn } from './bops';
import { wallFeatures } from './walls';
import { buildCompound, pickBlock, ClaimBlock } from './compounds';
import { approachGates, axisLines, outsetConvex } from './streetops';
import { distToRing, pointInRing, area as areaOf, inscribed, convexHull } from '../geo/poly';
import { unionMany } from '../geo/bool';
import type { UrbanBuilding, PolyH, UrbanParcel } from '../types';

export interface UrbanResult { layer: UrbanLayer; stats: Record<string, number | string>; debug: UrbanDebug }
export interface UrbanDebug { quarters: { poly: Polygon; phase: number; lab: number[] }[] }

const MARKET_AREA = (pop: number): number => (pop < 1200 ? 0 : Math.min(7000, 1300 + pop * 0.22));
/** Qibla from the Maghreb, roughly east-south-east (map angle, y down). */
const QIBLA = 0.2;
const NUCLEUS_COMPOUND: Record<string, string> = { mosque: 'great-mosque', castle: 'castle', temple: 'hindu-temple', grove: 'grove', 'drum-tower': 'drum-tower' };

/** A point strictly inside a polygon (centroid when inside, else the inscribed-circle center). */
export function interiorPoint(p: Polygon): Vec2 {
  const c = polygonCentroid(p);
  return pointInRing(p, c) ? c : inscribed(p, [], 1).c;
}

export function mainRoadAngle(world: World): number {
  const c = world.site!.center;
  let best = 0, bl = -1;
  for (const rd of world.roads ?? []) {
    if (rd.kind === 'track') continue;
    const pl = rd.path;
    if (dist(pl[pl.length - 1], c) > 10) continue;
    const q = pl[Math.max(0, pl.length - 12)];
    const l = pl.length;
    if (l > bl) { bl = l; best = Math.atan2(q.y - c.y, q.x - c.x); }
  }
  return best;
}

const orientAngle = (o: EnclosureSpec['orientation'] | NucleusSpec['orientation'], main: number) => (o === 'cardinal' ? 0 : o === 'qibla' ? QIBLA : main);

export function generateUrban(world: World, root: Rng): UrbanResult {
  const t0 = performance.now();
  const rng = root.fork('urban');
  const opts = world.options;
  const culture = getCulture(opts.culture);
  const pop = choosePopulation(opts.size, opts.population, rng.fork('pop'));
  let roads = (world.roads ?? []).filter((r) => r.kind !== 'track').map((r) => ({ path: r.path, major: r.kind === 'major' }));
  const reaching = roads.filter((r) => dist(r.path[r.path.length - 1], world.site!.center) < 10).length;
  let archetype = chooseArchetype(pop, reaching, rng.fork('arch'));
  const settlement = archetype === 'hamlet' ? culture.hamlet : archetype === 'town' ? null : culture.village;
  if (settlement && settlement.form !== 'auto' && archetype !== 'town') archetype = 'nucleated-village';
  // the plan of a town; villages and hamlets use the culture's settlement form
  const plan: ResolvedPlan = resolvePlan(culture.id, pop, archetype === 'town' ? opts.cultureMix : null, archetype === 'town' ? opts.plan : null);
  const coreMorph = settlement?.morphology ? resolveMorph(settlement.morphology) : plan.phases[0].morph;
  const base = coreMorph;
  // hamlets: wide farm plots and no block splitting; street villages: long blocks between field lanes
  const params: MorphologyParams = archetype === 'hamlet'
    ? { ...base, frontage: { ...base.frontage, village: [26, 55] }, blockSize: { ...base.blockSize, village: [60000, 90000] } }
    : archetype === 'street-village' ? { ...base, blockSize: { ...base.blockSize, village: [9000, 26000] } } : base;
  const lastEnc: EnclosureSpec = archetype === 'town' ? plan.phases[plan.phases.length - 1].enc : { ...plan.phases[0].enc, ...(settlement?.enclosure ?? {}) };
  const wallKind = lastEnc.wall;
  const autoWalled = archetype === 'town' && (pop >= 2500 || rng.fork('walls').chance(0.6));
  const canWall = archetype === 'town' || archetype === 'nucleated-village';
  const walled = opts.walls === 'no' ? false : opts.walls === 'yes' ? canWall
    : wallKind === 'auto' ? autoWalled : wallKind === 'none' ? false : canWall;
  const estArea = (pop / params.density.middle) * 1e4;
  const ctx = makeCtx(world, params, 2.6 * Math.sqrt(estArea / Math.PI) + 450);
  const mainAngle = mainRoadAngle(world);
  const streets = new Streets();

  let eplan: EnclosurePlan | null = null;
  let faub: { region: MultiPoly } = { region: [] };
  let marketArea = 0, extraRadials = false;
  let faubZone: Zone = 'faubourg';
  let nucleusSpec: NucleusSpec | null = null;
  let phaseMorphs: MorphologyParams[] = [];
  const phaseInputs = (n: number, zones: Zone[]): PhaseInput[] => plan.phases.slice(0, n).map((ph, k) => ({
    zone: zones[k], share: ph.share, density: ph.morph.density[zones[k]],
    shape: ph.enc.shape === 'terraces' ? 'rect' : ph.enc.shape, angle: orientAngle(ph.enc.orientation, mainAngle),
    aspect: ph.enc.aspect ? ph.enc.aspect[0] + (ph.enc.aspect[1] - ph.enc.aspect[0]) * rng.fork('aspect:' + k).float() : 1.35,
    closing: ph.morph.streetOp === 'organic', fossil: ph.enc.fossil !== 'none',
  }));
  if (archetype === 'hamlet' || archetype === 'street-village') {
    const rv = planRibbonVillage(ctx, roads, pop, archetype, rng.fork('village'));
    if (rv) {
      eplan = { phases: rv.phases, enclosure: rv.enclosure, walled: false };
      marketArea = archetype === 'street-village' ? 500 + pop * 0.6 : 0;
      phaseMorphs = [params];
    } else archetype = 'nucleated-village';
  }
  if (!eplan && archetype === 'nucleated-village') {
    const enc = { ...plan.phases[0].enc, ...(settlement?.enclosure ?? {}) };
    const spec: PhaseInput = {
      zone: 'village', share: 1, density: params.density.village, shape: enc.shape === 'terraces' ? 'rect' : enc.shape,
      angle: orientAngle(enc.orientation, mainAngle), aspect: 1.2, closing: params.streetOp === 'organic', fossil: false,
    };
    eplan = planServedPhases(ctx, pop, walled, mainAngle, rng.fork('phases'), roads, { nPh: 1, zones: ['village'], faubShare: 0.3, specs: settlement && settlement.form !== 'auto' ? [spec] : undefined });
    faub = planFaubourgs(ctx, eplan.enclosure, roads, ((pop * 0.3) / params.density.village) * 1e4, 0, rng.fork('faubourg'));
    const nu = { ...plan.nucleus, ...(settlement?.nucleus ?? {}) };
    marketArea = nu.kind === 'market' ? 500 + pop * 0.8 : 0;
    if (settlement && settlement.form !== 'auto') nucleusSpec = nu;
    faubZone = 'village';
    phaseMorphs = [params];
  }
  if (!eplan) {
    const n = plan.phases.length;
    const zones = zonesFor(n);
    const faubShare = plan.faubShare[walled ? 0 : 1];
    eplan = planServedPhases(ctx, pop, walled, mainAngle, rng.fork('phases'), roads, { specs: phaseInputs(n, zones), faubShare });
    const faubPop = pop * faubShare;
    // scarce land: what the enclosure could not hold grows along the roads instead
    const encTarget = eplan.phases.reduce((s2, ph, k) => s2 + (ph.pop / (plan.phases[k].morph.density[ph.zone] * (eplan!.densityScale ?? 1))) * 1e4, 0);
    const short = (eplan.shortfall ?? 0) > 0.05 * encTarget ? ((eplan.shortfall ?? 0) * params.density.middle) / plan.faubourg.density.faubourg : 0;
    faub = planFaubourgs(ctx, eplan.enclosure, roads, (faubPop / plan.faubourg.density.faubourg) * 1e4 + short, walled ? 22 : 0, rng.fork('faubourg'));
    marketArea = plan.nucleus.area === 'market' ? MARKET_AREA(pop) : 0;
    extraRadials = plan.phases.some((p) => p.morph.extraRadials && p.morph.streetOp !== 'grid');
    nucleusSpec = plan.nucleus;
    phaseMorphs = plan.phases.map((p) => p.morph);
  }
  const allStreetOps = new Set(phaseMorphs.flatMap((m) => m.streets));
  const stats: Record<string, number | string> = { pop, archetype, walled: walled ? 1 : 0, morphology: params.id, culture: culture.id };
  const t1 = performance.now();

  // ---- nucleus
  let nucleusIn: { shape: 'hull' | 'rect' | 'square' | 'circle'; area: number; angle: number; ring: number } | undefined;
  if (nucleusSpec && nucleusSpec.kind !== 'none') {
    const A = nucleusSpec.area === 'market' ? (marketArea || (archetype === 'town' ? 0 : 500 + pop * 0.8))
      : nucleusSpec.area[0] + (nucleusSpec.area[1] - nucleusSpec.area[0]) * Math.max(0, Math.min(1, (pop - 1500) / 25000));
    if (A > 0) nucleusIn = { shape: nucleusSpec.shape, area: A, angle: orientAngle(nucleusSpec.orientation, mainAngle), ring: nucleusSpec.ring };
  }
  // ---- axes and centred gates (planned towns): the regional roads are led to the gates
  let axisIn: { angle: number; extent: MultiPoly; width: number } | undefined;
  const axisPhase = eplan.phases.reduce((k, _ph, i) => ((phaseMorphs[i]?.streets.includes('axis')) ? i : k), -1);
  if (axisPhase >= 0 && archetype !== 'hamlet' && archetype !== 'street-village') {
    const m = phaseMorphs[axisPhase];
    const extent = eplan.phases[axisPhase].region;
    const angle = m.orientation === 'cardinal' ? 0 : mainAngle;
    axisIn = { angle, extent, width: m.widthByRank[0] * m.widthScale };
    let big = extent[0];
    for (const ph of extent) if (areaOf(ph.outer) > areaOf(big.outer)) big = ph;
    if (big) {
      const hull = convexHull(big.outer);
      const ends = axisLines(ctx.center, angle, big.outer, null).map((a) => ({ p: a.end, dir: a.dir }));
      if (ends.length) {
        const newPaths = approachGates(roads.map((r) => r.path), hull, ends, ctx.center, 30, ctx.isWater);
        roads = roads.map((r, i) => ({ ...r, path: newPaths[i] }));
        // the regional road layer follows (roads converge on the gates)
        const wr = (world.roads ?? []).filter((r) => r.kind !== 'track');
        wr.forEach((r, i) => { r.path = newPaths[i]; });
      }
    }
  }
  const coreM = phaseMorphs[0];
  const prim = buildPrimary(ctx, {
    phases: eplan.phases, enclosure: eplan.enclosure, walled: eplan.walled, faubourg: faub.region, roads,
    marketArea, mainAngle, extraRadials: extraRadials && !allStreetOps.has('spiral'), faubZone,
    nucleus: nucleusIn, axis: axisIn,
    gridCore: phaseMorphs.length > 1 && phaseMorphs[0].streetOp === 'grid' && !axisIn ? eplan.phases[0].region : null,
    spineAmp: allStreetOps.has('gateToGate') ? coreM.spineAmp : 0,
    kinks: allStreetOps.has('defensiveKinks') ? Math.max(...phaseMorphs.map((m) => m.kinks)) : 0,
    spiral: allStreetOps.has('spiral') ? { arms: pop > 6000 ? 5 : 4, turns: 0.32 } : undefined,
  }, streets, rng.fork('primary'));
  const t2 = performance.now();
  stats['ms.phases'] = Math.round(t1 - t0);
  stats['ms.primary'] = Math.round(t2 - t1);
  stats['quarters'] = prim.quarters.length;
  stats['ha.enclosed'] = Math.round(mpArea(eplan.enclosure) / 1e3) / 10;
  stats['ha.faubourg'] = Math.round(mpArea(faub.region) / 1e3) / 10;
  stats['ha.shortfall'] = Math.round((eplan.shortfall ?? 0) / 1e3) / 10;

  // ---- quarter morphologies: the phase's (or a sector's); faubourgs get the faubourg morphology
  const nPh = eplan.phases.length;
  const faubMorph = archetype === 'town' ? plan.faubourg : params;
  prim.quarters.forEach((q: Quarter) => {
    if (q.kind === 'market' || q.phase <= 0) { q.morph = phaseMorphs[0]; q.culture = plan.phases[0]?.culture ?? culture.id; return; }
    if (q.phase > nPh) { q.morph = faubMorph; q.culture = culture.id; return; }
    const ph = archetype === 'town' ? plan.phases[q.phase - 1] : null;
    q.morph = phaseMorphs[q.phase - 1] ?? params;
    q.culture = ph?.culture ?? culture.id;
    if (ph && ph.sectors.length) {
      const c = interiorPoint(q.lp.pts);
      let a = Math.atan2(c.y - ctx.center.y, c.x - ctx.center.x) - mainAngle;
      a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI);
      let acc = 0;
      for (const s of ph.sectors) { if (a >= acc && a < acc + s.share) { q.morph = s.morph; q.culture = s.culture; break; } acc += s.share; }
    }
  });

  // ---- level 2: blocks
  const nucleus = prim.market ? polygonCentroid(prim.market) : ctx.center;
  const field = new GuidanceField(ctx, nucleus, streets, mainAngle, rng.fork('field'));
  const pieces: Piece[][] = prim.quarters.map(() => []);
  const done = prim.quarters.map(() => false);
  for (let round = 0; round < 6; round++) {
    let progress = false;
    prim.quarters.forEach((q, qi) => {
      if (done[qi]) return;
      if (q.kind !== 'market' && !q.lp.lab.some((l) => l >= 0 && streets.connected.has(l))) return;
      pieces[qi] = splitQuarter(ctx, q, qi, streets, field, { nucleus, gridAngle: mainAngle }, rng.fork('q:' + qi));
      done[qi] = true;
      progress = true;
    });
    if (!progress) break;
  }
  field.P = null;
  const t3 = performance.now();
  let demoted = 0;
  for (const st of streets.list) if (!streets.connected.has(st.id) && st.ribbon) { streets.demote(st.id); demoted++; }
  if (demoted) for (const list of pieces) for (const pc of list) pc.lp.lab = pc.lp.lab.map((l) => (l >= 0 && !streets.list[l].ribbon ? LAB_OPEN : l));
  stats['demotedStreets'] = demoted;
  const closes = addCloses(ctx, pieces.flat(), streets, rng.fork('closes'));
  const derbs = culDeSacTree(pieces.flat(), streets, rng.fork('derbs'));
  const carved: CarvedBlock[] = [];
  const streetSpace: MultiPoly[] = [];
  const ribIdx = buildRibbonIndex(streets, prim.walls.map((w) => ({ path: w.ring.concat([w.ring[0]]), width: 2.6 + 3 })));
  const blockMorph: MorphologyParams[] = [];
  const blockCulture: string[] = [];
  prim.quarters.forEach((q, qi) => {
    const r = carveBlocks(q, pieces[qi], ribIdx, streets, (2.6 + 3) / 2);
    for (const b of r.blocks) { carved.push(b); blockMorph.push(q.morph ?? params); blockCulture.push(q.culture ?? culture.id); }
    streetSpace.push(r.streetSpace);
  });
  const blockPts = carved.map((b) => interiorPoint(b.poly));
  const holdsBlock = (ph: { outer: Polygon; holes: Polygon[] }) => blockPts.some((p) => pointInRing(ph.outer, p) && !ph.holes.some((h) => pointInRing(h, p)));
  prim.walls = prim.walls.filter((w) => holdsBlock({ outer: w.ring, holes: [] }));
  prim.footprint = prim.footprint.filter(holdsBlock);
  for (const ph of eplan.phases) ph.region = ph.region.filter(holdsBlock);
  const urbanized = new Set(carved.map((b) => b.quarter));
  let capacity = 0;
  const dScale = eplan.densityScale ?? 1;
  prim.quarters.forEach((q, qi) => { if (urbanized.has(qi) && q.kind !== 'market') capacity += (areaOf(q.lp.pts) * (q.morph ?? params).density[q.zone] * (q.zone === 'faubourg' ? 1 : dScale)) / 1e4; });
  stats['capacity'] = Math.round(capacity);
  const t4 = performance.now();
  stats['ms.split'] = Math.round(t3 - t2);
  stats['ms.carve'] = Math.round(t4 - t3);
  stats['blocks'] = carved.length;

  // ---- compounds and landmarks, claimed before plots (the nucleus, then the catalogue)
  const landmarks: UrbanLayer['landmarks'] = [];
  const parcels: UrbanParcel[] = [];
  const buildings: UrbanBuilding[] = [];
  const lines: UrbanLine[] = [];
  const waterPieces: PolyH[] = [];
  const compoundOf: (string | undefined)[] = carved.map(() => undefined);
  const perBlock: Polygon[][] = carved.map(() => []);
  const cxFor = (bi: number, ang: number) => ({ angle: ang, pop, rng: rng.fork('cmp:' + bi), center: ctx.center });
  const claim = (bi: number, kind: string, ang: number): boolean => {
    const out = buildCompound(kind, carved[bi].poly, cxFor(bi, ang));
    if (!out.parcels.length) return false;
    const first = parcels.length;
    for (const p of out.parcels) parcels.push({ poly: p.poly, use: p.use, block: bi, zone: carved[bi].zone });
    for (const b of out.buildings) {
      buildings.push({ poly: b.poly, kind: b.kind, parcel: first + b.parcel, arch: b.arch, roof: b.roof, storeys: b.storeys, material: b.material, courtyards: b.courtyards, orientation: b.orientation });
    }
    lines.push(...out.lines);
    for (const w of out.water) waterPieces.push({ outer: w, holes: [] });
    landmarks.push(...out.landmarks);
    carved[bi].kind = kind === 'church' ? 'church' : out.parcels[0].use === 'place' ? 'place' : 'compound';
    compoundOf[bi] = kind;
    return true;
  };
  const nucleusKind = nucleusSpec?.kind ?? 'market';
  if (prim.market) {
    const mbi = carved.findIndex((b) => b.kind === 'market');
    const ck = NUCLEUS_COMPOUND[nucleusKind];
    if (mbi >= 0 && ck) claim(mbi, ck, nucleusIn?.angle ?? mainAngle);
    else landmarks.push({ kind: nucleusKind === 'forum' ? 'forum' : archetype === 'town' ? 'market' : 'green', poly: prim.market });
  }
  if (archetype !== 'hamlet') {
    const encR = Math.sqrt(mpArea(eplan.enclosure) / Math.PI);
    const encRings = eplan.enclosure.map((ph) => ph.outer);
    const gates = prim.walls.flatMap((w) => w.gates.map((g) => g.p));
    const taken = new Set<number>();
    const frontsNucleus = (i: number): number => {
      if (prim.marketStreet < 0) return 0;
      let front = 0;
      const b = carved[i].poly;
      for (let k = 0; k < b.length; k++) {
        const p = b[k], q = b[(k + 1) % b.length];
        const ns = streets.nearest({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, 8);
        if (ns && ns.s === prim.marketStreet) front += dist(p, q);
      }
      return front;
    };
    const cb: ClaimBlock[] = carved.map((b) => ({ poly: b.poly, kind: b.kind, phase: b.phase, zone: b.zone, quarter: b.quarter }));
    for (const lm of plan.landmarks) {
      if (pop < lm.minPop) continue;
      const count = lm.count ?? 1;
      for (let k = 0; k < count; k++) {
        const bi = pickBlock(cb, lm.place, lm.area, nucleus, encR, {
          frontsNucleus, edgeDist: (p) => Math.min(...encRings.map((r) => distToRing(r, p)), 1e9), gates, rng: rng.fork('lm:' + lm.kind + k), taken,
        });
        if (bi < 0) break;
        taken.add(bi);
        const ang = lm.kind === 'great-mosque' ? QIBLA : blockMorph[bi].orientation === 'cardinal' ? 0 : mainAngle;
        if (claim(bi, lm.kind, ang)) cb[bi].kind = carved[bi].kind;
      }
    }
  }

  // ---- level 3: plots (by the block's plot operator)
  const plots: Plot[] = [];
  const plotMorph: MorphologyParams[] = [];
  const blockInfill: number[] = [];
  const slowest = { ms: 0, bi: -1, n: 0 };
  carved.forEach((b, bi) => {
    const P = blockMorph[bi];
    const br = rng.fork('blk:' + bi);
    const [c0, c1] = P.coverage[b.zone];
    const infill = c0 + (c1 - c0) * br.float();
    blockInfill.push(infill);
    if (compoundOf[bi]) return;
    if (b.kind !== 'block') {
      const use = b.kind === 'market' ? (archetype === 'town' ? 'market' : 'green') : b.kind === 'church' ? 'church' : 'place';
      parcels.push({ poly: b.poly, use, block: bi, zone: b.zone });
      return;
    }
    const tb0 = performance.now();
    const r = P.plotOp === 'courtyard' || P.plotOp === 'compound' ? cutCourtyards(b.poly, bi, b.zone, P, streets, br)
      : P.plotOp === 'garden' ? { plots: [], back: [b.poly] }
      : cutPlots(b.poly, bi, b.zone, infill, P, streets, br);
    const tb1 = performance.now() - tb0;
    if (tb1 > slowest.ms) { slowest.ms = tb1; slowest.bi = bi; slowest.n = b.poly.length; }
    for (const p of r.plots) { plots.push(p); plotMorph.push(P); parcels.push({ poly: p.poly, use: 'plot', block: bi, front: p.front, zone: b.zone }); }
    for (const g of r.back) parcels.push({ poly: g, use: 'garden', block: bi, zone: b.zone });
  });
  const t5 = performance.now();
  stats['ms.plots'] = Math.round(t5 - t4);
  stats['plots'] = plots.length;
  stats['ms.slowestBlock'] = Math.round(slowest.ms);
  stats['slowestBlockVerts'] = slowest.n;

  // ---- level 4: buildings (by the block's building operator), unioned into masses per block
  const plotGardens: Polygon[] = [];
  const parcelIndexOfPlot: number[] = [];
  parcels.forEach((pc, i) => { if (pc.use === 'plot') parcelIndexOfPlot.push(i); });
  const courtHint = (pl: Plot) => {
    const cr = rng.fork('court:' + pl.block + ':' + pl.run);
    const phase = cr.int(0, 8), f = cr.range(0.35, 0.65);
    return { court: (pl.order + phase) % 9 < 2, f };
  };
  plots.forEach((pl, pi) => {
    const pr = rng.fork('pl:' + pi);
    const cov = Math.max(0, Math.min(1, blockInfill[pl.block] + pr.range(-0.03, 0.03)));
    for (const b of buildOn(pl, cov, plotMorph[pi], pr, courtHint(pl))) {
      if (b.kind === 'garden') { plotGardens.push(b.poly); continue; }
      buildings.push({ poly: b.poly, kind: b.kind, parcel: parcelIndexOfPlot[pi], arch: b.arch, roof: b.roof, storeys: b.storeys, material: b.material, courtyards: b.courtyards, orientation: b.orientation });
    }
  });
  for (const b of buildings) if (b.parcel !== undefined) perBlock[parcels[b.parcel].block].push(b.poly);
  const t6 = performance.now();
  const masses: PolyH[] = [];
  perBlock.forEach((list) => { if (list.length) for (const ph of unionMany(list, 24, true)) masses.push({ outer: ph.outer, holes: ph.holes }); });
  const t7 = performance.now();
  stats['ms.buildings'] = Math.round(t6 - t5);
  stats['ms.masses'] = Math.round(t7 - t6);
  stats['buildings'] = buildings.length;
  stats['closes'] = closes + derbs;

  // ---- plan lines: ward walls (fang), compound walls of courtyard / yashiki lots, moat outside the town wall
  const hints = plan.render;
  if (hints.wardWalls) {
    carved.forEach((b, bi) => {
      if (b.kind !== 'block' || !blockMorph[bi].streets.includes('wardWalls')) return;
      const p = b.poly;
      for (let k = 0; k < p.length; k++) {
        const a = p[k], c = p[(k + 1) % p.length];
        const ns = streets.nearest({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 }, 12);
        if (ns && streets.list[ns.s].rank <= 2 && dist(a, c) > 3) lines.push({ kind: 'ward-wall', path: [a, c], width: 1.2 });
      }
    });
  }
  if (hints.moat) {
    for (const w of prim.walls) {
      const off = outsetConvex(convexHull(w.ring), 12);
      if (off.length >= 3) lines.push({ kind: 'moat', path: off, closed: true, width: 9 });
    }
  }
  // ---- elven canopy: trees over the town, clear of the houses
  const trees: UrbanTree[] = [];
  if (hints.canopy) {
    const tr = rng.fork('trees');
    const houses = buildings.map((b) => ({ c: polygonCentroid(b.poly), r: Math.sqrt(areaOf(b.poly) / Math.PI) }));
    for (const fp of prim.footprint) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const q of fp.outer) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
      for (let y = y0; y < y1; y += 11) for (let x = x0; x < x1; x += 11) {
        const p = { x: x + tr.range(-4, 4), y: y + tr.range(-4, 4) };
        if (!pointInRing(fp.outer, p) || ctx.isWater(p)) continue;
        const r = tr.range(4, 7.5);
        if (houses.some((h) => dist(h.c, p) < h.r + r * 0.45)) continue;
        trees.push({ x: p.x, y: p.y, r });
      }
    }
  }

  const keptQ = prim.quarters.map((_, qi) => qi).filter((qi) => urbanized.has(qi));
  const qMap: number[] = [];
  keptQ.forEach((qi, k) => { qMap[qi] = k; });
  const toPH = (m: { outer: Polygon; holes: Polygon[] }[]): PolyHT[] => m.map((p) => ({ outer: p.outer, holes: p.holes }));
  const layerStreets: UrbanStreet[] = streets.list.filter((s) => s.ribbon).map((s) => ({
    path: s.path, width: s.widths.reduce((a, b) => a + b, 0) / s.widths.length, widths: s.widths,
    kind: s.rank <= 1 ? 'main' : s.rank <= 2 ? 'street' : 'alley', rank: s.rank, role: s.role, phase: s.phase,
  }));
  const towerShape = hints.towerShape;
  const layer: UrbanLayer = {
    footprint: prim.footprint.map((p) => p.outer),
    footprintH: toPH(prim.footprint),
    streets: layerStreets,
    blocks: carved.map((b) => b.poly), parcels, buildings,
    walls: prim.walls.map((w, wi) => {
      const nearW = (q: Vec2) => ctx.water.some((ph) => distToRing(ph.outer, q) < 4 || pointInRing(ph.outer, q));
      const wf = wallFeatures(w.ring, w.gates, rng.fork('wall:' + wi), ctx.isWater, nearW);
      return { path: w.ring, closed: true, towers: wf.towers, gates: w.gates.map((g) => g.p), thickness: wallKind === 'hedge' || wallKind === 'palisade' ? 1.6 : pop > 12000 ? 3.2 : 2.6, gateInfo: w.gates.map((g) => ({ p: g.p, dir: g.dir, width: g.width })), pieces: wf.pieces, gateTowers: wf.gateTowers, towerScale: wf.towerScale, curtains: wf.curtains, towerShape };
    }),
    landmarks, squares: prim.market && !compoundOf[carved.findIndex((b) => b.kind === 'market')] ? [prim.market] : [],
    archetype, population: pop, morphology: params.id,
    phases: eplan.phases.map((p) => ({ id: p.id, kind: p.kind, zone: p.zone, region: toPH(p.region), walled: p.walled, fossil: p.fossil })),
    quarters: keptQ.map((qi) => { const q = prim.quarters[qi]; return { poly: { outer: q.lp.pts, holes: [] }, phase: q.phase, zone: q.zone, streetSpace: toPH(streetSpace[qi]) }; }),
    blockInfo: carved.map((b, bi) => ({ quarter: qMap[b.quarter], phase: b.phase, zone: b.zone, kind: b.kind === 'market' && archetype !== 'town' ? 'green' : b.kind, compound: compoundOf[bi], culture: blockCulture[bi], morphology: blockMorph[bi].id })), masses,
    backLand: parcels.filter((p) => p.use === 'garden').map((p) => p.poly).concat(plotGardens).map((p) => ({ outer: p, holes: [] })),
    culture: culture.id, cultures: plan.cultures.map((c) => c.id), renderHints: { ...hints, towerShape },
    lines, trees, water: waterPieces,
  };
  const debug: UrbanDebug = { quarters: prim.quarters.map((q) => ({ poly: q.lp.pts, phase: q.phase, lab: q.lp.lab })) };
  stats['ms.urban'] = Math.round(performance.now() - t0);
  return { layer, stats, debug };
}
