// Counts how often each road crosses the same stream. Usage: tsx scripts/road_cross.ts [size]
import { generate } from '../src/gen/pipeline';
import { makeOptions, Relief, SizeName, RiverOpt } from '../src/gen/options';
import { streamIds } from '../src/gen/roads/regional';

const size = (process.argv[2] ?? 'town') as SizeName;
let worst = 0, total = 0, roads = 0, crossings = 0;
for (const relief of ['mountains', 'valley', 'hills'] as Relief[]) {
  for (const seed of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']) {
    const w = generate(makeOptions({ seed, relief, size, river: (process.argv[3] ?? 'stream') as RiverOpt }));
    const t = w.terrain, n = t.height.w, cell = t.height.cell;
    const ids = streamIds(t);
    for (const r of w.roads ?? []) {
      const runs = new Map<number, number>();
      let prev = -2;
      for (let i = 1; i < r.path.length; i++) {
        const a = r.path[i - 1], b = r.path[i];
        const m = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (cell * 0.5)));
        for (let k = 0; k < m; k++) {
          const x = Math.min(n - 1, Math.floor((a.x + (b.x - a.x) * (k / m)) / cell)), y = Math.min(n - 1, Math.floor((a.y + (b.y - a.y) * (k / m)) / cell));
          const id = t.water[y * n + x] === 3 ? ids[y * n + x] : -1;
          if (id >= 0 && id !== prev) runs.set(id, (runs.get(id) ?? 0) + 1);
          prev = id >= 0 ? id : -1;
        }
      }
      roads++;
      runs.forEach((c) => { crossings += c; worst = Math.max(worst, c); total += Math.max(0, c - 1); });
    }
  }
}
console.log({ roads, worstSameStreamCrossings: worst, excessCrossings: total, crossings });
