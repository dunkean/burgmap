import { generateTerrain } from '../src/gen/terrain/hydrology';
import { makeOptions } from '../src/gen/options';
import { Rng } from '../src/gen/core/rng';
const reliefs = ['flat', 'hills', 'valley', 'mountains'] as const;
const rv = process.argv[2] ?? 'river';
const S0 = Number(process.argv[3] ?? 6);
for (let s = 1; s <= S0; s++) for (const relief of reliefs) for (const coast of ['none', 'random']) {
  const o = makeOptions({ seed: String(s), relief, coast: coast as never, river: rv as never, size: 'town' });
  const { terrain: t } = generateTerrain(o, new Rng('burgmap:' + o.seed));
  const lines = t.rivers.map((r) => {
    let len = 0; for (let k = 1; k < r.path.length; k++) len += Math.hypot(r.path[k].x - r.path[k - 1].x, r.path[k].y - r.path[k - 1].y);
    return `${r.id}${r.main ? 'M' : ''}:${r.cls?.[0]}${r.source?.[0]}>${r.mouth?.[0]}${r.host ?? ''} L${Math.round(len)} w${r.width[0].toFixed(1)}-${r.width[r.width.length - 1].toFixed(1)}`;
  });
  console.log(`${s} ${relief} ${coast} lakes${t.lakes.length}: ${lines.join(' | ')}`);
}
