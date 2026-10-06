/** Small, isolated inputs for the native parcel and house operators. */
import { Rng } from '../core/rng';
import type { Polygon } from '../core/geom';
import { orientPos } from '../geo/poly';

export const BENCH_SHAPE_NAMES = [
  'Rectangle', 'Longue et fine', 'Triangle aigu', 'Coin fermé', 'Parallélogramme',
  'Trapèze', 'Forme en L', 'Encoche', 'Bord courbé convexe', 'Bord courbé concave',
] as const;

export function benchShapes(seed: string, scale = 1): { name: string; poly: Polygon }[] {
  if (!Number.isFinite(scale) || scale < 1 || scale > 5) throw new Error('Le facteur de taille doit être compris entre 1 et 5.');
  const curve = (concave: boolean): number[][] => [
    [-14, -14], [14, -14],
    ...Array.from({ length: 13 }, (_, i) => {
      const t = i / 12;
      return [14 - 28 * t, 14 + (concave ? -10 : 10) * Math.sin(t * Math.PI)];
    }),
  ];
  const shapes = [
    [[-12, -16], [12, -16], [12, 16], [-12, 16]],
    [[-4, -28], [4, -28], [4, 28], [-4, 28]],
    [[-14, -18], [14, -18], [-11, 24]],
    [[-15, -12], [15, -12], [3, 24], [-9, 12]],
    [[-18, -14], [6, -14], [18, 14], [-6, 14]],
    [[-17, -14], [17, -14], [8, 16], [-8, 16]],
    [[-16, -16], [16, -16], [16, -2], [0, -2], [0, 18], [-16, 18]],
    [[-16, -16], [16, -16], [16, 16], [5, 16], [0, 2], [-5, 16], [-16, 16]],
    curve(false), curve(true),
  ];
  return shapes.map((points, i) => {
    const rng = new Rng(seed).fork('testbench-shape:' + i);
    const angle = rng.range(-Math.PI / 5, Math.PI / 5);
    const sx = rng.range(0.85, 1.15), sy = rng.range(0.85, 1.15);
    // Space the fixtures along with their dimensions, keeping every shape isolated.
    const cx = 320 + i % 5 * 90 * scale, cy = 420 + Math.floor(i / 5) * 100 * scale;
    const poly = orientPos(points.map(([x, y]) => ({
      x: cx + (x * sx * Math.cos(angle) - y * sy * Math.sin(angle)) * scale,
      y: cy + (x * sx * Math.sin(angle) + y * sy * Math.cos(angle)) * scale,
    })));
    return { name: BENCH_SHAPE_NAMES[i], poly };
  });
}
