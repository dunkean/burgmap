import { generate } from '../src/gen/pipeline';
import { makeOptions, Relief } from '../src/gen/options';
import type { TerrainLayer } from '../src/gen/types';

export function slopeStats(t: TerrainLayer) {
  const s: number[] = [];
  const n = t.height.w;
  for (let i = 0; i < n * n; i++) if (t.water[i] === 0 && t.height.data[i] > 0.5) s.push(t.slope.data[i]);
  s.sort((a, b) => a - b);
  const q = (p: number) => s[Math.floor(s.length * p)] ?? 0;
  let near: number[] = [];
  const m = t.rivers.find((r) => r.main);
  if (m) {
    const cell = t.height.cell;
    const R = 220;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (t.water[i] !== 0 || t.height.data[i] < 0.5) continue;
      const px = (x + 0.5) * cell, py = (y + 0.5) * cell;
      let ok = false;
      for (let k = 0; k < m.path.length && !ok; k += 2) if (Math.hypot(m.path[k].x - px, m.path[k].y - py) < R) ok = true;
      if (ok) near.push(t.slope.data[i]);
    }
    near.sort((a, b) => a - b);
  }
  const nearMed = near.length ? near[Math.floor(near.length / 2)] : NaN;
  return { nearMed, p25: q(0.25), med: q(0.5), p75: q(0.75), p95: q(0.95) };
}
if (process.argv[1]?.includes('terrain_stats')) {
  const reliefs: Relief[] = ['flat', 'hills', 'valley', 'mountains'];
  const size = (process.argv[2] ?? 'town') as any;
  for (const relief of reliefs) {
    const rows: string[] = [];
    for (const seed of ['1', '2', '3', '4', '5']) {
      const w = generate(makeOptions({ seed, relief, size, river: (process.argv[3] ?? 'river') as any }));
      const st = slopeStats(w.terrain);
      rows.push(`${(st.med * 100).toFixed(1)}/${(st.nearMed * 100).toFixed(1)}(${(st.p95 * 100).toFixed(0)}) ${Math.round(w.stats['ms.terrain'] as number)}ms L${w.terrain.lakes.length}`);
    }
    console.log(relief.padEnd(10), rows.join(' | '));
  }
}
