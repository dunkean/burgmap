/** Last footprint pass, after edge-roof and density mutations and before rebuilding masses. */
import type { Polygon, Vec2 } from '../core/geom';
import type { UrbanBuilding, UrbanParcel } from '../types';
import type { PolyH } from '../geo/bool';
import { area, bboxOf, cleanRing, isSimple, interiorAngle, minAngle, minNeck, inscribed } from '../geo/poly';
import { isConvex, lpoly, polyInside, splitByChord } from '../geo/split';
import { GridIndex } from '../geo/spatial';
import { distToRing, pointInRing } from '../geo/poly';
import { shapeOkObb } from './access';
import { splitLong } from './access';
import { mpArea, tryDifference, tryIntersection } from '../geo/bool';
import { reconstructRoom } from './roomReconstruct';
import { reconstructCompactRoom } from './compactRoom';

export interface FootprintFinalInput {
  buildings: UrbanBuilding[];
  parcels: UrbanParcel[];
  /** Optional receiver for released substandard arms, in native coordinates. */
  backLand?: PolyH[];
  /** Anonymous plot yards; a successful new roof transaction trims their land. */
  gardens?: Polygon[];
  /** Physical constraint beyond a sharp tip (sea/water/wall or neighbouring quarter). */
  tipConstrained?: (tip: Vec2, outward: Vec2) => boolean;
  /** True when the tip exits a labelled open quarter boundary. */
  openQuarterEdge?: (tip: Vec2, outward: Vec2) => boolean;
  /** Prove all proposed rooms retain street access and do not disconnect block peers. */
  validateParts?: (originalIndex: number, parts: Polygon[]) => boolean;
  /** Prove a proposed in-owner relocation misses water, roads, walls and other reserves. */
  placementClear?: (poly: Polygon, original?: Polygon) => boolean;
}
export interface FootprintFinalResult { changed: Set<number>; invalid: number[]; cleaned: number; releasedArea: number }

function proper(p: Polygon): boolean {
  if (p.length < 3 || !isSimple(p) || area(p) < 12) return false;
  if (p.length === 3) return 2 * inscribed(p, [], 0.02).r >= 3.2 && minAngle(p) >= 20 * Math.PI / 180;
  if (!shapeOkObb(p)) return false;
  if (2 * inscribed(p, [], 0.05, 1.8).r < 3.6) return false;
  return (minNeck(p)?.w ?? Infinity) >= 3.59;
}

function normalize(p: Polygon): Polygon | null {
  // No coordinate snapping: the native partition and world-scale translations stay exact.
  const q = cleanRing(p, 1e-6, 0.0001, 1e-9, false);
  return q.length >= 3 && isSimple(q) && Math.abs(area(q) - area(p)) < 1e-6 ? q : null;
}

/** Clip only a disproportionately sharp building tip; keep its land as open owner land. */
function clipSharpTip(p: Polygon, owner: Polygon, constrained: (tip: Vec2, outward: Vec2) => boolean,
  maxAngle = 18, legFraction = 0.45): { house: Polygon; tip: Polygon } | null {
  if (p.length < 3 || !isSimple(p)) return null;
  for (let i = 0; i < p.length; i++) {
    const angle = interiorAngle(p, i);
    if (angle >= maxAngle * Math.PI / 180) continue;
    const v = p[i], a = p[(i - 1 + p.length) % p.length], b = p[(i + 1) % p.length];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const vl = Math.hypot(v.x - mx, v.y - my) || 1;
    const outward = { x: (v.x - mx) / vl, y: (v.y - my) / vl };
    if (!constrained(v, outward)) continue;
    const la = Math.hypot(a.x - v.x, a.y - v.y), lb = Math.hypot(b.x - v.x, b.y - v.y);
    if (la < 3 || lb < 3) continue;
    let len = Math.min(legFraction * Math.min(la, lb), 1.2 / Math.max(0.05, Math.sin(angle / 2)));
    // Limit land released to 3% of the current building; the cut must remain visible.
    const maxLen = Math.sqrt(0.06 * area(p) / Math.max(1e-6, Math.sin(angle)));
    len = Math.min(len, maxLen);
    if (len < 0.4) continue;
    const pa = { x: v.x + (a.x - v.x) * len / la, y: v.y + (a.y - v.y) * len / la };
    const pb = { x: v.x + (b.x - v.x) * len / lb, y: v.y + (b.y - v.y) * len / lb };
    const house = [...p.slice(0, i), pa, pb, ...p.slice(i + 1)];
    const tip = [pa, v, pb];
    if (isSimple(house) && area(house) >= 12 && polyInside(owner, house)
      && Math.abs(area(house) + area(tip) - area(p)) < 1e-6 && area(tip) < 0.03 * area(p) + 1e-6) return { house, tip };
  }
  return null;
}

/** Blunt the narrow end of a long courtyard wing without filling its court. */
function clipHallWing(p: Polygon, owner: Polygon,
  constrained: (tip: Vec2, outward: Vec2) => boolean): { house: Polygon; tip: Polygon } | null {
  if (p.length < 6 || !isSimple(p)) return null;
  for (let i = 0; i < p.length; i++) {
    const j = (i + 1) % p.length;
    const a = p[(i - 1 + p.length) % p.length], v = p[i], w = p[j], b = p[(i + 2) % p.length];
    const cap = Math.hypot(v.x - w.x, v.y - w.y);
    const left = Math.hypot(a.x - v.x, a.y - v.y), right = Math.hypot(b.x - w.x, b.y - w.y);
    if (cap < 1.6 || cap > 2.8 || left < 7 || right < 7
      || Math.min(left, right) < 3 * cap) continue;
    const tip = { x: (v.x + w.x) / 2, y: (v.y + w.y) / 2 };
    const centre = { x: p.reduce((s, point) => s + point.x, 0) / p.length,
      y: p.reduce((s, point) => s + point.y, 0) / p.length };
    const outwardLength = Math.hypot(tip.x - centre.x, tip.y - centre.y) || 1;
    if (!constrained(tip, { x: (tip.x - centre.x) / outwardLength,
      y: (tip.y - centre.y) / outwardLength })) continue;
    for (const trim of [3, 2.5, 2, 1.5]) {
      if (trim > 0.4 * Math.min(left, right)) continue;
      const nv = { x: v.x + (a.x - v.x) * trim / left, y: v.y + (a.y - v.y) * trim / left };
      const nw = { x: w.x + (b.x - w.x) * trim / right, y: w.y + (b.y - w.y) * trim / right };
      const house = p.map((point, k) => k === i ? nv : k === j ? nw : point);
      const tip = [v, w, nw, nv];
      const loss = area(p) - area(house);
      if (loss < 1 || loss > 0.03 * area(p) || !isSimple(house) || !polyInside(owner, house)
        || Math.abs(area(tip) - loss) > 1e-6) continue;
      return { house, tip };
    }
  }
  return null;
}

export function finalizeFootprints(u: FootprintFinalInput): FootprintFinalResult {
  const changed = new Set<number>(), invalid: number[] = [];
  let cleaned = 0, releasedArea = 0;
  const parcelIndex = new GridIndex<number>(24);
  u.parcels.forEach((p, i) => { if (p.poly.length >= 3) parcelIndex.insertPts(p.poly, i); });
  const respectsOtherOwners = (i: number, after: Polygon): boolean => {
    const b = u.buildings[i], added = tryDifference(after, b.poly);
    if (added.failed || b.parcel === undefined) return false;
    for (const piece of added.pieces) {
      const bounds = bboxOf(piece.outer);
      for (const j of parcelIndex.query(bounds.x0, bounds.y0, bounds.x1, bounds.y1)) {
        if (j === b.parcel) continue;
        const hit = tryIntersection(piece, u.parcels[j].poly);
        if (hit.failed || mpArea(hit.pieces) > 1e-6) return false;
      }
    }
    return true;
  };
  const roofIndex = new GridIndex<number>(24);
  u.buildings.forEach((b, i) => { if (b.poly.length >= 3) roofIndex.insertPts(b.poly, i); });
  const indexGardens = (): GridIndex<number> => {
    const index = new GridIndex<number>(24);
    u.gardens?.forEach((p, i) => { if (p.length >= 3) index.insertPts(p, i); });
    return index;
  };
  let gardenIndex = indexGardens();
  type OpenLandPlan = { gardens: Map<number, PolyH[]>; back: Map<number, PolyH[]>; backConsumed: number };
  const planOpenLand = (after: Polygon | Polygon[]): OpenLandPlan | null => {
    const proposed: PolyH[] = after.length && Array.isArray(after[0])
      ? (after as Polygon[]).map((outer) => ({ outer, holes: [] }))
      : [{ outer: after as Polygon, holes: [] }];
    const gardens = new Map<number, PolyH[]>(), back = new Map<number, PolyH[]>();
    let backConsumed = 0;
    const boxes = proposed.map((p) => bboxOf(p.outer));
    const bounds = { x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)),
      x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)) };
    for (const j of gardenIndex.query(bounds.x0, bounds.y0, bounds.x1, bounds.y1)) {
      const old = u.gardens![j], hit = tryIntersection(proposed, old);
      if (hit.failed) return null;
      if (mpArea(hit.pieces) <= 1e-6) continue;
      const rest = tryDifference(old, proposed);
      if (rest.failed || Math.abs(area(old) - mpArea(rest.pieces) - mpArea(hit.pieces)) > 1e-5) return null;
      gardens.set(j, rest.pieces);
    }
    for (let j = 0; j < (u.backLand?.length ?? 0); j++) {
      const old = u.backLand![j], bb = bboxOf(old.outer);
      if (bb.x1 < bounds.x0 || bb.x0 > bounds.x1 || bb.y1 < bounds.y0 || bb.y0 > bounds.y1) continue;
      const hit = tryIntersection(proposed, [old]);
      if (hit.failed) return null;
      const consumed = mpArea(hit.pieces);
      if (consumed <= 1e-6) continue;
      const rest = tryDifference([old], proposed);
      if (rest.failed || Math.abs(mpArea([old]) - mpArea(rest.pieces) - consumed) > 1e-5) return null;
      back.set(j, rest.pieces); backConsumed += consumed;
    }
    return { gardens, back, backConsumed };
  };
  const commitOpenLand = (plan: OpenLandPlan): void => {
    if (u.backLand && plan.back.size) {
      const old = u.backLand.slice();
      u.backLand.splice(0, u.backLand.length, ...old.flatMap((p, i) => plan.back.get(i) ?? [p]));
      releasedArea -= plan.backConsumed;
    }
    if (u.gardens && plan.gardens.size) {
      const old = u.gardens.slice(), holes: PolyH[] = [];
      const next = old.flatMap((p, i) => {
        const replacement = plan.gardens.get(i);
        if (!replacement) return [p];
        for (const piece of replacement) if (piece.holes.length) holes.push(piece);
        return replacement.filter((piece) => !piece.holes.length).map((piece) => piece.outer);
      });
      u.gardens.splice(0, u.gardens.length, ...next);
      u.backLand?.push(...holes);
      gardenIndex = indexGardens();
    }
  };
  const relocateNarrowAnnex = (i: number, owner: UrbanParcel): Polygon | null => {
    const b = u.buildings[i], oldArea = area(b.poly);
    if (!u.placementClear || !u.validateParts || !owner.front || owner.use !== 'plot'
      || !['rear', 'back'].includes(b.kind) || oldArea < 20 || oldArea > 65) return null;
    const dx = owner.front[1].x - owner.front[0].x, dy = owner.front[1].y - owner.front[0].y;
    const length = Math.hypot(dx, dy);
    if (length < 4.5) return null;
    const ux = dx / length, uy = dy / length, vx = -uy, vy = ux;
    const center = { x: b.poly.reduce((s, p) => s + p.x, 0) / b.poly.length,
      y: b.poly.reduce((s, p) => s + p.y, 0) / b.poly.length };
    const shifts: { x: number; y: number }[] = [];
    for (let x = -18; x <= 18; x += 2) for (let y = -18; y <= 18; y += 2) {
      if (x * x + y * y <= 18 * 18) shifts.push({ x, y });
    }
    shifts.sort((a, c) => a.x * a.x + a.y * a.y - c.x * c.x - c.y * c.y || a.y - c.y || a.x - c.x);
    for (const width of [5.2, 4.5, 6]) {
      const depth = Math.max(4.5, oldArea / width);
      if (depth / width > 3 || width * depth > 1.08 * oldArea) continue;
      for (const shift of shifts) {
        const cx = center.x + shift.x, cy = center.y + shift.y;
        const rectangle = ([-1, 1] as const).flatMap((z) => ([-1, 1] as const).map((a) =>
          ({ x: cx + a * width / 2 * ux + z * depth / 2 * vx,
            y: cy + a * width / 2 * uy + z * depth / 2 * vy })));
        const candidate = [rectangle[0], rectangle[1], rectangle[3], rectangle[2]];
        if (!polyInside(owner.poly, candidate) || !respectsOtherOwners(i, candidate) || !u.placementClear(candidate, b.poly)
          || !planOpenLand(candidate)) continue;
        let clear = true;
        const bounds = bboxOf(candidate);
        for (const j of roofIndex.query(bounds.x0, bounds.y0, bounds.x1, bounds.y1)) {
          if (j === i) continue;
          const hit = tryIntersection(candidate, u.buildings[j].poly);
          if (hit.failed || mpArea(hit.pieces) > 1e-6) { clear = false; break; }
        }
        if (clear && u.validateParts(i, [candidate])) return candidate;
      }
    }
    return null;
  };
  const tipConstrained = (owner: number, tip: Vec2, outward: Vec2): boolean => {
    const beyond = { x: tip.x + 1.5 * outward.x, y: tip.y + 1.5 * outward.y };
    if (u.tipConstrained?.(tip, outward)) return true;
    return parcelIndex.queryPt(beyond, 1).some((j) => j !== owner && (pointInRing(u.parcels[j].poly, beyond)
      || distToRing(u.parcels[j].poly, beyond) < 1));
  };
  const openExterior = (owner: UrbanParcel, tip: Vec2, outward: Vec2): boolean => {
    const beyond = { x: tip.x + 1.5 * outward.x, y: tip.y + 1.5 * outward.y };
    return u.openQuarterEdge?.(tip, outward)
      ?? (!pointInRing(owner.poly, beyond) && distToRing(owner.poly, tip) < 2);
  };
  const armEdge = (main: Polygon, arm: Polygon): { tip: Vec2; outward: Vec2 } => {
    const centroid = (poly: Polygon): Vec2 => ({ x: poly.reduce((s, p) => s + p.x, 0) / poly.length,
      y: poly.reduce((s, p) => s + p.y, 0) / poly.length });
    const a = centroid(arm), m = centroid(main), len = Math.hypot(a.x - m.x, a.y - m.y) || 1;
    const outward = { x: (a.x - m.x) / len, y: (a.y - m.y) / len };
    const tip = arm.reduce((best, p) => (p.x * outward.x + p.y * outward.y > best.x * outward.x + best.y * outward.y ? p : best));
    return { tip, outward };
  };
  const splitIntoServedRooms = (i: number, owner: UrbanParcel): boolean => {
    if (!u.backLand || !u.validateParts || !u.placementClear) return false;
    const b = u.buildings[i], original = b.poly;
    const bounds = bboxOf(owner.poly);
    const occupied = roofIndex.query(bounds.x0, bounds.y0, bounds.x1, bounds.y1)
      .filter((j) => j !== i).map((j) => u.buildings[j].poly);
    let main = original;
    const extra: Polygon[] = [];
    for (let pass = 0; pass < 4 && !proper(main); pass++) {
      const neck = minNeck(main);
      if (!neck || neck.w >= 3.59) return false;
      const cut = splitByChord(lpoly(main, 0), [neck.a, neck.b], 0, 0.02);
      if (!cut) return false;
      const parts = cut.map((p) => p.pts).sort((a, c) => area(c) - area(a));
      if (Math.abs(area(parts[0]) + area(parts[1]) - area(main)) > 1e-6
        || !parts.every((p) => {
          if (!polyInside(owner.poly, p)) return false;
          const outside = tryDifference(p, owner.poly);
          return !outside.failed && mpArea(outside.pieces) <= 1e-6;
        })) return false;
      main = parts[0];
      const arm = parts[1];
      if (proper(arm)) extra.push(arm);
      else if (area(arm) >= 12) {
        const rebuilt = reconstructRoom(arm, owner.poly, occupied,
          (candidate) => u.placementClear!(candidate, original) && respectsOtherOwners(i, candidate)
            && !!planOpenLand(candidate),
          (candidate) => proper(candidate));
        if (!rebuilt) return false;
        extra.push(rebuilt);
      } else if (area(arm) > 0.02 * area(original)) return false;
    }
    const rooms = [main, ...extra];
    if (!rooms.every((p) => proper(p) && u.placementClear!(p, original))
      || rooms.reduce((s, p) => s + area(p), 0) < 0.95 * area(original)) return false;
    const proposed: PolyH[] = rooms.map((outer) => ({ outer, holes: [] }));
    for (let k = 0; k < rooms.length; k++) for (let j = k + 1; j < rooms.length; j++) {
      const hit = tryIntersection(rooms[k], rooms[j]);
      if (hit.failed || mpArea(hit.pieces) > 1e-6) return false;
    }
    const added = tryDifference(proposed, original), freed = tryDifference(original, proposed);
    if (added.failed || freed.failed || freed.pieces.some((p) => p.holes.length)
      || Math.abs(area(original) + mpArea(added.pieces)
        - rooms.reduce((s, p) => s + area(p), 0) - mpArea(freed.pieces)) > 1e-5) return false;
    for (const piece of added.pieces) for (const other of occupied) {
      const hit = tryIntersection(piece, other);
      if (hit.failed || mpArea(hit.pieces) > 1e-6) return false;
    }
    const land = planOpenLand(rooms);
    if (!land || !u.validateParts(i, rooms)) return false;
    commitOpenLand(land);
    b.poly = main;
    for (const p of extra) {
      const index = u.buildings.length;
      u.buildings.push({ ...b, poly: p });
      roofIndex.insertPts(p, index);
    }
    u.backLand.push(...freed.pieces);
    releasedArea += mpArea(freed.pieces);
    if (owner.block !== undefined) changed.add(owner.block);
    return true;
  };
  const count = u.buildings.length;
  for (let i = 0; i < count; i++) {
    const b = u.buildings[i], owner = b.parcel === undefined ? undefined : u.parcels[b.parcel];
    const block = owner?.block;
    const q = normalize(b.poly);
    if (q && q.length !== b.poly.length && (!owner || polyInside(owner.poly, q))) {
      b.poly = q; cleaned++;
      if (block !== undefined) changed.add(block);
    }
    // Keep the hall's intentional U-shaped court while blunting only a long
    // convex needle at its perimeter. The ordinary room-width rule is not
    // meaningful for the hall's open centre and remains disabled below.
    if (b.kind === 'hall' && b.arch === 'courtyard-hall' && !isConvex(b.poly, 1e-3)
      && owner && u.backLand) {
      const tip = clipSharpTip(b.poly, owner.poly, (p, d) => !openExterior(owner, p, d)
        || tipConstrained(b.parcel!, p, d), 55, 0.7);
      if (tip && (!u.validateParts || u.validateParts(i, [tip.house]))) {
        b.poly = tip.house;
        u.backLand.push({ outer: tip.tip, holes: [] });
        releasedArea += area(tip.tip);
        if (block !== undefined) changed.add(block);
      }
      const wing = clipHallWing(b.poly, owner.poly, (p, d) => !openExterior(owner, p, d)
        || tipConstrained(b.parcel!, p, d));
      if (wing && (!u.validateParts || u.validateParts(i, [wing.house]))) {
        b.poly = wing.house;
        u.backLand.push({ outer: wing.tip, holes: [] });
        releasedArea += area(wing.tip);
        if (block !== undefined) changed.add(block);
      }
    }
    // Courtyard ranges are deliberately narrow rooms; their minimum is set by the builder's rd.
    if (b.courtyards?.length || /courtyard|souk|ring/.test(b.arch ?? '')
      || !['house', 'rear', 'back'].includes(b.kind)) continue;
    if (owner && u.backLand) {
      const tip = clipSharpTip(b.poly, owner.poly, (p, d) => !openExterior(owner, p, d)
        || tipConstrained(b.parcel!, p, d));
      if (tip && (!u.validateParts || u.validateParts(i, [tip.house]))) {
        b.poly = tip.house;
        u.backLand.push({ outer: tip.tip, holes: [] });
        releasedArea += area(tip.tip);
        if (block !== undefined) changed.add(block);
      }
    }
    if (proper(b.poly)) continue;
    if (!owner || !u.backLand) { invalid.push(i); continue; }
    // A vertex can touch a distant edge exactly at a neighbouring roof seam.
    // Filling the loop would claim that neighbour; remove only a small existing
    // spur, with no added roof land and the owner/access proof intact.
    if ((minNeck(b.poly)?.w ?? Infinity) < 1e-5) {
      let fixed = false;
      for (let vertex = 0; vertex < b.poly.length; vertex++) {
        const candidate = b.poly.filter((_, j) => j !== vertex);
        if (!proper(candidate) || area(candidate) < 0.95 * area(b.poly) || !polyInside(owner.poly, candidate)) continue;
        const added = tryDifference(candidate, b.poly), freed = tryDifference(b.poly, candidate);
        if (added.failed || freed.failed || mpArea(added.pieces) > 1e-6
          || freed.pieces.some((p) => p.holes.length)
          || Math.abs(area(candidate) + mpArea(freed.pieces) - area(b.poly)) > 1e-5
          || (u.validateParts && !u.validateParts(i, [candidate]))) continue;
        b.poly = candidate;
        u.backLand.push(...freed.pieces);
        releasedArea += mpArea(freed.pieces);
        if (block !== undefined) changed.add(block);
        fixed = true; break;
      }
      if (fixed) continue;
    }
    if ((minNeck(b.poly)?.w ?? Infinity) < 2 && splitIntoServedRooms(i, owner)) continue;
    if (u.placementClear) {
      const bounds = bboxOf(owner.poly);
      const occupied = roofIndex.query(bounds.x0, bounds.y0, bounds.x1, bounds.y1)
        .filter((j) => j !== i).map((j) => u.buildings[j].poly);
      const rebuilt = reconstructRoom(b.poly, owner.poly, occupied,
        (candidate) => u.placementClear!(candidate, b.poly) && respectsOtherOwners(i, candidate)
          && !!planOpenLand(candidate),
        (candidate) => proper(candidate) && (!u.validateParts || u.validateParts(i, [candidate])));
      if (rebuilt) {
        const added = tryDifference(rebuilt, b.poly), freed = tryDifference(b.poly, rebuilt), land = planOpenLand(rebuilt);
        if (land && !added.failed && !freed.failed && freed.pieces.every((p) => !p.holes.length)
          && Math.abs(area(b.poly) + mpArea(added.pieces) - area(rebuilt) - mpArea(freed.pieces)) < 1e-5) {
          commitOpenLand(land);
          b.poly = rebuilt;
          u.backLand.push(...freed.pieces);
          releasedArea += mpArea(freed.pieces);
          roofIndex.insertPts(rebuilt, i);
          if (block !== undefined) changed.add(block);
          continue;
        }
      }
      // An unusable sub-2 m connector can join substantial but uninhabitable
      // wings. Search a compact replacement only after every ≥95% candidate
      // failed, and only with the same physical, ownership and access proofs.
      if (u.validateParts && (minNeck(b.poly)?.w ?? Infinity) < 2) {
        const compact = reconstructCompactRoom(b.poly, owner.poly, occupied, owner.front,
          (candidate) => u.placementClear!(candidate, b.poly) && respectsOtherOwners(i, candidate)
            && !!planOpenLand(candidate),
          (candidate) => proper(candidate) && u.validateParts!(i, [candidate]));
        if (compact) {
          const added = tryDifference(compact, b.poly), freed = tryDifference(b.poly, compact);
          const land = planOpenLand(compact);
          if (land && !added.failed && !freed.failed && freed.pieces.every((p) => !p.holes.length)
            && Math.abs(area(b.poly) + mpArea(added.pieces) - area(compact) - mpArea(freed.pieces)) < 1e-5) {
            commitOpenLand(land);
            b.poly = compact;
            u.backLand.push(...freed.pieces);
            releasedArea += mpArea(freed.pieces);
            roofIndex.insertPts(compact, i);
            if (block !== undefined) changed.add(block);
            continue;
          }
        }
      }
    }
    let main = b.poly;
    const extra: Polygon[] = [], released: Polygon[] = [];
    for (let pass = 0; pass < 4 && !proper(main); pass++) {
      const neck = minNeck(main);
      if (!neck || neck.w >= 3.59) break;
      const cut = splitByChord(lpoly(main, 0), [neck.a, neck.b], 0, 0.02);
      if (!cut) break;
      const parts = cut.map((p) => p.pts).sort((a, c) => area(c) - area(a));
      if (Math.abs(area(parts[0]) + area(parts[1]) - area(main)) > 1e-6 || !parts.every((p) => polyInside(owner.poly, p))) break;
      // Keep the dominant room through the next local cut; retain a second valid room as a building.
      // A failed small arm is released to the owner's open land only when total housing area stays ≥70%.
      if (!proper(parts[1])) {
        if (area(parts[0]) < 0.7 * area(main)) break;
        const { tip, outward } = armEdge(parts[0], parts[1]);
        // A sub-square-metre return is a drafting spur, not a usable exterior
        // room. It may be released even on a dry open edge; larger exterior
        // wings remain whole unless a real neighbouring barrier constrains them.
        const microscopic = area(parts[1]) <= 1 && area(parts[1]) <= 0.005 * area(main);
        if (!microscopic && openExterior(owner, tip, outward)
          && !tipConstrained(b.parcel!, tip, outward)) break;
      }
      main = parts[0];
      if (proper(parts[1])) extra.push(parts[1]); else released.push(parts[1]);
    }
    if (!proper(main) && main.length === 4 && isConvex(main, 1e-3)) {
      const sections = splitLong([{ poly: main, kind: b.kind }]);
      const pieces = sections.map((s) => s.poly);
      if (pieces.length > 1 && pieces.every((p) => proper(p) && polyInside(owner.poly, p))
        && pieces.reduce((s, p) => s + area(p), 0) >= 0.7 * area(main)) {
        const remainder = tryDifference(main, ...pieces);
        if (!remainder.failed && remainder.pieces.every((p) => !p.holes.length)) {
          const accounted = pieces.reduce((s, p) => s + area(p), 0)
            + remainder.pieces.reduce((s, p) => s + area(p.outer), 0);
          if (Math.abs(accounted - area(main)) < 1e-5) {
            main = pieces[0]; extra.push(...pieces.slice(1));
            released.push(...remainder.pieces.map((p) => p.outer));
          }
        }
      }
    }
    let keptExtra = extra, freed = released;
    if (u.validateParts && !u.validateParts(i, [main, ...extra]) && extra.length
      && area(main) >= 0.7 * area(b.poly) && u.validateParts(i, [main])) {
      keptExtra = [];
      freed = [...released, ...extra];
    }
    if (!proper(main) || area(main) + keptExtra.reduce((s, p) => s + area(p), 0) < 0.7 * area(b.poly)
      || (u.validateParts && !u.validateParts(i, [main, ...keptExtra]))) {
      const relocated = relocateNarrowAnnex(i, owner);
      if (relocated) {
        const freed = tryDifference(b.poly, relocated), added = tryDifference(relocated, b.poly), land = planOpenLand(relocated);
        if (land && !freed.failed && !added.failed && freed.pieces.every((p) => !p.holes.length)
          && Math.abs(area(b.poly) + mpArea(added.pieces) - area(relocated) - mpArea(freed.pieces)) < 1e-5) {
          commitOpenLand(land);
          u.backLand.push(...freed.pieces);
          releasedArea += mpArea(freed.pieces);
          b.poly = relocated; roofIndex.insertPts(relocated, i);
          if (block !== undefined) changed.add(block);
          continue;
        }
      }
      invalid.push(i); continue;
    }
    b.poly = main;
    for (const p of keptExtra) {
      const index = u.buildings.length;
      u.buildings.push({ ...b, poly: p });
      roofIndex.insertPts(p, index);
    }
    for (const p of freed) { u.backLand.push({ outer: p, holes: [] }); releasedArea += area(p); }
    if (block !== undefined) changed.add(block);
  }
  // Local repairs can expose collinear backtracks which were hidden by the
  // original self-touching vertex. Drop only zero-area vertices after repair.
  for (const b of u.buildings) {
    const q = normalize(b.poly);
    if (q && q.length < b.poly.length) {
      b.poly = q; cleaned++;
      const block = b.parcel === undefined ? undefined : u.parcels[b.parcel]?.block;
      if (block !== undefined) changed.add(block);
    }
  }
  return { changed, invalid, cleaned, releasedArea };
}
