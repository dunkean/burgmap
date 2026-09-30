/** Streets coloured by role, phase regions outlined: npx tsx scripts/dbg_streets.ts culture seed size focus */
import { writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';

const [culture, seed, size, focusS] = process.argv.slice(2);
const w = generate(makeOptions({ seed, size: size as SizeName, culture }));
const u = w.urban!;
const c = w.site!.center, F = Number(focusS ?? 900);
const col: Record<string, string> = { radial: '#d00', ring: '#00c', street: '#080', lane: '#999', close: '#f80' };
let s = `<rect x="${c.x - F / 2}" y="${c.y - F / 2}" width="${F}" height="${F}" fill="#fff"/>`;
const d = (pl: { x: number; y: number }[], closed = false) => 'M' + pl.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L') + (closed ? 'Z' : '');
for (const ph of u.phases) for (const r of ph.region) s += `<path d="${d(r.outer, true)}" fill="none" stroke="#c0c" stroke-width="1" stroke-dasharray="6 4"/>`;
for (const b of u.blocks) s += `<path d="${d(b, true)}" fill="#eee" stroke="none"/>`;
for (const st of u.streets) s += `<path d="${d(st.path)}" fill="none" stroke="${col[st.role] ?? '#000'}" stroke-width="${Math.max(1, st.width)}" stroke-opacity="0.8"/>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${c.x - F / 2} ${c.y - F / 2} ${F} ${F}" width="1000" height="1000">${s}</svg>`;
writeFileSync('out/dbg_streets.png', new Resvg(svg).render().asPng());
