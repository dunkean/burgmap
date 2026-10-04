/** Shore habitat for pile dwellings: shallow margins, gentle banks and open navigation channels. */
import type { Vec2, Polygon, Polyline } from '../../core/geom';
import { dist, simplify } from '../../core/geom';
import type { UrbanCtx } from '../context';
import { area, bboxOf, pointInRing, distToRing, distToSeg } from '../../geo/poly';
import { differenceSafeS, unionS, unionMany, mpArea, type MultiPoly } from '../../geo/bool';
import { ribbon } from '../../geo/offset';
import { GridIndex } from '../../geo/spatial';
import { splitHoles, goodShape, sharedLen, cutByCells } from './kit';

export function shoreTerrain(ctx: UrbanCtx) {
  // Keep bank growth inside the planning window even though the water context now covers the whole map.
  const covered = (p: Vec2) => p.x >= Math.max(3, ctx.win.x0) && p.y >= Math.max(3, ctx.win.y0) &&
    p.x <= Math.min(ctx.mapSize - 3, ctx.win.x1) && p.y <= Math.min(ctx.mapSize - 3, ctx.win.y1);
  const wet = ctx.water.map((ph) => ({ ph, box: bboxOf(ph.outer) }));
  const atWater = (p: Vec2) => wet.find(({ ph, box }) => p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1 &&
    pointInRing(ph.outer, p) && !ph.holes.some((h) => pointInRing(h, p)));
  const isWet = (p: Vec2) => !!atWater(p);
  /** Find the shoreline from either side; use one nearest ray, never cancelling opposite banks. */
  const anchor = (p: Vec2, radius = 700): { shore: Vec2; angle: number; center: Vec2 } | null => {
    if (!covered(p)) return null;
    const startsWet = isWet(p);
    for (let r = 12; r <= radius; r += 12) {
      let best: { shore: Vec2; angle: number; center: Vec2; d: number } | null = null;
      for (let i = 0; i < 48; i++) {
        const a = i * Math.PI * 2 / 48, dx = Math.cos(a), dy = Math.sin(a);
        const q = { x: p.x + r * dx, y: p.y + r * dy };
        if (!covered(q) || isWet(q) === startsWet) continue;
        let lo = 0, hi = r;
        for (let k = 0; k < 10; k++) {
          const mid = (lo + hi) / 2;
          if (isWet({ x: p.x + mid * dx, y: p.y + mid * dy }) === startsWet) lo = mid; else hi = mid;
        }
        const shore = { x: p.x + hi * dx, y: p.y + hi * dy }, angle = startsWet ? a + Math.PI : a;
        const ca = Math.cos(angle), sa = Math.sin(angle);
        const center = [6, 12, 18, 24, 36, 48].map((d) => ({ x: shore.x - ca * d, y: shore.y - sa * d }))
          .find((c) => !isWet(c) && [-6, 0, 6].every((u) => [-1.7, 0, 1.7].every((v) =>
            suitable({ x: c.x + ca * u - sa * v, y: c.y + sa * u + ca * v }))));
        // A rejected steep bank must not prevent trying a different nearby shore.
        if (center && (!best || hi < best.d)) best = { shore, angle, center, d: hi };
      }
      if (best) return best;
    }
    return null;
  };
  const channels: Polygon[] = [];
  const channelSegments = new GridIndex<{ a: Vec2; b: Vec2; h0: number; h1: number }>(30);
  for (const river of ctx.terrain.rivers) {
    const widths = river.width.map((w) => Math.max(3, w * 0.55));
    const path = ribbon(river.path, widths);
    if (path.length >= 3) channels.push(path);
    for (let i = 1; i < river.path.length; i++) {
      const a = river.path[i - 1], b = river.path[i], h0 = widths[i - 1] / 2, h1 = widths[i] / 2, margin = Math.max(h0, h1) + 1;
      channelSegments.insertBox(Math.min(a.x, b.x) - margin, Math.min(a.y, b.y) - margin,
        Math.max(a.x, b.x) + margin, Math.max(a.y, b.y) + margin, { a, b, h0, h1 });
    }
  }
  const navigation: MultiPoly = channels.length ? unionMany(channels, 16, true) : [];
  const suitable = (p: Vec2): boolean => {
    if (!covered(p) || ctx.slopeAt(p) > 0.12) return false;
    const water = atWater(p);
    // Shore distance is a conservative shallow-water proxy; the height grid has no bathymetry.
    if (water && Math.min(distToRing(water.ph.outer, p), ...water.ph.holes.map((h) => distToRing(h, p))) > 12) return false;
    for (const e of channelSegments.queryPt(p, 0)) {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      const t = Math.max(0, Math.min(1, ((p.x - e.a.x) * dx + (p.y - e.a.y) * dy) / (dx * dx + dy * dy || 1)));
      if (distToSeg(p, e.a, e.b) < e.h0 * (1 - t) + e.h1 * t + 1) return false;
    }
    return true;
  };
  return { isWet, anchor, suitable, navigation };
}

/** Grow connected bank ground, stopping each ray at its first unsuitable terrain. */
export function stiltGround(habitat: ReturnType<typeof shoreTerrain>, c: Vec2, a: number, b: number, angle: number,
  wobble: (t: number) => number): Polygon[] {
  if (!habitat.suitable(c)) return [];
  const points: Polygon = [];
  const count = Math.max(128, Math.ceil(Math.PI * Math.max(a, b) * 1.1));
  for (let i = 0; i < count; i++) {
    const t = i * Math.PI * 2 / count;
    const limit = (1 + wobble(t)) / Math.sqrt((Math.cos(t) / a) ** 2 + (Math.sin(t) / b) ** 2);
    const dx = Math.cos(t + angle), dy = Math.sin(t + angle);
    let end = 0;
    for (let r = 2; r <= limit; r += 2) {
      if (!habitat.suitable({ x: c.x + dx * r, y: c.y + dy * r })) break;
      end = r;
    }
    const p = { x: c.x + dx * end, y: c.y + dy * end };
    if (!points.length || dist(points[points.length - 1], p) > 0.01) points.push(p);
  }
  if (points.length > 1 && dist(points[0], points[points.length - 1]) < 0.01) points.pop();
  const ground = differenceSafeS(points, habitat.navigation).filter((ph) => area(ph.outer) > 80);
  const rooted = ground.find((ph) => (pointInRing(ph.outer, c) || distToRing(ph.outer, c) < 0.05) && !ph.holes.some((h) => pointInRing(h, c)));
  return rooted ? splitHoles(rooted).filter((q) => area(q) > 40 &&
    mpArea(differenceSafeS(q, habitat.navigation)) >= area(q) - 0.05) : [];
}

/** Keep only the continuous part containing its access root, with the entire walk width on suitable ground. */
export function rootedWalk(path: Polyline, root: Vec2, width: number, quarters: Polygon[], suitable: (p: Vec2) => boolean): Polyline | null {
  const runs: Polyline[] = []; let run: Polyline = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], length = dist(a, b);
    if (length < 0.01) continue;
    const steps = Math.ceil(length / 1.5), nx = -(b.y - a.y) / length, ny = (b.x - a.x) / length;
    const fits = (p: Vec2) => quarters.some((q) => pointInRing(q, p) || distToRing(q, p) < 0.05) &&
      [-0.5, 0, 0.5].every((k) => suitable({ x: p.x + nx * width * k, y: p.y + ny * width * k }));
    const edge = (inside: Vec2, outside: Vec2): Vec2 => {
      let lo = 0, hi = 1;
      for (let k = 0; k < 10; k++) {
        const t = (lo + hi) / 2, p = { x: inside.x + (outside.x - inside.x) * t, y: inside.y + (outside.y - inside.y) * t };
        if (fits(p)) lo = t; else hi = t;
      }
      return { x: inside.x + (outside.x - inside.x) * lo, y: inside.y + (outside.y - inside.y) * lo };
    };
    let outside: Vec2 | null = null;
    for (let j = 0; j <= steps; j++) {
      const p = { x: a.x + (b.x - a.x) * j / steps, y: a.y + (b.y - a.y) * j / steps };
      if (fits(p)) {
        if (!run.length && outside) run.push(edge(p, outside));
        if (!run.length || dist(run[run.length - 1], p) > 0.01) run.push(p);
        outside = null;
      } else {
        // End at the actual safe boundary, rather than stranding a sub-metre
        // sliver between the final coarse sample and the quarter edge.
        if (run.length) {
          const last = run[run.length - 1], end = edge(last, p);
          if (dist(last, end) > 0.01) run.push(end);
          runs.push(run); run = [];
        }
        outside = p;
      }
    }
  }
  if (run.length) runs.push(run);
  const rooted = runs.find((pl) => pl.some((p) => dist(p, root) < 0.05));
  if (!rooted || rooted.length < 2 || dist(rooted[0], rooted[rooted.length - 1]) < 6) return null;
  return simplify(rooted, 0.05);
}

/** Repair the rare cell corners around dead ends without filling their boardwalk holes. */
export function finishShoreLots(input: { poly: Polygon; tag: number }[]): { poly: Polygon; tag: number }[] {
  const out = input.slice();
  for (let pass = 0; pass < 64; pass++) {
    let repaired = false;
    for (let i = 0; i < out.length && !repaired; i++) {
      if (goodShape(out[i].poly, 2.2)) continue;
      const neighbours = out.map((pc, j) => ({ j, shared: i === j ? 0 : sharedLen(out[i].poly, pc.poly) }))
        .filter((n) => n.shared > 0.05).sort((a, b) => b.shared - a.shared || a.j - b.j);
      for (const { j } of neighbours) {
        const joined = unionS(out[i].poly, out[j].poly);
        if (joined.length !== 1) continue;
        const replacement = splitHoles(joined[0]);
        // splitHoles has a bounded recursion: reject a fallback that refills a hole.
        if (!replacement.length || Math.abs(replacement.reduce((a, q) => a + area(q), 0) - mpArea(joined)) > 0.02 ||
          !replacement.every((q) => goodShape(q, 2.2))) continue;
        const tag = out[j].tag;
        out.splice(Math.max(i, j), 1); out.splice(Math.min(i, j), 1);
        out.push(...replacement.map((poly) => ({ poly, tag })));
        repaired = true;
        break;
      }
    }
    if (!repaired) break;
  }
  return out;
}

/** Leave tiny, unserved bank corners as open ground before defining the final blocks. */
export function shoreBlockLots(block: Polygon, cells: { poly: Polygon; tag: number }[], frontage: (q: Polygon) => number):
  { poly: Polygon; lots: { poly: Polygon; tag: number }[] }[] {
  const pending = [{ poly: block, depth: 0 }], result: { poly: Polygon; lots: { poly: Polygon; tag: number }[] }[] = [];
  while (pending.length) {
    const { poly, depth } = pending.pop()!;
    const lots = finishShoreLots(cutByCells(poly, cells, true));
    const scraps = lots.filter((pc) => area(pc.poly) < 30 && !goodShape(pc.poly, 2.2) && frontage(pc.poly) < 3.2);
    if (scraps.length && depth < 4) {
      const cuts = unionMany(scraps.map((pc) => pc.poly), 16, true);
      const reduced = differenceSafeS(poly, cuts).flatMap((ph) => splitHoles(ph));
      const reducedArea = reduced.reduce((sum, p) => sum + area(p), 0);
      // No min-area pruning or corner trimming here: preserve all served land,
      // and reject boolean failures or any split that refills a public hole.
      if (reducedArea < area(poly) - 0.01 && Math.abs(area(poly) - reducedArea - mpArea(cuts)) <= 0.05 &&
        reduced.every((p) => goodShape(p, 2.2))) {
        pending.push(...reduced.map((p) => ({ poly: p, depth: depth + 1 })));
        continue;
      }
    }
    result.push({ poly, lots });
  }
  return result;
}
