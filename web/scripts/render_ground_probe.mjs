// Correctness/visual probe: identical generated Worlds and cameras in old SVG/Canvas and current SVG/vector/raster.
// No performance campaign. Outputs belong in an ignored artifact directory; production handoff is untouched.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const args = process.argv.slice(2), arg = (name, value) => { const i = args.indexOf(name); return i < 0 ? value : args[i + 1]; };
const source = resolve(arg('--source', '.')), baseline = resolve(arg('--baseline', source)), out = resolve(arg('--out', 'out/ground-appearance'));
const dpr = Number(arg('--dpr', '1'));
if (![1, 2].includes(dpr)) throw new Error('DPR must be 1 or 2');
mkdirSync(out, { recursive: true });
const server = await createServer({ configFile: false, root: source, server: { host: '127.0.0.1', port: 0, fs: { allow: [dirname(source), dirname(baseline)] } },
  plugins: [{ name: 'ground-appearance-probe', configureServer(server) {
    server.middlewares.use('/__probe', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><body style="margin:0"><canvas id="display" width="900" height="700" style="width:900px;height:700px"></canvas>'); });
  } }] });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`, url = (root, path) => `${base}/@fs/${root.replaceAll('\\', '/')}/${path}`;
const browser = await chromium.launch({ headless: true }), context = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: dpr }), page = await context.newPage();
const errors = [], report = { source, baseline, dpr, errors, cases: [] };
page.on('pageerror', error => errors.push(error.message));
const fixtures = [
  { id: 'sahel-desert', options: { culture: 'sahel', biome: 'desert', size: 'town', mapSize: 5000, population: 1800, river: 'none', castles: '1', suburbs: 'some', settlements: { list: [{ population: 1400, culture: 'european-organic' }] } } },
  { id: 'steppe-tribe', options: { culture: 'native-plains', biome: 'steppe', size: 'village', population: 350, river: 'none', castles: '0', suburbs: 'none' } },
  { id: 'paved-citadel', options: { culture: 'european-organic', biome: 'desert', size: 'town', population: 1400, river: 'none', castles: '1', walls: 'single', suburbs: 'some' } },
  { id: 'temperate-hamlets', options: { culture: 'european-organic', biome: 'temperate', size: 'town', population: 1400, river: 'stream', castles: '0', suburbs: 'some', settlements: { counts: { city: 0, town: 0, village: 0, hamlet: 2, farmstead: 0 } } } },
  { id: 'forest-village', options: { culture: 'european-organic', biome: 'forest', size: 'village', population: 500, river: 'stream', castles: '0', suburbs: 'some' } },
];
try {
  await page.goto(base + '/__probe');
  await page.evaluate(async ({ source, baseline, dpr }) => {
    const imports = await Promise.all([import(source + '/src/gen/pipeline.ts'), import(source + '/src/gen/options.ts'), import(source + '/src/render/canvas.ts'), import(source + '/src/render/sceneCache.ts'),
      import(source + '/src/render/svg.ts'), import(source + '/src/gen/landuse/groundAppearance.ts'), import(source + '/src/gen/landuse/landscapeGround.ts'), import(baseline + '/src/render/canvas.ts'), import(baseline + '/src/render/svg.ts'), import(source + '/src/render/campCover.ts')]);
    const [pipeline, options, canvas, cache, svg, appearance, ground, oldCanvas, oldSvg, cover] = imports;
    const display = document.querySelector('#display'); display.width = 900 * dpr; display.height = 700 * dpr;
    const stringify = world => JSON.stringify(world, (_k, v) => ArrayBuffer.isView(v) ? { __typed: v.constructor.name, data: Array.from(v) } : v);
    const hash = async world => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stringify(world))))).map(x => x.toString(16).padStart(2, '0')).join('');
    const image = text => new Promise((accept, reject) => { const blob = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' })), img = new Image(); img.onload = () => { URL.revokeObjectURL(blob); accept(img); }; img.onerror = () => { URL.revokeObjectURL(blob); reject(new Error('SVG image failed')); }; img.src = blob; });
    window.probe = { pipeline, options, canvas, cache, svg, appearance, ground, oldCanvas, oldSvg, cover, display, image, stringify, hash, dpr };
  }, { source: url(source, '').replace(/\/$/, ''), baseline: url(baseline, '').replace(/\/$/, ''), dpr });
  const selected = arg('--case', '');
  for (const fixture of fixtures.filter(f => !selected || f.id === selected)) {
    const info = await page.evaluate(async ({ fixture }) => {
      const p = window.probe;
      p.world = p.pipeline.generate(p.options.makeOptions({ seed: '42', relief: 'flat', coast: 'none', walls: 'none', shantytowns: 'none', settlements: 'none', labels: false, legend: false, ...fixture.options }));
      p.before = await p.hash(p.world); p.scene = new p.cache.SceneBuilder().update(p.world);
      const u = p.world.urban, polygons = u.footprintH.map(x => x.outer), points = polygons.flat();
      const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x)), minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
      p.views = [{ id: 'main', cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, scale: Math.min(900 / (maxX - minX + 160), 700 / (maxY - minY + 160)) }];
      if (points.length) p.views.push({ id: 'edge', cx: points[0].x, cy: points[0].y, scale: 1.2 });
      if (p.world.settlements?.some(s => !s.main)) p.views.push({ id: 'overview', cx: p.world.mapSize / 2, cy: p.world.mapSize / 2, scale: 700 / p.world.mapSize });
      for (const s of p.world.settlements?.filter(s => !s.main && s.urban) ?? []) p.views.push({ id: `secondary-${s.index}`, cx: s.center.x, cy: s.center.y, scale: 1.2 });
      const material = p.appearance.worldGroundAppearance(p.world), area = polys => polys.reduce((sum, q) => { const ring = r => Math.abs(r.reduce((s, a, i) => { const b = r[(i + 1) % r.length]; return s + a.x * b.y - a.y * b.x; }, 0)) / 2; return sum + ring(q.outer) - q.holes.reduce((s, h) => s + ring(h), 0); }, 0);
      const patches = p.cover.worldCampCover(p.world);
      return { id: fixture.id, options: p.world.options, before: p.before, views: p.views, buildings: u.buildings.length, realWalls: u.walls?.length ?? 0,
        urbanCulture: u.culture, lineKinds: Object.fromEntries([...new Set((u.lines ?? []).map(l => l.kind))].map(k => [k, u.lines.filter(l => l.kind === k).length])),
        parcelUses: Object.fromEntries([...new Set(u.parcels.map(p => p.use))].map(k => [k, u.parcels.filter(p => p.use === k).length])),
        secondary: p.world.settlements?.filter(s => !s.main).map(s => ({ index: s.index, population: s.population, center: s.center })) ?? [],
        ground: { naturalBackLand: material.natural.length, gardens: material.gardens.length, earthStreets: material.earthStreets,
          displayedArea: area(p.ground.currentLandscapeGround(p.world, true)), reservePatches: patches.length,
          reservePatchArea: area(patches.map((a) => ({ outer: a.poly, holes: a.holes ?? [] }))) } };
    }, { fixture });
    console.log(`prepared ${fixture.id}: ${info.buildings} roofs, ${info.ground.naturalBackLand} natural yards`);
    for (const style of ['parchment', 'night']) for (const view of info.views) for (const kind of ['old-svg', 'old-canvas', 'svg', 'vector', 'raster']) {
      await page.evaluate(async ({ style, view, kind }) => {
        const p = window.probe, ctx = p.display.getContext('2d'); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, p.display.width, p.display.height);
        if (kind.endsWith('svg')) {
          const svg = (kind === 'old-svg' ? p.oldSvg : p.svg).renderSvg(p.world, { style, width: Math.ceil(p.world.mapSize * view.scale * p.dpr), labels: false, legend: false, cartouche: false });
          const img = await p.image(svg); ctx.setTransform(view.scale * p.dpr, 0, 0, view.scale * p.dpr, (450 - view.cx * view.scale) * p.dpr, (350 - view.cy * view.scale) * p.dpr); ctx.drawImage(img, 0, 0, p.world.mapSize, p.world.mapSize);
        } else {
          const target = new OffscreenCanvas(900 * p.dpr, 700 * p.dpr), renderer = (kind === 'old-canvas' ? p.oldCanvas : p.canvas).createCanvasRenderer(target, p.world, style, { dpr: p.dpr, ...(kind === 'old-canvas' ? {} : { scene: p.scene, raster: kind === 'raster' }) });
          renderer.setOverlays({ labels: false, legend: false, cartouche: false }); renderer.draw(view); ctx.drawImage(target, 0, 0); renderer.dispose?.();
        }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, { style, view, kind });
      await page.screenshot({ path: resolve(out, `${fixture.id}-${view.id}-${style}-${kind}-dpr${dpr}.png`) });
    }
    info.after = await page.evaluate(() => probe.hash(probe.world));
    if (info.after !== info.before) throw new Error(`${fixture.id}: rendering mutated the World`);
    if (args.includes('--save-world')) writeFileSync(resolve(out, `${fixture.id}.world.json`), await page.evaluate(() => probe.stringify(probe.world)));
    report.cases.push(info); writeFileSync(resolve(out, `ground-appearance-dpr${dpr}.json`), JSON.stringify(report, null, 2));
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally { await browser.close(); await server.close(); }
