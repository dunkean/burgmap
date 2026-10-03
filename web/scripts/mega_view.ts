/**
 * Megacity macro plan viewer: quarters by district (or density), arterials, wall rings, nuclei.
 *   npx tsx scripts/mega_view.ts seed=3 population=1000000 mapSize=20000 [--out out/mega.png] [--crop x,y,w] [--detail N] [--density]
 * `--detail N` also generates the detail of the N quarters nearest the center and draws their blocks and buildings.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { generate } from '../src/gen/pipeline';
import { makeOptions, applyOverride } from '../src/gen/options';
import { megaQuarterDetail } from '../src/gen/urban/mega/detail';
import type { Polygon } from '../src/gen/types';

const args = process.argv.slice(2);
const o = makeOptions({});
for (const a of args.filter((x) => x.includes('=') && !x.startsWith('--'))) { const i = a.indexOf('='); applyOverride(o, a.slice(0, i), a.slice(i + 1)); }
const arg = (k: string): string | undefined => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const out = arg('--out') ?? 'out/mega.png';
const nDetail = Number(arg('--detail') ?? 0);
const t0 = performance.now();
const w = generate(o);
const t1 = performance.now();
const u = w.urban!;
const M = u.macro;
console.log('generate', Math.round(t1 - t0), 'ms; urban', w.stats['ms.urban'], 'ms; quarters', M?.quarters.length);
const S = w.mapSize;
let crop = { x: 0, y: 0, w: S };
const cr = arg('--crop');
if (cr) { const [x, y, ww] = cr.split(',').map(Number); crop = { x, y, w: ww }; }
else if (M) { const R = arg('--zoom') ? Number(arg('--zoom')) : M.cityR * 1.15; const o = (arg('--off') ?? '0,0').split(',').map(Number); crop = { x: M.center.x + o[0] - R, y: M.center.y + o[1] - R, w: 2 * R }; }
const px = 1800 / crop.w;
const P = (p: Polygon): string => p.map((q, i) => (i ? 'L' : 'M') + ((q.x - crop.x) * px).toFixed(1) + ',' + ((q.y - crop.y) * px).toFixed(1)).join('') + 'Z';
const L = (p: Polygon): string => p.map((q, i) => (i ? 'L' : 'M') + ((q.x - crop.x) * px).toFixed(1) + ',' + ((q.y - crop.y) * px).toFixed(1)).join('');
const COL: Record<string, string> = { market: '#e8d9a8', 'old-town': '#c9705a', town: '#d99a6c', suburb: '#e6c79c', village: '#8fb070', satellite: '#b5654f', port: '#6f98b8', palace: '#a77fc2', cathedral: '#8c3b3b', craft: '#9a8f6a', gardens: '#9cc48a', citadel: '#444', university: '#d8c25a' };
const parts: string[] = [];
parts.push(`<rect width="1800" height="1800" fill="#f4efe2"/>`);
for (const ph of w.terrain.coastline) parts.push(`<path d="${P(ph)}" fill="#a9c6d6"/>`);
for (const r of w.terrain.rivers) parts.push(`<path d="${L(r.path)}" stroke="#a9c6d6" stroke-width="${Math.max(1, (r.width[r.width.length - 1] ?? 10) * px)}" fill="none"/>`);
for (const lk of w.terrain.lakes) parts.push(`<path d="${P(lk)}" fill="#a9c6d6"/>`);
const dens = args.includes('--density');
if (M) for (const q of M.quarters) {
  const fill = dens ? `hsl(20,60%,${Math.round(92 - Math.min(60, q.density / 6))}%)` : COL[q.district] ?? '#ccc';
  parts.push(`<path d="${P(q.pts)}" fill="${fill}" stroke="#7a6a55" stroke-width="0.4"/>`);
}
for (const wt of u.water ?? []) parts.push(`<path d="${P(wt.outer)}" fill="#a9c6d6"/>`);
for (const st of u.streets) parts.push(`<path d="${L(st.path)}" stroke="${st.rank === 0 ? '#3a2f25' : '#6b5a48'}" stroke-width="${Math.max(0.6, st.width * px)}" fill="none" stroke-linecap="round"/>`);
for (const wl of u.walls ?? []) for (const pc of wl.pieces ?? [wl.path]) parts.push(`<path d="${L(pc)}" stroke="#222" stroke-width="${Math.max(1.6, wl.thickness * 2 * px)}" fill="none"/>`);
for (const wl of u.walls ?? []) for (const t of wl.towers) parts.push(`<circle cx="${((t.x - crop.x) * px).toFixed(1)}" cy="${((t.y - crop.y) * px).toFixed(1)}" r="${Math.max(1.2, 6 * px)}" fill="#222"/>`);
for (const b of w.bridges ?? []) parts.push(`<path d="${L([b.a, b.b])}" stroke="#c33" stroke-width="${Math.max(1.5, b.width * px)}"/>`);
if (M) for (const nu of M.nuclei) parts.push(`<circle cx="${((nu.p.x - crop.x) * px).toFixed(1)}" cy="${((nu.p.y - crop.y) * px).toFixed(1)}" r="5" fill="${nu.kind === 'main' ? '#000' : nu.kind === 'town' ? '#b00' : '#060'}"/>`);
if (M && nDetail > 0) {
  const order = M.quarters.map((q) => q.id).sort((a, b) => {
    const qa = M.quarters[a], qb = M.quarters[b];
    const cx = crop.x + crop.w / 2, cy = crop.y + crop.w / 2;
    const da = Math.hypot((qa.bb[0] + qa.bb[2]) / 2 - cx, (qa.bb[1] + qa.bb[3]) / 2 - cy);
    const db = Math.hypot((qb.bb[0] + qb.bb[2]) / 2 - cx, (qb.bb[1] + qb.bb[3]) / 2 - cy);
    return da - db;
  }).slice(0, nDetail).filter((id) => { const q = M.quarters[id]; return !(q.bb[0] > crop.x + crop.w || q.bb[2] < crop.x || q.bb[1] > crop.y + crop.w || q.bb[3] < crop.y); });
  let tot = 0, mx = 0;
  for (const id of order) {
    const t = performance.now();
    const d = megaQuarterDetail(w, id);
    const ms = performance.now() - t;
    tot += ms; mx = Math.max(mx, ms);
    if (!d) continue;
    for (const b of d.blocks) parts.push(`<path d="${P(b)}" fill="#efe6cf" stroke="#9a8"/>`);
    for (const m of d.masses) parts.push(`<path d="${P(m.outer)}${m.holes.map(P).join('')}" fill="#5a4636" fill-rule="evenodd"/>`);
    for (const st of d.streets) parts.push(`<path d="${L(st.path)}" stroke="#bba" stroke-width="${Math.max(0.3, st.width * px * 0.3)}" fill="none"/>`);
  }
  console.log('detail', order.length, 'quarters: mean', Math.round(tot / order.length), 'ms, max', Math.round(mx), 'ms');
}
if (args.includes('--rings') && M) {
  const rc = ['#e00', '#0a0', '#00e', '#e0e', '#0cc', '#880'];
  M.rings.forEach((r, i) => parts.push(`<path d="${P(r)}" fill="none" stroke="${rc[i % rc.length]}" stroke-width="${3 - i * 0.3}" stroke-opacity="0.8"/>`));
  M.rings.forEach((r, i) => r.forEach((q) => parts.push(`<circle cx="${((q.x - crop.x) * px).toFixed(1)}" cy="${((q.y - crop.y) * px).toFixed(1)}" r="2.5" fill="${rc[i % rc.length]}"/>`)));
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1800" viewBox="0 0 1800 1800">${parts.join('')}</svg>`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, new Resvg(svg, { fitTo: { mode: 'width', value: 1800 } }).render().asPng());
console.log('wrote', out);
