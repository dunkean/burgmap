// Visual QA of an open fringe and a walled town with open suburbs.
// Usage: node scripts/open_edge_visual_qa.mjs --out out/open-edge-visual-qa
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const out = resolve(args[args.indexOf('--out') + 1] || 'out/open-edge-visual-qa');
mkdirSync(out, { recursive: true });
const selected = args.includes('--case') ? args[args.indexOf('--case') + 1] : null;
const cases = [
  { name: 'open-p4uefz', options: { seed: 'p4uefz', size: 'city', culture: 'european-organic', walls: 'none', settlements: 'none' } },
  { name: 'walled-open-p4uefz', options: { seed: 'p4uefz', size: 'town', culture: 'european-organic', walls: 'single', suburbs: 'some',
    settlements: { counts: { city: 0, town: 0, village: 1, hamlet: 0, farmstead: 0 } } } },
].filter((testCase) => !selected || testCase.name === selected);
const styles = ['parchment', 'night', 'illuminated', 'atlas'];
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: resolve(out, 'vite-cache'),
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'open-edge-qa', configureServer(s) { s.middlewares.use('/__qa', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><body style="margin:0"><div id="target" style="width:900px;height:900px"></div></body></html>');
  }); } }] });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const testCase of cases) {
    for (const dpr of [1, 2]) {
      const context = await browser.newContext({ viewport: { width: 900, height: 900 }, deviceScaleFactor: dpr });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${base}/__qa`);
      const metadata = await page.evaluate(async (options) => {
        const { generate } = await import('/src/gen/pipeline.ts');
        const { makeOptions } = await import('/src/gen/options.ts');
        const { renderView } = await import('/src/gen/settlements/merge.ts');
        const world = generate(makeOptions(options));
        window.qaWorld = world;
        const u = world.urban, view = renderView(world).urban;
        const tails = u?.openTails ?? [], visibleTails = view?.openTails ?? [];
        const focus = visibleTails.find((t) => t.kind === 'unservedOpenEdge' && t.excess > 10)
          ?? visibleTails.find((t) => t.kind === 'servedDeadEnd' && t.excess > 10)
          ?? visibleTails.find((t) => t.excess > 0);
        const center = focus?.point ?? world.site?.center ?? { x: world.mapSize / 2, y: world.mapSize / 2 };
        window.qaFocus = { cx: center.x, cy: center.y, span: Math.min(760, world.mapSize * 0.4) };
        const kinds = Object.fromEntries([...new Set(visibleTails.map((t) => t.kind))].map((kind) => [kind, visibleTails.filter((t) => t.kind === kind).length]));
        return { seed: world.seed, mapSize: world.mapSize, requestedWalls: world.options.walls,
          requestedSettlements: JSON.stringify(world.options.settlements), walls: u?.walls?.length ?? 0,
          townWalls: u?.walls?.filter((w) => w.role === 'town' || w.role === 'outer' || !w.role).length ?? 0,
          openQuarters: u?.quarters?.filter((q) => q.zone === 'faubourg' || q.zone === 'edge').length ?? 0,
          secondaryCount: world.settlements?.filter((s) => !s.main && s.urban).length ?? 0,
          streetCount: u?.streets.length ?? 0, viewStreetCount: view?.streets.length ?? 0,
          tailCount: tails.length, invalidTailIndices: tails.filter((t) => t.street < 0 || t.street >= (u?.streets.length ?? 0)).length,
          viewTailCount: view?.openTails?.length ?? 0,
          invalidViewTailIndices: view?.openTails?.filter((t) => t.street < 0 || t.street >= view.streets.length).length ?? 0,
          viewOpenGroundCount: view?.openEdgeGround?.length ?? 0,
          openGroundCount: u?.openEdgeGround?.length ?? 0,
          focus: window.qaFocus, focusKind: focus?.kind ?? null, tailKinds: kinds };
      }, testCase.options);
      if (metadata.requestedWalls !== testCase.options.walls
        || metadata.requestedSettlements !== JSON.stringify(testCase.options.settlements)
        || metadata.invalidTailIndices || metadata.invalidViewTailIndices
        || (testCase.name.startsWith('open-') && metadata.townWalls !== 0)
        || (testCase.name.startsWith('walled-') && (metadata.townWalls === 0 || metadata.secondaryCount === 0 || metadata.viewOpenGroundCount === 0))) {
        throw new Error(`Invalid QA fixture or merged metadata: ${testCase.name} ${JSON.stringify(metadata)}`);
      }
      for (const style of styles) {
        const svg = await page.evaluate(async ({ style }) => {
          const { renderSvg } = await import('/src/render/svg.ts');
          const { cx, cy, span } = window.qaFocus;
          const text = renderSvg(window.qaWorld, { style, width: 900, labels: false, legend: false, raster: false });
          const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
          const root = doc.documentElement;
          root.setAttribute('viewBox', `${cx - span / 2} ${cy - span / 2} ${span} ${span}`);
          root.setAttribute('width', '900'); root.setAttribute('height', '900');
          document.querySelector('#target').replaceChildren(document.importNode(root, true));
          return { bytes: text.length, fringeLayer: text.includes('u-country-fringe'), groundLayer: text.includes('p-country-ground') };
        }, { style });
        await page.locator('#target svg').screenshot({ path: resolve(out, `${testCase.name}-${style}-svg-dpr${dpr}.png`) });
        const canvas = await page.evaluate(async ({ style, dpr }) => {
          const { createCanvasRenderer } = await import('/src/render/canvas.ts');
          const target = document.querySelector('#target');
          const element = document.createElement('canvas');
          element.width = 900 * dpr; element.height = 900 * dpr;
          element.style.width = '900px'; element.style.height = '900px';
          target.replaceChildren(element);
          const renderer = createCanvasRenderer(element, window.qaWorld, style, { dpr });
          renderer.setOverlays({ labels: false, legend: false, cartouche: false });
          const f = window.qaFocus;
          const stats = renderer.draw({ cx: f.cx, cy: f.cy, scale: 900 / f.span });
          renderer.dispose();
          return { pathsBuilt: stats.pathsBuilt, buildingsCandidate: stats.buildingsCandidate, buildingsDrawn: stats.buildingsDrawn };
        }, { style, dpr });
        await page.locator('#target canvas').screenshot({ path: resolve(out, `${testCase.name}-${style}-canvas-dpr${dpr}.png`) });
        results.push({ case: testCase.name, dpr, style, ...metadata, svg, canvas, errors: [...errors] });
        console.log(`${testCase.name} ${style} DPR${dpr}: ${metadata.tailCount} tails, ${metadata.openGroundCount} ground, ${errors.length} errors`);
      }
      await context.close();
    }
  }
} finally {
  writeFileSync(resolve(out, selected ? `results-${selected}.json` : 'results.json'), JSON.stringify(results, null, 2));
  await browser.close();
  await server.close();
}
if (results.some((r) => r.errors.length || r.invalidTailIndices || r.invalidViewTailIndices)) process.exitCode = 1;
