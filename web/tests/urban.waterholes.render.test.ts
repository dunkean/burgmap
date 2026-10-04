import { describe, it, expect } from 'vitest';
import { fakeWorld } from '../scripts/fakeworld';
import { urbanLayer } from '../src/render/urban';
import { buildScene } from '../src/render/scene';
import { PALETTES } from '../src/render/styles';
import { polygonArea } from '../src/gen/core/geom';
import { pathD } from '../src/render/util';
import { orientPos } from '../src/gen/geo/poly';

const box = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
function fixture() {
  const w = fakeWorld({ mapSize: 1000, buildings: 0, streets: 0, clusters: 1, landAreas: 0 });
  const poly = { outer: box(100, 100, 900, 900), holes: [box(400, 400, 600, 600)] };
  w.urban!.quarters = [{ poly, phase: 1, zone: 'village', streetSpace: [poly] }];
  w.urban!.renderHints = { towerShape: 'round', openGround: false };
  w.urban!.walls = [];
  w.roads = [];
  return { w, poly };
}

describe('quarter lake holes reach both rendering paths', () => {
  it('keeps the SVG street-space lake transparent even with ordinary quarter ground', () => {
    const { w, poly } = fixture();
    const svg = urbanLayer(w, PALETTES.parchment, 1, false);
    const streets = svg.match(/<path class="u-streets"[^>]*>/)![0];
    expect(streets).toContain('fill-rule="nonzero"');
    expect(streets).toContain(pathD(orientPos(poly.outer), true) + pathD(orientPos(poly.holes[0]).slice().reverse(), true));
  });

  it('keeps holes oppositely wound in Canvas scene batches using their nonzero street fill', () => {
    const { w, poly } = fixture();
    const streets = buildScene(w).poly.get('u-streets')!;
    expect(streets.polys).toHaveLength(1);
    expect(streets.holes?.[0]).toHaveLength(1);
    expect(Math.sign(polygonArea(streets.polys[0]))).toBe(-Math.sign(polygonArea(streets.holes![0]![0])));
    expect(Math.abs(polygonArea(streets.holes![0]![0]))).toBe(Math.abs(polygonArea(poly.holes[0])));
  });

  it('uses the same nonzero winding for overlapping quarters with reversed input rings', () => {
    const { w, poly } = fixture();
    poly.outer.reverse();
    const other = { outer: box(200, 200, 700, 700).reverse(), holes: [] };
    w.urban!.quarters.push({ poly: other, phase: 1, zone: 'village', streetSpace: [other] });
    const svg = urbanLayer(w, PALETTES.parchment, 1, false);
    const streets = svg.match(/<path class="u-streets"[^>]*>/)![0];
    expect(streets).toContain('fill-rule="nonzero"');
    expect(streets).toContain(pathD(orientPos(poly.outer), true));
    expect(streets).toContain(pathD(orientPos(other.outer), true));
    const scene = buildScene(w).poly.get('u-streets')!;
    expect(scene.polys).toHaveLength(2);
    expect(scene.polys.every((ring) => polygonArea(ring) > 0)).toBe(true);
    expect(polygonArea(scene.holes![0]![0])).toBeLessThan(0);
  });
});
