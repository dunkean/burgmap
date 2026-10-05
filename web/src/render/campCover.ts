/** Restore only unclassified rural-reserve gaps outside open camps, using their neighbouring real cover. */
import type { World, UrbanLayer, LandArea, LandKind, Polygon, PolyH, Vec2 } from '../gen/types';
import { offsetRibbon } from '../gen/core/geom';
import { bboxOf, orientPos, pointInRing } from '../gen/geo/poly';
import { differenceSafeS, intersectionS, unionMany } from '../gen/geo/bool';
import { protectedGround, waterGround } from '../gen/landuse/landscapeGround';

const NATURAL: readonly LandKind[] = ['meadow', 'pasture', 'commons', 'forest', 'marsh'];
const piece = (outer: Polygon): PolyH => ({ outer: orientPos(outer), holes: [] });
const finite = (pieces: PolyH[]): boolean => pieces.every((p) => [p.outer, ...p.holes]
  .every((r) => r.length >= 3 && r.every((v) => Number.isFinite(v.x) && Number.isFinite(v.y))));
const distanceSq = (p: Vec2, ring: Polygon): number => {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2);
  }
  return best;
};

/** Immutable scene parts retain this result; exports derive it from the current World without a global cache. */
export function campCover(world: World, u: UrbanLayer): LandArea[] {
  if (world.landuse?.landscapeGround === undefined || !u.renderHints?.openGround || u.renderHints.stilts || u.renderHints.graves) return [];
  const apron = u.landmarks.filter((l) => l.kind === 'camp-ground').map((l) => piece(l.poly));
  const { cell, w, h } = world.terrain.height;
  if (!apron.length || !Number.isFinite(cell) || cell <= 0 || !Number.isSafeInteger(w) || !Number.isSafeInteger(h)
    || w <= 0 || h <= 0 || !finite(apron)) return [];
  // The rural reserve grows a rasterised footprint by 5 m + half a cell; vectorisation adds another cell.
  // This is a bounded display repair outside that footprint, not an extension of a camp or of agricultural land.
  const margin = 8 + 2 * cell, reach = margin + 2 * cell;
  const grown = apron.concat(apron.map((p) => piece(offsetRibbon([...p.outer, p.outer[0]], p.outer.concat(p.outer[0]).map(() => margin * 2)))));
  const boxes = grown.map((p) => bboxOf(p.outer));
  const near = (poly: Polygon, padding = 0): boolean => {
    const b = bboxOf(poly);
    return boxes.some((a) => a.x0 <= b.x1 + padding && a.x1 >= b.x0 - padding && a.y0 <= b.y1 + padding && a.y1 >= b.y0 - padding);
  };
  const areas = world.landuse.areas.filter((a) => near(a.poly, reach));
  const neighbours = areas.filter((a) => NATURAL.includes(a.kind));
  if (!neighbours.length) return [];
  const layers = [world.urban, ...(world.settlements ?? []).filter((s) => !s.main).map((s) => s.urban), ...Object.values(world.megaDetail ?? {})]
    .filter((layer): layer is UrbanLayer => !!layer);
  const protection = [
    ...areas.map((a) => ({ outer: orientPos(a.poly), holes: a.holes ?? [] })),
    // Do not fill real forest clearings or grazing courts inside the camp. Only the exterior reserve is repaired.
    ...u.footprintH,
    ...layers.flatMap((layer) => layer === u ? protectedGround(layer, world) : layer.footprintH),
    ...layers.flatMap((layer) => layer.masses.length ? layer.masses : layer.buildings.map((b) => piece(b.poly))),
    ...world.landuse.farmsteads.map((f) => piece(f.lot ?? f.yard)),
  ].filter((p) => near(p.outer));
  const terrain = world.terrain;
  const waterRings = [...terrain.coastline, ...(terrain.islands ?? []), ...terrain.lakes, ...terrain.rivers.map((r) => r.path)];
  if (!finite(grown) || !finite(protection) || waterRings.some((r) => r.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)))
    || terrain.rivers.some((r) => r.width.some((w) => !Number.isFinite(w)))) return [];
  try {
    const water = waterGround(world).filter((p) => near(p.outer));
    if (!finite(water)) return [];
    const gaps = differenceSafeS(unionMany(grown, 24, true), unionMany([...protection, ...water], 24, true));
    if (!gaps.length) return [];
    const assigned = new Map<LandKind, PolyH[]>(), seen = new Set<string>();
    // Class assignment follows the terrain grid, while exact clipping below retains every field/water boundary.
    for (const gap of gaps) {
      const b = bboxOf(gap.outer);
      for (let y = Math.max(0, Math.floor(b.y0 / cell)); y <= Math.min(h - 1, Math.floor(b.y1 / cell)); y++) for (let x = Math.max(0, Math.floor(b.x0 / cell)); x <= Math.min(w - 1, Math.floor(b.x1 / cell)); x++) {
        const key = `${x},${y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Large, malformed worlds fail closed instead of allocating an unbounded display grid.
        if (seen.size > 65536) return [];
        const p = { x: (x + 0.5) * cell, y: (y + 0.5) * cell };
        const distances = new Map<LandKind, number>();
        for (const a of neighbours) {
          const distance = pointInRing(a.poly, p) && !(a.holes ?? []).some((h) => pointInRing(h, p)) ? 0
            : Math.min(distanceSq(p, a.poly), ...(a.holes ?? []).map((h) => distanceSq(p, h)));
          distances.set(a.kind, Math.min(distances.get(a.kind) ?? Infinity, distance));
        }
        const sorted = [...distances].sort((a, b) => a[1] - b[1] || NATURAL.indexOf(a[0]) - NATURAL.indexOf(b[0]));
        if (!sorted.length || sorted[0][1] > reach * reach || (sorted[1] && Math.abs(sorted[0][1] - sorted[1][1]) < 0.0001)) continue;
        const kind = sorted[0][0], list = assigned.get(kind) ?? [];
        list.push(piece([{ x: x * cell, y: y * cell }, { x: (x + 1) * cell, y: y * cell },
          { x: (x + 1) * cell, y: (y + 1) * cell }, { x: x * cell, y: (y + 1) * cell }]));
        assigned.set(kind, list);
      }
    }
    return [...assigned].flatMap(([kind, cells]) => intersectionS(unionMany(cells, 24, true), gaps)
      .map((p) => ({ kind, poly: p.outer, holes: p.holes })));
  } catch { return []; }
}

export function worldCampCover(world: World): LandArea[] {
  return [world.urban, ...(world.settlements ?? []).filter((s) => !s.main).map((s) => s.urban), ...Object.values(world.megaDetail ?? {})]
    .filter((u): u is UrbanLayer => !!u).flatMap((u) => campCover(world, u));
}
