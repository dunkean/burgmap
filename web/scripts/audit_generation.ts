/** Reproducible generation audit. Run from web with: npx tsx scripts/audit_generation.ts */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Session } from 'node:inspector';
import { serialize } from 'node:v8';
import { cpus, totalmem, release } from 'node:os';
import { generate, generateSettlementDetail } from '../src/gen/pipeline';
import { fromQuery } from '../src/gen/options';
import { megaQuarterDetail } from '../src/gen/urban/mega/detail';
import { buildScene } from '../src/render/scene';
import type { World } from '../src/gen/types';

export const cases = [
  { id: 'environment-flat', query: 'seed=1&size=town&mode=e&map=10000&relief=flat&biome=desert' },
  { id: 'environment-valley', query: 'seed=1&size=town&mode=e&map=10000&relief=valley&biome=forest' },
  { id: 'environment-mountains', query: 'seed=1&size=town&mode=e&map=40000&relief=mountains' },
  { id: 'hamlet', query: 'seed=4&size=hamlet' },
  { id: 'village', query: 'seed=4&size=village' },
  { id: 'town', query: 'seed=4&size=town' },
  { id: 'city', query: 'seed=4&size=city' },
  { id: 'valley-city20k', query: 'seed=1&size=city&relief=valley&population=20000' },
  { id: 'open20k-10km', query: 'seed=1&size=city&mode=a&map=10000&relief=valley&biome=forest&population=20000&walls=none&seaLevel=0' },
  { id: 'region-p4uefz', query: 'seed=p4uefz&size=city&map=10000' },
  { id: 'region-40km', query: 'seed=1&size=town&map=40000&population=5000' },
  { id: 'medina', query: 'seed=4&size=town&culture=medina' },
  { id: 'persian', query: 'seed=4&size=town&culture=persian' },
  { id: 'russian', query: 'seed=42&size=town&population=6000&culture=russian-kremlin&walls=single' },
  { id: 'capital', query: 'seed=4&size=capital' },
  { id: 'capital60k', query: 'seed=1&size=capital&population=60000' },
  { id: 'mega5m', query: 'seed=3&size=city&population=5000000&settl=none' },
  { id: 'region-lazy', query: 'seed=p4uefz&size=city&map=10000', lazy: true },
];
const profileCases = new Set(['environment-valley', 'city', 'open20k-10km', 'region-40km', 'persian', 'russian', 'capital60k', 'mega5m', 'region-lazy']);
const args = process.argv.slice(2);
const arg = (key: string, fallback: string): string => {
  const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1];
};
const out = resolve(arg('--out', 'out/optimization-audit-2026-10-05'));
mkdirSync(out, { recursive: true });

interface CpuNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
interface CpuProfile { nodes: CpuNode[]; samples?: number[]; timeDeltas?: number[]; startTime: number; endTime: number }
async function profiled<T>(name: string, enabled: boolean, run: () => T): Promise<{ value: T; ms: number }> {
  if (!enabled) { const t = performance.now(); const value = run(); return { value, ms: performance.now() - t }; }
  const session = new Session(); session.connect();
  const post = (method: string, params = {}): Promise<any> => new Promise((ok, fail) => {
    session.post(method as any, params, (error, result) => error ? fail(error) : ok(result));
  });
  try {
    await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 1000 }); await post('Profiler.start');
    const t = performance.now(); const value = run(); const ms = performance.now() - t;
    const { profile } = await post('Profiler.stop') as { profile: CpuProfile };
    writeFileSync(resolve(out, name + '.cpuprofile'), JSON.stringify(profile));
    writeFileSync(resolve(out, name + '.cpu.json'), JSON.stringify(summarizeCpu(profile), null, 2));
    return { value, ms };
  } finally { session.disconnect(); }
}

function summarizeCpu(p: CpuProfile): unknown {
  const nodes = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of p.nodes) for (const ch of n.children ?? []) parent.set(ch, n.id);
  const funcs = new Map<string, { fn: string; url: string; selfUs: number; inclusiveUs: number }>();
  const files = new Map<string, number>();
  let sampledUs = 0;
  for (let i = 0; i < (p.samples?.length ?? 0); i++) {
    const us = p.timeDeltas?.[i] ?? 1000; sampledUs += us;
    let id: number | undefined = p.samples![i];
    const visited = new Set<string>(); let leaf = true;
    while (id !== undefined) {
      const n = nodes.get(id); if (!n) break;
      const fn = n.callFrame.functionName || '(anonymous)';
      const url = n.callFrame.url.replaceAll('\\', '/').replace(/^.*\/web\//, 'web/');
      const key = url + ':' + fn;
      if (!visited.has(key)) {
        const row = funcs.get(key) ?? { fn, url, selfUs: 0, inclusiveUs: 0 };
        row.inclusiveUs += us;
        if (leaf) { row.selfUs += us; files.set(url || fn, (files.get(url || fn) ?? 0) + us); }
        funcs.set(key, row); visited.add(key);
      }
      leaf = false; id = parent.get(id);
    }
  }
  const rows = [...funcs.values()].map((r) => ({ fn: r.fn, url: r.url, selfMs: r.selfUs / 1000,
    inclusiveMs: r.inclusiveUs / 1000, selfPct: 100 * r.selfUs / sampledUs, inclusivePct: 100 * r.inclusiveUs / sampledUs }));
  return { intervalUs: 1000, samples: p.samples?.length ?? 0, sampledMs: sampledUs / 1000,
    profileMs: (p.endTime - p.startTime) / 1000,
    filesSelf: [...files].map(([url, us]) => ({ url, ms: us / 1000, pct: us / sampledUs * 100 })).sort((a, b) => b.ms - a.ms),
    functionsSelf: [...rows].sort((a, b) => b.selfMs - a.selfMs),
    functionsInclusive: [...rows].sort((a, b) => b.inclusiveMs - a.inclusiveMs) };
}

function worldHash(world: World): string {
  // Remove all timing dictionaries, including nested per-settlement urban.stats.
  const withoutStats = (value: unknown): unknown => {
    if (ArrayBuffer.isView(value) || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(withoutStats);
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'stats').map(([k, v]) => [k, withoutStats(v)]));
  };
  const canonical = JSON.stringify(withoutStats(world), (_key, value) => {
    if (ArrayBuffer.isView(value)) return { type: value.constructor.name,
      bytes: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
    if (typeof value === 'number' && !Number.isFinite(value)) return { number: String(value) };
    if (Object.is(value, -0)) return { number: '-0' };
    return value;
  });
  return createHash('sha256').update(canonical).digest('hex');
}
function timed<T>(run: () => T): { value: T; ms: number } {
  const t = performance.now(); const value = run(); return { value, ms: performance.now() - t };
}

async function sample(): Promise<void> {
  const c = cases.find((x) => x.id === arg('--case', 'town')); if (!c) throw new Error('Unknown case');
  const tag = arg('--tag', '1'), cpu = args.includes('--cpu');
  const options = fromQuery(c.query);
  const requestedCulture = new URLSearchParams(c.query).get('culture');
  if (requestedCulture && options.culture !== requestedCulture) throw new Error(`Culture did not resolve: ${requestedCulture}`);
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const sourceTree = execFileSync('git', ['rev-parse', 'HEAD:web/src'], { encoding: 'utf8' }).trim();
  const before = process.memoryUsage();
  console.log(`START ${c.id} ${tag}`);
  const result = await profiled(c.id + '-generate', cpu, () => generate(options, (stage) => console.log(`STAGE ${c.id} ${stage}`), { lazy: c.lazy }));
  const world = result.value;
  const after = process.memoryUsage(); const resources = process.resourceUsage();
  const data: Record<string, unknown> = { case: c.id, query: c.query, options, sourceRevision, sourceTree, lazyOverride: c.lazy ?? null,
    tag, profiled: cpu, generateMs: result.ms, stats: world.stats, mapSize: world.mapSize,
    buildings: world.urban?.buildings.length ?? 0, macroQuarters: world.urban?.macro?.quarters.length ?? 0,
    settlements: world.settlements?.length ?? 0, memoryBefore: before, memoryAfter: after,
    maxRssKiB: resources.maxRSS, cpuUserUs: resources.userCPUTime, cpuSystemUs: resources.systemCPUTime,
    hash: worldHash(world), hashEncoding: 'canonical-json-typedarray-bytes-v1' };
  if (args.includes('--save-world')) writeFileSync(resolve(out, `${c.id}-${tag}.bin`), serialize(world));
  const detailRows: Record<string, unknown>[] = [];
  await profiled(c.id + '-secondaries', cpu && c.id === 'region-lazy', () => {
    for (const s of world.settlements ?? []) {
      if (s.main || s.detail !== 'lazy') continue;
      const d = timed(() => generateSettlementDetail(world, s.index));
      detailRows.push({ index: s.index, culture: s.culture, population: s.population, ms: d.ms, buildings: d.value?.urban.buildings.length ?? 0 });
    }
  });
  data.secondaryDetails = detailRows;
  const macro = world.urban?.macro;
  if (macro) {
    const near = [...macro.quarters].sort((a, b) => {
      const distance = (q: typeof a) => Math.hypot((q.bb[0] + q.bb[2]) / 2 - macro.center.x, (q.bb[1] + q.bb[3]) / 2 - macro.center.y);
      return distance(a) - distance(b) || a.id - b.id;
    });
    const ids: number[] = [];
    for (const district of ['old-town', 'market', 'town', 'suburb', 'village']) {
      const q = near.find((q) => q.district === district && q.kind === 'quarter'); if (q) ids.push(q.id);
    }
    const largest = [...macro.quarters].filter((q) => q.kind === 'quarter').sort((a, b) => b.area - a.area || a.id - b.id)[0];
    if (largest && !ids.includes(largest.id)) ids.push(largest.id);
    if (c.id === 'capital60k') ids.splice(0, ids.length, ...macro.quarters.map((q) => q.id));
    const qRows: Record<string, unknown>[] = [];
    await profiled(c.id + '-quarters', cpu && (c.id === 'mega5m' || c.id === 'capital60k'), () => {
      for (const id of ids) {
        const d = timed(() => megaQuarterDetail(world, id)); const q = macro.quarters[id];
        qRows.push({ id, district: q.district, kind: q.kind, area: q.area, population: q.pop,
          ms: d.ms, buildings: d.value?.buildings.length ?? 0, parcels: d.value?.parcels.length ?? 0 });
      }
    });
    data.quarterDetails = qRows;
  }
  // Side costs are measured separately, on the initial World without added lazy detail.
  data.cloneMs = timed(() => structuredClone(world)).ms;
  data.sceneColdMs = timed(() => buildScene(world)).ms;
  data.sceneWarmMs = timed(() => buildScene(world)).ms;
  const bytes = timed(() => serialize(world)); data.serializeMs = bytes.ms; data.serializedBytes = bytes.value.length;
  writeFileSync(resolve(out, `${c.id}-${tag}.json`), JSON.stringify(data, null, 2) + '\n');
  console.log(`DONE ${c.id} ${tag} ${(result.ms / 1000).toFixed(3)}s`);
}

function batch(): void {
  const selected = arg('--case', 'all').split(',');
  const repetitions = Number(arg('--samples', '3'));
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('Samples must be a positive integer');
  for (const c of cases) {
    const culture = new URLSearchParams(c.query).get('culture');
    if (culture && fromQuery(c.query).culture !== culture) throw new Error(`Culture did not resolve: ${culture}`);
  }
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  writeFileSync(resolve(out, 'machine.json'), JSON.stringify({ date: new Date().toISOString(), revision, dirty,
    node: process.version, platform: process.platform, os: release(), cpu: cpus()[0].model, logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(), execArgv: process.execArgv, repetitions }, null, 2));
  for (const c of cases.filter((c) => selected.includes('all') || selected.includes(c.id))) {
    for (const tag of [...Array.from({ length: repetitions }, (_, i) => String(i + 1)), ...(profileCases.has(c.id) && !args.includes('--no-profiles') ? ['cpu'] : [])]) {
      const name = resolve(out, `${c.id}-${tag}.json`);
      if (args.includes('--resume') && existsSync(name)) {
        const previous = JSON.parse(readFileSync(name, 'utf8'));
        if (previous.query !== c.query) throw new Error(`Cached query changed: ${c.id}; use a new output directory`);
        console.log(`SKIP ${c.id} ${tag}`); continue;
      }
      const child = spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/audit_generation.ts'), '--sample',
        '--case', c.id, '--tag', tag, '--out', out, ...(tag === 'cpu' ? ['--cpu'] : []),
        ...(args.includes('--save-world') ? ['--save-world'] : [])], { stdio: 'inherit' });
      if (child.status !== 0) throw new Error(`Failed ${c.id} ${tag}: ${child.error ?? child.status}`);
    }
  }
  const results = cases.flatMap((c) => Array.from({ length: repetitions }, (_, i) => resolve(out, `${c.id}-${i + 1}.json`)))
    .filter(existsSync).map((name) => JSON.parse(readFileSync(name, 'utf8')));
  writeFileSync(resolve(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
}

if (args.includes('--sample')) await sample(); else batch();
