/**
 * Fabric metrics. npx tsx scripts/fabric.ts seed size [culture[,culture...]] [--brief]
 *
 * Per culture and per zone (phase):
 * - footprint metrics of the ordinary buildings (landmarks, compounds and huts excluded):
 *   - dwellings (house / hall pieces): area histogram, median / p10 / p90, aspect (long / short side of the
 *     minimum OBB) median and share in [1, 2.2], vertex-count histogram;
 *   - outbuildings (rear ranges, back buildings, sheds, barns): median area and ratio to the dwellings;
 *   - houses per parcel (the parcel's built pieces unioned, as a cadastre counts a house with its wings);
 * - the targets: Napoleonic cadastre of a French town core, dwellings median 60–90 m², aspect 1.3–2;
 * - open interior share per block (median, p90, share of blocks above 15 %), churches and places.
 */
import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';
import { area, obb } from '../src/gen/geo/poly';
import type { World } from '../src/gen/types';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const brief = process.argv.includes('--brief');
const [seed, size] = [args[0] ?? '4', (args[1] ?? 'city') as SizeName];
const cultures = (args[2] ?? 'european-organic').split(',');

const AREA_BINS = [25, 40, 60, 90, 120, 200, 400, Infinity];
const AREA_LBL = ['<25', '25-40', '40-60', '60-90', '90-120', '120-200', '200-400', '>400'];
const VERT_BINS = [4, 5, 6, 8, Infinity];
const VERT_LBL = ['4', '5', '6', '7-8', '9+'];
const DWELL = new Set(['house', 'hall']);
const OUT = new Set(['rear', 'back', 'shed', 'barn']);

const q = (l: number[], p: number) => (l.length ? l[Math.min(l.length - 1, Math.floor(p * l.length))] : NaN);
const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(0) + '%' : '-');
const hist = (vals: number[], bins: number[]) => { const h = bins.map(() => 0); for (const v of vals) h[bins.findIndex((x) => v <= x)]++; return h; };

interface Acc { dA: number[]; dAsp: number[]; dV: number[]; oA: number[]; pA: number[] }

function report(w: World, culture: string): void {
  const u = w.urban!;
  const byZone = new Map<string, Acc>();
  const acc = (z: string) => { let a = byZone.get(z); if (!a) { a = { dA: [], dAsp: [], dV: [], oA: [], pA: [] }; byZone.set(z, a); } return a; };
  const perParcel = new Map<number, number>();
  for (const b of u.buildings) {
    if (b.parcel === undefined) continue;
    const pc = u.parcels[b.parcel];
    if (pc.use !== 'plot') continue;
    const inf = u.blockInfo[pc.block];
    if (inf.compound) continue;
    const z = `${inf.phase}:${pc.zone ?? inf.zone}`;
    const A = area(b.poly);
    const o = obb(b.poly);
    if (DWELL.has(b.kind)) {
      const a = acc(z);
      a.dA.push(A); a.dAsp.push(o.hu / Math.max(1e-6, o.hv)); a.dV.push(b.poly.length);
    } else if (OUT.has(b.kind)) acc(z).oA.push(A);
    perParcel.set(b.parcel, (perParcel.get(b.parcel) ?? 0) + A);
  }
  for (const [pi, A] of perParcel) { const pc = u.parcels[pi]; const inf = u.blockInfo[pc.block]; acc(`${inf.phase}:${pc.zone ?? inf.zone}`).pA.push(A); }
  console.log(`\n== ${culture} seed ${seed} ${size}: pop ${u.population}, buildings ${u.buildings.length}, ms.urban ${w.stats['ms.urban']}`);
  const all: Acc = { dA: [], dAsp: [], dV: [], oA: [], pA: [] };
  const keys = [...byZone.keys()].sort();
  for (const k of keys) { const a = byZone.get(k)!; for (const f of Object.keys(all) as (keyof Acc)[]) all[f].push(...a[f]); }
  const line = (name: string, a: Acc) => {
    for (const l of Object.values(a)) l.sort((x: number, y: number) => x - y);
    const n = a.dA.length;
    if (!n) { console.log(`  ${name}: no dwellings`); return; }
    const inAsp = a.dAsp.filter((x) => x <= 2.2).length;
    const asp13 = a.dAsp.filter((x) => x >= 1.3 && x <= 2).length;
    console.log(`  ${name.padEnd(12)} dwellings n=${n} area med ${q(a.dA, 0.5).toFixed(0)} (p10 ${q(a.dA, 0.1).toFixed(0)}, p90 ${q(a.dA, 0.9).toFixed(0)}) | aspect med ${q(a.dAsp, 0.5).toFixed(2)} ≤2.2 ${pct(inAsp, n)} in[1.3,2] ${pct(asp13, n)} | outb n=${a.oA.length} med ${q(a.oA, 0.5).toFixed(0)} (×${(q(a.oA, 0.5) / q(a.dA, 0.5)).toFixed(2)}) | per parcel med ${q(a.pA, 0.5).toFixed(0)}`);
    if (brief) return;
    console.log(`               area   ` + hist(a.dA, AREA_BINS).map((v, i) => `${AREA_LBL[i]}:${pct(v, n)}`).join(' '));
    console.log(`               verts  ` + hist(a.dV, VERT_BINS).map((v, i) => `${VERT_LBL[i]}:${pct(v, n)}`).join(' '));
  };
  for (const k of keys) line('phase ' + k, byZone.get(k)!);
  line('ALL', all);
  if (brief) return;
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
  console.log('  open interior share per block:');
  for (const [ph, l] of [...open.entries()].sort((a, b) => a[0] - b[0])) {
    l.sort((a, b) => a - b);
    console.log(`    phase ${ph} (${u.blockInfo.find((b) => b.phase === ph)?.zone}): median ${(100 * q(l, 0.5)).toFixed(0)}% p90 ${(100 * q(l, 0.9)).toFixed(0)}% blocks>15% ${pct(l.filter((x) => x > 0.15).length, l.length)} (n=${l.length})`);
  }
  const churches = u.landmarks.filter((l) => l.kind === 'church' || l.kind === 'cathedral').length;
  const places = u.parcels.filter((p) => p.use === 'place' || p.use === 'market').length;
  console.log(`  churches ${churches}, places ${places}`);
}

for (const c of cultures) {
  const w = generate(makeOptions({ seed, size, culture: c, ...(c === 'dwarven' ? { relief: 'mountains' as never } : {}) }));
  report(w, c);
}
