import { readFileSync } from 'node:fs';
import { buildCompound } from '../src/gen/urban/compounds';
import { Rng } from '../src/gen/core/rng';

const kind = process.argv[2] ?? 'great-mosque';
const arg = process.argv[3];
const lot = arg ? JSON.parse(arg.startsWith('[') ? arg : readFileSync(arg, 'utf8')) : [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 64 }, { x: 0, y: 64 }];
const ang = Number(process.argv[4] ?? 0.2);
const out = buildCompound(kind, lot, { angle: ang, pop: 5000, rng: new Rng('x'), center: { x: 0, y: 0 } });
console.log(kind, 'parcels', out.parcels.map((p) => p.use), 'buildings', out.buildings.map((b) => b.arch), 'lines', out.lines.length);
