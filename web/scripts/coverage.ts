/** Coverage survey: npx tsx scripts/coverage.ts [culture] */
import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';
import { coverage } from '../tests/coverage';

const culture = process.argv[2] ?? 'european-organic';
for (const size of ['town', 'city'] as SizeName[]) for (const seed of ['1', '2', '3', '4', '5', '6']) {
  const w = generate(makeOptions({ seed, size, culture: culture as never }));
  const r = coverage(w);
  const ph = [...r.byPhase.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `p${k}(${v.zone[0]}):${((100 * v.built) / v.area).toFixed(0)}% r${((100 * v.rect) / Math.max(1, v.n)).toFixed(0)}`).join(' ');
  console.log(size, seed, ph, `| faub near ${(100 * r.faubNear).toFixed(0)}% far ${(100 * r.faubFar).toFixed(0)}% | minW ${r.minWidth.toFixed(1)} maxAsp ${r.maxAspect.toFixed(1)} narrow ${r.narrow} long ${r.long} / ${r.buildings} | ${w.stats['ms.urban']}ms`);
}
