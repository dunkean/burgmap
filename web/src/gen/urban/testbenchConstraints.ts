/** Analytical land constraints: no noise, hydrology or regional terrain generation. */
import type { Polygon, Polyline } from '../core/geom';
import { createGrid } from '../core/grid';
import type { World } from '../types';
import { bboxOf, orientPos } from '../geo/poly';

export interface BenchConstraints {
  relief?: 'flat' | 'valley' | 'hill';
  reliefSlope?: number;
  river?: 'none' | 'vertical' | 'horizontal' | 'diagonal';
  riverWidth?: number;
}

export function applyBenchConstraints(world: World, footprint: Polygon, options: BenchConstraints): { land?: Polygon; contours: Polyline[] } {
  const b = bboxOf(footprint), cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const rx = (b.x1 - b.x0) / 2, ry = (b.y1 - b.y0) / 2;
  const relief = options.relief ?? 'flat', slope = (options.reliefSlope ?? 18) / 100;
  const contours: Polyline[] = [];
  // A gentle bend shared by the buildable corridor, contours and slope samples.
  const valleyWave = Math.PI / Math.max(1, ry);
  const valleyCenter = (y: number) => cx + rx * 0.2 * Math.sin((y - cy) * valleyWave);
  const valleyLine = (offset: number, padding = 0): Polyline => Array.from({ length: 33 }, (_, i) => {
    const y = b.y0 - padding + (b.y1 - b.y0 + 2 * padding) * i / 32;
    return { x: valleyCenter(y) + rx * offset, y };
  });
  const ellipse = (scale: number): Polygon => Array.from({ length: 48 }, (_, i) => {
    const a = i * 2 * Math.PI / 48;
    return { x: cx + rx * scale * Math.cos(a), y: cy + ry * scale * Math.sin(a) };
  });
  let land: Polygon | undefined;
  if (relief === 'valley') {
    // The valley floor follows the bend; high sides are excluded from the fixture.
    land = orientPos([...valleyLine(-0.65, 1), ...valleyLine(0.65, 1).reverse()]);
    for (const s of [-0.9, -0.65, -0.35, 0.35, 0.65, 0.9]) contours.push(valleyLine(s));
  } else if (relief === 'hill') {
    // A summit footprint with flanks following analytical elliptical contours.
    land = orientPos(ellipse(0.95));
    for (const s of [0.25, 0.5, 0.75, 0.95]) { const ring = ellipse(s); contours.push([...ring, ring[0]]); }
  }
  if (relief !== 'flat') {
    const height = world.terrain.height, slopeGrid = createGrid(height.w, height.h, height.cell);
    for (let y = 0; y < height.h; y++) for (let x = 0; x < height.w; x++) {
      const dx = x * height.cell - cx, dy = y * height.cell - cy;
      const nx = dx / Math.max(1, rx), ny = dy / Math.max(1, ry);
      const r = Math.max(1, Math.min(rx, ry));
      const i = y * height.w + x;
      if (relief === 'valley') {
        const valleyDx = x * height.cell - valleyCenter(y * height.cell);
        const bend = rx * 0.2 * valleyWave * Math.cos(dy * valleyWave);
        height.data[i] = slope * valleyDx * valleyDx / (2 * Math.max(1, rx));
        slopeGrid.data[i] = slope * Math.abs(valleyDx / Math.max(1, rx)) * Math.hypot(1, bend);
      } else {
        height.data[i] = slope * r * Math.exp(-0.5 * (nx * nx + ny * ny));
        slopeGrid.data[i] = slope * r * Math.exp(-0.5 * (nx * nx + ny * ny)) * Math.hypot(nx / rx, ny / ry);
      }
    }
    world.terrain.slope = slopeGrid;
  }
  if (options.river && options.river !== 'none') {
    const d = options.river === 'vertical' ? { x: 0, y: 1 } : options.river === 'horizontal' ? { x: 1, y: 0 } : { x: Math.SQRT1_2, y: Math.SQRT1_2 };
    const width = options.riverWidth ?? 14;
    const path = [{ x: cx - d.x * 1800, y: cy - d.y * 1800 }, { x: cx + d.x * 1800, y: cy + d.y * 1800 }];
    world.terrain.rivers = [{ path, width: [width, width], main: true, cls: 'river' }];
    const g = world.terrain.height;
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      const distance = Math.abs((x * g.cell - cx) * d.y - (y * g.cell - cy) * d.x);
      world.terrain.water[y * g.w + x] = distance <= width / 2 ? 1 : 0;
    }
  }
  return { land, contours };
}
