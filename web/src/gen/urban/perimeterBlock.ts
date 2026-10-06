/** Street-front buildings; the collective court is the space their varied depths leave unbuilt. */
import type { Polygon, Vec2 } from '../core/geom';
import { dist } from '../core/geom';
import { Rng } from '../core/rng';
import type { MorphologyParams, Zone } from './morphology';
import { cutPlots, plotFrontOnStreet, type Plot, type PlotResult } from './plots';
import { Streets } from './streets';
import { clipPlot, normalizeFootprints, shapeOf, MIN_BW, MAX_ASPECT, type Bldg } from './buildings';
import { difference, tryDifference, tryIntersection, type MultiPoly } from '../geo/bool';
import { area, orientPos, distToSeg } from '../geo/poly';
import { isConvex } from '../geo/split';
import { stitchUnion } from '../geo/stitch';

export interface PerimeterHouse extends Bldg { orientation: number; ring: true }
export interface PerimeterBlockResult {
  buildings: PerimeterHouse[];
  courts: MultiPoly;
  passages: Polygon[];
  programme: 'open' | 'infill' | 'solid';
}

/** Compatibility for already saved wholeBlock cases. New recipes use cutPlots. */
export function retainBlockPlot(block: Polygon, bi: number, zone: Zone, streets: Streets): PlotResult {
  const poly = orientPos(block);
  const edges = poly.map((a, i): [Vec2, Vec2] => [a, poly[(i + 1) % poly.length]]);
  const served = edges.filter(([a, b]) => plotFrontOnStreet(streets, a, b));
  if (!served.length) return { plots: [], back: [poly] };
  const front = served.slice().sort((a, b) => dist(...b) - dist(...a))[0];
  const len = dist(...front), nrm = { x: -(front[1].y - front[0].y) / len, y: (front[1].x - front[0].x) / len };
  return { back: [], plots: [{ poly, block: bi, zone, front, nrm,
    sideA: { p: front[0], d: nrm }, sideB: { p: front[1], d: nrm },
    sideFronts: served.filter(edge => edge !== front), boundarySides: edges,
    rank: 0, depth: Math.max(...poly.map(p => (p.x - front[0].x) * nrm.x + (p.y - front[0].y) * nrm.y)),
    wide: true, run: 0, order: 0, wholeBlock: true }] };
}

/** Build perpendicular to the actual street facade, clipped to the existing cadastral parcel. */
export function buildPerimeterPlot(pl: Plot, P: MorphologyParams, rng: Rng): PerimeterHouse[] {
  const pr = rng.fork('perimeter-plot');
  // All parcels in this block share the programme, while their architectural
  // dimensions still vary independently. The root seed survives eager/lazy forks.
  const B = pl.blockPoly ?? pl.poly;
  const programme = new Rng(rng.seedKey.split('\u0001')[0]).fork('perimeter-programme:' + pl.block + ':' + B[0].x + ':' + B[0].y);
  const solid = programme.fork('solid').chance(P.blockSolidChance ?? 0.08);
  const infill = !solid && programme.fork('infill').chance(P.blockInfillChance ?? 0.22);
  const share = programme.fork('court-preference').range(...(P.blockCourtShare ?? [0.12, 0.45]));
  const buildings: PerimeterHouse[] = [];
  const fronts: [Vec2, Vec2][] = [pl.front, ...pl.sideFronts];
  for (const side of pl.streetSides ?? []) {
    if (!fronts.some(([a, b]) => side.every(p => distToSeg(p, a, b) < 0.1))) fronts.push(side);
  }
  for (const [row, front] of fronts.entries()) {
    const width = dist(...front);
    if (width < 1.5) continue;
    const rr = pr.fork('row:' + row), o = front[0];
    const t = { x: (front[1].x - o.x) / width, y: (front[1].y - o.y) / width }, n = { x: -t.y, y: t.x };
    const dot = (p: Vec2, v: Vec2) => (p.x - o.x) * v.x + (p.y - o.y) * v.y;
    const u0 = Math.min(...pl.poly.map(p => dot(p, t))), u1 = Math.max(...pl.poly.map(p => dot(p, t)));
    const available = Math.max(...pl.poly.map(p => dot(p, n)));
    const count = Math.max(1, Math.min(80, Math.floor(width / MIN_BW), Math.round(width / rr.range(9, 24))));
    const weights = Array.from({ length: count }, (_, i) => rr.fork('width:' + i).range(0.35, 1.8));
    const sum = weights.reduce((s, w) => s + w, 0), remainder = Math.max(0, width - count * MIN_BW);
    const raw: Bldg[] = [];
    let left = u0;
    for (let i = 0; i < count; i++) {
      const right = i === count - 1 ? u1 : (i === 0 ? 0 : left) + MIN_BW + remainder * weights[i] / sum;
      const w = Math.min(width, right) - Math.max(0, left);
      const nominal = Math.max(MIN_BW, available * (1 - Math.sqrt(share)));
      const depth = solid ? available : Math.min(available, w * (MAX_ASPECT - 0.5),
        Math.max(MIN_BW, nominal * rr.fork('depth:' + i).range(0.5, infill ? 2.1 : 1.5)));
      const pieces = clipPlot(pl.poly, [
        { p: { x: o.x + n.x * depth, y: o.y + n.y * depth }, n: { x: -n.x, y: -n.y } },
        { p: { x: o.x + t.x * left, y: o.y + t.y * left }, n: t },
        { p: { x: o.x + t.x * right, y: o.y + t.y * right }, n: { x: -t.x, y: -t.y } },
      ], isConvex(pl.poly));
      for (const poly of pieces) for (const ph of tryDifference(poly, ...buildings.map(b => b.poly)).pieces) {
        if (!ph.holes.length && area(ph.outer) > 1) raw.push({ poly: ph.outer, kind: 'house' });
      }
      left = right;
    }
    const contactFronts = [front, ...(pl.boundarySides ?? []).filter(([a, b]) =>
      Math.max(dot(a, n), dot(b, n)) <= Math.max(1, width * 0.25))];
    // A tapered corner return belongs to its attached neighbour, rather than
    // becoming a sliver or an artificial hole in the street facade.
    for (let i = raw.length - 1; i >= 0; i--) {
      const shape = shapeOf(raw[i].poly);
      if (shape.w >= MIN_BW && shape.asp <= MAX_ASPECT) continue;
      for (const neighbour of buildings) {
        const joined = stitchUnion(neighbour.poly, raw[i].poly);
        if (!joined) continue;
        const s = shapeOf(joined);
        if (s.w < MIN_BW || s.asp > MAX_ASPECT) continue;
        const crop = tryIntersection(joined, pl.blockPoly ?? pl.poly, pl.poly).pieces;
        if (crop.length !== 1 || crop[0].holes.length) continue;
        neighbour.poly = crop[0].outer; raw.splice(i, 1); break;
      }
    }
    for (const b of normalizeFootprints(raw, t)) {
      const crop = tryIntersection(b.poly, pl.blockPoly ?? pl.poly, pl.poly).pieces;
      for (const ph of tryDifference(crop, ...buildings.map(b => b.poly)).pieces) {
        if (ph.holes.length) continue;
        const poly = ph.outer, shape = shapeOf(poly);
        if (shape.w < MIN_BW - 1e-6 || shape.asp > MAX_ASPECT + 1e-6) continue;
        const served = poly.some((a, i) => {
          const q = poly[(i + 1) % poly.length];
          return dist(a, q) >= 1.5 && contactFronts.some(([c, d]) => [0.25, 0.5, 0.75].every(v =>
            distToSeg({ x: a.x + (q.x - a.x) * v, y: a.y + (q.y - a.y) * v }, c, d) < 0.1));
        });
        if (served) buildings.push({ poly, kind: 'house', orientation: Math.atan2(n.y, n.x), ring: true });
      }
    }
  }
  return buildings;
}

/** Legacy adapter also uses native cutPlots, never custom cells or a pretraced court. */
export function buildPerimeterBlock(pl: Plot, P: MorphologyParams, rng: Rng): PerimeterBlockResult {
  if (!pl.wholeBlock) {
    const buildings = buildPerimeterPlot(pl, P, rng);
    return { buildings, courts: difference(pl.poly, ...buildings.map(b => b.poly)), passages: [], programme: 'open' };
  }
  const streets = new Streets();
  [pl.front, ...pl.sideFronts].forEach(front => streets.add(front, 0.2, pl.rank, 'radial', 0));
  const parcels = cutPlots(pl.poly, pl.block, pl.zone, 0.95, { ...P, deepFill: true }, streets, rng.fork('legacy-cut-plots'));
  const buildings = parcels.plots.flatMap((plot, i) => buildPerimeterPlot(plot, P, rng.fork('plot:' + i)));
  return { buildings, courts: difference(pl.poly, ...buildings.map(b => b.poly)), passages: [],
    programme: (P.blockSolidChance ?? 0.08) === 1 ? 'solid' : 'open' };
}
