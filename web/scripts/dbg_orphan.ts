import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';
import { StreetGraph } from '../src/gen/geo/graph';

const w = generate(makeOptions({ seed: process.argv[3] ?? '1', size: (process.argv[4] ?? 'town') as SizeName, culture: process.argv[2] ?? 'elven' }));
const ub = w.urban!;
const g = new StreetGraph();
ub.streets.forEach((s, i) => g.insertPolyline(s.path, { width: s.width, rank: s.rank, phase: s.phase, kind: 'street', street: i }, { snapR: 0.3, mergeDist: 0 }));
const { comp } = g.components();
const radialComp = new Set<number>();
for (const e of g.aliveEdges()) if (ub.streets[e.street].role === 'radial') radialComp.add(comp[e.a]);
const seen = new Set<number>();
for (const e of g.aliveEdges()) {
  const st = ub.streets[e.street];
  if (st.rank <= 2 && !radialComp.has(comp[e.a]) && !seen.has(e.street)) {
    seen.add(e.street);
    console.log('orphan street', e.street, st.role, 'rank', st.rank, 'phase', st.phase, 'len', st.path.length, st.path[0], st.path[st.path.length - 1]);
  }
}
