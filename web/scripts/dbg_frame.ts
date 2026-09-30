import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { inscribed, obb, area } from '../src/gen/geo/poly';

const lot = JSON.parse(readFileSync(process.argv[2], 'utf8')) as { x: number; y: number }[];
const ins = inscribed(lot, [], 1);
const ob = obb(lot);
console.log('area', area(lot).toFixed(0), 'ins', ins, 'obb', ob.hu.toFixed(1), ob.hv.toFixed(1), 'n', lot.length);
let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
for (const p of lot) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
const d = 'M' + lot.map((p) => `${p.x} ${p.y}`).join('L') + 'Z';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0 - 5} ${y0 - 5} ${x1 - x0 + 10} ${y1 - y0 + 10}" width="800" height="${Math.round((800 * (y1 - y0 + 10)) / (x1 - x0 + 10))}"><rect x="${x0 - 5}" y="${y0 - 5}" width="${x1 - x0 + 10}" height="${y1 - y0 + 10}" fill="white"/><path d="${d}" fill="#cde" stroke="#036" stroke-width="0.4"/><circle cx="${ins.c.x}" cy="${ins.c.y}" r="${ins.r}" fill="none" stroke="red" stroke-width="0.5"/></svg>`;
writeFileSync('out/dbg_frame.png', new Resvg(svg).render().asPng());
