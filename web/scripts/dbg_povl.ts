import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';
import { mixFromString } from '../src/gen/urban/culture';
import { intersectionS, mpArea } from '../src/gen/geo/bool';
import { area, bboxOf } from '../src/gen/geo/poly';

const [cu, mix] = (process.argv[2] ?? 'medina+bastide:0.45:phases').split('+');
const w = generate(makeOptions({ seed: process.argv[3] ?? '3', size: (process.argv[4] ?? 'town') as SizeName, culture: cu, cultureMix: mix ? mixFromString(mix) : null }));
const u = w.urban!;
const P = u.parcels;
const bb = P.map((p) => bboxOf(p.poly));
for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
  const a = bb[i], b = bb[j];
  if (b.x0 > a.x1 || b.x1 < a.x0 || b.y0 > a.y1 || b.y1 < a.y0) continue;
  const o = mpArea(intersectionS(P[i].poly, P[j].poly));
  if (o > 0.05) console.log('parcels', i, j, P[i].use, P[j].use, 'blocks', P[i].block, P[j].block, 'overlap', o.toFixed(2), 'areas', area(P[i].poly).toFixed(0), area(P[j].poly).toFixed(0), JSON.stringify(u.blockInfo[P[i].block]), JSON.stringify(u.blockInfo[P[j].block]));
}
