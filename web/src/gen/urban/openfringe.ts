import type { Vec2, Polygon, Polyline } from '../core/geom';
import type { Rng } from '../core/rng';
import type { UrbanCtx } from './context';
import type { Quarter, Primary } from './primary';
import type { MorphologyParams } from './morphology';
import { Streets, LAB_OPEN } from './streets';
import { GridIndex } from '../geo/spatial';
import { area, bboxOf, distToSeg, pointInRing, orientPos } from '../geo/poly';
import { differenceSafeS, intersectionS, mpArea, unionMany, type MultiPoly } from '../geo/bool';
import { miterNormals, ribbon } from '../geo/offset';
import { goodShape, pieces } from './camps/kit';

/** Density drops before an open settlement's planning boundary, rather than ending in a continuous row. */
export const openEdgeFade = (distance: number, band: number): number => band > 0 ? 0.9 * Math.max(0, Math.min(1, 1 - distance / band)) : 0;

const inLand = (p: Vec2, land: MultiPoly): boolean => land.some((ph) => pointInRing(ph.outer, p) && !ph.holes.some((h) => pointInRing(h, p)));

/** Public strips keep the full path's miters without repairing a closed circuit into solid land. */
export function streetStrips(path: Polyline, widths: number | number[]): MultiPoly {
  if (path.length < 2) return [];
  const normals = miterNormals(path, 2.5);
  const side = (i: number, sign: number): Vec2 => {
    const half = (typeof widths === 'number' ? widths : widths[i]) / 2;
    return { x: path[i].x + sign * normals[i].x * half, y: path[i].y + sign * normals[i].y * half };
  };
  return path.slice(1).map((_, i) => ({ outer: orientPos([side(i, 1), side(i + 1, 1), side(i + 1, -1), side(i, -1)]), holes: [] }));
}

/** Small served extensions beyond the original frame. Core quarters and landmarks are never reclaimed. */
export function addOpenFringe(ctx: UrbanCtx, primary: Primary, streets: Streets, phase: number, morph: MorphologyParams, culture: string, rng: Rng, protect: MultiPoly = [], varyGrowth = true): Quarter[] {
  if (varyGrowth && rng.fork('growth').chance(0.18)) return [];
  const planned = primary.footprint;
  const protectedIndex = new GridIndex<number>(30);
  protect.forEach((ph, i) => protectedIndex.insertPts(ph.outer, i));
  const edges = new GridIndex<{ a: Vec2; b: Vec2 }>(30);
  for (const ph of planned) for (let i = 0; i < ph.outer.length; i++) edges.insertSeg(ph.outer[i], ph.outer[(i + 1) % ph.outer.length], { a: ph.outer[i], b: ph.outer[(i + 1) % ph.outer.length] });
  const candidates: { root: Vec2; dx: number; dy: number; id: number; end: number }[] = [];
  for (const street of streets.list.slice()) {
    if (!street.ribbon || !streets.connected.has(street.id) || street.rank > 3 || street.path.length < 2) continue;
    if (Math.hypot(street.path[0].x - street.path.at(-1)!.x, street.path[0].y - street.path.at(-1)!.y) < 0.1) continue;
    for (const end of [0, street.path.length - 1]) {
      const root = street.path[end], previous = street.path[end === 0 ? 1 : end - 1];
      const length = Math.hypot(root.x - previous.x, root.y - previous.y);
      if (length < 0.1) continue;
      const dx = (root.x - previous.x) / length, dy = (root.y - previous.y) / length;
      let distance = Infinity;
      edges.forEachIn(root.x - 6, root.y - 6, root.x + 6, root.y + 6, (e) => { distance = Math.min(distance, distToSeg(root, e.a, e.b)); });
      if (distance > 5 || inLand({ x: root.x + dx * 10, y: root.y + dy * 10 }, planned)) continue;
      candidates.push({ root, dx, dy, id: street.id, end });
    }
  }
  candidates.sort((a, b) => a.id - b.id || a.end - b.end);
  const quarters: Quarter[] = [], occupied: MultiPoly[] = [], corridors: Polygon[] = [];
  const roots: Vec2[] = [];
  const safe = (p: Vec2): boolean => p.x >= Math.max(3, ctx.win.x0) && p.y >= Math.max(3, ctx.win.y0) && p.x <= Math.min(ctx.mapSize - 3, ctx.win.x1) && p.y <= Math.min(ctx.mapSize - 3, ctx.win.y1) && !ctx.isWater(p) && ctx.slopeAt(p) <= 0.28;
  for (const candidate of candidates) {
    if (roots.length >= 24) break;
    const { root, dx, dy } = candidate;
    if (roots.some((p) => Math.hypot(p.x - root.x, p.y - root.y) < 55)) continue;
    const local = rng.fork(`street:${candidate.id}:${candidate.end}`);
    if (varyGrowth && !local.fork('growth').chance(0.85)) continue;
    const width = Math.max(3, Math.min(4.5, morph.widthByRank[3] * morph.widthScale));
    const wanted = local.range(45, 95);
    const curve = morph.streetOp === 'grid' ? 0 : local.fork('curve').range(-8, 8);
    const at = (t: number, side: number): Vec2 => {
      const offset = side + curve * (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, (t - 8) / (wanted - 8))))) / 2;
      return { x: root.x + dx * t - dy * offset, y: root.y + dy * t + dx * offset };
    };
    let length = 0;
    for (let t = 0; t <= wanted; t += 2) {
      if (![0, -width / 2, width / 2].every((side) => safe(at(t, side)))) break;
      length = t;
    }
    if (length < 30) continue;
    const knots = [4, 8];
    for (let t = 16; t < length - 2; t += 8) knots.push(t);
    knots.push(length);
    const path = [{ ...root }, ...knots.map((t) => at(t, 0))], parts: Polygon[] = [];
    const corridor = ribbon(path, width), bb = bboxOf(path);
    if (!corridor.every(safe)) continue;
    // Check the actual piecewise-linear street, including its full mitered width, not only its guiding curve.
    const normals = miterNormals(path, 2.5);
    let streetSafe = true;
    for (let i = 1; i < path.length && streetSafe; i++) {
      const a = path[i - 1], b = path[i], steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
      for (let j = 0; j <= steps && streetSafe; j++) {
        const t = j / steps;
        for (const side of [-1, 0, 1]) {
          const nx = normals[i - 1].x * (1 - t) + normals[i].x * t, ny = normals[i - 1].y * (1 - t) + normals[i].y * t;
          if (!safe({ x: a.x * (1 - t) + b.x * t + nx * width / 2 * side, y: a.y * (1 - t) + b.y * t + ny * width / 2 * side })) { streetSafe = false; break; }
        }
      }
    }
    if (!streetSafe) continue;
    const nearby = [...protectedIndex.query(bb.x0 - 30, bb.y0 - 30, bb.x1 + 30, bb.y1 + 30)].map((i) => [protect[i]]);
    const parent = streets.list[candidate.id], parentRibbon = streetStrips(parent.path, parent.widths);
    if (area(corridor) - mpArea(differenceSafeS(corridor, ctx.water)) > 0.02) continue;
    if (occupied.length && area(corridor) - mpArea(differenceSafeS(corridor, ...occupied)) > 0.02) continue;
    // The whole connection may enter older land only inside its existing parent's public ribbon.
    // Free land excludes that ribbon too, so the two allowed areas cannot be counted twice.
    const free = mpArea(differenceSafeS(corridor, planned, ...nearby, parentRibbon));
    const shared = mpArea(intersectionS(corridor, parentRibbon));
    if (area(corridor) - free - shared > 0.02) continue;
    const onLane = (p: Vec2): boolean => path.some((b, i) => i > 0 && distToSeg(p, path[i - 1], b) < 0.02);
    const edgeOnLane = (a: Vec2, b: Vec2): boolean => onLane(a) && onLane(b) && onLane({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    for (const side of [-1, 1]) {
      const depth = local.range(12, 26), tip = local.range(7, 12);
      const back = knots.map((t, i) => at(t, side * (i === knots.length - 1 ? tip : depth * local.fork(`depth:${side}:${i}`).range(0.7, 1))));
      const shape = orientPos([...knots.map((t) => at(t, 0)), ...back.reverse()]);
      const cut = differenceSafeS(shape, planned, ...occupied, ...nearby, ctx.water);
      for (const poly of pieces(cut, 180)) {
        if (!goodShape(poly, 5)) continue;
        // Hole splitting must never refill protected land, including its rare depth-limit fallback.
        if (area(poly) - mpArea(differenceSafeS(poly, planned, ...occupied, ...nearby, ctx.water)) > 0.02) continue;
        const front = poly.reduce((sum, a, i) => { const b = poly[(i + 1) % poly.length]; return sum + (edgeOnLane(a, b) ? Math.hypot(b.x - a.x, b.y - a.y) : 0); }, 0);
        if (front < 18 || !poly.every(safe)) continue;
        const box = bboxOf(poly);
        let valid = true;
        for (let y = box.y0; y <= box.y1 && valid; y += 4) for (let x = box.x0; x <= box.x1; x += 4) if (pointInRing(poly, { x, y }) && !safe({ x, y })) { valid = false; break; }
        if (valid && area(poly) > 180) parts.push(poly);
      }
    }
    if (!parts.length) continue;
    const id = streets.add(path, width, 3, 'lane', phase);
    streets.connected.add(id);
    for (const poly of parts) quarters.push({ lp: { pts: poly, lab: poly.map((a, i) => edgeOnLane(a, poly[(i + 1) % poly.length]) ? id : LAB_OPEN) }, phase, zone: 'faubourg', age: 0.05, kind: 'quarter', morph, culture });
    occupied.push(...parts.map((outer) => [{ outer, holes: [] }]), [{ outer: corridor, holes: [] }]);
    corridors.push(corridor);
    roots.push(root);
  }
  if (quarters.length) primary.footprint = unionMany([planned, ...quarters.map((q) => q.lp.pts), ...corridors], 24, true);
  return quarters;
}
