/**
 * Fabric metrics: footprint aspect-ratio histogram per phase, open-interior share per block (per phase: median,
 * p90, share of blocks above 15 %), churches and places. npx tsx scripts/fabric.ts seed size [culture]
 */
import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';
import { area, obb } from '../src/gen/geo/poly';

const [seed, size, culture] = [process.argv[2] ?? '4', (process.argv[3] ?? 'city') as SizeName, process.argv[4] ?? 'european-organic'];
const w = generate(makeOptions({ seed, size, culture }));
const u = w.urban!;
const bins = [1.5, 2, 2.5, 3, 4, 99];
const hist = new Map<number, number[]>();
for (const b of u.buildings) {
  if (b.parcel === undefined || b.kind === 'landmark' || b.kind === 'church' || b.kind === 'cathedral') continue;
  const ph = u.blockInfo[u.parcels[b.parcel].block].phase;
  const o = obb(b.poly);
  const asp = o.hu / Math.max(1e-6, o.hv);
  const h = hist.get(ph) ?? bins.map(() => 0);
  h[bins.findIndex((x) => asp <= x)]++;
  hist.set(ph, h);
}
console.log(`seed ${seed} ${size} ${culture}: pop ${u.population}`);
console.log('aspect histogram per phase (≤1.5, ≤2, ≤2.5, ≤3, ≤4, >4):');
for (const [ph, h] of [...hist.entries()].sort((a, b) => a[0] - b[0])) {
  const n = h.reduce((a, b) => a + b, 0);
  console.log(`  phase ${ph}: ` + h.map((v) => `${((100 * v) / n).toFixed(0)}%`).join(' ') + ` (n=${n})`);
}
const built = new Float64Array(u.blocks.length);
for (const b of u.buildings) if (b.parcel !== undefined) built[u.parcels[b.parcel].block] += area(b.poly);
const open = new Map<number, number[]>();
u.blocks.forEach((poly, i) => {
  const inf = u.blockInfo[i];
  if (inf.kind !== 'block') return;
  const l = open.get(inf.phase) ?? [];
  l.push(1 - built[i] / area(poly));
  open.set(inf.phase, l);
});
console.log('open interior share per block:');
for (const [ph, l] of [...open.entries()].sort((a, b) => a[0] - b[0])) {
  l.sort((a, b) => a - b);
  const q = (p: number) => l[Math.min(l.length - 1, Math.floor(p * l.length))];
  console.log(`  phase ${ph} (${u.blockInfo.find((b) => b.phase === ph)?.zone}): median ${(100 * q(0.5)).toFixed(0)}% p90 ${(100 * q(0.9)).toFixed(0)}% blocks>15% ${((100 * l.filter((x) => x > 0.15).length) / l.length).toFixed(0)}% (n=${l.length})`);
}
const churches = u.landmarks.filter((l) => l.kind === 'church' || l.kind === 'cathedral').length;
const places = u.parcels.filter((p) => p.use === 'place' || p.use === 'market').length;
console.log(`churches ${churches}, places ${places}`);
