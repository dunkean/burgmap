// Read-only browser measurements of staged Rust variants. No live source mutation.
// Usage: node scripts/terrain_perf_audit.mjs [current|matrix|experiments|compare|regional|cave|profile]
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = resolve(root, 'rust/out/perf-audit');
const mode = process.argv[2] ?? 'current';
const origin = process.env.TERRAIN_AUDIT_ORIGIN ?? 'http://127.0.0.1:5173';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
await page.route('**/perf-audit-assets/**', async route => {
  const relative = decodeURIComponent(new URL(route.request().url()).pathname).replace('/perf-audit-assets/', '');
  const path = resolve(out, relative);
  if (!path.startsWith(out + '\\') && !path.startsWith(out + '/')) throw new Error('Outside audit');
  await route.fulfill({ contentType: extname(path) === '.wasm' ? 'application/wasm' : 'text/javascript', body: await readFile(path) });
});
page.on('pageerror', e => errors.push(e.message));
page.on('console', msg => { if (msg.type() === 'error') console.error('browser', msg.text()); });
page.on('requestfailed', req => console.error('request', req.url(), req.failure()));
try {
  let results;
  if (mode === 'current') {
    await page.addInitScript(() => {
      window.audit = { events: [], requests: [] };
      const start = performance.now();
      const observer = new MutationObserver(() => {
        const status = document.getElementById('status')?.textContent;
        if (status && status !== window.audit.events.at(-1)?.status) window.audit.events.push({ ms: performance.now() - start, status });
      });
      observer.observe(document, { subtree: true, childList: true, characterData: true });
      const OriginalWorker = window.Worker;
      window.Worker = class extends OriginalWorker {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', e => {
            const r = window.audit.requests.find(r => r.id === e.data.id);
            if (r) { r.receivedMs = performance.now() - start; r.computeMs = e.data.terrain?.generationMs; }
          });
        }
        postMessage(msg, ...rest) {
          window.audit.requests.push({ id: msg.id, kind: msg.kind, region: msg.region, postedMs: performance.now() - start });
          return super.postMessage(msg, ...rest);
        }
      };
    });
    results = [];
    for (const relief of ['flat', 'mountains', 'valley', 'volcano', 'cavern']) {
      await page.goto(`${origin}/terrainbench.html?seed=42&width=3000&motif=3000&relief=${relief}&erosion=0.5&auto=0`);
      await page.waitForFunction(() => document.getElementById('status')?.textContent.includes('détail 768'), { timeout: 90000 });
      results.push({ relief, ...await page.evaluate(() => window.audit) });
      console.log(relief, results.at(-1).events.at(-1));
    }
  } else {
    await page.route('**/perf-audit-empty', route => route.fulfill({ contentType: 'text/html', body: '<html><body><svg id="auditSvg"></svg></body></html>' }));
    await page.goto(`${origin}/perf-audit-empty`);
    await page.evaluate(async root => {
      const prefix = '/@fs/' + root.replaceAll('\\', '/');
      window.auditModules = {
        render: await import(prefix + '/rust/bridge/terrainRender.ts'),
        raster: await import(prefix + '/web/src/render/raster.ts'),
        contour: await import(prefix + '/web/src/gen/terrain/contour.ts'),
        styles: await import(prefix + '/web/src/render/styles.ts'),
      };
      window.auditTransport = false;
      window.variants = {};
      window.loadVariant = async name => {
        if (window.variants[name]) return window.variants[name];
        const base = `/perf-audit-assets/${name}/pkg/`;
        const module = await import(base + 'burgmap_wasm.js');
        const start = performance.now();
        const bytes = await (await fetch(base + 'burgmap_wasm_bg.wasm')).arrayBuffer();
        await module.default({ module_or_path: bytes });
        window.variants[name] = module;
        console.log('init', name, performance.now() - start);
        return module;
      };
      window.benchCase = async (name, relief, seed = '42', erosion = 0.5, regions = [512, 768], render = true, width = 3000, motif = 3000) => {
        const module = await window.loadVariant(name);
        let start = performance.now();
        const engine = new module.TerrainEngine(seed, width, relief, erosion, motif, 0.5);
        const prepareMs = performance.now() - start;
        const samples = [];
        try {
          for (const spec of regions) {
            const region = typeof spec === 'number' ? { x: 0, y: 0, extent: width, resolution: spec } : spec;
            const { resolution } = region;
            start = performance.now();
            const result = engine.sample_region(region.x, region.y, region.extent, resolution);
            const sampleMs = performance.now() - start;
            start = performance.now();
            const data = {
              x: result.x, y: result.y, width: result.width, resolution: result.resolution,
              minHeight: result.min_height, maxHeight: result.max_height,
              globalMinHeight: engine.min_height, globalMaxHeight: engine.max_height, motifSize: motif,
              height: result.height, caveMask: result.cave_mask,
              normalX: result.normal_x, normalY: result.normal_y, normalZ: result.normal_z, generationMs: 0,
            };
            const gettersMs = performance.now() - start;
            window.lastTerrain = data;
            result.free();
            const hashes = {};
            for (const key of ['height', 'caveMask', 'normalX', 'normalY', 'normalZ']) {
              const hash = await crypto.subtle.digest('SHA-256', data[key]);
              hashes[key] = Array.from(new Uint8Array(hash), v => v.toString(16).padStart(2, '0')).join('');
            }
            const sample = { ...region, sampleMs, gettersMs, hashes, minHeight: data.minHeight, maxHeight: data.maxHeight, globalMaxHeight: data.globalMaxHeight };
            if (render) {
              start = performance.now();
              const scene = window.auditModules.render.renderRustTerrain(data, 'parchment', false);
              sample.renderMs = performance.now() - start;
              sample.sceneHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scene.svg))), v => v.toString(16).padStart(2, '0')).join('');
              // A second render isolates stages; this is a warmed breakdown.
              const { raster, contour, styles } = window.auditModules;
              const n = resolution, cell = data.width / n;
              const world = { mapSize: data.width, terrain: { height: { w: n, h: n, cell, data: data.height }, water: new Uint8Array(n * n) } };
              start = performance.now();
              const pixels = raster.renderTerrainPixels(world, { ...styles.PALETTES.parchment, hatch: 0, grain: 0 }, { pixels: n, surface: data.height, normals: { x: data.normalX, y: data.normalY, z: data.normalZ }, heightRange: { min: data.globalMinHeight, max: data.globalMaxHeight }, exaggeration: 2, grainCoordinates: { x: 0, y: 0, cell: motif / 512 } });
              sample.pixelsMs = performance.now() - start;
              start = performance.now();
              const png = raster.encodePng(pixels.rgb, n, n);
              sample.pngMs = performance.now() - start;
              start = performance.now();
              const url = raster.pngDataUrl(png);
              sample.base64Ms = performance.now() - start;
              sample.pngBytes = png.length;
              const raw = Math.max(1, (data.globalMaxHeight - data.globalMinHeight) / 24);
              const power = 10 ** Math.floor(Math.log10(raw));
              const step = [1, 2, 5, 10].find(v => v * power >= raw) * power;
              start = performance.now();
              let levels = 0, points = 0, pathsText = '';
              if (!data.caveMask.length) for (let h = Math.ceil(data.minHeight / step) * step; h < data.maxHeight; h += step) {
                const paths = contour.marchingSquares(data.height, n, n, h, cell, cell / 2, cell / 2);
                points += paths.reduce((a, p) => a + p.pts.length, 0); levels++;
                pathsText += paths.map(p => p.pts.map((v, i) => `${i ? 'L' : 'M'}${v.x.toFixed(2)},${v.y.toFixed(2)}`).join('') + (p.closed ? 'Z' : '')).join('');
              }
              sample.contoursMs = performance.now() - start;
              sample.levels = levels; sample.points = points;
              start = performance.now();
              document.getElementById('auditSvg').innerHTML = scene.svg;
              sample.domMs = performance.now() - start;
              start = performance.now();
              const image = new Image(); image.src = url; await image.decode();
              sample.decodeMs = performance.now() - start;
              if (window.auditTransport && !data.caveMask.length) {
                start = performance.now();
                const rgba = new Uint8ClampedArray(n * n * 4);
                for (let i = 0; i < n * n; i++) {
                  rgba[i * 4] = pixels.rgb[i * 3]; rgba[i * 4 + 1] = pixels.rgb[i * 3 + 1]; rgba[i * 4 + 2] = pixels.rgb[i * 3 + 2]; rgba[i * 4 + 3] = 255;
                }
                const canvas = new OffscreenCanvas(n, n), ctx = canvas.getContext('2d');
                ctx.putImageData(new ImageData(rgba, n, n), 0, 0);
                const blob = await canvas.convertToBlob({ type: 'image/png' });
                sample.nativePngMs = performance.now() - start;
                sample.nativePngBytes = blob.size;
                const decoded = await createImageBitmap(blob);
                ctx.clearRect(0, 0, n, n); ctx.drawImage(decoded, 0, 0); decoded.close();
                const actual = ctx.getImageData(0, 0, n, n).data;
                sample.nativePngIdentical = actual.every((v, i) => v === rgba[i]);
              }
            }
            samples.push(sample);
          }
        } finally { engine.free(); }
        return { name, relief, seed, erosion, width, motif, prepareMs, samples };
      };
    }, root);
    results = [];
    if (mode === 'matrix') {
      for (const name of ['baseline-dev', 'baseline', 'candidate', 'candidate-edges']) {
        for (const relief of ['flat', 'hills', 'mountains', 'mixed', 'valley', 'plateau', 'high-mountains', 'volcano', 'caldera', 'cavern', 'canyon']) {
          const result = await page.evaluate(({ name, relief }) => window.benchCase(name, relief), { name, relief });
          results.push(result);
          console.log(name, relief, Math.round(result.prepareMs), result.samples.map(s => [s.resolution, Math.round(s.sampleMs), Math.round(s.renderMs)]));
          await writeFile(resolve(out, 'matrix.partial.json'), JSON.stringify(results, null, 2));
        }
      }
    } else if (mode === 'experiments') {
      await page.evaluate(() => { window.auditTransport = true; });
      for (const name of ['candidate-lod', 'candidate-math']) {
        const reliefs = name === 'candidate-math' ? ['flat', 'plateau', 'volcano', 'caldera'] : ['flat', 'hills', 'mountains', 'mixed', 'valley', 'plateau', 'high-mountains', 'volcano', 'caldera', 'cavern', 'canyon'];
        for (const relief of reliefs) {
          const result = await page.evaluate(({ name, relief }) => window.benchCase(name, relief), { name, relief });
          results.push(result);
          console.log(name, relief, Math.round(result.prepareMs), result.samples.map(s => [s.resolution, Math.round(s.sampleMs), Math.round(s.renderMs), s.nativePngMs && Math.round(s.nativePngMs)]));
          await writeFile(resolve(out, 'experiments.partial.json'), JSON.stringify(results, null, 2));
        }
      }
    } else if (mode === 'compare') {
      for (const seed of ['42', '1', '1a72a9n']) for (const erosion of [0, 0.5, 1]) for (let repeat = 0; repeat < 3; repeat++) {
        for (const name of repeat % 2 ? ['candidate-lod', 'baseline'] : ['baseline', 'candidate-lod']) {
          results.push(await page.evaluate(({ name, seed, erosion }) => window.benchCase(name, 'flat', seed, erosion), { name, seed, erosion }));
        }
        console.log('pair', seed, erosion, repeat);
        await writeFile(resolve(out, 'compare.partial.json'), JSON.stringify(results, null, 2));
      }
    } else if (mode === 'cave') {
      const session = await page.context().newCDPSession(page);
      await session.send('Profiler.enable');
      await session.send('Profiler.setSamplingInterval', { interval: 1000 });
      for (const seed of ['42', '1', '1a72a9n']) {
        if (seed === '42') await session.send('Profiler.start');
        const baseline = await page.evaluate(seed => window.benchCase('candidate-lod', 'cavern', seed), seed);
        if (seed === '42') {
          const { profile } = await session.send('Profiler.stop');
          await writeFile(resolve(out, 'cavern.cpuprofile'), JSON.stringify(profile));
        }
        await page.evaluate(() => { window.referenceTerrain = window.lastTerrain; });
        const candidate = await page.evaluate(seed => window.benchCase('candidate-cave', 'cavern', seed), seed);
        candidate.differences = await page.evaluate(() => {
          const out = {};
          for (const key of ['height', 'normalX', 'normalY', 'normalZ', 'caveMask']) {
            const a = window.referenceTerrain[key], b = window.lastTerrain[key];
            let changed = 0, max = 0, sum = 0;
            for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > 0) changed++; max = Math.max(max, d); sum += d * d; }
            out[key] = { changed, max, rms: Math.sqrt(sum / a.length) };
          }
          return out;
        });
        results.push(baseline, candidate);
        console.log(seed, Math.round(baseline.samples[1].sampleMs), Math.round(candidate.samples[1].sampleMs), candidate.differences);
      }
    } else if (mode === 'regional') {
      const regions = [
        { x: 117.31, y: 319.17, extent: 1732.7, resolution: 127 },
        { x: 2911.19, y: 4107.23, extent: 48.5, resolution: 768 },
        { x: 4100.1, y: 3999.3, extent: 8, resolution: 768 },
      ];
      for (const relief of ['flat', 'mountains', 'valley', 'volcano', 'cavern']) for (const name of ['baseline', 'candidate-lod']) {
        results.push(await page.evaluate(({ name, relief, regions }) => window.benchCase(name, relief, '1a72a9n', 0.38, regions, false, 8000, 3000), { name, relief, regions }));
        console.log(name, relief, 'regional');
        await writeFile(resolve(out, 'regional.partial.json'), JSON.stringify(results, null, 2));
      }
    } else if (mode === 'profile') {
      await page.evaluate(() => window.benchCase('baseline-dev', 'flat', '42', 0.5, [768], false));
      const session = await page.context().newCDPSession(page);
      await session.send('Profiler.enable');
      await session.send('Profiler.setSamplingInterval', { interval: 1000 });
      await session.send('Profiler.start');
      for (const relief of ['flat', 'mountains', 'valley', 'volcano']) results.push(await page.evaluate(relief => window.benchCase('baseline-dev', relief), relief));
      const { profile } = await session.send('Profiler.stop');
      await writeFile(resolve(out, 'browser.cpuprofile'), JSON.stringify(profile));
    } else throw new Error('Unknown mode');
  }
  await writeFile(resolve(out, mode + '.json'), JSON.stringify({ browser: browser.version(), errors, results }, null, 2));
  console.log('saved', mode, 'errors', errors);
} finally { await browser.close(); }
