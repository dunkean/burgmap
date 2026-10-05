// Native correctness/visual probe. Synthetic isolated cover polygons have holes and a fixed World hash.
// Runtime timings are diagnostics only unless --timing is explicitly run in a quiet, approved slot.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const args = process.argv.slice(2), arg = (key, value) => { const i = args.indexOf(key); return i < 0 ? value : args[i + 1]; };
if (!args.includes('--baseline')) throw new Error('--baseline must name the independent classic source');
const source = resolve(arg('--source', '.')), baseline = resolve(arg('--baseline', '')), out = resolve(arg('--out', 'out/brushes'));
const dpr = Number(arg('--dpr', '1')); if (![1, 2].includes(dpr)) throw new Error('Invalid DPR');
mkdirSync(out, { recursive: true });
const server = await createServer({ configFile: false, root: source, server: { host: '127.0.0.1', port: 0, fs: { allow: [dirname(source), dirname(baseline), realpathSync(resolve(source, 'node_modules'))] } },
  plugins: [{ name: 'brush-probe', configureServer(s) { s.middlewares.use('/__brush', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><body style="margin:0"><canvas id="display" style="width:900px;height:700px"></canvas>'); }); } }] });
await server.listen(); const base = `http://127.0.0.1:${server.httpServer.address().port}`, url = root => `${base}/@fs/${root.replaceAll('\\', '/')}`;
const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: dpr });
const errors = []; page.on('pageerror', error => errors.push(String(error))); const results = [];
try {
  await page.goto(base + '/__brush');
  await page.evaluate(async ({ source, baseline, dpr }) => {
    const [fake, canvas, svg, brush, assets, oldCanvas, oldSvg] = await Promise.all([
      import(source + '/scripts/fakeworld.ts'), import(source + '/src/render/canvas.ts'), import(source + '/src/render/svg.ts'), import(source + '/src/render/brushes.ts'), import(source + '/src/render/assets/brushAssets.ts'),
      import(baseline + '/src/render/canvas.ts'), import(baseline + '/src/render/svg.ts')]);
    const world = fake.fakeWorld({ mapSize: 800, buildings: 0, streets: 0, clusters: 1, landAreas: 0 });
    world.seed = 'botanical-map-42'; world.options.contours = false; world.options.labels = false; world.options.legend = false; world.roads = []; world.urban = undefined; world.terrain.rivers = [];
    const kinds = ['forest', 'orchard', 'meadow', 'pasture', 'marsh', 'commons', 'garden', 'field'];
    const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    world.landuse.areas = kinds.map((kind, i) => ({ kind, poly: rect(30 + i % 4 * 150, 30 + Math.floor(i / 4) * 180, 135, 160), holes: [rect(78 + i % 4 * 150, 100 + Math.floor(i / 4) * 180, 35, 35)], ...(kind === 'field' ? { strips: [rect(480, 240, 120, 35), rect(480, 290, 120, 35)], stripAngle: 0 } : {}) }));
    const display = document.querySelector('#display'); display.width = 900 * dpr; display.height = 700 * dpr;
    const images = await brush.decodeBrushes(assets.BRUSH_SOURCES); if (!images) throw new Error('Atlas decode failed');
    const digest = async world => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(world))))).map(x => x.toString(16).padStart(2, '0')).join('');
    const image = svg => new Promise((resolve, reject) => { const uri = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), img = new Image(); img.onload = () => { URL.revokeObjectURL(uri); resolve(img); }; img.onerror = () => { URL.revokeObjectURL(uri); reject(new Error('SVG decode failed')); }; img.src = uri; });
    window.probe = { world, display, dpr, canvas, svg, images, sources: assets.BRUSH_SOURCES, oldCanvas, oldSvg, digest, image };
  }, { source: url(source), baseline: url(baseline), dpr });
  for (const biome of ['temperate', 'forest', 'desert', 'steppe', 'tropical', 'tundra']) for (const style of ['parchment', 'night', 'engraving']) for (const scale of [1.5, 4]) {
    const info = await page.evaluate(async ({ biome, style, scale, timing }) => {
      const p = window.probe; p.world.options.biome = biome; p.world.options.style = style;
      const before = await p.digest(p.world), view = scale === 4 ? { cx: 100, cy: 110, scale } : { cx: 335, cy: 205, scale };
      const draw = (library, painted, raster) => { const renderer = library.createCanvasRenderer(p.display, p.world, style, { dpr: p.dpr, raster, brushes: painted ? p.images : undefined }); const start = performance.now(); renderer.draw(view); p.display.getContext('2d').getImageData(0, 0, 1, 1); const ms = performance.now() - start; const bytes = p.display.getContext('2d').getImageData(0, 0, p.display.width, p.display.height).data; renderer.dispose(); return { bytes, ms }; };
      const baseline = draw(p.oldCanvas, false, false), classic = draw(p.canvas, false, false); let changed = 0;
      for (let i = 0; i < classic.bytes.length; i++) if (classic.bytes[i] !== baseline.bytes[i]) changed++;
      const classicSvg = p.svg.renderSvg(p.world, { raster: false, labels: false, cartouche: false }), oldSvg = p.oldSvg.renderSvg(p.world, { raster: false, labels: false, cartouche: false });
      const result = { biome, style, scale, before, classicChangedChannels: changed, classicSvgExact: classicSvg === oldSvg, timingsValid: timing };
      p.view = view; p.style = style;
      result.after = await p.digest(p.world); return result;
    }, { biome, style, scale, timing: args.includes('--timing') });
    if (info.before !== info.after || !info.classicSvgExact || info.classicChangedChannels) throw new Error('Classic/World regression: ' + JSON.stringify(info));
    for (const kind of ['vector', 'raster', 'svg']) {
      const detail = await page.evaluate(async kind => {
        const p = window.probe, ctx = p.display.getContext('2d');
        if (kind === 'svg') {
          let text = p.svg.renderSvg(p.world, { style: p.style, width: 900, brushes: p.sources, labels: false, legend: false, cartouche: false });
          // Crop before SVG image decoding: never allocate a giant whole-map bitmap to inspect zoom.
          const w = 900 / p.view.scale, h = 700 / p.view.scale;
          text = text.replace(/viewBox="[^"]*"/, `viewBox="${p.view.cx - w / 2} ${p.view.cy - h / 2} ${w} ${h}"`).replace('height="900"', 'height="700"');
          const img = await p.image(text); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, p.display.width, p.display.height); ctx.drawImage(img, 0, 0, p.display.width, p.display.height);
          return { svgBytes: text.length, atlasDefinitions: (text.match(/<image id="brush-/g) ?? []).length };
        }
        const renderer = p.canvas.createCanvasRenderer(p.display, p.world, p.style, { dpr: p.dpr, raster: kind === 'raster', brushes: p.images });
        const start = performance.now(); const cold = renderer.draw(p.view); ctx.getImageData(0, 0, 1, 1); const coldMs = performance.now() - start;
        const warmStart = performance.now(); const warm = renderer.draw(p.view); ctx.getImageData(0, 0, 1, 1); const warmMs = performance.now() - warmStart;
        const pixels = ctx.getImageData(0, 0, p.display.width, p.display.height).data;
        if (kind === 'vector') p.vector = pixels;
        let error = 0, large = 0; if (kind === 'raster') for (let i = 0; i < pixels.length; i++) { const d = Math.abs(pixels[i] - p.vector[i]); error += d; if (d > 32) large++; }
        renderer.dispose(); return { cold, warm, coldMs, warmMs, rasterMeanChannelError: kind === 'raster' ? error / pixels.length : undefined, rasterLargeFraction: kind === 'raster' ? large / pixels.length : undefined };
      }, kind);
      await page.locator('#display').screenshot({ path: resolve(out, `${biome}-${style}-${scale}-${kind}.png`) }); info[kind] = detail;
    }
    info.after = await page.evaluate(() => window.probe.digest(window.probe.world)); if (info.before !== info.after) throw new Error('Painted render changed World');
    results.push(info); writeFileSync(resolve(out, 'probe.json'), JSON.stringify({ dpr, errors, results }, null, 2)); console.log(`${biome}/${style}/${scale}: classic exact, World unchanged`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally { await page.close(); await browser.close(); await server.close(); }
