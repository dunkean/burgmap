/** Invariant checks of URBAN_GEOMETRY.md §6 on a generated world (shared by the urban tests). */
import type { World, UrbanStreet } from '../src/gen/types';
import type { Vec2, Polygon } from '../src/gen/core/geom';
import { area, interiorAngle, inscribed, bboxOf, distToSeg, pointInRing } from '../src/gen/geo/poly';
import { intersection, difference, mpArea } from '../src/gen/geo/bool';
import { GridIndex } from '../src/gen/geo/spatial';
import { StreetGraph } from '../src/gen/geo/graph';

export interface Report {
  quarters: number; blocks: number; plots: number; buildings: number;
  /** worst relative area error block → parcels */
  blockAreaErr: number;
  /** blocks leaving their quarter (area m²) */
  blockOutside: number;
  overlapsBlocks: number; overlapsPlots: number; overlapsBuildings: number;
  noFrontage: number;
  bldgOutside: number;
  acute: number; thin: number;
  components: number; orphanMain: number;
  details: string[];
}

function overlaps(polys: Polygon[], tol: number, limit = 1e9): { n: number; worst: number } {
  const idx = new GridIndex<number>(40);
  polys.forEach((p, i) => idx.insertPts(p, i));
  const bbs = polys.map(bboxOf);
  let n = 0, worst = 0;
  polys.forEach((p, i) => {
    for (const j of idx.query(bbs[i].x0, bbs[i].y0, bbs[i].x1, bbs[i].y1)) {
      if (j <= i) continue;
      const b = bbs[j], a = bbs[i];
      if (b.x0 > a.x1 || b.x1 < a.x0 || b.y0 > a.y1 || b.y1 < a.y0) continue;
      const ar = mpArea(intersection(p, polys[j]));
      if (ar > tol) { n++; worst = Math.max(worst, ar); }
      if (n >= limit) return;
    }
  });
  return { n, worst };
}

export function checkWorld(w: World): Report {
  const ub = w.urban!;
  const det: string[] = [];
  const r: Report = {
    quarters: ub.quarters.length, blocks: ub.blocks.length, plots: ub.parcels.filter((p) => p.use === 'plot').length, buildings: ub.buildings.length,
    blockAreaErr: 0, blockOutside: 0, overlapsBlocks: 0, overlapsPlots: 0, overlapsBuildings: 0, noFrontage: 0, bldgOutside: 0,
    acute: 0, thin: 0, components: 0, orphanMain: 0, details: det,
  };
  // 1. blocks inside their quarter; blocks → parcels conservation
  ub.blocks.forEach((b, i) => {
    const q = ub.quarters[ub.blockInfo[i].quarter];
    const out = mpArea(difference(b, q.poly.outer));
    if (out > 0.05) { r.blockOutside += out; det.push(`block ${i} outside quarter by ${out.toFixed(2)} m²`); }
  });
  const byBlock = new Map<number, number>();
  for (const p of ub.parcels) byBlock.set(p.block, (byBlock.get(p.block) ?? 0) + area(p.poly));
  ub.blocks.forEach((b, i) => {
    const a = area(b), s = byBlock.get(i) ?? 0;
    const e = Math.abs(a - s) / a;
    if (e > r.blockAreaErr) r.blockAreaErr = e;
    if (e > 0.005) det.push(`block ${i}: area ${a.toFixed(1)} vs parcels ${s.toFixed(1)}`);
  });
  // 2. overlaps
  const ob = overlaps(ub.blocks, 0.05);
  r.overlapsBlocks = ob.n;
  const op = overlaps(ub.parcels.map((p) => p.poly), 0.05);
  r.overlapsPlots = op.n;
  if (op.n) det.push(`parcel overlaps ${op.n}, worst ${op.worst.toFixed(3)} m²`);
  const obd = overlaps(ub.buildings.map((b) => b.poly), 0.05);
  r.overlapsBuildings = obd.n;
  if (obd.n) det.push(`building overlaps ${obd.n}, worst ${obd.worst.toFixed(3)} m²`);
  // 3. frontage: ≥ 3 m on a street ribbon edge
  const sidx = new GridIndex<{ s: UrbanStreet; i: number }>(30);
  for (const s of ub.streets) for (let i = 1; i < s.path.length; i++) sidx.insertSeg(s.path[i - 1], s.path[i], { s, i });
  const onRibbon = (p: Vec2): boolean => {
    for (const { s, i } of sidx.queryPt(p, 12)) {
      const hw = ((s.widths?.[i - 1] ?? s.width) + (s.widths?.[i] ?? s.width)) / 4;
      const d = distToSeg(p, s.path[i - 1], s.path[i]);
      if (Math.abs(d - hw) < Math.max(0.6, 0.3 * hw) || d < hw) return true;
    }
    // disks at street ends (junction widening)
    return false;
  };
  for (const p of ub.parcels) {
    if (p.use !== 'plot') continue;
    const f = p.front!;
    const L = Math.hypot(f[1].x - f[0].x, f[1].y - f[0].y);
    const m = { x: (f[0].x + f[1].x) / 2, y: (f[0].y + f[1].y) / 2 };
    if (L < 3 || !onRibbon(m)) { r.noFrontage++; if (r.noFrontage < 6) det.push(`plot without frontage (L=${L.toFixed(1)})`); }
  }
  // 4. buildings inside their plot
  for (const b of ub.buildings) {
    if (b.parcel === undefined) continue;
    const out = mpArea(difference(b.poly, ub.parcels[b.parcel].poly));
    if (out > 0.05) { r.bldgOutside++; if (r.bldgOutside < 6) det.push(`building outside plot by ${out.toFixed(3)} m²`); }
  }
  // 5. angles and widths
  const shapeCheck = (p: Polygon, what: string) => {
    let mn = Infinity;
    for (let i = 0; i < p.length; i++) mn = Math.min(mn, interiorAngle(p, i));
    if (mn < (12 * Math.PI) / 180) { r.acute++; if (r.acute < 8) det.push(`${what} with angle ${((mn * 180) / Math.PI).toFixed(1)}° (area ${area(p).toFixed(1)})`); }
    if (inscribed(p, [], 0.1).r * 2 < 2) { r.thin++; if (r.thin < 8) det.push(`${what} thinner than 2 m (area ${area(p).toFixed(1)})`); }
  };
  ub.blocks.forEach((b) => shapeCheck(b, 'block'));
  ub.parcels.forEach((p) => shapeCheck(p.poly, p.use));
  ub.buildings.forEach((b) => shapeCheck(b.poly, 'building'));
  // 6. connectivity of the street graph
  const g = new StreetGraph();
  ub.streets.forEach((s, i) => g.insertPolyline(s.path, { width: s.width, rank: s.rank, phase: s.phase, kind: 'street', street: i }, { snapR: 0.3, mergeDist: 0 }));
  const { count, comp } = g.components();
  r.components = count;
  // components holding a main street must be the one holding the radials
  const radialComp = new Set<number>();
  for (const e of g.aliveEdges()) if (ub.streets[e.street].role === 'radial') radialComp.add(comp[e.a]);
  for (const e of g.aliveEdges()) {
    if (ub.streets[e.street].rank <= 2 && !radialComp.has(comp[e.a])) { r.orphanMain++; break; }
  }
  void pointInRing;
  return r;
}
