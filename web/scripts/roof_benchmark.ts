/** Fresh-process A/B on identical saved inputs. --source points to the web directory under test. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { deserialize } from 'node:v8';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const arg = (name: string, fallback = '') => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const source = resolve(arg('--source', '.'));
const sourceFiles = ['src/gen/geo/bool.ts', 'src/gen/urban/edgeRoofs.ts', 'src/gen/urban/roofProof.ts', 'src/gen/urban/roofSearch.ts'];
const sourceHashes = Object.fromEntries(sourceFiles.map((file) => {
  const path = resolve(source, file);
  return [file, existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null];
}));
const { generate } = await import(pathToFileURL(resolve(source, 'src/gen/pipeline.ts')).href);
const { fromQuery } = await import(pathToFileURL(resolve(source, 'src/gen/options.ts')).href);
const { megaQuarterDetail } = await import(pathToFileURL(resolve(source, 'src/gen/urban/mega/detail.ts')).href);

function canonical(value: any): any {
  if (ArrayBuffer.isView(value)) return { type: value.constructor.name,
    bytes: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'stats').map(([key, item]) => [key, canonical(item)]));
  if (typeof value === 'number' && !Number.isFinite(value)) return { number: String(value) };
  if (Object.is(value, -0)) return { number: '-0' };
  return value;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const results: any[] = [];
if (arg('--world')) {
  const worldFile = resolve(arg('--world'));
  const arrays: Record<string, { new (data: number[]): ArrayBufferView }> = {
    Float32Array, Float64Array, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array,
  };
  const world = worldFile.endsWith('.json') ? JSON.parse(readFileSync(worldFile, 'utf8'), (_key, value) => {
    if (value?.__typed) {
      const constructor = arrays[value.__typed];
      if (!constructor || !Array.isArray(value.data)) throw new Error(`Unsupported typed fixture: ${value.__typed}`);
      return new constructor(value.data);
    }
    return value;
  }) : deserialize(readFileSync(worldFile));
  const ids = arg('--ids', '58,75').split(',').map(Number);
  for (const id of ids) {
    const started = performance.now(), layer = megaQuarterDetail(world, id), ms = performance.now() - started;
    results.push({ id, ms, buildings: layer?.buildings.length, hash: hash(layer) });
    process.stdout.write(`quarter ${id}: ${ms.toFixed(1)} ms\n`);
  }
} else {
  const query = arg('--query', 'seed=4&size=city'), started = performance.now();
  const world = generate(fromQuery(query)), ms = performance.now() - started;
  results.push({ query, ms, buildings: world.urban?.buildings.length, hash: hash(world) });
  process.stdout.write(`generation: ${ms.toFixed(1)} ms\n`);
}
const report = { source, sourceHashes, results };
if (arg('--out')) writeFileSync(resolve(arg('--out')), JSON.stringify(report, null, 2) + '\n');
else process.stdout.write(JSON.stringify(report, null, 2) + '\n');
