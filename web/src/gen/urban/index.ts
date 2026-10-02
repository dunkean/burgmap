/**
 * Urban stage orchestrator: partition, never place (URBAN_GEOMETRY.md).
 * plan (culture) → region → quarters (level 1) → blocks (level 2) → compounds, plots (level 3) → built / unbuilt
 * (level 4). The culture (URBAN_MORPHOLOGY.md) chooses the phases and their enclosures, the nucleus, the street
 * operators, the plot and building operators per quarter, and the landmark catalogue.
 */
import type { Vec2, Polygon, Polyline } from '../core/geom';
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
import { mpArea, MultiPoly, differenceS } from '../geo/bool';
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
import { StreetGraph } from '../geo/graph';
import { polyInside } from '../geo/split';
import type { UrbanBuilding, PolyH, UrbanParcel, UrbanSite, UrbanWall } from '../types';
import { m4Flags, registerM4 } from './m4/index';
import { siteCastle, type CastlePlan } from './m4/castle';
import { reserveCastle, type M4State } from './m4/reserve';
import { reserveCathedral, reservePalace, reserveMonasteries } from './m4/catalogue';
import { LineIndex } from './m4/lots';
import { marketHall } from './m4/market';
import { reservePort, portPieceBuildings } from './m4/port';
import { pickInns, innBuildings } from './m4/inns';
import { reserveMills, reserveWindmills, reserveTanneries, reserveRoadside, reserveArena } from './m4/activities';
import type { ReservedLot } from './primary';
import { unionS } from '../geo/bool';

export interface UrbanResult { layer: UrbanLayer; stats: Record<string, number | string>; debug: UrbanDebug }
export interface UrbanDebug { quarters: { poly: Polygon; phase: number; lab: number[] }[] }

/** Grand-place (M4): 0.2–1 ha, growing with the town. */
const MARKET_AREA = (pop: number): number => (pop < 1200 ? 0 : Math.min(10000, 1800 + pop * 0.3));
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

let TERRAIN_ANGLE = 0;
const orientAngle = (o: EnclosureSpec['orientation'] | NucleusSpec['orientation'], main: number) => (o === 'cardinal' ? 0 : o === 'qibla' ? QIBLA : o === 'terrain' ? TERRAIN_ANGLE : main);

/** Contour direction (radians) at p: perpendicular to the gradient of the height field smoothed over ~120 m. */
export function contourAngle(world: World, p: Vec2): number {
  const g = world.terrain.height;
  let gx = 0, gy = 0;
  const R = 120;
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * 2 * Math.PI, dx = Math.cos(a), dy = Math.sin(a);
    const q = { x: p.x + dx * R, y: p.y + dy * R };
    const ix = Math.min(g.w - 1, Math.max(0, Math.floor(q.x / g.cell))), iy = Math.min(g.h - 1, Math.max(0, Math.floor(q.y / g.cell)));
    const h = g.data[iy * g.w + ix];
    gx += dx * h; gy += dy * h;
  }
  if (Math.hypot(gx, gy) < 1e-6) return 0;
  return Math.atan2(gy, gx) + Math.PI / 2;
}

/** Parcel uses of the open port pieces. */
const LOT_USE: Record<string, string> = { 'm4-quay': 'quay', 'm4-pier': 'pier', 'm4-slipway': 'slipway' };
const castleTower = (cid: string): 'round' | 'square' => (cid === 'medina' || cid === 'chinese' || cid === 'indian-temple' ? 'square' : 'round');

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
  TERRAIN_ANGLE = contourAngle(world, world.site!.center);
  const terrainAngle = TERRAIN_ANGLE;
  const streets = new Streets();
  registerM4();
  const flags = m4Flags(opts, culture, pop, archetype, rng.fork('m4'));
  const sites: UrbanSite[] = [];
  const lotData = new Map<string, unknown>();
  const lotKind = new Map<string, string>();
  const quays: Polyline[] = [];
  const siteLines: UrbanLine[] = [];
  let castle: CastlePlan | null = null;
  // the castle is sited on the enclosure before the faubourgs and the streets; it may extend the enclosure
  const siteCastleOn = (ep: EnclosurePlan): void => {
    if (!flags.castle || !ep.enclosure.length) return;
    const nonTrack = (world.roads ?? []).filter((r) => r.kind !== 'track').map((r) => r.path);
    castle = siteCastle(ctx, { enclosure: ep.enclosure, phases: ep.phases, roads: nonTrack, nucleus: ctx.center, pop, variant: flags.castle, walled: ep.walled, citadelSpot: world.site!.citadelSpot }, rng.fork('castle'));
    if (!castle) return;
    if (castle.outside) {
      const last = ep.phases[ep.phases.length - 1];
      last.band = unionS(last.band, differenceS(castle.C, ep.enclosure));
      last.region = unionS(last.region, castle.C).map((ph) => ({ outer: ph.outer, holes: [] }));
      ep.enclosure = castle.enclosure;
    }
  };

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
    eplan = planServedPhases(ctx, pop, walled, mainAngle, rng.fork('phases'), roads, { nPh: 1, zones: ['village'], faubShare: 0.3, specs: settlement && settlement.form !== 'auto' ? [spec] : undefined, organicOutline: enc.wall === 'hedge' || enc.wall === 'none' });
    siteCastleOn(eplan);
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
    // lines that never were walls (hedges, unwalled cultures) stay curved; wall lines become straight curtains
    const organicOutline = plan.phases.every((p) => p.enc.wall === 'hedge' || p.enc.wall === 'none');
    eplan = planServedPhases(ctx, pop, walled, mainAngle, rng.fork('phases'), roads, { specs: phaseInputs(n, zones), faubShare, organicOutline });
    siteCastleOn(eplan);
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
    nucleusRings: coreM.ringSpacing > 0 ? { spacing: coreM.ringSpacing, width: coreM.widthByRank[1] * coreM.widthScale } : undefined,
    switchbacks: allStreetOps.has('switchbacks') ? { angle: terrainAngle, pitch: coreM.gridSpacing[0] * 2, width: coreM.widthByRank[0] * coreM.widthScale } : undefined,
    gatesOnly: !!coreM.gatesOnly,
    preLots: castle ? [(castle as CastlePlan).lot] : [],
    reserve: (api) => {
      const st: M4State = { ctx, rng: rng.fork('m4lots'), pop, P: coreM, lotData, sites, culture: culture.id };
      const out: ReservedLot[] = [];
      if (castle) { const l = reserveCastle(st, api, castle); if (l) out.push(l); else castle = null; }
      const nonTrack = (world.roads ?? []).filter((r) => r.kind !== 'track').map((r) => r.path);
      const ci = { avoid: [] as Polygon[], nucleus: api.market ? polygonCentroid(api.market) : ctx.center, castle: castle ? (castle as CastlePlan).lot : null, roads: nonTrack };
      const tm = (k: string, f: () => void) => { const t = performance.now(); f(); stats['ms.lot.' + k] = Math.round(performance.now() - t); };
      const push = (l: ReservedLot | null) => { if (l) { out.push(l); ci.avoid.push(l.poly); lotKind.set(l.id, l.kind); } };
      if (castle) ci.avoid.push((castle as CastlePlan).lot);
      if (flags.port && archetype === 'town') tm('port', () => { for (const l of reservePort(st, api, { avoid: ci.avoid.slice(), nucleus: ci.nucleus, harbor: world.site!.harbor, roads: nonTrack, bridges: world.bridges ?? [] })) push(l); });
      quays.push(...(st.quays ?? []));
      if (flags.cathedral) tm('cathedral', () => push(reserveCathedral(st, api, ci)));
      if (flags.palace) tm('palace', () => push(reservePalace(st, api, ci)));
      if (flags.monasteries && flags.monastery) tm('monastery', () => { for (const l of reserveMonasteries(st, api, ci, flags.monasteries, flags.monastery!)) push(l); });
      const ai = { avoid: ci.avoid, nucleus: ci.nucleus, roads: nonTrack, bridges: world.bridges ?? [], lines: siteLines };
      if (flags.arena) tm('arena', () => push(reserveArena(st, api, ai)));
      if (flags.activities && archetype === 'town') {
        tm('activities', () => {
          for (const l of reserveTanneries(st, api, ai)) push(l);
          for (const l of reserveMills(st, api, ai, pop < 6000 ? 1 : pop < 25000 ? 2 : 3)) push(l);
          for (const l of reserveWindmills(st, api, ai, pop < 6000 ? 1 : pop < 25000 ? 3 : 4)) push(l);
          const rs: Parameters<typeof reserveRoadside>[3] = [{ kind: 'gallows', size: [16, 16], dmin: 140, dmax: 520 }];
          if (pop >= 4000) rs.push({ kind: 'lazar-house', size: [52, 38], dmin: 300, dmax: 900 });
          if (pop >= 9000) rs.push({ kind: 'cemetery', size: [80, 55], dmin: 40, dmax: 260 });
          for (const l of reserveRoadside(st, api, ai, rs)) push(l);
        });
      }
      return out;
    },
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
  field.terrainAngle = terrainAngle;
  const pieces: Piece[][] = prim.quarters.map(() => []);
  const done = prim.quarters.map(() => false);
  for (let round = 0; round < 6; round++) {
    let progress = false;
    prim.quarters.forEach((q, qi) => {
      if (done[qi]) return;
      if (q.kind === 'quarter' && !q.lp.lab.some((l) => l >= 0 && streets.connected.has(l))) return;
      pieces[qi] = splitQuarter(ctx, q, qi, streets, field, { nucleus, gridAngle: mainAngle, terrainAngle }, rng.fork('q:' + qi));
      done[qi] = true;
      progress = true;
    });
    if (!progress) break;
  }
  field.P = null;
  const t3 = performance.now();
  let demoted = 0;
  for (const st of streets.list) if (!streets.connected.has(st.id) && st.ribbon) { streets.demote(st.id); demoted++; }
  // geometric connectivity (as the checker sees it): street components that do not reach a radial are demoted
  {
    const g = new StreetGraph();
    for (const st of streets.list) if (st.ribbon) g.insertPolyline(st.path, { width: st.widths[0], rank: st.rank, phase: st.phase, kind: 'street', street: st.id }, { snapR: 0.3, mergeDist: 0 });
    const { comp } = g.components();
    const good = new Set<number>();
    for (const e of g.aliveEdges()) if (streets.list[e.street].role === 'radial') good.add(comp[e.a]);
    const bad = new Set<number>();
    for (const e of g.aliveEdges()) if (!good.has(comp[e.a])) bad.add(e.street);
    for (const id of bad) if (streets.list[id].ribbon && streets.list[id].role !== 'radial') { streets.demote(id); streets.connected.delete(id); demoted++; }
  }
  if (demoted) for (const list of pieces) for (const pc of list) pc.lp.lab = pc.lp.lab.map((l) => (l >= 0 && !streets.list[l].ribbon ? LAB_OPEN : l));
  stats['demotedStreets'] = demoted;
  // ---- landmark lots, claimed as whole pieces before dead ends and plots (URBAN_GEOMETRY §3.4)
  if (archetype !== 'hamlet') {
    const allPieces = pieces.flat();
    const encR = Math.sqrt(mpArea(eplan.enclosure) / Math.PI);
    const encRings = eplan.enclosure.map((ph) => ph.outer);
    const gates = prim.walls.flatMap((w) => w.gates.map((g) => g.p));
    const taken = new Set<number>();
    const frontsNucleus = (i: number): number => {
      let front = 0;
      const lp = allPieces[i].lp;
      for (let k = 0; k < lp.pts.length; k++) if (lp.lab[k] === prim.marketStreet && prim.marketStreet >= 0) front += dist(lp.pts[k], lp.pts[(k + 1) % lp.pts.length]);
      return front;
    };
    const cb: ClaimBlock[] = allPieces.map((pc) => ({ poly: pc.lp.pts, kind: pc.kind, phase: pc.phase, zone: pc.zone, quarter: pc.quarter, height: ctx.heightAt(interiorPoint(pc.lp.pts)) }));
    const placed = new Map<string, Vec2[]>();
    for (const lm of plan.landmarks) {
      if (pop < lm.minPop) continue;
      // the kasbah is the culture's castle: sited at level 1 by the castle rule (or switched off)
      if (lm.kind === 'kasbah' && (castle || opts.castle === 'no')) continue;
      if (lm.kind === 'hospital' && (!flags.activities || archetype !== 'town')) continue;
      const count = Math.max(lm.count ?? 1, lm.perPop ? Math.floor((pop - (lm.minPop - lm.perPop)) / lm.perPop) : 0);
      // separation from the other worship landmarks too (the main church counts for the parishes)
      const kin = lm.kind === 'parish-church' ? ['church', 'parish-church'] : [lm.kind];
      for (let k = 0; k < count; k++) {
        const others = kin.flatMap((kk) => placed.get(kk) ?? []);
        const pi = pickBlock(cb, lm.place, lm.area, nucleus, encR, {
          frontsNucleus, edgeDist: (p) => Math.min(...encRings.map((r) => distToRing(r, p)), 1e9), gates, rng: rng.fork('lm:' + lm.kind + k), taken, others, sep: lm.sep,
        });
        if (pi < 0) break;
        placed.set(lm.kind, [...(placed.get(lm.kind) ?? []), interiorPoint(allPieces[pi].lp.pts)]);
        taken.add(pi);
        allPieces[pi].kind = lm.kind === 'church' || lm.kind === 'parish-church' ? 'church' : 'compound';
        allPieces[pi].compound = lm.kind;
        cb[pi].kind = allPieces[pi].kind;
      }
    }
  }
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
  const cxFor = (bi: number, ang: number) => ({ angle: ang, pop, rng: rng.fork('cmp:' + bi), center: ctx.center, data: carved[bi].lot ? lotData.get(carved[bi].lot!) : undefined });
  const extraWalls: NonNullable<ReturnType<typeof buildCompound>['walls']> = [];
  const compoundTrees: UrbanTree[] = [];
  const claim = (bi: number, kind: string, ang: number): boolean => {
    const out = buildCompound(kind, carved[bi].poly, cxFor(bi, ang));
    if (out.walls) extraWalls.push(...out.walls);
    if (out.trees) compoundTrees.push(...out.trees);
    if (!out.parcels.length) return false;
    const first = parcels.length;
    for (const p of out.parcels) parcels.push({ poly: p.poly, use: p.use, block: bi, zone: carved[bi].zone });
    for (const b of out.buildings) {
      buildings.push({ poly: b.poly, kind: b.kind, parcel: first + b.parcel, arch: b.arch, roof: b.roof, storeys: b.storeys, material: b.material, courtyards: b.courtyards, orientation: b.orientation });
    }
    lines.push(...out.lines);
    for (const w of out.water) waterPieces.push({ outer: w, holes: [] });
    landmarks.push(...out.landmarks);
    carved[bi].kind = kind === 'church' || kind === 'parish-church' ? 'church' : out.parcels[0].use === 'place' ? 'place' : 'compound';
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
  // landmark lots claimed at level 2 (see above) are filled here
  carved.forEach((b, bi) => { if (b.compound && !compoundOf[bi]) claim(bi, b.compound, b.compound === 'great-mosque' ? QIBLA : blockMorph[bi].orientation === 'cardinal' ? 0 : blockMorph[bi].orientation === 'terrain' ? terrainAngle : mainAngle); });

  // ---- level 3: plots (by the block's plot operator)
  const encRingsF = eplan.enclosure.map((ph) => ph.outer);
  const faubFade = (p: Vec2): number => {
    const d = encRingsF.length ? Math.min(...encRingsF.map((r) => distToRing(r, p))) : 0;
    return Math.max(0, Math.min(1, (d - 50) / 330));
  };
  // the quay apron piece nearest the nucleus carries the fish market and the customs house
  let firstQuay = -1;
  carved.forEach((b, bi) => { if (b.lot && lotKind.get(b.lot) === 'm4-quay' && (firstQuay < 0 || dist(interiorPoint(b.poly), nucleus) < dist(interiorPoint(carved[firstQuay].poly), nucleus))) firstQuay = bi; });
  const plots: Plot[] = [];
  const plotMorph: MorphologyParams[] = [];
  const innGates = flags.activities && archetype === 'town' ? prim.walls.flatMap((w) => w.gates.filter((g) => g.street >= 0).map((g) => ({ p: g.p, street: g.street }))) : [];
  const innServed = new Set<{ p: Vec2; street: number }>();
  const smithies = new Set<Plot>();
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
      const lk = b.lot ? lotKind.get(b.lot) : undefined;
      const use = lk && LOT_USE[lk] ? LOT_USE[lk] : b.kind === 'market' ? (archetype === 'town' ? 'market' : 'green') : b.kind === 'church' ? 'church' : 'place';
      const pi = parcels.length;
      parcels.push({ poly: b.poly, use, block: bi, zone: b.zone });
      if (lk) for (const hb of portPieceBuildings(lk, b.poly, lotData.get(b.lot!), nucleus, bi === firstQuay)) buildings.push({ ...hb, parcel: pi });
      return;
    }
    const tb0 = performance.now();
    // faubourgs: plots widen along the ribbon (continuous rows at the gate, wider lots further out)
    const fade = b.zone === 'faubourg' ? faubFade(interiorPoint(b.poly)) : 0;
    const Pb = fade > 0 ? { ...P, frontage: { ...P.frontage, faubourg: [P.frontage.faubourg[0] * (1 + 0.9 * fade), P.frontage.faubourg[1] * (1 + 1.3 * fade)] as [number, number] } } : P;
    const r = Pb.plotOp === 'courtyard' || P.plotOp === 'compound' ? cutCourtyards(b.poly, bi, b.zone, P, streets, br)
      : P.plotOp === 'garden' ? { plots: [], back: [b.poly] }
      : cutPlots(b.poly, bi, b.zone, infill, Pb, streets, br);
    if (fade > 0) for (const p of r.plots) p.fade = faubFade({ x: (p.front[0].x + p.front[1].x) / 2, y: (p.front[0].y + p.front[1].y) / 2 });
    const tb1 = performance.now() - tb0;
    if (tb1 > slowest.ms) { slowest.ms = tb1; slowest.bi = bi; slowest.n = b.poly.length; }
    // inns at the gates: a few plots along the entrance road merged into one courtyard inn lot
    let rplots = r.plots;
    if (innGates.length && P.plotOp === 'burgage' && rplots.length > 3) {
      const free = innGates.filter((g) => !innServed.has(g));
      const picks = free.length ? pickInns(rplots, free, (pl) => streets.nearest({ x: (pl.front[0].x + pl.front[1].x) / 2, y: (pl.front[0].y + pl.front[1].y) / 2 }, 10)?.s ?? -1, br) : [];
      for (const pk of picks) {
        const g = free.find((q) => dist(q.p, pk.front[0]) < 200);
        if (g) innServed.add(g);
        rplots = rplots.filter((pl) => !pk.plots.includes(pl));
        const pi = parcels.length;
        parcels.push({ poly: pk.poly, use: 'inn', block: bi, front: pk.front, zone: b.zone });
        for (const ib of innBuildings(pk.poly, pk.front, pk.plots[0].nrm, rng.fork('inn:' + bi))) buildings.push({ poly: ib.poly, kind: 'house', parcel: pi, arch: ib.arch, roof: 'gable', material: 'timber', storeys: 2 });
        if (pk.smithy) smithies.add(pk.smithy);
      }
    }
    for (const p of rplots) { plots.push(p); plotMorph.push(P); parcels.push({ poly: p.poly, use: 'plot', block: bi, front: p.front, zone: b.zone }); }
    for (const g of r.back) parcels.push({ poly: g, use: 'garden', block: bi, zone: b.zone });
  });
  // ---- the market hall (or town hall with its belfry) standing on the grand-place
  if (flags.marketHall) {
    const mi = parcels.findIndex((p) => p.use === 'market');
    if (mi >= 0) {
      const hb = marketHall(parcels[mi].poly, pop, rng.fork('hall'));
      if (hb) buildings.push({ ...hb, parcel: mi });
    }
  }
  // blocks that received no plot (no street frontage: along water, behind a wall) stay kitchen gardens / orchards
  const plotted = new Set(parcels.filter((p) => p.use === 'plot').map((p) => p.block));
  carved.forEach((b, bi) => { if (b.kind === 'block' && !compoundOf[bi] && !plotted.has(bi)) b.kind = 'green'; });
  // a large piece that splitting could not open up (little street frontage) is plotted along its few streets only:
  // the rest is intramural gardens and orchards, so the block counts as green land (URBAN_GEOMETRY §2.2)
  {
    const plotA = new Float64Array(carved.length);
    for (const p of parcels) if (p.use === 'plot') plotA[p.block] += areaOf(p.poly);
    carved.forEach((b, bi) => { if (b.kind === 'block' && !compoundOf[bi]) { const A = areaOf(b.poly); if (A > 12000 && plotA[bi] < 0.3 * A) b.kind = 'green'; } });
  }
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
    return { court: (pl.order + phase) % 9 < 3, f };
  };
  plots.forEach((pl, pi) => {
    const pr = rng.fork('pl:' + pi);
    const cov = Math.max(0, Math.min(1, (blockInfill[pl.block] + pr.range(-0.03, 0.03)) * (1 - 0.4 * (pl.fade ?? 0))));
    let first = smithies.has(pl);
    for (const b of buildOn(pl, cov, plotMorph[pi], pr, courtHint(pl))) {
      if (b.kind === 'garden') { plotGardens.push(b.poly); continue; }
      if (first && b.kind === 'house') { b.arch = 'smithy'; first = false; }
      buildings.push({ poly: b.poly, kind: b.kind, parcel: parcelIndexOfPlot[pi], arch: b.arch, roof: b.roof, storeys: b.storeys, material: b.material, courtyards: b.courtyards, orientation: b.orientation });
    }
  });
  // final guard of the partition (level 4 ⊂ level 3): a footprint must lie inside its parcel
  for (let i = buildings.length - 1; i >= 0; i--) {
    const b = buildings[i];
    if (b.parcel !== undefined && !polyInside(parcels[b.parcel].poly, b.poly)) buildings.splice(i, 1);
  }
  for (const b of buildings) if (b.parcel !== undefined) perBlock[parcels[b.parcel].block].push(b.poly);
  const t6 = performance.now();
  const masses: PolyH[] = [];
  perBlock.forEach((list) => { if (list.length) for (const ph of unionMany(list, 24, true)) masses.push({ outer: ph.outer, holes: ph.holes }); });
  const t7 = performance.now();
  stats['ms.buildings'] = Math.round(t6 - t5);
  stats['ms.masses'] = Math.round(t7 - t6);
  stats['buildings'] = buildings.length;
  stats['closes'] = closes + derbs;

  lines.push(...siteLines);
  // ---- the stone quay edges
  for (const q of quays) lines.push({ kind: 'quay-edge', path: q, width: 1.1 });
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
  if (hints.moat && prim.walls.length) {
    // one moat around the whole (planned, convex) enclosure
    const off = outsetConvex(convexHull(prim.walls.flatMap((w) => w.ring)), 12);
    if (off.length >= 3) lines.push({ kind: 'moat', path: off, closed: true, width: 9 });
  }
  // ---- terraces (dwarven): retaining walls along the contour-parallel streets, hachured on the downhill side
  if (hints.terraces) {
    const ca = Math.cos(terrainAngle), sa = Math.sin(terrainAngle);
    // downhill normal: the side where the height decreases
    const probe = (p: Vec2, s2: number) => ctx.heightAt({ x: p.x - sa * s2, y: p.y + ca * s2 });
    for (const st of streets.list) {
      if (!st.ribbon || st.rank > 3 || st.role === 'close' || st.path.length < 2) continue;
      const a = st.path[0], b = st.path[st.path.length - 1];
      const L = dist(a, b);
      if (L < 20 || Math.abs(((b.x - a.x) * ca + (b.y - a.y) * sa) / L) < 0.94) continue;
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const down = probe(m, 8) < probe(m, -8) ? 1 : -1;
      const nx = -sa * down, ny = ca * down;
      const hw = st.widths[0] / 2;
      // the retaining wall on the downhill edge of the street, with hachures down the face
      const edge = st.path.map((q) => ({ x: q.x + nx * (hw - 0.4), y: q.y + ny * (hw - 0.4) }));
      lines.push({ kind: 'terrace', path: edge, width: 1.6 });
      const cum = [0];
      for (let i = 1; i < edge.length; i++) cum.push(cum[i - 1] + dist(edge[i - 1], edge[i]));
      for (let sPos = 1.5; sPos < cum[cum.length - 1]; sPos += 2.6) {
        let i = 1;
        while (i < edge.length - 1 && cum[i] < sPos) i++;
        const t = (sPos - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
        const q = { x: edge[i - 1].x + (edge[i].x - edge[i - 1].x) * t, y: edge[i - 1].y + (edge[i].y - edge[i - 1].y) * t };
        const len = sPos % 4.4 < 2.2 ? 3.2 : 1.8;
        lines.push({ kind: 'hachure', path: [q, { x: q.x - nx * len, y: q.y - ny * len }], width: 0.3 });
      }
    }
  }
  // ---- elven canopy: trees over the town, clear of the houses
  const trees: UrbanTree[] = [...compoundTrees];
  if (hints.canopy) {
    const tr = rng.fork('trees');
    const houses = buildings.map((b) => ({ c: polygonCentroid(b.poly), r: Math.sqrt(areaOf(b.poly) / Math.PI) }));
    for (const fp of prim.footprint) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const q of fp.outer) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
      for (let y = y0; y < y1; y += 14) for (let x = x0; x < x1; x += 14) {
        const p = { x: x + tr.range(-5, 5), y: y + tr.range(-5, 5) };
        if (!pointInRing(fp.outer, p) || ctx.isWater(p)) continue;
        const r = tr.range(4, 7.5);
        if (houses.some((h) => dist(h.c, p) < h.r + r * 0.45)) continue;
        // the main paths stay open to the sky; lanes run under the canopy
        const ns = streets.nearest(p, r + 4, (st) => st.rank <= 1 && st.ribbon);
        if (ns && ns.d < ns.hw + r * 0.6) continue;
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
    walls: prim.walls.map((w, wi): UrbanWall | null => {
      const nearW = (q: Vec2) => ctx.water.some((ph) => distToRing(ph.outer, q) < 4 || pointInRing(ph.outer, q));
      const wf = wallFeatures(w.ring, w.gates, rng.fork('wall:' + wi), ctx.isWater, nearW);
      if (wallKind === 'hedge') {
        // a living hedge: a plan line, no masonry
        lines.push({ kind: 'hedge', path: w.ring, closed: true, width: 2.6 });
        return null;
      }
      return { path: w.ring, closed: true, towers: wf.towers, gates: w.gates.map((g) => g.p), thickness: wallKind === 'palisade' ? 1.6 : pop > 12000 ? 3.2 : 2.6, gateInfo: w.gates.map((g) => ({ p: g.p, dir: g.dir, width: g.width })), pieces: wf.pieces, gateTowers: wf.gateTowers, towerScale: wf.towerScale, curtains: wf.curtains, towerShape, role: 'town' as const };
    }).filter((w): w is UrbanWall => !!w).concat(extraWalls.map((w, wi): UrbanWall => {
      // castle curtains: the stretches lying on the town wall are drawn by the town wall
      const townIdx = new LineIndex(prim.walls.map((tw) => ({ path: tw.ring.concat([tw.ring[0]]), hw: 0 })));
      const skip = (q: Vec2) => townIdx.dist(q, 3) < 1.5 || ctx.isWater(q);
      const wf = wallFeatures(w.ring, w.gates, rng.fork('xwall:' + wi), ctx.isWater, skip, 40);
      return { path: w.ring, closed: true, towers: wf.towers, gates: w.gates.map((g) => g.p), thickness: 3.2, gateInfo: w.gates, pieces: wf.pieces, gateTowers: wf.gateTowers, towerScale: wf.towerScale.map((x) => x * 1.15), curtains: wf.curtains, towerShape: castleTower(culture.id), role: w.role === 'castle' ? 'castle' : 'quarter' };
    })),
    landmarks, squares: prim.market && !compoundOf[carved.findIndex((b) => b.kind === 'market')] ? [prim.market] : [],
    archetype, population: pop, morphology: params.id,
    phases: eplan.phases.map((p) => ({ id: p.id, kind: p.kind, zone: p.zone, region: toPH(p.region), walled: p.walled, fossil: p.fossil })),
    quarters: keptQ.map((qi) => { const q = prim.quarters[qi]; return { poly: { outer: q.lp.pts, holes: [] }, phase: q.phase, zone: q.zone, streetSpace: toPH(streetSpace[qi]) }; }),
    blockInfo: carved.map((b, bi) => ({ quarter: qMap[b.quarter], phase: b.phase, zone: b.zone, kind: b.kind === 'market' && archetype !== 'town' ? 'green' : b.kind, compound: compoundOf[bi], culture: blockCulture[bi], morphology: blockMorph[bi].id })), masses,
    backLand: parcels.filter((p) => p.use === 'garden').map((p) => p.poly).concat(plotGardens).map((p) => ({ outer: p, holes: [] })),
    culture: culture.id, cultures: plan.cultures.map((c) => c.id), renderHints: { ...hints, towerShape },
    lines, trees, water: waterPieces,
    sites, quays,
  };
  const debug: UrbanDebug = { quarters: prim.quarters.map((q) => ({ poly: q.lp.pts, phase: q.phase, lab: q.lp.lab })) };
  stats['ms.urban'] = Math.round(performance.now() - t0);
  return { layer, stats, debug };
}
