/** Inspect unresolved native footprint failures from a quality JSON report. */
import { readFileSync } from 'node:fs';
import type { Polygon } from '../src/gen/core/geom';
import { area, minNeck } from '../src/gen/geo/poly';
import { lpoly, polyInside, splitByChord } from '../src/gen/geo/split';

const path = process.argv[2];
if (!path) throw new Error('usage: npx tsx scripts/diagnose_invalid.ts <quality.json>');
const d = JSON.parse(readFileSync(path, 'utf8')) as {
  failures: { i: number; poly: Polygon; area: number; block: number; kind: string; neck?: number }[];
  urban: { buildings: { parcel?: number }[]; parcels: { poly: Polygon }[] };
};
for (const f of d.failures) {
  const n = minNeck(f.poly);
  const parts = n && splitByChord(lpoly(f.poly, 0), [n.a, n.b], 0, 0.02)?.map((p) => p.pts);
  const owner = d.urban.buildings[f.i]?.parcel;
  console.log(JSON.stringify({ i: f.i, block: f.block, kind: f.kind, neck: n?.w, area: f.area,
    chord: n && !parts ? [n.a, n.b] : undefined,
    parts: parts?.map((p) => ({ area: area(p), next: minNeck(p)?.w,
      inside: owner === undefined ? null : polyInside(d.urban.parcels[owner].poly, p) })) ?? null }));
}
