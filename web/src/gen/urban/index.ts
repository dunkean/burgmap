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
import { resolveMorph, applySprawl } from './morphology';
import { resolvePlan, populationCulture, ResolvedPlan, EnclosureSpec, NucleusSpec, scaleMinPop, scaleMaxPop } from './culture';
import { generateCamp } from './camps/index';
import { planRibbonVillage } from './villages';
import { makeCtx } from './context';
import { waterNear } from './waterland';
import { choosePopulation, chooseArchetype, planServedPhases, planFaubourgs, EnclosurePlan, zonesFor, PhaseInput, dilate } from './phases';
import { buildPrimary, Quarter } from './primary';
import { Streets, LAB_OPEN, LAB_WALL } from './streets';
import { addOpenFringe, openEdgeFade, streetStrips } from './openfringe';
import { mpArea, MultiPoly, differenceS, differenceSafeS, intersectionS } from '../geo/bool';
import { ribbon } from '../geo/offset';
import { GuidanceField } from './field';
import { splitQuarter, addCloses, carveBlocks, buildRibbonIndex, Piece, CarvedBlock } from './blocks';
import { culDeSacTree } from './culdesac';
import { polygonCentroid } from '../core/geom';
import { cutPlots, Plot } from './plots';
import { cutCourtyards } from './courtyards';
import { buildOn, type ArchBldg } from './bops';
import { chamferPersianHouse } from './persianhouse';
import { blockReach, carvePassage, makeStreetAt, splitLong, frontRangeDepth, shapeOkObb } from './access';
import { GridIndex } from '../geo/spatial';
import { wallFeatures } from './walls';
import { buildCompound, pickBlock, ClaimBlock } from './compounds';
import { approachGates, axisLines } from './streetops';
import { distToRing, pointInRing, area as areaOf, inscribed, convexHull, distToSeg, segSegT, bboxOf, orientPos } from '../geo/poly';
import { openRing } from './camps/kit';
import { offsetCurtain, moatBand, moatReserve } from './moat';
import { unionMany } from '../geo/bool';
import { StreetGraph } from '../geo/graph';
import { polyInside } from '../geo/split';
import type { UrbanBuilding, PolyH, UrbanParcel, UrbanSite, UrbanWall } from '../types';
import { m4Flags, registerM4 } from './m4/index';
import { registerInca, andenes, canals } from './inca';
import { registerAztec, streetCanals, chinampas } from './aztec';
import { registerRussian } from './russian';
import { registerFantasy } from './fantasy';
import { registerByzantine, stairLanes } from './byzantine';
import { registerVenice, lagoonWaterways, reserveArsenal } from './venice';
import { registerPersian, bazaarRoofs, qanats } from './persian';
import { registerOttoman } from './ottoman';
import { registerSwahili, swahiliDoorLines, swahiliBazaarQuarter, hasSwahiliBazaar } from './swahili';
import { registerPrimitiveFeatures, primitiveBoundaryLines, primitiveGardenLines, halflingGardenTrees } from './primitive_features';
import { registerSahel } from './sahel';
import { registerHanse } from './hanse';
import { registerKorea } from './korea';
import { reserveLevel1 } from './level1';
import { siteCastle, type CastlePlan } from './m4/castle';
import { reserveCastle, type M4State } from './m4/reserve';
import { reserveCathedral, reservePalace, reserveMonasteries } from './m4/catalogue';
import { LineIndex } from './m4/lots';
import { marketHall } from './m4/market';
import { reservePort, portPieceBuildings } from './m4/port';
import { pickInns, innBuildings } from './m4/inns';
import { reserveMills, reserveWindmills, reserveTanneries, reserveRoadside, reserveArena } from './m4/activities';
import { reserveShanty } from './m4/shanty';
import { embedChurch } from './m4/churches';
import { reserveBridges, bridgeHouses, type BridgeHousesData } from './m4/bridges';
import { streamBridges, STREAM_BRIDGES } from './streambridges';
import { outerEnclosure, absorbedVillages, joinVillages, reserveVillages, quarterWall, type Village } from './m4/suburbs';
import type { ReservedLot } from './primary';
import { unionS } from '../geo/bool';
import { servedFootprint } from './footprint';
import { finishEdgeRoofs } from './edgeRoofs';
import { repairResidentialDensity } from './densityRepair';
import { finalizeFootprints } from './footprintFinal';
import { privatePassageAccess, type PrivatePassage } from './privatePassage';
import { finishOpenEdges, markPlannedTerminalPlots, physicalTipConstraint, openQuarterEdge, footprintPlacementGuard } from './edgeFinish';

export interface UrbanResult { layer: UrbanLayer; stats: Record<string, number | string>; debug: UrbanDebug }
export interface UrbanDebug { quarters: { poly: Polygon; phase: number; lab: number[] }[] }

/** Grand-place (M4): 0.2–1 ha, growing with the town. */
const MARKET_AREA = (pop: number): number => (pop < 1200 ? 0 : Math.min(10000, 1800 + pop * 0.3));
/** Qibla from the Maghreb, roughly east-south-east (map angle, y down). */
const QIBLA = 0.2;
const NUCLEUS_COMPOUND: Record<string, string> = { mosque: 'great-mosque', castle: 'castle', temple: 'hindu-temple', grove: 'grove', 'drum-tower': 'drum-tower', ushnu: 'inca-plaza', precinct: 'aztec-precinct', mortuary: 'mortuary-temple', maidan: 'maidan', 'mud-mosque': 'mud-mosque', 'wizard-tower': 'wizard-tower', clocktower: 'clocktower' };

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
let WATER_ANGLE = 0;
const orientAngle = (o: EnclosureSpec['orientation'] | NucleusSpec['orientation'], main: number) => (o === 'cardinal' ? 0 : o === 'qibla' ? QIBLA : o === 'terrain' ? TERRAIN_ANGLE : o === 'water' ? WATER_ANGLE : main);

/** Direction (radians) from p to the nearest open water (the first ring of samples that meets it), else downhill. */
export function waterAngle(ctx: { isWater: (p: Vec2) => boolean }, p: Vec2, contour: number): number {
  for (let r = 40; r <= 1600; r += 30) {
    let sx = 0, sy = 0, n = 0;
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * 2 * Math.PI;
      if (ctx.isWater({ x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r })) { sx += Math.cos(a); sy += Math.sin(a); n++; }
    }
    if (n && Math.hypot(sx, sy) > 1e-6) return Math.atan2(sy, sx);
  }
  return contour + Math.PI / 2;
}

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

/** Level-2 compounds listed as landmark sites (name hooks). */
const L2_SITES: Record<string, 'power' | 'worship' | 'market' | 'civic' | 'activity'> = {
  hospital: 'civic', kasbah: 'power', 'great-mosque': 'worship', yamen: 'power', 'chinese-temple': 'worship', 'walled-market': 'market',
  'jp-temple': 'worship', 'hindu-temple': 'worship', palace: 'power', basilica: 'civic', 'roman-temple': 'worship', castle: 'power', hammam: 'civic',
  'inca-temple': 'worship', 'inca-palace': 'power', 'inca-plaza': 'civic',
  'orthodox-church': 'worship', 'mortuary-temple': 'worship', 'charnel-house': 'civic',
  'byz-church': 'worship', 'byz-metropolis': 'worship', 'byz-monastery': 'worship',
  campo: 'worship', 'doge-basilica': 'worship', 'doge-palace': 'power', arsenal: 'civic',
  maidan: 'market', 'friday-mosque': 'worship', caravanserai: 'market', 'chahar-bagh': 'civic',
  mescit: 'worship', kulliye: 'worship', 'ulu-cami': 'worship', bedesten: 'market',
  'mud-mosque': 'worship', 'sahel-mosque': 'worship', 'sahel-palace': 'power',
  'swahili-juma-mosque': 'worship', 'swahili-mosque': 'worship', 'swahili-fort': 'power', 'swahili-merchant-house': 'civic',
  'cattle-kraal': 'civic', 'chieftain-hall': 'power', 'kiva-plaza': 'worship',
  'hall-church': 'worship', rathaus: 'civic',
  'korean-palace': 'power', jongmyo: 'worship', hyanggyo: 'civic', 'korean-temple': 'worship',
  'wizard-tower': 'power', 'mage-tower': 'civic', 'arcane-garden': 'civic', observatory: 'civic',
  clocktower: 'civic',
  'aztec-precinct': 'worship', 'calpulli-temple': 'worship', tecpan: 'power', tianguis: 'market',
};
/** Parcel uses of the open port pieces. */
const LOT_USE: Record<string, string> = { 'm4-quay': 'quay', 'm4-pier': 'pier', 'm4-slipway': 'slipway', 'm4-green': 'green', 'm4-bridge-houses': 'bridge' };
const castleTower = (cid: string): 'round' | 'square' => (cid === 'medina' || cid === 'chinese' || cid === 'indian-temple' || cid === 'byzantine-greek' ? 'square' : 'round');

export function generateUrban(world: World, root: Rng): UrbanResult {
  const t0 = performance.now();
  const rng = root.fork('urban');
  const opts = world.options;
  let pop = choosePopulation(opts.size, opts.population, rng.fork('pop'));
  const culture = populationCulture(opts.culture, pop);
  // settlements planned without streets (camps, kraals, barbarian and native villages, pueblos)
  if (culture.camp) {
    const cr = generateCamp(world, rng, culture, pop);
    return { layer: cr.layer, stats: cr.stats, debug: { quarters: [] } };
  }
  // the culture's settlement classes: below its minimum it is raised to it, above its maximum capped (1.5 ×)
  if (culture.scale) pop = Math.round(Math.max(scaleMinPop(culture.scale.min), Math.min(pop, scaleMaxPop(culture.scale.max) * 1.5)));
  let roads = (world.roads ?? []).filter((r) => r.kind !== 'track').map((r) => ({ path: r.path, major: r.kind === 'major', width: r.width }));
  const reaching = roads.filter((r) => dist(r.path[r.path.length - 1], world.site!.center) < 10).length;
  let archetype = chooseArchetype(pop, reaching, rng.fork('arch'));
  const settlement = archetype === 'hamlet' ? culture.hamlet : archetype === 'town' ? null : culture.village;
  if (settlement && settlement.form !== 'auto' && archetype !== 'town') archetype = 'nucleated-village';
  // the plan of a town; villages and hamlets use the culture's settlement form
  const plan: ResolvedPlan = resolvePlan(culture.id, pop, archetype === 'town' ? opts.cultureMix : null, archetype === 'town' ? opts.plan : null);
  // sprawl: the same population on more (or less) land, relative to the culture's baseline
  const sprawl = Math.max(0.5, Math.min(2, opts.sprawl ?? 1));
  const sprF = Math.log2(sprawl);
  if (sprawl !== 1) {
    plan.phases = plan.phases.map((ph) => ({ ...ph, morph: applySprawl(ph.morph, sprawl), sectors: ph.sectors.map((sc) => ({ ...sc, morph: applySprawl(sc.morph, sprawl) })) }));
    plan.faubourg = applySprawl(plan.faubourg, sprawl);
    const fk = 1 + (sprF > 0 ? 0.7 : 0.5) * sprF;
    plan.faubShare = [plan.faubShare[0] * fk, plan.faubShare[1] * fk];
  }
  const coreMorph = settlement?.morphology ? applySprawl(resolveMorph(settlement.morphology), sprawl) : plan.phases[0].morph;
  const base = coreMorph;
  // hamlets: wide farm plots and no block splitting; street villages: long blocks between field lanes
  const params: MorphologyParams = archetype === 'hamlet'
    ? { ...base, frontage: { ...base.frontage, village: [26 * (1 + 0.32 * sprF), 55 * (1 + 0.32 * sprF)] }, blockSize: { ...base.blockSize, village: [60000, 90000] } }
    : archetype === 'street-village' ? { ...base, blockSize: { ...base.blockSize, village: [9000, 26000] } } : base;
  const lastEnc: EnclosureSpec = archetype === 'town' ? plan.phases[plan.phases.length - 1].enc : { ...plan.phases[0].enc, ...(settlement?.enclosure ?? {}) };
  const wallKind = lastEnc.wall;
  const primitivePalisade = !!culture.urbanGrowth && !culture.camp && culture.id !== 'native-pueblo';
  const autoWalled = archetype === 'town' && (pop >= 2500 || rng.fork('walls').chance(0.6));
  const canWall = archetype === 'town' || archetype === 'nucleated-village';
  // walls: none (open town), single curtain, double enceinte (old spellings: yes / no)
  const wallsOpt = opts.walls === 'no' ? 'none' : opts.walls === 'yes' ? 'single' : opts.walls;
  const walled = wallsOpt === 'none' ? false : wallsOpt === 'single' || wallsOpt === 'double' ? canWall
    : wallKind === 'auto' ? autoWalled : wallKind === 'none' ? false : canWall;
  // the double enceinte: an outer, lower wall 10–25 m outside the curtain (the lists between them)
  const listsW = walled && wallsOpt === 'double' && archetype === 'town' && wallKind !== 'palisade' && wallKind !== 'hedge' && !primitivePalisade ? rng.fork('lists').range(12, 22) : 0;
  const estArea = (pop / params.density.middle) * 1e4;
  const ctx = makeCtx(world, params, 2.6 * Math.sqrt(estArea / Math.PI) + 450);
  const mainAngle = mainRoadAngle(world);
  TERRAIN_ANGLE = contourAngle(world, world.site!.center);
  WATER_ANGLE = waterAngle(ctx, world.site!.center, TERRAIN_ANGLE);
  const terrainAngle = TERRAIN_ANGLE;
  const streets = new Streets();
  registerM4();
  registerInca();
  registerAztec();
  registerRussian();
  registerFantasy();
  registerByzantine();
  registerVenice();
  registerPersian();
  registerOttoman();
  registerSwahili();
  registerPrimitiveFeatures();
  registerSahel();
  registerHanse();
  registerKorea();
  const flags = m4Flags(opts, culture, pop, archetype, rng.fork('m4'));
  const sites: UrbanSite[] = [];
  const lotData = new Map<string, unknown>();
  const lotKind = new Map<string, string>();
  const quays: Polyline[] = [];
  const siteLines: UrbanLine[] = [];
  const townBridges: { a: Vec2; b: Vec2; width: number }[] = [];
  let castle: CastlePlan | null = null;
  let outerPhase = false;
  let villages: Village[] = [];
  // the castle is sited on the enclosure before the faubourgs and the streets; it may extend the enclosure
  const castlesAll: CastlePlan[] = [];
  const siteCastleOn = (ep: EnclosurePlan): void => {
    if (!flags.castle || !ep.enclosure.length) return;
    const nonTrack = (world.roads ?? []).filter((r) => r.kind !== 'track').map((r) => r.path);
    const crossings = (world.bridges ?? []).map((b) => ({ x: (b.a.x + b.b.x) / 2, y: (b.a.y + b.b.y) / 2 }));
    for (let k = 0; k < flags.castles; k++) {
      const c = siteCastle(ctx, { enclosure: ep.enclosure, phases: ep.phases, roads: nonTrack, nucleus: ctx.center, pop, variant: flags.castle, walled: ep.walled, citadelSpot: world.site!.citadelSpot, avoid: castlesAll.map((x) => polygonCentroid(x.C)), bridges: crossings }, rng.fork(k ? 'castle:' + k : 'castle'));
      if (!c) break;
      if (castlesAll.some((o) => intersectionS(o.lot, c.lot).length)) break;
      castlesAll.push(c);
      if (c.outside) {
        // the last phase region becomes the extended enclosure (the same ring as the wall), its band follows
        const last = ep.phases[ep.phases.length - 1];
        const prev = ep.phases.length > 1 ? ep.phases[ep.phases.length - 2].region : [];
        ep.enclosure = c.enclosure;
        last.region = c.enclosure.map((ph) => ({ outer: ph.outer, holes: ph.holes }));
        last.band = prev.length ? differenceS(last.region, prev) : last.region;
      }
    }
    castle = castlesAll[0] ?? null;
  };

  let eplan: EnclosurePlan | null = null;
  let faub: { region: MultiPoly } = { region: [] };
  const varyFringeGrowth = (opts.suburbs ?? 'auto') === 'auto';
  // A preliminary fringe can inform an outer enclosure. Final districts must use the roads redirected to gates.
  let replanFringe: (() => { region: MultiPoly }) | null = null;
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
    const rv = planRibbonVillage(ctx, roads, pop, archetype, rng.fork('village'), sprawl);
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
    replanFringe = () => flags.suburbs === 'none' ? { region: [] } : planFaubourgs(ctx, eplan!.enclosure, roads, ((pop * 0.3) / params.density.village) * 1e4, 0, rng.fork('faubourg'), 'village', 1, varyFringeGrowth);
    faub = replanFringe();
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
    // suburbs (M4): none, the faubourg ribbons, or thick suburbs (an outer wall for a city, absorbed villages)
    const faubArea = (faubPop / plan.faubourg.density.faubourg) * 1e4 + short;
    const sub = flags.suburbs;
    replanFringe = () => {
      let district: { region: MultiPoly } = sub === 'none' ? { region: [] } : planFaubourgs(ctx, eplan!.enclosure, roads, faubArea * (sub === 'many' ? 2.4 : 1), walled ? 22 + (listsW ? listsW + 8 : 0) : 0, rng.fork('faubourg'), 'faubourg', (sub === 'many' ? 1.6 : 1) * Math.max(0.7, 1 + 0.35 * sprF), varyFringeGrowth);
      if (sub === 'many' && district.region.length) {
        // A broad suburban belt joins the road ribbons beyond the defensive works.
        const gl = walled ? 22 + (listsW ? listsW + 8 : 0) : 0;
        let belt = differenceS(dilate(eplan!.enclosure, gl + rng.fork('belt').range(150, 220)), dilate(eplan!.enclosure, gl));
        if (ctx.water.length) belt = differenceS(belt, ctx.water);
        belt = belt.filter((ph) => areaOf(ph.outer) > 5000);
        district = { region: unionS(district.region, belt).filter((ph) => areaOf(ph.outer) > 1500) };
      }
      return district;
    };
    faub = replanFringe();
    if (sub === 'many') {
      if (walled && pop >= 9000 && outerEnclosure(ctx, eplan, faub.region, pop)) {
        outerPhase = true;
        replanFringe = () => planFaubourgs(ctx, eplan!.enclosure, roads, faubArea * 0.6, 22 + (listsW ? listsW + 8 : 0), rng.fork('faubourg2'), 'faubourg', 1.2, varyFringeGrowth);
        faub = replanFringe();
      }
    }
    marketArea = plan.nucleus.area === 'market' ? MARKET_AREA(pop) : 0;
    extraRadials = plan.phases.some((p) => p.morph.extraRadials && p.morph.streetOp !== 'grid');
    nucleusSpec = plan.nucleus;
    phaseMorphs = plan.phases.map((p) => p.morph);
    if (outerPhase) phaseMorphs.push(plan.faubourg);
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
  let axisIn: { angle: number; extent: MultiPoly; width: number; count?: number } | undefined;
  const axisPhase = eplan.phases.reduce((k, _ph, i) => ((phaseMorphs[i]?.streets.includes('axis')) ? i : k), -1);
  if (axisPhase >= 0 && archetype !== 'hamlet' && archetype !== 'street-village') {
    const m = phaseMorphs[axisPhase];
    const extent = eplan.phases[axisPhase].region;
    const angle = m.orientation === 'cardinal' ? 0 : mainAngle;
    axisIn = { angle, extent, width: m.widthByRank[0] * m.widthScale, count: m.axisCount ?? 4 };
    let big = extent[0];
    for (const ph of extent) if (areaOf(ph.outer) > areaOf(big.outer)) big = ph;
    if (big) {
      const hull = convexHull(big.outer);
      const ends = axisLines(ctx.center, angle, big.outer, null, m.axisCount ?? 4).map((a) => ({ p: a.end, dir: a.dir }));
      if (ends.length) {
        const newPaths = approachGates(roads.map((r) => r.path), hull, ends, ctx.center, 30, ctx.isWater);
        roads = roads.map((r, i) => ({ ...r, path: newPaths[i] }));
        if (replanFringe) faub = replanFringe();
        // the regional road layer follows (roads converge on the gates)
        const wr = (world.roads ?? []).filter((r) => r.kind !== 'track');
        wr.forEach((r, i) => { r.path = newPaths[i]; });
      }
    }
  }
  if (archetype === 'town' && flags.suburbs === 'many') {
    villages = absorbedVillages(ctx, eplan.enclosure, faub.region, roads, pop >= 40000 ? 3 : 2, rng.fork('villages'));
    faub = { region: joinVillages(faub.region, villages, eplan.enclosure, ctx, walled ? 22 + (listsW ? listsW + 8 : 0) : 0) };
  }
  const coreM = phaseMorphs[0];
  const prim = buildPrimary(ctx, {
    phases: eplan.phases, enclosure: eplan.enclosure, walled: eplan.walled, faubourg: faub.region, roads,
    moat: world.options.moat, customaryMoat: !!culture.render?.moat, moatWallOffset: listsW,
    marketArea, mainAngle, extraRadials: extraRadials && !allStreetOps.has('spiral'), faubZone,
    nucleus: nucleusIn, axis: axisIn,
    gridCore: phaseMorphs.length > 1 && phaseMorphs[0].streetOp === 'grid' && !axisIn ? eplan.phases[0].region : null,
    spineAmp: allStreetOps.has('gateToGate') ? coreM.spineAmp : 0,
    kinks: allStreetOps.has('defensiveKinks') ? Math.max(...phaseMorphs.map((m) => m.kinks)) : 0,
    spiral: allStreetOps.has('spiral') ? { arms: pop > 6000 ? 5 : 4, turns: 0.32 } : undefined,
    nucleusRings: coreM.ringSpacing > 0 ? { spacing: coreM.ringSpacing, width: coreM.widthByRank[1] * coreM.widthScale } : undefined,
    switchbacks: allStreetOps.has('switchbacks') ? { angle: terrainAngle, pitch: coreM.gridSpacing[0] * 2, width: coreM.widthByRank[0] * coreM.widthScale } : undefined,
    gatesOnly: !!coreM.gatesOnly,
    preLots: castlesAll.map((c) => c.lot),
    reserve: (api) => {
      const st: M4State = { ctx, rng: rng.fork('m4lots'), pop, P: coreM, lotData, sites, culture: culture.id, listsW, wallThickness: wallKind === 'hedge' || primitivePalisade ? 0 : wallKind === 'palisade' ? 1.6 : pop > 12000 ? 3.2 : 2.6 };
      const out: ReservedLot[] = [];
      for (let k = 0; k < castlesAll.length; k++) {
        const l = reserveCastle(st, api, castlesAll[k], k ? 'castle:' + k : 'castle');
        if (l) { out.push(l); lotKind.set(l.id, l.kind); } else if (k === 0) castle = null;
      }
      const nonTrack = (world.roads ?? []).filter((r) => r.kind !== 'track').map((r) => r.path);
      const ci = { avoid: [] as Polygon[], nucleus: api.market ? polygonCentroid(api.market) : ctx.center, castle: castle ? (castle as CastlePlan).lot : null, roads: nonTrack };
      const tm = (k: string, f: () => void) => { const t = performance.now(); f(); stats['ms.lot.' + k] = Math.round(performance.now() - t); };
      const push = (l: ReservedLot | null) => { if (l) { out.push(l); ci.avoid.push(l.poly); lotKind.set(l.id, l.kind); } };
      for (const c of castlesAll) ci.avoid.push(c.lot);
      if (flags.port && archetype === 'town') tm('port', () => { for (const l of reservePort(st, api, { avoid: ci.avoid.slice(), nucleus: ci.nucleus, harbor: world.site!.harbor, roads: nonTrack, bridges: world.bridges ?? [] })) push(l); });
      quays.push(...(st.quays ?? []));
      if (villages.length) for (const l of reserveVillages(st, api, villages, ci.avoid, world.options.size === 'city' || world.options.size === 'capital')) push(l);
      // town bridges every 250–500 m of river course, joined to the streets on both banks
      if (archetype === 'town') tm('bridges', () => {
        const br = reserveBridges(st, api, ci.avoid.slice(), world.bridges ?? []);
        api.cuts.push(...br.cuts);
        for (const l of br.lots) push(l);
        townBridges.push(...br.bridges);
      });
      if (flags.cathedral) tm('cathedral', () => push(reserveCathedral(st, api, ci)));
      if (flags.palace) tm('palace', () => push(reservePalace(st, api, ci)));
      if (flags.monasteries && flags.monastery) tm('monastery', () => { for (const l of reserveMonasteries(st, api, ci, flags.monasteries, flags.monastery!)) push(l); });
      const ai = { avoid: ci.avoid, nucleus: ci.nucleus, roads: nonTrack, bridges: world.bridges ?? [], lines: siteLines };
      if (flags.arena) tm('arena', () => push(reserveArena(st, api, ai)));
      if (culture.m4?.arsenal && archetype === 'town' && pop >= 8000) tm('arsenal', () => push(reserveArsenal(st, api, ci.avoid.slice(), ci.nucleus)));
      // large precincts claimed at level 1 (a palace at the north end of the axis)
      for (const lm of plan.landmarks) if (lm.level1 && archetype === 'town' && pop >= lm.minPop) tm('l1', () => push(reserveLevel1(st, api, ci.avoid.slice(), ci.nucleus, lm, 0)));
      if (flags.activities && archetype === 'town') {
        tm('activities', () => {
          tm('tannery', () => { for (const l of reserveTanneries(st, api, ai)) push(l); });
          tm('mills', () => { for (const l of reserveMills(st, api, ai, pop < 6000 ? 1 : pop < 25000 ? 2 : 3)) push(l); });
          tm('windmills', () => { for (const l of reserveWindmills(st, api, ai, pop < 6000 ? 1 : pop < 25000 ? 3 : 4)) push(l); });
          const rs: Parameters<typeof reserveRoadside>[3] = [{ kind: 'gallows', size: [16, 16], dmin: 140, dmax: 520 }];
          if (pop >= 4000) rs.push({ kind: 'lazar-house', size: [52, 38], dmin: 300, dmax: 900 });
          if (pop >= 9000) rs.push({ kind: 'cemetery', size: [80, 55], dmin: 40, dmax: 260 });
          for (const l of reserveRoadside(st, api, ai, rs)) push(l);
        });
      }
      if (flags.shanty !== 'none') tm('shanty', () => {
        const nuisance = out.filter((l) => l.kind === 'm4-tannery').map((l) => l.poly);
        for (const l of reserveShanty(st, api, { avoid: ci.avoid.slice(), roads: nonTrack, nucleus: ci.nucleus, nuisance, walled: eplan!.walled }, flags.shanty as 'some' | 'many', flags.shantyKind)) push(l);
      });
      return out;
    },
  }, streets, rng.fork('primary'));
  if (townBridges.length) world.bridges = [...(world.bridges ?? []), ...townBridges];
  stats['townBridges'] = townBridges.length;
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

  if (culture.id === 'swahili-stone-town' && archetype === 'town' && !hasSwahiliBazaar(prim.quarters.map((q) => ({ kind: q.kind, morph: q.morph?.id, served: q.lp.lab.some((l) => l >= 0 && streets.connected.has(l)) })))) {
    const sector = plan.phases[0].sectors.find((s) => s.morph.id === 'swahili-bazaar');
    if (sector) {
      const index = swahiliBazaarQuarter(prim.quarters.map((q, id) => ({ id, poly: q.lp.pts, eligible: q.kind === 'quarter' && q.phase === 1 && q.culture === culture.id && q.lp.lab.some((l) => l >= 0 && streets.connected.has(l)), marketFront: prim.marketStreet >= 0 && q.lp.lab.includes(prim.marketStreet) })), ctx.center, sector.share);
      if (index !== undefined) prim.quarters[index].morph = sector.morph;
    }
  }

  // ---- level 2: blocks
  const nucleus = prim.market ? polygonCentroid(prim.market) : ctx.center;
  const field = new GuidanceField(ctx, nucleus, streets, mainAngle, rng.fork('field'));
  field.terrainAngle = terrainAngle;
  field.waterAngle = WATER_ANGLE;
  // (the first street cut at level 2: lagoon canals are level-2 cuts only)
  const l2First = streets.list.length;
  const pieces: Piece[][] = prim.quarters.map(() => []);
  const done = prim.quarters.map(() => false);
  for (let round = 0; round < 6; round++) {
    let progress = false;
    prim.quarters.forEach((q, qi) => {
      if (done[qi]) return;
      if (q.kind === 'quarter' && !q.lp.lab.some((l) => l >= 0 && streets.connected.has(l))) return;
      pieces[qi] = splitQuarter(ctx, q, qi, streets, field, { nucleus, gridAngle: mainAngle, terrainAngle, waterAngle: WATER_ANGLE }, rng.fork('q:' + qi));
      done[qi] = true;
      progress = true;
    });
    if (!progress) break;
  }
  field.P = null;
  // ---- small bridges: secondary streets and lanes cross the streams and small rivers of the town
  if (STREAM_BRIDGES.on && archetype !== 'hamlet') {
    const tsb = performance.now();
    const sb = streamBridges(ctx, pieces, streets, { archetype, cultureOf: (qi) => prim.quarters[qi]?.culture ?? culture.id, lagoon: !!plan.render.lagoon, cuttableLot: (l) => lotKind.get(l) === 'm4-quay', existing: world.bridges ?? [], rng: rng.fork('streamBridges') });
    if (sb.bridges.length) world.bridges = [...(world.bridges ?? []), ...sb.bridges];
    stats['streamBridges'] = sb.bridges.length;
    for (const [k, v] of Object.entries(sb.stats)) stats['sb.' + k] = v;
    stats['ms.streamBridges'] = Math.round((performance.now() - tsb) * 10) / 10;
  }
  // Small extensions grow from connected street ends after the core's cuts are frozen.
  const fringeQuarters = new Set<number>();
  if (!eplan.walled && archetype === 'town' && flags.suburbs !== 'none' && faub.region.length) {
    const protect: MultiPoly = [
      ...prim.quarters.map((q) => ({ outer: q.lp.pts, holes: [] })),
      ...castlesAll.map((c) => ({ outer: c.lot, holes: [] })),
      ...(world.roads ?? []).filter((r) => r.kind !== 'track').flatMap((r) => streetStrips(r.path, r.width + 2)),
      ...(world.bridges ?? []).flatMap((b) => streetStrips([b.a, b.b], b.width + 2)),
      ...streets.list.filter((s) => s.ribbon).flatMap((s) => streetStrips(s.path, s.widths)),
    ];
    const fringe = addOpenFringe(ctx, prim, streets, nPh + 1, faubMorph, culture.id, rng.fork('openFringe'), protect, varyFringeGrowth);
    for (const q of fringe) {
      const qi = prim.quarters.length;
      fringeQuarters.add(qi);
      prim.quarters.push(q);
      pieces.push(splitQuarter(ctx, q, qi, streets, field, { nucleus, gridAngle: mainAngle, terrainAngle, waterAngle: WATER_ANGLE }, rng.fork('q:' + qi)));
    }
    field.P = null;
    stats['openFringe.quarters'] = fringe.length;
    stats['quarters'] = prim.quarters.length;
  }
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
    // suburbs get their own parish churches, near their places and village greens
    const suburbPts = villages.map((v) => v.c);
    const lmList = [...plan.landmarks];
    if (flags.suburbs === 'many' && archetype === 'town' && plan.culture.id !== 'medina') lmList.push({ role: 'extra', kind: plan.culture.id === 'swahili-stone-town' ? 'swahili-mosque' : 'parish-church', place: 'suburb', area: [700, 5000], minPop: 0, count: Math.max(1, suburbPts.length + (outerPhase ? 2 : 1)), sep: 200, culture: culture.id });
    for (const lm of lmList) {
      if (pop < lm.minPop || lm.level1) continue;
      // the kasbah is the culture's castle: sited at level 1 by the castle rule (or switched off)
      if (lm.kind === 'kasbah' && (castle || opts.castle === 'no')) continue;
      if (lm.kind === 'hospital' && (!flags.activities || archetype !== 'town')) continue;
      const count = Math.max(lm.count ?? 1, lm.perPop ? Math.floor((pop - (lm.minPop - lm.perPop)) / lm.perPop) : 0);
      // separation from the other worship landmarks too (the main church counts for the parishes)
      const kin = lm.kind === 'parish-church' ? ['church', 'parish-church'] : [lm.kind];
      for (let k = 0; k < count; k++) {
        const others = kin.flatMap((kk) => placed.get(kk) ?? []);
        const pi = pickBlock(cb, lm.place, lm.area, nucleus, encR, {
          frontsNucleus, edgeDist: (p) => Math.min(...encRings.map((r) => distToRing(r, p)), 1e9), gates, rng: rng.fork('lm:' + lm.kind + k + lm.place), taken, others, sep: lm.sep, targets: suburbPts,
        });
        if (pi < 0) break;
        placed.set(lm.kind, [...(placed.get(lm.kind) ?? []), interiorPoint(allPieces[pi].lp.pts)]);
        taken.add(pi);
        // most parish churches stand in the fabric (a lot taken from the street front, houses against them)
        if (lm.kind === 'parish-church' && (allPieces[pi].morph ?? params).plotOp === 'burgage' && rng.fork('emb:' + k + lm.place).chance(0.65)) {
          allPieces[pi].compound = 'embedded-church';
          cb[pi].kind = 'church';
          continue;
        }
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
  const lines: UrbanLine[] = [];
  // ---- sub-quarters (M4): the walled Jewish quarter (mellah) of a large medina, at the edge, by the kasbah
  if (culture.id === 'medina' && pop >= 6000 && archetype === 'town') {
    const kc = castle ? polygonCentroid((castle as CastlePlan).C) : null;
    let bq = -1, bs = -Infinity;
    prim.quarters.forEach((q, qi) => {
      if (q.kind !== 'quarter' || q.zone === 'core' || q.zone === 'faubourg' || !q.lp.lab.includes(LAB_WALL)) return;
      const A = areaOf(q.lp.pts);
      if (A < 12000 || A > 90000) return;
      const c = interiorPoint(q.lp.pts);
      const sc = (kc ? -dist(c, kc) / 100 : dist(c, ctx.center) / 200) - Math.abs(A - 35000) / 40000;
      if (sc > bs) { bs = sc; bq = qi; }
    });
    if (bq >= 0) {
      const bl = carved.filter((b) => b.quarter === bq && b.kind === 'block').map((b) => b.poly);
      for (const w of quarterWall(bl)) lines.push({ kind: 'ward-wall', path: w, width: 1.6 });
      if (bl.length) sites.push({ id: 'mellah', kind: 'mellah', role: 'suburb', lot: prim.quarters[bq].lp.pts, anchor: interiorPoint(prim.quarters[bq].lp.pts), culture: culture.id });
    }
  }
  const blockPts = carved.map((b) => interiorPoint(b.poly));
  const holdsBlock = (ph: { outer: Polygon; holes: Polygon[] }) => blockPts.some((p) => pointInRing(ph.outer, p) && !ph.holes.some((h) => pointInRing(h, p)));
  prim.walls = prim.walls.filter((w) => holdsBlock({ outer: w.ring, holes: [] }));
  let defensiveReserve: MultiPoly = [];
  if (prim.moat.length) {
    const curtains = listsW ? prim.walls.flatMap((w) => { const out = offsetCurtain(w, listsW); return out ? [out] : []; }) : prim.walls;
    prim.moat = curtains.length ? intersectionS(prim.moat, moatBand(curtains)) : [];
    defensiveReserve = moatReserve(curtains);
    if (!defensiveReserve.length) prim.moat = [];
  }
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
  const waterPieces: PolyH[] = prim.moat.slice();
  const compoundOf: (string | undefined)[] = carved.map(() => undefined);
  const perBlock: Polygon[][] = carved.map(() => []);
  const cxFor = (bi: number, ang: number) => ({ angle: ang, pop, rng: rng.fork('cmp:' + bi), center: ctx.center, data: carved[bi].lot ? lotData.get(carved[bi].lot!) : undefined });
  const extraWalls: NonNullable<ReturnType<typeof buildCompound>['walls']> = [];
  const compoundTrees: UrbanTree[] = [];
  const claim = (bi: number, kind: string, ang: number): boolean => {
    const out = buildCompound(kind, carved[bi].poly, cxFor(bi, ang));
    if (out.walls) extraWalls.push(...out.walls);
    if (Object.prototype.hasOwnProperty.call(L2_SITES, kind)) sites.push({ id: kind + ':' + bi, kind, role: L2_SITES[kind], lot: carved[bi].poly, anchor: interiorPoint(carved[bi].poly), culture: blockCulture[bi] ?? culture.id });
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
    carved[bi].kind = kind === 'church' || kind === 'parish-church' ? 'church' : kind === 'm4-shanty' ? 'shanty' : out.parcels[0].use === 'place' ? 'place' : 'compound';
    compoundOf[bi] = kind;
    return true;
  };
  const nucleusKind = nucleusSpec?.kind ?? 'market';
  // (the nucleus block, found before its claim turns it into a compound: a claimed nucleus is not an open square)
  const marketBi = carved.findIndex((b) => b.kind === 'market');
  if (prim.market) {
    const mbi = marketBi;
    const ck = nucleusSpec?.builder ?? (Object.prototype.hasOwnProperty.call(NUCLEUS_COMPOUND, nucleusKind) ? NUCLEUS_COMPOUND[nucleusKind] : undefined);
    if (mbi >= 0 && ck) claim(mbi, ck, nucleusIn?.angle ?? mainAngle);
    else landmarks.push({ kind: nucleusKind === 'forum' ? 'forum' : archetype === 'town' ? 'market' : 'green', poly: prim.market });
  }
  // landmark lots claimed at level 2 (see above) are filled here
  // with a cathedral close the market church is a parish church (one cathedral per town)
  const hasClose = sites.some((x) => x.kind === 'cathedral-close');
  carved.forEach((b, bi) => { if (b.compound && b.compound !== 'embedded-church' && !compoundOf[bi]) claim(bi, hasClose && b.compound === 'church' ? 'parish-church' : b.compound, b.compound === 'great-mosque' ? QIBLA : blockMorph[bi].orientation === 'cardinal' ? 0 : blockMorph[bi].orientation === 'terrain' ? terrainAngle : blockMorph[bi].orientation === 'water' ? WATER_ANGLE : mainAngle); });

  // ---- level 3: plots (by the block's plot operator)
  const encRingsF = eplan.enclosure.map((ph) => ph.outer);
  // (many suburbs: the suburban belt is a garden suburb, looser than the ribbons at the gates)
  const subK = flags.suburbs === 'many' ? 1 : 0;
  // (the wall distance only matters below 380 m: the fade is 1 beyond; an index of the ring edges finds it)
  const encIdx = new GridIndex<{ a: Vec2; b: Vec2 }>(40);
  for (const r of encRingsF) for (let i = 0; i < r.length; i++) encIdx.insertSeg(r[i], r[(i + 1) % r.length], { a: r[i], b: r[(i + 1) % r.length] });
  const edgeDistance = (p: Vec2): number => {
    let d = 0;
    if (encRingsF.length) {
      d = Infinity;
      encIdx.forEachIn(p.x - 381, p.y - 381, p.x + 381, p.y + 381, (sg) => { const e = distToSeg(p, sg.a, sg.b); if (e < d) d = e; });
      if (d > 381) d = 1e9;
    }
    return d;
  };
  const faubFade = (p: Vec2): number => {
    const f = Math.max(0, Math.min(1, (edgeDistance(p) - 50) / 330));
    return subK ? Math.min(1, 0.12 + 1.35 * f) : f;
  };
  const openBand = Math.max(30, Math.min(90, 0.18 * Math.sqrt(mpArea(eplan.enclosure) / Math.PI)));
  const edgeFade = (p: Vec2, fringe: boolean): number => fringe ? 0.65 + 0.25 * Math.min(1, edgeDistance(p) / 100)
    : !eplan.walled && archetype === 'town' && eplan.enclosure.some((ph) => pointInRing(ph.outer, p) && !ph.holes.some((h) => pointInRing(h, p))) ? openEdgeFade(edgeDistance(p), openBand) : 0;
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
  // wealth of a frontage: near the market and on the main streets → rich; back lanes and the edge → poor
  const wealthR = Math.max(150, Math.sqrt(mpArea(eplan.enclosure) / Math.PI));
  const RANK_W = [0.26, 0.18, 0.02, -0.12, -0.2];
  const wealthAt = (p: Vec2, rank: number): number => Math.max(0, Math.min(1, 0.66 * (1 - dist(p, nucleus) / (1.25 * wealthR)) + (RANK_W[Math.min(4, Math.max(0, rank))] ?? -0.2) + 0.08));
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
      if (lk) for (const hb of portPieceBuildings(lk, b.poly, lotData.get(b.lot!), nucleus, bi === firstQuay)) {
        const coastalHouse = culture.id === 'swahili-stone-town' && (hb.arch === 'customs-house' || hb.arch === 'fish-market');
        buildings.push({ ...hb, ...(coastalHouse ? { arch: 'swahili-' + hb.arch, roof: 'flat' as const, material: 'coral-stone' } : {}), parcel: pi });
      }
      if (lk === 'm4-bridge-houses') for (const hb of bridgeHouses(b.poly, lotData.get(b.lot!) as BridgeHousesData)) if (polyInside(b.poly, hb.poly)) buildings.push({ poly: hb.poly, kind: 'house', parcel: pi, arch: hb.arch, roof: 'gable', material: 'timber', storeys: 3 });
      return;
    }
    const tb0 = performance.now();
    // faubourgs: plots widen along the ribbon (continuous rows at the gate, wider lots further out)
    const fade = b.zone === 'faubourg' && P.faubFade !== false ? faubFade(interiorPoint(b.poly)) : 0;
    const Pb = fade > 0 ? { ...P, frontage: { ...P.frontage, faubourg: [P.frontage.faubourg[0] * (1 + 0.9 * fade), P.frontage.faubourg[1] * (1 + 1.3 * fade)] as [number, number] } } : P;
    const r = Pb.plotOp === 'courtyard' || P.plotOp === 'compound' ? cutCourtyards(b.poly, bi, b.zone, P, streets, br)
      : P.plotOp === 'garden' ? { plots: [], back: [b.poly] }
      : cutPlots(b.poly, bi, b.zone, infill, Pb, streets, br, wealthAt);
    for (const p of r.plots) p.wealth = wealthAt({ x: (p.front[0].x + p.front[1].x) / 2, y: (p.front[0].y + p.front[1].y) / 2 }, p.rank);
    for (const p of r.plots) {
      const front = { x: (p.front[0].x + p.front[1].x) / 2, y: (p.front[0].y + p.front[1].y) / 2 };
      const taper = P.faubFade !== false ? edgeFade(front, fringeQuarters.has(b.quarter)) : 0;
      if (fade > 0 || taper > 0) p.fade = Math.max(fade > 0 ? faubFade(front) : 0, taper);
    }
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
    if (b.compound === 'embedded-church' && rplots.length > 3) {
      const ec = embedChurch(rplots, pop, rng.fork('ech:' + bi));
      if (ec) {
        rplots = rplots.filter((pl) => !ec.plots.includes(pl));
        const pi = parcels.length;
        parcels.push({ poly: ec.lot, use: 'place', block: bi, front: ec.front, zone: b.zone });
        for (const part of ec.parts) { buildings.push({ poly: part, kind: 'church', parcel: pi, arch: 'parish-church', roof: 'gable', material: 'stone', storeys: 1 }); landmarks.push({ kind: 'church', poly: part }); }
        sites.push({ id: 'parish:' + bi, kind: 'parish-church', role: 'worship', lot: ec.lot, entrance: { x: (ec.front[0].x + ec.front[1].x) / 2, y: (ec.front[0].y + ec.front[1].y) / 2 }, anchor: interiorPoint(ec.lot), culture: blockCulture[bi] ?? culture.id });
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
  const tan = sites.find((x) => x.kind === 'tannery');
  const craftAt: Vec2 | null = tan ? tan.anchor : null;
  if (tan) sites.push({ id: 'craft-quarter', kind: 'craft-quarter', role: 'suburb', lot: tan.lot, anchor: tan.anchor, culture: culture.id, tags: { trade: 'tanners, dyers, fullers' } });
  if (quays.length) sites.push({ id: 'merchant-quarter', kind: 'merchant-quarter', role: 'suburb', lot: (sites.find((x) => x.kind === 'harbour' || x.kind === 'river-port') ?? sites[0]).lot, anchor: (sites.find((x) => x.kind === 'harbour' || x.kind === 'river-port') ?? sites[0]).anchor, culture: culture.id });
  const parcelIndexOfPlot: number[] = [];
  parcels.forEach((pc, i) => { if (pc.use === 'plot') parcelIndexOfPlot.push(i); });
  const courtHint = (pl: Plot) => {
    const cr = rng.fork('court:' + pl.block + ':' + pl.run);
    const phase = cr.int(0, 8), f = cr.range(0.35, 0.65);
    // (with the shared passages giving light and access, light courts are rarer: about one plot in nine)
    return { court: (pl.order + phase) % 9 < 1, f };
  };
  const accessPlaces = (): Polygon[] => parcels.filter((p) => ['place', 'market', 'quay', 'green'].includes(String(p.use))).map((p) => p.poly);
  const plotBld: ArchBldg[][] = plots.map(() => []);
  if (!eplan.walled && !plan.render.openGround && !plan.render.stilts) {
    markPlannedTerminalPlots(plots, streets.list.filter((s) => s.ribbon).map((s) => ({
      path: s.path, width: s.widths.reduce((a, b) => a + b, 0) / s.widths.length,
      widths: s.widths, kind: s.rank <= 1 ? 'main' : s.rank <= 2 ? 'street' : 'alley',
      rank: s.rank, role: s.role, phase: s.phase,
    })), prim.footprint, { regionalRoads: world.roads, barriers: ctx.water });
  }
  const tBo = performance.now();
  let openGardens = 0;
  plots.forEach((pl, pi) => {
    const pr = rng.fork('pl:' + pi);
    const mature = pl.zone === 'core' || pl.zone === 'middle';
    // Preserve the phase's configured burgage programme in mature quarters. The edge still changes setbacks;
    // lowering the infill as well can turn an established middle quarter into young house-and-garden fabric.
    const cov = Math.max(0, Math.min(1, (blockInfill[pl.block] + pr.range(-0.03, 0.03)) * (mature ? 1 : 1 - 0.4 * (pl.fade ?? 0))));
    let first = smithies.has(pl);
    const fm = { x: (pl.front[0].x + pl.front[1].x) / 2, y: (pl.front[0].y + pl.front[1].y) / 2 };
    const onQuay = quays.length > 0 && !!streets.nearest(fm, 10, (st) => st.role === 'quay');
    const craft = craftAt && dist(fm, craftAt) < 170;
    // Mature phases already express gardens through their configured burgage programme.
    // Whole-plot gaps belong to younger fabric, rather than independently emptying core/middle plots.
    const gap = !mature && plotMorph[pi].faubFade !== false && !onQuay && !first && !craft ? edgeFade(fm, false) : 0;
    if (gap > 0 && pr.fork('openGap').chance(0.5 * gap) && !pl.terminal) {
      plotGardens.push(pl.poly);
      openGardens++;
      return;
    }
    for (const b of buildOn(pl, cov, plotMorph[pi], pr, courtHint(pl))) {
      if (b.kind === 'garden') { plotGardens.push(b.poly); continue; }
      if (first && b.kind === 'house') { b.arch = 'smithy'; first = false; }
      // the warehouse row on the quay (merchant quarter) and the craftsmen's quarter by the tanneries
      if (onQuay && b.kind === 'house' && plotMorph[pi].buildingOp !== 'venetian' && plotMorph[pi].buildingOp !== 'primitive') { b.arch = b.arch === 'swahili-stone-house' ? 'swahili-seafront-house' : 'warehouse'; b.storeys = 3; }
      else if (craft && b.kind === 'house' && plotMorph[pi].buildingOp !== 'primitive') b.arch = 'craft-workshop';
      plotBld[pi].push(b);
    }
    // no matchsticks among dwellings: long footprints are cut into rooms, the remaining slivers dropped
    // (ranges of courtyard rings and souk cells are judged on their room depth by their builder)
    plotBld[pi] = splitLong(plotBld[pi].filter((b) => !b.ring)).filter((b) => b.kind === 'landmark' || shapeOkObb(b.poly)).concat(plotBld[pi].filter((b) => b.ring));
  });
  // ---- access: every building touches the street or open ground reached from it (passages shared by two plots)
  stats['ms.buildOn'] = Math.round(performance.now() - tBo);
  if (openGardens) stats['openEdge.gardens'] = openGardens;
  const tAcc = performance.now();
  {
    const streetAt = makeStreetAt(streets.list.filter((st) => st.ribbon).map((st) => ({ path: st.path, widths: st.widths, width: st.widths[0] })), accessPlaces());
    const byBlock = new Map<number, number[]>();
    plots.forEach((pl, pi) => { if (!byBlock.has(pl.block)) byBlock.set(pl.block, []); byBlock.get(pl.block)!.push(pi); });
    // footprints already placed in the blocks (inns, market hall...): obstacles; the inn ranges must be reached too
    const others = new Map<number, number[]>();
    buildings.forEach((b, i) => { if (b.parcel !== undefined) { const bk = parcels[b.parcel].block; if (!others.has(bk)) others.set(bk, []); others.get(bk)!.push(i); } });
    const dropInn = new Set<number>();
    let carvedN = 0, dropped = 0;
    const touchesFront = (pl: Plot, poly: Polygon): boolean => {
      const segs = [pl.front, ...pl.sideFronts];
      return poly.some((q) => segs.some(([a, b]) => distToSeg(q, a, b) < 0.6));
    };
    for (const [bk, pis] of byBlock) {
      if ((globalThis as Record<string, unknown>).__noaccess) break;
      const block = carved[bk].poly;
      // a block whose footprints all stand on their street front needs no flood fill (inn lots are checked too)
      if (!others.has(bk) && pis.every((pi) => plotBld[pi].every((b) => touchesFront(plots[pi], b.poly)))) continue;
      const reach = (): boolean[][] => {
        const list: Polygon[] = [], own: [number, number][] = [];
        pis.forEach((pi) => plotBld[pi].forEach((b, k) => { list.push(b.poly); own.push([pi, k]); }));
        const extra = others.get(bk) ?? [];
        const ok = blockReach(block, [...list, ...extra.map((i) => buildings[i].poly)], streetAt);
        const res: boolean[][] = pis.map((pi) => plotBld[pi].map(() => true));
        own.forEach(([pi, k], j) => { res[pis.indexOf(pi)][k] = ok[j]; });
        extra.forEach((i, j) => { if (!ok[list.length + j] && parcels[buildings[i].parcel!].use === 'inn') dropInn.add(i); else dropInn.delete(i); });
        return res;
      };
      // first a gateway through the front range into the court or yard behind it (1.6 m, along a side line) for
      // every plot with a building off the street front (no flood fill needed to know that), then one check
      for (const pi of pis) {
        if (plots[pi].gated || plotBld[pi].every((b) => touchesFront(plots[pi], b.poly))) continue;
        const dF = frontRangeDepth(plots[pi], plotBld[pi]);
        if (dF > 0) plotBld[pi] = carvePassage(plots[pi], plotBld[pi], 'A', 1.6, dF + 0.05);
      }
      let r = reach();
      const need = pis.filter((_, j) => r[j].some((v) => !v));
      if ((globalThis as Record<string, unknown>).__acc === bk) console.log('[acc] block', bk, 'unreach', r.flat().filter((v) => !v).length, '/', r.flat().length, 'need', need.length);
      if (!need.length) continue;
      // passages along a side line shared with the neighbour of the same run: half each when both plots are wide
      // enough to keep proper houses, else the wider plot gives the whole passage (1.6 m)
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
        const nb = pis.find((q) => q !== pi && plots[q].run === pl.run && dist(plots[q].sideA.p, pl.sideB.p) < 0.05);
        const pv = pis.find((q) => q !== pi && plots[q].run === pl.run && dist(plots[q].sideB.p, pl.sideA.p) < 0.05);
        let ok = false;
        if (nb !== undefined) ok = share(pi, 'B', nb, 'A');
        if (!ok && pv !== undefined) ok = share(pi, 'A', pv, 'B');
        if (!ok) { plotBld[pi] = carvePassage(plots[pi], plotBld[pi], 'A', 1.6); ok = true; }
        if (ok) carvedN++;
      }
      r = reach();
      pis.forEach((pi, j) => { const before = plotBld[pi].length; plotBld[pi] = plotBld[pi].filter((_, k) => r[j][k]); dropped += before - plotBld[pi].length; });
    }
    if (dropInn.size) { const kept = buildings.filter((_, i) => !dropInn.has(i)); buildings.length = 0; buildings.push(...kept); }
    stats['access.passages'] = carvedN;
    stats['ms.access'] = Math.round(performance.now() - tAcc);
    stats['access.dropped'] = dropped;
  }
  plots.forEach((pl, pi) => {
    for (const b of plotBld[pi]) {
      // Passage cuts can create new acute patio corners. Finish only after all access cuts and filters;
      // subsequent containment checks and mass unions consume these footprints without cutting them again.
      const poly = b.kind === 'house' && b.arch === 'persian-courtyard-house' ? chamferPersianHouse(b.poly) : b.poly;
      buildings.push({ poly, kind: b.kind, parcel: parcelIndexOfPlot[pi], arch: b.arch, roof: b.roof, storeys: b.storeys, material: b.material, courtyards: b.courtyards, orientation: b.orientation });
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
  // walled compound lots (samurai yashiki, siheyuan): the wall along the lot line, open where the gate stands
  if (hints.compoundWalls) {
    plots.forEach((pl, pi) => {
      const op = plotMorph[pi].buildingOp;
      if ((op !== 'yashiki' && op !== 'pavilionCompound' && op !== 'kancha' && op !== 'yardHouse' && op !== 'sahelCompound' && op !== 'hanok') || !plotBld[pi].length) return;
      const p = pl.poly;
      const fm = { x: (pl.front[0].x + pl.front[1].x) / 2, y: (pl.front[0].y + pl.front[1].y) / 2 };
      if (op === 'yardHouse') {
        // the dvor's fence: the lot line, open at the yard gate beside the izba
        for (const w of openRing(orientPos(p), [{ p: fm, width: 3.2 }])) lines.push({ kind: 'yard-fence', path: w, width: 0.45 });
        return;
      }
      if (op === 'kancha' || op === 'sahelCompound' || op === 'hanok') {
        // the kancha wall: the whole lot line, with the single gate in the middle of the street side
        for (const w of openRing(orientPos(p), [{ p: fm, width: 3.4 }])) lines.push({ kind: 'compound-wall', path: w, width: 1 });
        return;
      }
      for (let k = 0; k < p.length; k++) {
        const a = p[k], c = p[(k + 1) % p.length];
        // the street front: walls between the gate ranges only (the ranges stand on the wall line)
        if (distToSeg(fm, a, c) < 0.3) continue;
        if (dist(a, c) > 1) lines.push({ kind: 'compound-wall', path: [a, c], width: 0.8 });
      }
    });
  }
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
  // ---- terraces (dwarven): retaining walls along the contour-parallel streets, hachured on the downhill side
  if (hints.terraces) {
    for (const st of streets.list) {
      if (!st.ribbon || st.rank > 3 || st.role === 'close' || st.path.length < 2) continue;
      const a = st.path[0], b = st.path[st.path.length - 1];
      const L = dist(a, b);
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // (the terraces follow the local contour: streets along it get their retaining wall)
      const lc = field.localContour(m);
      const ca = Math.cos(lc), sa = Math.sin(lc);
      const probe = (p: Vec2, s2: number) => ctx.heightAt({ x: p.x - sa * s2, y: p.y + ca * s2 });
      if (L < 20 || Math.abs(((b.x - a.x) * ca + (b.y - a.y) * sa) / L) < 0.94) continue;
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
  // ---- Inca: agricultural terraces on the slopes round the town, stone-lined channels for the streams through it
  if (hints.andenes && archetype !== 'hamlet') {
    const an = andenes(ctx, prim.footprint.map((p) => p.outer), Math.min(520, 160 + Math.sqrt(pop) * 3));
    lines.push(...an.lines);
    for (const f of an.fields) landmarks.push({ kind: 'terrace-field', poly: f });
  }
  if (hints.canals) lines.push(...canals(ctx, prim.footprint));
  // ---- hill towns: stair treads on the lanes that climb the slope
  if (hints.stairs) lines.push(...stairLanes(ctx, streets));
  // ---- lagoon towns: water down the canals, footbridges where the calli cross them
  if (hints.lagoon) {
    const wet = ctx.water.map((w) => ({ w, box: bboxOf(w.outer) }));
    const isWet = (p: Vec2) => wet.some(({ w, box }) => p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1 &&
      pointInRing(w.outer, p) && !w.holes.some((h) => pointInRing(h, p)));
    const occupied = new GridIndex<Polygon>(40);
    for (const b of carved) occupied.insertPts(b.poly, b.poly);
    const canOutlet = (path: Polyline, width: number) => {
      const strip = ribbon(path, width), box = bboxOf(strip);
      const near = occupied.query(box.x0, box.y0, box.x1, box.y1);
      return areaOf(strip) > 0.05 && (!near.length ||
        areaOf(strip) - mpArea(differenceSafeS(strip, near.map((outer) => ({ outer, holes: [] })))) < 0.05);
    };
    lines.push(...lagoonWaterways(streets, rng.fork('canals'), hints.locks ? ctx.isWater : isWet, l2First, !!hints.locks, canOutlet));
  }
  // ---- Persian city: the vaulted bazaar spine through the old town, the qanats across the fields
  if (hints.bazaarRoof && archetype === 'town') lines.push(...bazaarRoofs(streets, eplan.phases.slice(0, Math.min(2, eplan.phases.length)).flatMap((p) => p.region), nucleus));
  if (hints.qanats && archetype !== 'hamlet') lines.push(...qanats(ctx, prim.footprint, rng.fork('qanats'), pop < 3000 ? 2 : pop < 15000 ? 3 : 4));
  // ---- Aztec: canals down the lanes, chinampas round the city
  if (hints.streetCanals) lines.push(...streetCanals(streets));
  if (hints.chinampas && archetype !== 'hamlet') {
    const ch = chinampas(ctx, prim.footprint, (world.roads ?? []).map((r) => r.path), Math.min(320, 50 + Math.sqrt(pop) * 1.6));
    for (const w of ch.water) landmarks.push({ kind: 'chinampa-canal', poly: w });
    for (const f of ch.strips) landmarks.push({ kind: 'chinampa', poly: f });
  }
  // ---- elven canopy: trees over the town, clear of the houses
  const trees: UrbanTree[] = world.options.biome === 'underdark' ? [] : [...compoundTrees];
  if (world.options.biome !== 'underdark' && hints.primitive && culture.id === 'halfling') trees.push(...halflingGardenTrees(parcels, buildings));
  if (world.options.biome !== 'underdark' && hints.canopy) {
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

  // Finish edge roofs after seeded programmes and ornaments are complete. Grow the owner at all partition
  // levels on safe open ground; physical barriers retain an intact contained rectangle instead.
  const edgePartition = {
    ctx, quarters: prim.quarters, blocks: carved, parcels, buildings, streetSpace, footprint: prim.footprint,
    gardens: plotGardens, streets, phases: eplan.phases,
    protectedLand: [
      ...ctx.water, ...waterPieces, ...defensiveReserve,
      ...streets.list.filter((s) => s.ribbon).flatMap((s) => streetStrips(s.path, s.widths)),
      ...(world.roads ?? []).flatMap((r) => streetStrips(r.path, r.width)),
      ...prim.walls.flatMap((w) => streetStrips(w.ring.concat([w.ring[0]]), 5.6)),
      ...prim.walls.flatMap((w) => { const out = listsW ? offsetCurtain(w, listsW) : null; return out ? streetStrips(out.ring.concat([out.ring[0]]), 5.6) : []; }),
      ...lines.filter((l) => /wall|fence|palisade|rampart|barbican|hedge/.test(l.kind)).flatMap((l) => streetStrips(l.closed && l.path.length ? l.path.concat([l.path[0]]) : l.path, l.width ?? 1)),
    ],
    allowGrowth: true,
    eligible: (pi: number) => parcels[pi].use === 'plot' && ['streetFrontRow', 'detached', 'machiya', 'giebelhaus', 'yardHouse', 'shopRow'].includes(blockMorph[parcels[pi].block].buildingOp),
  };
  const edgeRoofs = finishEdgeRoofs(edgePartition);
  // Dedicated programmes can change the remaining mature residential inputs. Restore the whole-block floor
  // inside existing plots after roof styling, preserving every planning frame and the seeded dwelling counts.
  const densityRepair = repairResidentialDensity({ ...edgePartition, morphology: (bi: number) => blockMorph[bi] });
  const releasedFootprintLand: PolyH[] = [];
  const privatePassages: PrivatePassage[] = [];
  const placementClear = footprintPlacementGuard(edgePartition.protectedLand, p => ctx.isWater(p) || ctx.slopeAt(p) > 0.28);
  const privateAccess = privatePassageAccess({ buildings, parcels, blocks: carved.map(b => b.poly),
    streets: streets.list.filter(s => s.ribbon).map(s => ({ path: s.path, widths: s.widths, width: s.widths[0] })),
    places: accessPlaces(), publicGround: streetSpace.flat(), footprint: edgePartition.footprint,
    passages: privatePassages, placementClear });
  const footprintFinal = finalizeFootprints({ buildings, parcels, backLand: releasedFootprintLand, gardens: plotGardens,
    placementClear, privatePassages, ...privateAccess,
    tipConstrained: physicalTipConstraint(edgePartition.protectedLand, ctx.isWater),
    openQuarterEdge: openQuarterEdge(prim.quarters.map((q) => q.lp)) });
  for (const passage of privatePassages) {
    const phase = carved[parcels[passage.parcel].block]?.phase ?? 0;
    const id = streets.add(passage.path, passage.width, 4, 'close', phase);
    streets.list[id].private = true;
    streets.connected.add(id);
  }
  stats['footprint.cleaned'] = footprintFinal.cleaned;
  stats['footprint.invalid'] = footprintFinal.invalid.length;
  stats['footprint.releasedArea'] = footprintFinal.releasedArea;
  if (densityRepair.enlarged) {
    stats['densityRepair.enlarged'] = densityRepair.enlarged;
    stats['densityRepair.addedArea'] = densityRepair.addedArea;
  }
  const densityShortfall = densityRepair.groups.reduce((sum, group) => sum + group.shortfall, 0);
  if (densityShortfall > 1e-6) stats['densityRepair.shortfall'] = densityShortfall;
  if (edgeRoofs.constrained) stats['edgeRoofs.constrained'] = edgeRoofs.constrained;
  if (edgeRoofs.grown) { prim.footprint = edgePartition.footprint; eplan.enclosure = eplan.phases.at(-1)!.region; }
  if (edgeRoofs.grown || edgeRoofs.fitted || densityRepair.changedBlocks.size || footprintFinal.changed.size) {
    stats['edgeRoofs.grown'] = edgeRoofs.grown; stats['edgeRoofs.fitted'] = edgeRoofs.fitted;
    perBlock.forEach((list) => { list.length = 0; });
    for (const b of buildings) if (b.parcel !== undefined) perBlock[parcels[b.parcel].block].push(b.poly);
    masses.length = 0;
    perBlock.forEach((list) => { if (list.length) masses.push(...unionMany(list, 24, true)); });
  }

  const keptQ = prim.quarters.map((_, qi) => qi).filter((qi) => urbanized.has(qi));
  const qMap: number[] = [];
  keptQ.forEach((qi, k) => { qMap[qi] = k; });
  const toPH = (m: { outer: Polygon; holes: Polygon[] }[]): PolyHT[] => m.map((p) => ({ outer: p.outer, holes: p.holes }));
  const layerStreets: UrbanStreet[] = streets.list.filter((s) => s.ribbon).map((s) => ({
    path: s.path, width: s.widths.reduce((a, b) => a + b, 0) / s.widths.length, widths: s.widths,
    kind: s.rank <= 1 ? 'main' : s.rank <= 2 ? 'street' : 'alley', rank: s.rank, role: s.role, phase: s.phase,
    ...(s.private ? { private: true } : {}),
  }));
  // A retained coarse footprint component may still contain districts that never got connected
  // quarters. Resolve only the exported footprint here, after all seeded urban work is complete.
  const footprint = servedFootprint(prim.footprint, keptQ.map((qi) => ({ outer: prim.quarters[qi].lp.pts, holes: [] })), layerStreets, prim.walls.map((w) => w.ring));
  const towerShape = hints.towerShape;
  // within 4 m of the water or in it (wall stretches along the water are left out): the water edges in a grid index
  // (the polygons are long river ribbons; a full scan per 2 m sample of every wall was the slowest part of the walls)
  const nearW = (q: Vec2): boolean => waterNear(ctx.water, q, 4);
  // the outer wall of a double enceinte: the curtain line offset by the lists, gates aligned on the inner gates,
  // a barbican in front of each outer gate
  const outerWalls = (): UrbanWall[] => {
    const out: UrbanWall[] = [];
    prim.walls.forEach((w, wi) => {
      const curtain = offsetCurtain(w, listsW);
      if (!curtain) return;
      const ring = curtain.ring;
      const gates: { p: Vec2; dir: Vec2; width: number }[] = [];
      for (const g of curtain.gates) {
        const best = g.p;
        gates.push({ p: best, dir: g.dir, width: g.width });
        const t = { x: -g.dir.y, y: g.dir.x }, o = { x: -g.dir.x, y: -g.dir.y }, hw = g.width / 2 + 4.5, dp = 11;
        lines.push({ kind: 'barbican', path: [
          { x: best.x + t.x * hw, y: best.y + t.y * hw }, { x: best.x + t.x * hw + o.x * dp, y: best.y + t.y * hw + o.y * dp },
          { x: best.x + t.x * (g.width / 2 + 1) + o.x * dp, y: best.y + t.y * (g.width / 2 + 1) + o.y * dp },
        ], width: 1.6 });
        lines.push({ kind: 'barbican', path: [
          { x: best.x - t.x * hw, y: best.y - t.y * hw }, { x: best.x - t.x * hw + o.x * dp, y: best.y - t.y * hw + o.y * dp },
          { x: best.x - t.x * (g.width / 2 + 1) + o.x * dp, y: best.y - t.y * (g.width / 2 + 1) + o.y * dp },
        ], width: 1.6 });
      }
      // (towers staggered against the inner curtain's)
      const inner = wallFeatures(w.ring, w.gates, rng.fork('wall:' + wi), ctx.isWater, nearW).towers;
      const wf = wallFeatures(ring, gates, rng.fork('owall:' + wi), ctx.isWater, nearW, 50, inner);
      out.push({ path: ring, closed: true, towers: wf.towers, gates: gates.map((g) => g.p), thickness: 1.8, gateInfo: gates, pieces: wf.pieces, gateTowers: wf.gateTowers, towerScale: wf.towerScale.map((x) => x * 0.8), curtains: wf.curtains, towerShape, role: 'outer' });
    });
    return out;
  };
  if (hints.carvedDoors) lines.push(...swahiliDoorLines(buildings, parcels));
  if (hints.primitive) lines.push(...primitiveGardenLines(culture.id, parcels));
  const layer: UrbanLayer = {
    footprint: footprint.map((p) => p.outer),
    footprintH: toPH(footprint),
    ...(prim.moat.length ? { ruralReserve: defensiveReserve } : {}),
    streets: layerStreets,
    blocks: carved.map((b) => b.poly), parcels, buildings,
    walls: prim.walls.map((w, wi): UrbanWall | null => {
      const wf = wallFeatures(w.ring, w.gates, rng.fork('wall:' + wi), ctx.isWater, nearW);
      if (wallKind === 'hedge') {
        // a living hedge: a plan line, no masonry
        lines.push({ kind: 'hedge', path: w.ring, closed: true, width: 2.6 });
        return null;
      }
      if (primitivePalisade) {
        for (const path of wf.pieces) lines.push(...primitiveBoundaryLines(culture.id, path));
        return null;
      }
      return { path: w.ring, closed: true, towers: wf.towers, gates: w.gates.map((g) => g.p), thickness: wallKind === 'palisade' ? 1.6 : pop > 12000 ? 3.2 : 2.6, gateInfo: w.gates.map((g) => ({ p: g.p, dir: g.dir, width: g.width })), pieces: wf.pieces, gateTowers: wf.gateTowers, towerScale: wf.towerScale, curtains: wf.curtains, towerShape, role: 'town' as const };
    }).filter((w): w is UrbanWall => !!w).concat(listsW ? outerWalls() : []).concat(extraWalls.map((w, wi): UrbanWall => {
      // castle curtains: the stretches lying on the town wall are drawn by the town wall
      const townIdx = new LineIndex(prim.walls.map((tw) => ({ path: tw.ring.concat([tw.ring[0]]), hw: 0 })));
      // (a kremlin's brick curtain is drawn whole, over the posad's timber wall where they meet)
      const ownCurtain = w.role === 'castle' && castlesAll.some((cp) => cp.variant === 'kremlin');
      const skip = (q: Vec2) => (!ownCurtain && townIdx.dist(q, 3) < 1.5) || ctx.isWater(q);
      const wf = wallFeatures(w.ring, w.gates, rng.fork('xwall:' + wi), ctx.isWater, skip, 40);
      return { path: w.ring, closed: true, towers: wf.towers, gates: w.gates.map((g) => g.p), thickness: 3.2, gateInfo: w.gates, pieces: wf.pieces, gateTowers: wf.gateTowers, towerScale: wf.towerScale.map((x) => x * 1.15), curtains: wf.curtains, towerShape: castleTower(culture.id), role: w.role === 'castle' ? 'castle' : 'quarter' };
    })),
    landmarks, squares: prim.market && !(marketBi >= 0 && compoundOf[marketBi]) ? [prim.market] : [],
    archetype, population: pop, morphology: params.id,
    phases: eplan.phases.map((p) => ({ id: p.id, kind: p.kind, zone: p.zone, region: toPH(p.region), walled: p.walled, fossil: p.fossil })),
    quarters: keptQ.map((qi) => { const q = prim.quarters[qi]; return { poly: { outer: q.lp.pts, holes: [] }, phase: q.phase, zone: q.zone, streetSpace: toPH(streetSpace[qi]) }; }),
    blockInfo: carved.map((b, bi) => ({ quarter: qMap[b.quarter], phase: b.phase, zone: b.zone, kind: b.kind === 'market' && archetype !== 'town' ? 'green' : b.kind, compound: compoundOf[bi], culture: blockCulture[bi], morphology: blockMorph[bi].id })), masses,
    backLand: [...parcels.filter((p) => p.use === 'garden').map((p) => p.poly).concat(plotGardens).map((p): PolyH => ({ outer: p, holes: [] })), ...releasedFootprintLand],
    culture: culture.id, cultures: plan.cultures.map((c) => c.id), renderHints: { ...hints, towerShape },
    lines, trees, water: waterPieces,
    ...(prim.moat.length ? { moats: prim.moat } : {}),
    sites, quays,
  };
  finishOpenEdges(layer, {
    seed: world.seed,
    regionalRoads: world.roads,
    barriers: [...ctx.water, ...defensiveReserve, ...(layer.walls ?? []).flatMap((w) => streetStrips(w.closed ? [...w.path, w.path[0]] : w.path, w.thickness + 2))],
    protectedGround: lines.filter((l) => /wall|fence|palisade|rampart|barbican|hedge/.test(l.kind))
      .flatMap((l) => streetStrips(l.closed && l.path.length ? [...l.path, l.path[0]] : l.path, l.width ?? 1)),
  });
  stats['openEdge.unserved'] = layer.openTails?.filter((t) => t.kind === 'unservedOpenEdge' && t.excess > 0.5).length ?? 0;
  stats['buildings'] = buildings.length;
  const debug: UrbanDebug = { quarters: prim.quarters.map((q) => ({ poly: q.lp.pts, phase: q.phase, lab: q.lp.lab })) };
  stats['ms.urban'] = Math.round(performance.now() - t0);
  return { layer, stats, debug };
}
