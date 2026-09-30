import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';
import { mixFromString } from '../src/gen/urban/culture';
import { differenceS, mpArea } from '../src/gen/geo/bool';
import { polyInside } from '../src/gen/geo/split';

const [cu, mix] = (process.argv[2] ?? 'medina+european-organic:0.5:blend').split('+');
const w = generate(makeOptions({ seed: process.argv[3] ?? '2', size: (process.argv[4] ?? 'city') as SizeName, culture: cu, cultureMix: mix ? mixFromString(mix) : null }));
const u = w.urban!;
for (const b of u.buildings) {
  if (b.parcel === undefined) continue;
  const P = u.parcels[b.parcel].poly;
  if (polyInside(P, b.poly)) continue;
  const out = mpArea(differenceS(b.poly, P));
  if (out > 0.05) console.log(JSON.stringify({ b: b.poly, P }));
  if (out > 0.05) console.log('building', b.kind, b.arch, 'out', out.toFixed(3), 'parcel use', u.parcels[b.parcel].use, 'nverts', b.poly.length, 'parcel verts', P.length, 'morph', u.blockInfo[u.parcels[b.parcel].block].morphology);
}
