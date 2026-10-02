import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';
import { interiorAngle, area } from '../src/gen/geo/poly';

const w = generate(makeOptions({ seed: process.argv[2] ?? '6', size: (process.argv[3] ?? 'village') as SizeName, culture: process.argv[4] ?? 'european-organic' }));
const u = w.urban!;
const minA = (p: { x: number; y: number }[]) => { let m = 9; for (let i = 0; i < p.length; i++) m = Math.min(m, interiorAngle(p, i)); return (m * 180) / Math.PI; };
u.blocks.forEach((b, i) => { if (minA(b) < 12) console.log('block', i, minA(b).toFixed(1), area(b).toFixed(0), JSON.stringify(u.blockInfo[i]), JSON.stringify(b.map((q) => [Math.round(q.x), Math.round(q.y)]))); });
u.parcels.forEach((p, i) => { if (minA(p.poly) < 12) console.log('parcel', i, p.use, minA(p.poly).toFixed(1), area(p.poly).toFixed(0), 'block', p.block); });
