// One-off data/timing diagnostic; visual validation belongs to the user.
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.route('**/erosion-empty', route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
try {
  await page.goto('http://localhost:5173/erosion-empty');
  await page.evaluate(async root => {
    const prefix = '/@fs/' + root.replaceAll('\\', '/');
    const { sampleRustTerrain } = await import(prefix + '/rust/bridge/terrain.ts');
    window.measure = async settings => {
      const rows = []; let ref;
      for (const generationCompute of ['cpu', 'gpu-erosion']) {
        const terrain = await sampleRustTerrain({ id: 1, generation: 1, kind: 'overview', settings: { ...settings, generationCompute, compute: 'gpu-f32', resolution: 768 }, region: { x: 0, y: 0, extent: settings.width, resolution: 768 } });
        if (generationCompute === 'cpu') ref = terrain;
        else if (terrain.generationBackend !== 'gpu-erosion-f32') throw new Error(terrain.generationReason ?? 'GPU erosion did not run');
        let max = 0, square = 0, normalMax = 0;
        for (let i = 0; i < terrain.height.length; i++) {
          if (!Number.isFinite(terrain.height[i])) throw new Error('Nonfinite height');
          const delta = terrain.height[i] - ref.height[i]; max = Math.max(max, Math.abs(delta)); square += delta * delta;
          for (const key of ['normalX', 'normalY', 'normalZ']) {
            if (!Number.isFinite(terrain[key][i])) throw new Error('Nonfinite normal');
            normalMax = Math.max(normalMax, Math.abs(terrain[key][i] - ref[key][i]));
          }
        }
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', terrain.height))).map(x => x.toString(16).padStart(2, '0')).join('');
        rows.push({ requested: generationCompute, backend: terrain.generationBackend, reason: terrain.generationReason, prepareMs: terrain.prepareMs, gpuMs: terrain.gpuSimulationMs, samplingMs: terrain.samplingMs, min: terrain.minHeight, max: terrain.maxHeight, heightMax: max, heightRms: Math.sqrt(square / terrain.height.length), normalMax, hash });
      }
      return { settings, rows };
    };
  }, root);
  const results = [];
  const cases = process.argv[2] === 'lines' ? [
    { relief: 'hills', width: 5000, seed: 'lp13l2', erosion: .62 },
    { relief: 'mountains', width: 12000, seed: '42', erosion: .5 },
    { relief: 'mountains', width: 30000, seed: '42', erosion: .5 },
  ] : process.argv[2] === 'boundary' ? [
    { relief: 'hills', width: 3000, seed: '42', erosion: 0 },
    { relief: 'mountains', width: 3000, seed: '42', erosion: 1 },
    { relief: 'mountains', width: 12000, seed: '1a72a9n', erosion: .5 },
    { relief: 'mixed', width: 3000, seed: '42', erosion: .5, mountainMix: .75 },
    { relief: 'high-mountains', width: 3000, seed: '42', erosion: .5 },
  ] : ['mountains', 'hills', 'valley'].flatMap(relief => ['42', '42-1', '42-2'].map(seed => ({ relief, seed, width: 3000, erosion: .5 })));
  for (const value of cases) {
    const result = await page.evaluate(settings => window.measure(settings), { motifSize: 3000, mountainMix: .5, ...value });
    results.push(result); console.log(JSON.stringify(result));
    await writeFile(root + '/rust/out/perf-audit/erosion-gpu-' + (process.argv[2] ?? 'current') + '.json', JSON.stringify({ errors, results }, null, 2));
  }
  if (errors.length) throw new Error(JSON.stringify(errors));
} finally { await browser.close(); }
