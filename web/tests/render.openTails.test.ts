import { describe, expect, it } from 'vitest';
import type { Polygon, PolyH, World } from '../src/gen/types';
import { fakeWorld } from '../scripts/fakeworld';
import { urbanLandscapeGround, LandscapeGroundCache } from '../src/gen/landuse/landscapeGround';
import { buildScene } from '../src/render/scene';
import { pointInRing } from '../src/gen/geo/poly';
import { urbanLayer } from '../src/render/urban';
import { biomePalette } from '../src/render/biomes';

const rect = (x0: number, y0: number, x1: number, y1: number): Polygon => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];
const piece = (p: Polygon): PolyH => ({ outer: p, holes: [] });
const contains = (ground: PolyH[], x: number, y: number): boolean => ground.some((ph) => pointInRing(ph.outer, { x, y })
  && !ph.holes.some((h) => pointInRing(h, { x, y })));

function fixture(): World {
  const world = fakeWorld({ mapSize: 1600, buildings: 0, streets: 0, landAreas: 0 });
  world.roads = [];
  world.terrain.rivers = [];
  world.terrain.coastline = [];
  world.terrain.lakes = [];
  world.urban!.footprint = [rect(100, 100, 300, 300)];
  world.urban!.footprintH = [piece(rect(100, 100, 300, 300))];
  world.urban!.quarters = [{ poly: piece(rect(100, 100, 300, 300)), phase: 0, zone: 'edge', streetSpace: [piece(rect(100, 100, 300, 300))] }];
  world.urban!.blocks = [];
  world.urban!.blockInfo = [];
  world.urban!.parcels = [];
  world.urban!.buildings = [];
  world.urban!.walls = [];
  world.urban!.streets = [{ path: [{ x: 150, y: 200 }, { x: 300, y: 200 }], width: 6, rank: 3, kind: 'street', role: 'street', phase: 0 }];
  world.urban!.openTails = [{ street: 0, end: 'end', point: { x: 300, y: 200 }, kind: 'unservedOpenEdge', servedFromEnd: 40, excess: 34 }];
  world.urban!.openEdgeGround = [piece(rect(270, 194, 300, 206))];
  world.landuse!.landscapeGround = [];
  return world;
}

describe('open edge material and street ink', () => {
  it('replays terrain on the same public tail used by the scene and keeps World paths immutable', () => {
    const world = fixture(), u = world.urban!;
    const before = JSON.stringify(u.streets);
    const ground = urbanLandscapeGround(world, true);
    expect(contains(ground, 290, 200)).toBe(true);
    const scene = buildScene(world);
    const paths = scene.lines.filter((line) => line.role === 'street').flatMap((line) => line.lines);
    expect(paths).toHaveLength(1);
    expect(paths[0][paths[0].length - 1].x).toBe(266);
    expect(JSON.stringify(u.streets)).toBe(before);
  });

  it('invalidates both landscape caches when the edge permission changes', () => {
    const world = fixture(), cache = new LandscapeGroundCache();
    cache.prepare(world, 0, true);
    expect(contains(cache.layer(world.urban!), 290, 200)).toBe(true);
    world.urban!.openEdgeGround = [piece(rect(230, 194, 250, 206))];
    expect(contains(cache.layer(world.urban!), 290, 200)).toBe(false);
    expect(contains(urbanLandscapeGround(world, true), 290, 200)).toBe(false);
  });

  it('uses the same clipped ink path in SVG and Canvas scene for open ground', () => {
    const world = fixture();
    world.urban!.renderHints = { towerShape: 'round', openGround: true };
    const svg = urbanLayer(world, biomePalette('parchment', world.options.biome), 1, false,
      undefined, true, true, [], false, urbanLandscapeGround(world, true));
    const scene = buildScene(world);
    const paths = scene.lines.filter((line) => line.role === 'street').flatMap((line) => line.lines);
    expect(svg).toContain('M150 200L266 200');
    expect(svg).not.toContain('M150 200L300 200');
    expect(paths[0][paths[0].length - 1].x).toBe(266);
  });
});
