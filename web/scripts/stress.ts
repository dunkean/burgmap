/**
 * Synthetic stress test: ~200k building polygons + ~50k street polylines over a 30 km map.
 * Measures scene/tile-index build time and JS-side per-frame cost (path building + draw calls
 * issued into a mock 2D context) at several zoom levels. GPU rasterisation cost is NOT included:
 * for real per-frame timings open the app and read the HUD (bottom-left).
 *   npx tsx scripts/stress.ts [--buildings N] [--streets N]
 */
import { fakeWorld, mockCanvas, MockPath2D } from './fakeworld';
import { buildScene } from '../src/render/scene';
import { createCanvasRenderer } from '../src/render/canvas';
import type { CanvasLike } from '../src/render/canvas';

const args = process.argv.slice(2);
const arg = (k: string, d: number): number => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const nb = arg('--buildings', 200_000), ns = arg('--streets', 50_000);

let t = performance.now();
const world = fakeWorld({ buildings: nb, streets: ns });
console.log(`fake world: ${world.urban!.buildings.length} buildings, ${world.urban!.streets.length} streets, ${(performance.now() - t).toFixed(0)} ms`);

const builds: number[] = [];
let scene = buildScene(world);
for (let i = 0; i < 3; i++) { t = performance.now(); scene = buildScene(world); builds.push(performance.now() - t); }
console.log(`scene + tile index build: ${builds.map((b) => b.toFixed(0)).join(', ')} ms (3 runs)`);
console.log('layer counts:', JSON.stringify(scene.counts));

const { canvas, log } = mockCanvas(1600, 900);
const r = createCanvasRenderer(canvas as unknown as CanvasLike, world, 'parchment', { Path2D: MockPath2D as never, dpr: 1, scene, terrain: () => null });
const c0 = world.urban!.footprint[0];
const cx = c0.reduce((s, p) => s + p.x, 0) / c0.length, cy = c0.reduce((s, p) => s + p.y, 0) / c0.length;
console.log('scale(px/m)  band  cold ms  warm ms  bldg candidates  fill+stroke calls  path vertices  paths built(cold)');
for (const scale of [0.03, 0.06, 0.15, 0.3, 0.6, 1.2, 3]) {
  r.dispose();
  const cold = r.draw({ cx, cy, scale });
  const warms: number[] = [];
  log.calls = {}; log.pathOps = 0;
  for (let i = 0; i < 11; i++) warms.push(r.draw({ cx: cx + i * 0.5, cy, scale }).ms);
  const st = r.lastStats();
  warms.sort((a, b) => a - b);
  const calls = ((log.calls.fill ?? 0) + (log.calls.stroke ?? 0)) / 11;
  console.log(`${scale.toFixed(2).padStart(10)}  ${String(st.band).padStart(4)}  ${cold.ms.toFixed(1).padStart(7)}  ${warms[5].toFixed(1).padStart(7)}  ${String(st.buildingsCandidate).padStart(15)}  ${String(Math.round(calls)).padStart(17)}  ${String(Math.round(log.pathOps / 11)).padStart(13)}  ${cold.pathsBuilt}`);
}
