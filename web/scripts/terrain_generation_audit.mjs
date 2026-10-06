import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
await page.route('**/generation-empty', route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
try {
  await page.goto('http://localhost:5173/generation-empty');
  const result = await page.evaluate(async root => {
    const prefix = '/@fs/' + root.replaceAll('\\', '/');
    const { sampleRustTerrain } = await import(prefix + '/rust/bridge/terrain.ts');
    const results = [];
    const references = new Map();
    for (const relief of ['mountains', 'hills', 'valley']) {
      for (const generationCompute of ['cpu', 'gpu', 'gpu-all']) {
        const readings = [];
        for (let repeat = 0; repeat < 4; repeat++) {
          const settings = { seed: '42-' + repeat, width: 3000, motifSize: 3000, relief, erosion: .5, mountainMix: .5, resolution: 768, compute: 'gpu-f32', generationCompute };
          const data = await sampleRustTerrain({ settings, region: { x: 0, y: 0, extent: 3000, resolution: 768 }, id: 1, generation: 1, kind: 'overview' });
          if (data.backend !== 'gpu-f32') throw new Error(data.backendReason);
          if (generationCompute !== 'cpu' && !data.generationBackend?.startsWith('gpu-noise')) throw new Error(data.generationReason ?? 'Generation GPU inactive');
          let difference;
          if (generationCompute === 'cpu') references.set(relief + repeat, data);
          else {
            const ref = references.get(relief + repeat);
            let max = 0, square = 0, normalMax = 0;
            for (let i = 0; i < data.height.length; i++) {
              const delta = Math.abs(ref.height[i] - data.height[i]); max = Math.max(max, delta); square += delta * delta;
              for (const key of ['normalX', 'normalY', 'normalZ']) normalMax = Math.max(normalMax, Math.abs(ref[key][i] - data[key][i]));
            }
            difference = { heightMax: max, heightRms: Math.sqrt(square / data.height.length), normalMax };
          }
          const digest = async array => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', array))).map(x => x.toString(16).padStart(2, '0')).join('');
          readings.push({ prepareMs: data.prepareMs, noiseMs: data.noiseMs, erosionMs: data.erosionMs, generationBackend: data.generationBackend, generationReason: data.generationReason, samplingMs: data.samplingMs, totalMs: data.generationMs, hash: await digest(data.height), min: data.minHeight, max: data.maxHeight, difference });
        }
        results.push({ relief, generationCompute, readings });
      }
    }
    return results;
  }, root);
  await writeFile(root + '/rust/out/perf-audit/generation-' + (process.argv[2] ?? 'current') + '.json', JSON.stringify(result, null, 2));
  for (const row of result) console.log(JSON.stringify(row));
} finally { await browser.close(); }
