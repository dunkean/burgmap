/** Run in web/: npx tsx scripts/geometry_audit.ts [query-string ...] */
import { generate } from '../src/gen/pipeline';
import { fromQuery } from '../src/gen/options';
import { auditUrban } from '../src/gen/urban/geometryAudit';
import { finalizeFootprints } from '../src/gen/urban/footprintFinal';
import { minNeck } from '../src/gen/geo/poly';

const finalize = process.argv.includes('--finalize');
const fixtures = process.argv.slice(2).filter((a) => a !== '--finalize');
if (!fixtures.length) fixtures.push(
  'seed=4&size=town&culture=wizard',
  'seed=42&size=town&relief=hills&walls=none&settlements=none',
  'seed=4&size=town&culture=medina&walls=none',
  'seed=4&size=town&culture=persian',
);
for (const query of fixtures) {
  const world = generate(fromQuery(new URLSearchParams(query)));
  const final = finalize && world.urban ? finalizeFootprints({ buildings: world.urban.buildings, parcels: world.urban.parcels, backLand: [] }) : undefined;
  const audit = auditUrban(world);
  const byKind = Object.fromEntries(['building', 'parcel', 'block', 'quarter'].map((kind) => {
    const rows = audit.overlaps.filter((x) => x.kind === kind);
    return [kind, { pairs: rows.length, seams: rows.filter((x) => x.thickness <= 0.02).length,
      beyond5cm: rows.filter((x) => x.thickness > 0.05).length,
      failed: rows.filter((x) => x.failed).length,
      largest: rows.filter((x) => !x.failed).sort((a, b) => b.thickness - a.thickness).slice(0, 8) }];
  }));
  console.log(JSON.stringify({ query, counts: audit.counts, final: final ? { changedBlocks: final.changed.size, invalid: final.invalid.length,
    cleaned: final.cleaned, releasedArea: final.releasedArea,
    invalidExamples: final.invalid.slice(0, 25).map((i) => { const b = world.urban!.buildings[i]; return { i, kind: b.kind,
      arch: b.arch, neck: minNeck(b.poly)?.w, area: b.poly.length >= 3 ? Math.abs(b.poly.reduce((s, p, k) => { const q = b.poly[(k + 1) % b.poly.length]; return s + p.x * q.y - p.y * q.x; }, 0)) / 2 : 0, vertices: b.poly.length }; }) } : undefined,
    malformed: audit.malformed.slice(0, 30), malformedCount: audit.malformed.length,
    failed: audit.failed, byKind }, null, 2));
}
