/** Dev/preview for the open-field system: npx tsx tests/tools/fields_dev.ts <name> <seed> <town|10km> -> out/fields_<name>*.png */
import { writeFileSync, mkdirSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { generate } from '../../src/gen/pipeline';
import { makeOptions } from '../../src/gen/options';
import { renderSvg } from '../../src/render/svg';

const [name, seed, kind, mode = 'full'] = process.argv.slice(2);
const o = kind === '10km'
  ? makeOptions({ seed, mapSize: 10000, population: 2500, settlements: 'auto' })
  : makeOptions({ seed, size: 'town' });
const t0 = performance.now();
const w = generate(o);
console.log('gen ms', Math.round(performance.now() - t0), 'landuse ms', w.stats['ms.landuse'], 'furlongs', w.stats['landuse.furlongs'], 'strips', w.stats['landuse.strips']);
mkdirSync('out', { recursive: true });
const svg = renderSvg(w, { style: o.style });
writeFileSync(`out/fields_${name}.svg`, svg);
const S = w.mapSize;
if (mode === 'full') writeFileSync(`out/fields_${name}.png`, new Resvg(svg, { fitTo: { mode: 'width', value: 1800 }, font: { loadSystemFonts: true } }).render().asPng());
// crops of 1 km: the densest field area, and the first secondary settlement
const luA = (w.landuse?.areas ?? []).filter((a) => a.kind === 'field');
const cens = luA.map((a) => a.poly.reduce((p, q) => ({ x: p.x + q.x / a.poly.length, y: p.y + q.y / a.poly.length }), { x: 0, y: 0 }));
let best = { x: S / 2, y: S / 2 }, bs = -1;
for (const c of cens) {
  let sc = 0;
  for (const d of cens) if (Math.hypot(d.x - c.x, d.y - c.y) < 500) sc++;
  if (sc > bs) { bs = sc; best = c; }
}
const sets = (w.settlements ?? []).filter((s) => !s.main && s.detail !== 'farmstead');
const cw = Math.min(S, 1000);
const cr = (c: { x: number; y: number }) => [Math.round(Math.max(0, Math.min(S - cw, c.x - cw / 2))), Math.round(Math.max(0, Math.min(S - cw, c.y - cw / 2))), cw].join(',');
console.log('CROP', cr(best), sets[0] ? cr(sets[0].center) : '');
// strip statistics (length along the furlong direction, width across)
{
  const Ls: number[] = [], Ws: number[] = [], As: number[] = [];
  for (const a of w.landuse?.areas ?? []) for (const st of a.strips ?? []) {
    let mx = 0, my = 0;
    for (const q of st) { mx += q.x / st.length; my += q.y / st.length; }
    let cxx = 0, cxy = 0, cyy = 0;
    for (const q of st) { cxx += (q.x - mx) ** 2; cxy += (q.x - mx) * (q.y - my); cyy += (q.y - my) ** 2; }
    const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy), ca = Math.cos(th), sa = Math.sin(th);
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    for (const q of st) { const u = q.x * ca + q.y * sa, v = -q.x * sa + q.y * ca; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    Ls.push(u1 - u0); Ws.push(v1 - v0); As.push(Math.abs(st.reduce((t, q, i) => t + (q.x * st[(i + 1) % st.length].y - st[(i + 1) % st.length].x * q.y), 0)) / 2);
  }
  const pc = (a: number[], p: number) => { const b = [...a].sort((x, y) => x - y); return Math.round(b[Math.floor(b.length * p)] ?? 0); };
  { const idx = Ls.map((_, i) => i).sort((a, b) => Ls[a] - Ls[b]); const tot = As.reduce((a, b) => a + b, 0); let acc = 0; const q: number[] = []; for (const i of idx) { acc += As[i]; for (const t of [0.1, 0.5, 0.9]) if (q.length < [0.1, 0.5, 0.9].indexOf(t) + 1 && acc >= t * tot) q.push(Math.round(Ls[i])); } console.log('area-weighted L p10/50/90', q.join(' ')); }
  console.log('strip L p10/50/90', pc(Ls, 0.1), pc(Ls, 0.5), pc(Ls, 0.9), 'W', pc(Ws, 0.1), pc(Ws, 0.5), pc(Ws, 0.9), 'n', Ls.length);
}
{
  const Lf: number[] = [], Af: number[] = [];
  for (const a of w.landuse?.areas ?? []) {
    if (a.kind !== 'field' || !a.strips) continue;
    const ca = Math.cos(a.stripAngle!), sa = Math.sin(a.stripAngle!);
    let u0 = 1e9, u1 = -1e9;
    for (const q of a.poly) { const u = q.x * ca + q.y * sa; u0 = Math.min(u0, u); u1 = Math.max(u1, u); }
    Lf.push(u1 - u0);
    let ar = 0; for (let i = 0; i < a.poly.length; i++) { const p = a.poly[i], q = a.poly[(i + 1) % a.poly.length]; ar += p.x * q.y - q.x * p.y; }
    Af.push(Math.abs(ar) / 2e4);
  }
  const pc = (a: number[], p: number) => { const b = [...a].sort((x, y) => x - y); return Math.round((b[Math.floor(b.length * p)] ?? 0) * 10) / 10; };
  console.log('furlong L p10/50/90', pc(Lf, 0.1), pc(Lf, 0.5), pc(Lf, 0.9), 'area ha', pc(Af, 0.1), pc(Af, 0.5), pc(Af, 0.9));
}
