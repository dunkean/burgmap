/** Small flat fixture using the actual block, plot and cultural building operators. */
import { Rng } from '../core/rng';
import { createGrid } from '../core/grid';
import { polygonCentroid, type Polygon, type Polyline } from '../core/geom';
import type { World, UrbanBuilding, UrbanParcel } from '../types';
import { DEFAULTS } from '../options';
import { type MorphologyParams } from './morphology';
import { benchMorph, type BenchMorphOptions } from './testbenchConfig';
import { makeCtx } from './context';
import { Streets, LAB_OPEN, LAB_WATER } from './streets';
import type { Quarter } from './primary';
import { GuidanceField } from './field';
import { splitQuarter, addCloses, buildRibbonIndex, carveBlocks, type CarvedBlock } from './blocks';
import { culDeSacTree } from './culdesac';
import { cutPlots, type Plot } from './plots';
import { cutCourtyards } from './courtyards';
import { detectPlotFrame } from './plotAxes';
import { buildOn } from './bops';
import { retainBlockPlot } from './perimeterBlock';
import { buildCompound } from './compounds';
import { area, orientPos, distToSeg, distToRing, type OBB } from '../geo/poly';
import { intersectionS, type MultiPoly } from '../geo/bool';
import { dryPieces } from './waterland';
import { applyBenchConstraints, type BenchConstraints } from './testbenchConstraints';
import { registerM4 } from './m4';
import { registerFantasy } from './fantasy';
import { registerInca } from './inca';
import { registerAztec } from './aztec';
import { registerRussian } from './russian';
import { registerByzantine } from './byzantine';
import { registerVenice } from './venice';
import { registerPersian } from './persian';
import { registerOttoman } from './ottoman';
import { registerSwahili } from './swahili';
import { registerPrimitiveFeatures } from './primitive_features';
import { registerSahel } from './sahel';
import { registerHanse } from './hanse';
import { registerKorea } from './korea';
import { benchShapes } from './testbenchShapes';
import { miterNormals } from '../geo/offset';
import { blockReach, carvePassage, frontRangeDepth, makeStreetAt } from './access';
import { housePlotNormal } from './houseFrames';
import { polyInside } from '../geo/split';

export interface BenchOptions extends BenchMorphOptions, BenchConstraints {
  mode?: 'quarters' | 'micro';
  /** Multiplier of micro fixture lengths (1–5), independent of generation density. */
  microScale?: number;
  /** One-sided access stress case, or an ordinary street-surrounded block. */
  microFrontage?: 'front' | 'perimeter';
  count: number; radius: number; monument: string;
  placement?: 'center' | 'lateral' | 'rectangle' | 'skew' | 'notched';
  rings?: 1 | 2;
}
export interface BenchBlock extends CarvedBlock {
  /** Shared by parcel generation and the orientation overlay. */
  plotFrame: OBB;
}
export interface BenchLayout {
  shapeNames?: string[];
  options: BenchOptions; streets: Streets; quarters: Quarter[]; blocks: BenchBlock[]; morph: MorphologyParams;
  water: MultiPoly; contours: Polyline[];
}
export interface BenchHouses { buildings: UrbanBuilding[]; parcels: UrbanParcel[] }
export interface BenchParcels {
  parcels: UrbanParcel[];
  plots: { plot: Plot; parcel: number; index: number }[];
  compounds: { kind: string; poly: Polygon; parcel: number; block: number }[];
}

export function benchLayout(options: BenchOptions, seed: string): BenchLayout {
  const rng = new Rng(seed).fork('testbench-layout');
  const morph = benchMorph(options, 'streets');
  if (options.mode === 'micro') {
    const shapes = benchShapes(seed, options.microScale ?? 1), streets = new Streets();
    const quarters = shapes.map(({ poly }): Quarter => {
      if (options.microFrontage === 'perimeter') {
        // Offset a closed centreline outward; the retained block is not inset again.
        const closed = [poly[poly.length - 1], ...poly, poly[0], poly[1]];
        const normals = miterNormals(closed, 8).slice(1, poly.length + 1);
        const road = poly.map((p, i) => ({ x: p.x - normals[i].x * 2, y: p.y - normals[i].y * 2 }));
        const id = streets.add([...road, road[0]], 4, 1, 'street', 0);
        streets.connected.add(id);
        return { lp: { pts: poly, lab: poly.map(() => id) }, phase: 0, zone: options.zone, age: 1, kind: 'quarter', morph };
      }
      // A real street ribbon touches the first edge from outside. The fixture
      // itself stays intact, including sharp tips and concave/curved boundaries.
      const [a, b] = poly, length = Math.hypot(b.x - a.x, b.y - a.y);
      const offset = { x: (b.y - a.y) / length * 2, y: -(b.x - a.x) / length * 2 };
      const id = streets.add([a, b].map(p => ({ x: p.x + offset.x, y: p.y + offset.y })), 4, 1, 'street', 0);
      streets.connected.add(id);
      return { lp: { pts: poly, lab: poly.map((_, i) => i === 0 ? id : LAB_OPEN) }, phase: 0, zone: options.zone, age: 1, kind: 'quarter', morph };
    });
    const blocks: BenchBlock[] = shapes.map(({ poly }, quarter) => ({ poly, quarter, phase: 0, age: 1, zone: options.zone, kind: 'block', plotFrame: detectPlotFrame(poly) }));
    return { options: structuredClone(options), streets, quarters, blocks, morph, water: [], contours: [], shapeNames: shapes.map(s => s.name) };
  }
  const grid = createGrid(200, 200, 10);
  const center = { x: 500, y: 500 };
  const cost = createGrid(200, 200, 10);
  for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) cost.data[y * 200 + x] = Math.hypot(x * 10 - 500, y * 10 - 500);
  const floats = () => new Float32Array(40000);
  const world: World = {
    seed, options: { ...DEFAULTS, culture: options.culture }, mapSize: 2000, stats: {},
    terrain: { height: grid, slope: grid, flow: grid, water: new Uint8Array(40000), seaLevel: -1, seaFraction: 0, coastline: [], lakes: [], rivers: [], receiver: new Int32Array(40000), filled: floats(), downSide: 'S', seaSide: null },
    site: { center, archetype: 'plain', offers: {}, cost, reserveRadius: options.radius, fields: { dWater: floats(), dSea: floats(), dMain: floats(), hab: floats(), slopeS: floats(), riverMask: new Uint8Array(40000), bridgeZone: new Uint8Array(40000) } },
  };
  const streets = new Streets();
  const angle = morph.orientation === 'cardinal' ? 0 : rng.range(0, Math.PI * 2);
  const rings = options.rings === 2 ? 2 : 1;
  let quarters: Quarter[];
  if (options.placement && options.placement !== 'center') {
    // A patch beside the nucleus, bounded by through streets rather than spokes.
    // Shared vertices/labels keep adjacent quarter partitions exact.
    const columnsPerBand = Math.ceil(options.count / 2);
    const columns = columnsPerBand * rings;
    const x0 = 570, y0 = 500 - options.radius * 0.7;
    const width = options.radius * 1.4 * rings, height = options.radius * 1.4;
    const nodes = Array.from({ length: 3 }, (_, row) => Array.from({ length: columns + 1 }, (_, col) => ({
      x: x0 + width * col / columns + (col > 0 && col < columns ? rng.range(-8, 8) : 0),
      y: y0 + height * row / 2 + (row === 1 ? rng.range(-10, 10) : 0),
    })));
    if (options.placement === 'skew') for (const row of nodes) for (const p of row) {
      const u = (p.x - x0) / width, v = (p.y - y0) / height;
      p.x += options.radius * (0.55 * v + 0.12 * u * v);
      p.y += options.radius * 0.3 * u;
    }
    const horizontalPaths = nodes.map((row, r) => row.slice(0, -1).map((p, col) => {
      const end = row[col + 1];
      // A V cut into the upper boundary creates genuinely concave test quarters.
      return options.placement === 'notched' && r === 0 && col % columnsPerBand === Math.floor(columnsPerBand / 2)
        ? [p, { x: (p.x + end.x) / 2, y: (p.y + end.y) / 2 + height * 0.3 }, end] : [p, end];
    }));
    const horizontal = horizontalPaths.map(row => row.map(path => streets.add(path, morph.widthByRank[1] * morph.widthScale, 1, 'street', 0)));
    const vertical = nodes.slice(0, -1).map((row, r) => row.map((p, col) => streets.add([p, nodes[r + 1][col]], morph.widthByRank[col === 0 ? 0 : 1] * morph.widthScale, col === 0 ? 0 : 1, col === 0 ? 'radial' : 'street', 0)));
    streets.list.forEach(st => streets.connected.add(st.id));
    quarters = Array.from({ length: options.count * rings }, (_, i) => {
      const band = Math.floor(i / options.count), local = i % options.count;
      const row = Math.floor(local / columnsPerBand), col = band * columnsPerBand + local % columnsPerBand;
      // For odd counts the last lower quarter owns the remaining column too.
      // Keep every intermediate point/label along the shared upper boundary.
      const end = col + (options.count % 2 === 1 && local === options.count - 1 ? 2 : 1);
      const top = horizontalPaths[row].slice(col, end).flatMap((path, k) => k === 0 ? path : path.slice(1));
      const bottom = horizontalPaths[row + 1].slice(col, end).flatMap((path, k) => k === 0 ? path : path.slice(1));
      const pts = [...top, ...bottom.slice().reverse()];
      const lab = [...horizontalPaths[row].slice(col, end).flatMap((path, k) => path.slice(1).map(() => horizontal[row][col + k])), vertical[row][end], ...horizontalPaths[row + 1].slice(col, end).reverse().flatMap((path, k) => path.slice(1).map(() => horizontal[row + 1][end - 1 - k])), vertical[row][col]];
      return { lp: { pts, lab }, phase: band, zone: options.zone, age: 1, kind: 'quarter', morph };
    });
  } else {
  const angles = Array.from({ length: options.count }, (_, i) => angle + i * Math.PI * 2 / options.count + rng.range(-0.12, 0.12));
  const points = (radius: number, jitter: boolean): Polygon => angles.map(a => {
    const r = radius * (jitter ? rng.range(0.85, 1.15) : 1);
    return { x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r };
  });
  const inner = points(options.zone === 'core' ? 25 : 16, false), outer = points(options.radius, true);
  const radial = outer.map((p, i) => streets.add([inner[i], p], morph.widthByRank[0] * morph.widthScale, 0, 'radial', 0));
  const ring = inner.map((p, i) => streets.add([p, inner[(i + 1) % inner.length]], morph.widthByRank[1] * morph.widthScale, 1, 'ring', 0));
  [...radial, ...ring].forEach(id => streets.connected.add(id));
  quarters = outer.map((p, i) => {
    const j = (i + 1) % outer.length;
    const pts = orientPos([inner[i], p, outer[j], inner[j]]);
    const lab = pts.map((a, k) => {
      const b = pts[(k + 1) % pts.length];
      return streets.nearest({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, 0.1)?.s ?? LAB_OPEN;
    });
    return { lp: { pts, lab }, phase: 0, zone: options.zone, age: 1, kind: 'quarter', morph };
  });
  if (rings === 2) {
    const beyond = points(options.radius + 100, true);
    outer.forEach((p, i) => {
      const j = (i + 1) % outer.length;
      const id = streets.add([p, outer[j]], morph.widthByRank[1] * morph.widthScale, 1, 'ring', 1);
      streets.connected.add(id);
    });
    beyond.forEach((p, i) => {
      const id = streets.add([outer[i], p], morph.widthByRank[0] * morph.widthScale, 0, 'radial', 1);
      streets.connected.add(id);
    });
    // Re-label the first ring's outer edge now that it is a shared street.
    for (const q of quarters) q.lp.lab = q.lp.pts.map((a, i) => {
      const b = q.lp.pts[(i + 1) % q.lp.pts.length];
      return streets.nearest({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, 0.1)?.s ?? LAB_OPEN;
    });
    quarters.push(...beyond.map((p, i): Quarter => {
      const j = (i + 1) % beyond.length;
      const pts = orientPos([outer[i], p, beyond[j], outer[j]]);
      const lab = pts.map((a, k) => {
        const b = pts[(k + 1) % pts.length];
        return streets.nearest({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, 0.1)?.s ?? LAB_OPEN;
      });
      return { lp: { pts, lab }, phase: 1, zone: options.zone, age: 1, kind: 'quarter', morph };
    }));
  }
  }
  const constraint = applyBenchConstraints(world, quarters.flatMap(q => q.lp.pts), options);
  const ctx = makeCtx(world, morph, options.radius * 3 + 150);
  if (constraint.land || ctx.water.length) {
    quarters = quarters.flatMap(q => {
      const clipped = constraint.land ? intersectionS(q.lp.pts, constraint.land) : [{ outer: q.lp.pts, holes: [] }];
      return dryPieces(clipped, ctx.water).filter(ph => ph.holes.length === 0 && area(ph.outer) > 1).map(ph => {
        const pts = orientPos(ph.outer);
        const lab = pts.map((a, i) => {
          const b = pts[(i + 1) % pts.length], m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          if (ctx.water.some(w => distToRing(w.outer, m) < 0.02)) return LAB_WATER;
          const edge = q.lp.pts.findIndex((p, k) => distToSeg(m, p, q.lp.pts[(k + 1) % q.lp.pts.length]) < 0.02);
          return edge >= 0 ? q.lp.lab[edge] : LAB_OPEN;
        });
        return { ...q, lp: { pts, lab } };
      });
    });
  }
  if (!quarters.length) throw new Error('La contrainte ne laisse aucun quartier constructible.');
  const field = new GuidanceField(ctx, center, streets, angle, rng.fork('field'));
  field.terrainAngle = options.relief === 'valley' ? Math.PI / 2 : angle;
  field.waterAngle = options.river === 'vertical' ? Math.PI / 2 : options.river === 'horizontal' ? 0 : options.river === 'diagonal' ? Math.PI / 4 : angle;
  const pieces = quarters.map((q, i) => splitQuarter(ctx, q, i, streets, field, { nucleus: center, gridAngle: angle, terrainAngle: field.terrainAngle, waterAngle: field.waterAngle }, rng.fork('quarter:' + i)));
  if (['culDeSacTree', 'hutong', 'roji'].includes(morph.closeOp)) culDeSacTree(pieces.flat(), streets, rng.fork('closes'));
  else if (morph.closeOp === 'closes') addCloses(ctx, pieces.flat(), streets, rng.fork('closes'));
  const index = buildRibbonIndex(streets);
  const blocks = quarters.flatMap((q, i) => carveBlocks(q, pieces[i], index, streets, 0).blocks)
    .map(block => ({ ...block, plotFrame: detectPlotFrame(block.poly) }));
  if (options.monument !== 'none') {
    const block = blocks.filter(b => b.kind === 'block').sort((a, b) => area(b.poly) - area(a.poly))[0];
    if (block) { block.kind = 'compound'; block.compound = options.monument; }
  }
  return { options: structuredClone(options), streets, quarters, blocks, morph, water: ctx.water, contours: constraint.contours };
}

export function benchParcels(layout: BenchLayout, seed: string, options = layout.options): BenchParcels {
  const rng = new Rng(seed).fork('testbench-plots');
  const parcels: UrbanParcel[] = [], plots: BenchParcels['plots'] = [], compounds: BenchParcels['compounds'] = [];
  const P = benchMorph(options, 'plots');
  layout.blocks.forEach((block, bi) => {
    const br = rng.fork('block:' + bi);
    if (block.compound) {
      compounds.push({ kind: block.compound, poly: block.poly, parcel: parcels.length, block: bi });
      parcels.push({ poly: block.poly, use: 'place', block: bi, zone: block.zone });
      return;
    }
    if (block.kind !== 'block') {
      parcels.push({ poly: block.poly, use: 'place', block: bi, zone: block.zone });
      return;
    }
    const coverage = br.range(...P.coverage[block.zone]);
    const result = P.plotOp === 'wholeBlock' ? retainBlockPlot(block.poly, bi, block.zone, layout.streets)
      : P.plotOp === 'courtyard' || P.plotOp === 'compound'
      ? cutCourtyards(block.poly, bi, block.zone, P, layout.streets, br, block.plotFrame.u)
      : P.plotOp === 'garden' ? { plots: [], back: [block.poly] }
      : cutPlots(block.poly, bi, block.zone, coverage, P, layout.streets, br, undefined, block.plotFrame.u);
    result.plots.forEach((plot, pi) => {
      const parcel = parcels.length;
      parcels.push({ poly: plot.poly, use: 'plot', block: bi, zone: plot.zone, front: plot.front });
      plots.push({ plot, parcel, index: pi });
    });
    for (const poly of result.back) parcels.push({ poly, use: 'garden', block: bi, zone: block.zone });
  });
  return { parcels, plots, compounds };
}

/** Build from retained frontage frames; changing houses never recuts a parcel. */
export function benchBuildings(layout: BenchLayout, partition: BenchParcels, seed: string, options = layout.options): BenchHouses {
  [registerM4, registerFantasy, registerInca, registerAztec, registerRussian, registerByzantine, registerVenice, registerPersian, registerOttoman, registerSwahili, registerPrimitiveFeatures, registerSahel, registerHanse, registerKorea].forEach(register => register());
  const rng = new Rng(seed).fork('testbench-houses');
  const P = benchMorph(options, 'buildings');
  const buildings: UrbanBuilding[] = [];
  for (const { plot, parcel, index } of partition.plots) {
    const br = rng.fork('block:' + plot.block);
    const coverage = br.range(...P.coverage[plot.zone]);
    buildings.push(...buildOn(structuredClone(plot), coverage, P, br.fork('house:' + index)).map(b => ({ ...b, parcel })));
  }
  for (const compound of partition.compounds) {
    const out = buildCompound(compound.kind, compound.poly, { angle: 0, pop: layout.options.zone === 'village' ? 600 : 3000, center: polygonCentroid(compound.poly), rng: rng.fork('block:' + compound.block) });
    buildings.push(...out.buildings.map(b => ({ ...b, parcel: compound.parcel })));
  }
  // Replay the native building-access stage too: a front door alone does not
  // serve the rear ranges of a deep plot. Test actual free space of the whole
  // block, including neighbours and compounds, before proposing a passage.
  const streetAt = makeStreetAt(layout.streets.list.filter(s => s.ribbon).map(s => ({
    path: s.path, widths: s.widths, width: s.widths[0],
  })), partition.parcels.filter(p => p.use === 'place').map(p => p.poly));
  for (const [bi, block] of layout.blocks.entries()) {
    let peers = buildings.filter(b => b.kind !== 'garden' && partition.parcels[b.parcel!].block === bi);
    let reached = blockReach(block.poly, peers.map(b => b.poly), streetAt);
    const need = new Set(peers.filter((_, i) => !reached[i]).map(b => b.parcel));
    for (const parcel of need) {
      const entry = partition.plots.find(p => p.parcel === parcel);
      if (!entry) continue;
      const original = peers.filter(b => b.parcel === parcel);
      const beforeArea = original.reduce((sum, b) => sum + area(b.poly), 0);
      let best: UrbanBuilding[] | null = null, bestReached = reached.filter(Boolean).length, bestArea = 0;
      const sides: ('A' | 'B')[] = rng.fork('entrance:' + parcel).chance(0.5) ? ['A', 'B'] : ['B', 'A'];
      for (const side of sides) {
        const plot = entry.plot;
        const framed = ['streetFrontRowExperimental'].includes(P.buildingOp) && plot.axis && plot.zone !== 'village'
          ? { ...plot, sideA: { p: plot.front[0], d: housePlotNormal(plot) }, sideB: { p: plot.front[1], d: housePlotNormal(plot) } } : plot;
        // Prefer a short entrance into the first yard. A full-depth passage
        // remains a fallback for sealed successive ranges, not the default.
        const frontDepth = frontRangeDepth(plot, original);
        for (const depth of frontDepth > 0 ? [frontDepth + 0.1, Infinity] : [Infinity]) {
          const cut = carvePassage(framed, original, side, 1.8, depth);
          const proposal = peers.filter(b => b.parcel !== parcel).concat(cut);
          const flags = blockReach(block.poly, proposal.map(b => b.poly), streetAt);
          // No proposal may obstruct a previously reachable neighbour or
          // destroy a served house to reach its rear range. Prefer roof area
          // when two entrances give the same access gain.
          if (peers.some((b, i) => reached[i] && b.parcel !== parcel && !flags[proposal.indexOf(b)])) continue;
          if (peers.some((b, i) => reached[i] && b.parcel === parcel
            && cut.filter(q => polyInside(b.poly, q.poly) && flags[proposal.indexOf(q)])
              .reduce((sum, q) => sum + area(q.poly), 0) < area(b.poly) * 0.6)) continue;
          const count = flags.filter(Boolean).length, keptArea = cut.reduce((sum, b) => sum + area(b.poly), 0);
          if (keptArea < beforeArea * 0.6) continue;
          if (count > bestReached || best && count === bestReached && keptArea > bestArea) {
            best = proposal; bestReached = count; bestArea = keptArea;
          }
        }
      }
      // Narrow attached houses can share an entrance, as in the native row
      // stage. Prove the common side line; run/order alone is insufficient for
      // compact or curved parcels that face different streets.
      for (const side of sides) {
        const endpoint = entry.plot.front[side === 'A' ? 0 : 1];
        const n = housePlotNormal(entry.plot), opposite = side === 'A' ? 'B' : 'A';
        const neighbour = partition.plots.find(p => p.parcel !== parcel && p.plot.block === bi
          && Math.hypot(p.plot.front[opposite === 'A' ? 0 : 1].x - endpoint.x, p.plot.front[opposite === 'A' ? 0 : 1].y - endpoint.y) < 0.05
          && n.x * housePlotNormal(p.plot).x + n.y * housePlotNormal(p.plot).y > 0.99999);
        if (!neighbour || !['streetFrontRowExperimental'].includes(P.buildingOp)) continue;
        const neighbourRoofs = peers.filter(b => b.parcel === neighbour.parcel);
        if (!neighbourRoofs.length) continue;
        const framed = (plot: Plot): Plot => ({ ...plot,
          sideA: { p: plot.front[0], d: housePlotNormal(plot) }, sideB: { p: plot.front[1], d: housePlotNormal(plot) },
        });
        const cut = carvePassage(framed(entry.plot), original, side, 0.9);
        const neighbourCut = carvePassage(framed(neighbour.plot), neighbourRoofs, opposite, 0.9);
        const proposal = peers.filter(b => b.parcel !== parcel && b.parcel !== neighbour.parcel).concat(cut, neighbourCut);
        const flags = blockReach(block.poly, proposal.map(b => b.poly), streetAt);
        if (peers.some((b, i) => reached[i] && proposal.filter(q => q.parcel === b.parcel && polyInside(b.poly, q.poly) && flags[proposal.indexOf(q)])
          .reduce((sum, q) => sum + area(q.poly), 0) < area(b.poly) * 0.6)) continue;
        const keptArea = cut.reduce((sum, b) => sum + area(b.poly), 0);
        if (keptArea < beforeArea * 0.6 || neighbourCut.reduce((sum, b) => sum + area(b.poly), 0)
          < neighbourRoofs.reduce((sum, b) => sum + area(b.poly), 0) * 0.6) continue;
        const count = flags.filter(Boolean).length;
        if (count > bestReached || best && count === bestReached && keptArea > bestArea) {
          best = proposal; bestReached = count; bestArea = keptArea;
        }
      }
      if (best) { peers = best; reached = blockReach(block.poly, peers.map(b => b.poly), streetAt); }
    }
    // Match the native final guard: never display a house with no entrance.
    const kept = peers.filter((_, i) => reached[i]);
    for (let i = buildings.length - 1; i >= 0; i--) {
      const b = buildings[i];
      if (b.kind !== 'garden' && partition.parcels[b.parcel!].block === bi) buildings.splice(i, 1);
    }
    buildings.push(...kept);
  }
  const parcels = partition.parcels;
  return { parcels, buildings };
}

export function benchHouses(layout: BenchLayout, seed: string, cultureId = layout.options.culture, density = layout.options.density): BenchHouses {
  const options = { ...layout.options, culture: cultureId, density };
  return benchBuildings(layout, benchParcels(layout, seed, options), seed, options);
}
