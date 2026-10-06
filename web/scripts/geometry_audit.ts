/** Run in web/: npx tsx scripts/geometry_audit.ts [query-string ...] */
import { generate } from '../src/gen/pipeline';
import { fromQuery } from '../src/gen/options';
import { auditUrban } from '../src/gen/urban/geometryAudit';
import { finalizeFootprints } from '../src/gen/urban/footprintFinal';
import { area, distToRing, minNeck, pointInRing } from '../src/gen/geo/poly';
import { lpoly, polyInside, splitByChord } from '../src/gen/geo/split';

const finalize = process.argv.includes('--finalize');
const fixtures = process.argv.slice(2).filter((a) => a !== '--finalize');
if (!fixtures.length) fixtures.push(
  'seed=4&size=town&culture=wizard-city&walls=none&settl=none&labels=0',
  'seed=42&size=town&relief=hills&walls=none&settl=none',
  'seed=4&size=town&culture=medina&walls=none',
  'seed=4&size=town&culture=persian',
);
for (const query of fixtures) {
  const params = new URLSearchParams(query.startsWith('http') ? new URL(query).search : query);
  const world = generate(fromQuery(params));
  const pins = (params.get('pins') ?? '').split(';').filter(Boolean).map((s) => s.split(',').map(Number));
  const final = finalize && world.urban ? finalizeFootprints({ buildings: world.urban.buildings, parcels: world.urban.parcels, backLand: [] }) : undefined;
  const pinAudit = pins.map(([x, y]) => ({ pin: [x, y], nearby: (world.urban?.buildings ?? []).map((b, i) => ({ i, b,
    d: pointInRing(b.poly, { x, y }) ? 0 : distToRing(b.poly, { x, y }) })).sort((a, b) => a.d - b.d).slice(0, 4)
    .map(({ i, b, d }) => ({ i, d, kind: b.kind, arch: b.arch, parcel: b.parcel, area: area(b.poly), neck: minNeck(b.poly)?.w,
      poly: b.poly })) }));
  const audit = auditUrban(world);
  const byKind = Object.fromEntries(['building', 'parcel', 'block', 'quarter'].map((kind) => {
    const rows = audit.overlaps.filter((x) => x.kind === kind);
    return [kind, { pairs: rows.length, seams: rows.filter((x) => x.thickness <= 0.02).length,
      beyond5cm: rows.filter((x) => x.thickness > 0.05).length,
      failed: rows.filter((x) => x.failed).length,
      largest: rows.filter((x) => !x.failed).sort((a, b) => b.thickness - a.thickness).slice(0, 8) }];
  }));
  console.log(JSON.stringify({ query, counts: audit.counts, pinAudit: pins.length ? pinAudit : undefined,
    final: final ? { changedBlocks: final.changed.size, invalid: final.invalid.length,
    cleaned: final.cleaned, releasedArea: final.releasedArea,
    invalidExamples: final.invalid.slice(0, 25).map((i) => { const b = world.urban!.buildings[i]; return { i, kind: b.kind,
      arch: b.arch, neck: minNeck(b.poly)?.w, cut: (() => { const n = minNeck(b.poly); const c = n && splitByChord(lpoly(b.poly, 0), [n.a, n.b], 0, 0.02);
        return c?.map((p) => ({ area: area(p.pts), nextNeck: minNeck(p.pts)?.w,
          contained: b.parcel === undefined ? null : polyInside(world.urban!.parcels[b.parcel].poly, p.pts) })) ?? null; })(),
      area: b.poly.length >= 3 ? Math.abs(b.poly.reduce((s, p, k) => { const q = b.poly[(k + 1) % b.poly.length]; return s + p.x * q.y - p.y * q.x; }, 0)) / 2 : 0, vertices: b.poly.length }; }) } : undefined,
    malformed: audit.malformed.slice(0, 30), malformedCount: audit.malformed.length,
    failed: audit.failed, byKind }, null, 2));
}
