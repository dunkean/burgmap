// Native integration checks against a built single-file app, including file:// and main fallback.
// node scripts/optimization_verify.mjs --html dist/index.html --out out/optimization/native
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const arg = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const htmlPath = resolve(arg('--html', 'dist/index.html'));
const out = resolve(arg('--out', 'out/optimization-implementation-2026-10-05/native'));
mkdirSync(out, { recursive: true });
const html = readFileSync(htmlPath);
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html);
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const local = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true });
const checks = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const ready = page => page.waitForFunction(() => {
  const state = window.__burgmap?.rendering();
  return state?.ready && state.displayedGen === state.gen;
}, null, { timeout: 180000 });
const paint = page => page.evaluate(() => new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok))));
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => key !== 'stats').map(key => [key, canonical(value[key])]));
  return value;
};
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

try {
  for (const mode of ['offscreen', 'main', 'offline', 'refused']) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    if (mode === 'refused') await context.addInitScript(() => {
      window.Worker = class { constructor() { throw new Error('Native verification: Worker refused'); } };
    });
    const page = await context.newPage();
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    const base = mode === 'offline' ? pathToFileURL(htmlPath).href : local;
    await page.goto(base + '?seed=7&size=village&legend=1&style=illuminated' + (mode === 'main' ? '&render=main' : ''));
    await ready(page); await paint(page);
    assert(await page.evaluate(() => window.__burgmap.mode()) === (['main', 'refused'].includes(mode) ? 'main' : 'offscreen'), `${mode}: unexpected renderer`);
    const initial = await page.evaluate(() => ({ options: window.__burgmap.options(), rendering: window.__burgmap.rendering() }));
    await page.screenshot({ path: resolve(out, `${mode}-fit.png`) });
    await page.click('#quickShare > summary');
    const exports = {};
    for (const [id, extension] of [['exportJson', 'json'], ['exportSvg', 'svg'], ['exportPng', 'png']]) {
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.click('#' + id)]);
      assert(download.suggestedFilename().endsWith('.' + extension), `${mode}: incorrect ${id} extension`);
      const destination = resolve(out, `${mode}.${extension}`);
      await download.saveAs(destination);
      const data = readFileSync(destination);
      assert(data.length > 1000, `${mode}: empty ${extension}`);
      if (extension === 'json') {
        const document = JSON.parse(data.toString());
        assert(document.format === 'burgmap-world', `${mode}: incorrect World format`);
        const world = document.world;
        assert(world.urban?.buildings?.length > 0, `${mode}: exported World lacks buildings`);
        exports.worldHash = hash(world);
        exports.buildings = world.urban.buildings.length;
      } else if (extension === 'svg') {
        assert(data.toString().includes('<svg'), `${mode}: malformed SVG`);
        exports.svgHash = createHash('sha256').update(data).digest('hex');
      } else {
        assert(data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${mode}: malformed PNG`);
        exports.pngWidth = data.readUInt32BE(16); exports.pngHeight = data.readUInt32BE(20);
        assert(exports.pngWidth === 3000 && exports.pngHeight > 0, `${mode}: incorrect PNG size`);
      }
      await page.waitForFunction(() => !document.getElementById('exportJson').disabled);
    }
    await page.click('#quickShare > summary');
    const center = await page.evaluate(() => window.__burgmap.center());
    for (const scale of [0.6, 1.5]) {
      const tick = await page.evaluate(({ center, scale }) => {
        const previous = window.__perf.frames.length;
        window.__burgmap.setView({ cx: center.x + 0.37, cy: center.y - 0.63, scale });
        return { previous, target: window.__burgmap.getView() };
      }, { center, scale });
      await page.waitForFunction(({ previous, target }) => {
        if (window.__perf.frames.length <= previous) return false;
        const view = window.__burgmap.mode() === 'offscreen' ? window.__perf.extra.lastFrameView : window.__burgmap.getView();
        return view?.cx === target.cx && view.cy === target.cy && view.scale === target.scale;
      }, tick, { timeout: 60000 });
      await paint(page);
      await page.screenshot({ path: resolve(out, `${mode}-zoom-${scale}.png`) });
    }
    const beforeStyleImage = await page.locator('#view').screenshot();
    const styleTick = await page.evaluate(() => ({ frames: window.__perf.frames.length, ver: window.__burgmap.rendering().frameVer }));
    await page.click('#menuBtn'); await page.click('#appearanceTab');
    await page.selectOption('#style', 'parchment');
    await page.click('#closeSettings');
    await page.waitForFunction(({ frames, ver }) => window.__perf.frames.length > frames
      && (window.__burgmap.mode() === 'main' || window.__burgmap.rendering().frameVer > ver), styleTick, { timeout: 60000 });
    await ready(page); await paint(page);
    const afterStyle = await page.evaluate(() => ({ options: window.__burgmap.options(), rendering: window.__burgmap.rendering() }));
    assert(afterStyle.options.style === 'parchment' && afterStyle.rendering.gen === initial.rendering.gen, `${mode}: appearance regenerated the World`);
    assert(!beforeStyleImage.equals(await page.locator('#view').screenshot()), `${mode}: appearance failed to change native image`);
    await page.screenshot({ path: resolve(out, `${mode}-style.png`) });
    // Two real generation requests; require the latest requested generation to be presented.
    // The synchronous refused-Worker path cannot overlap its calculations.
    await page.click('#newMap');
    await page.waitForFunction(({ gen, synchronous }) => window.__burgmap.rendering().gen > gen
      && (synchronous || !window.__burgmap.rendering().ready),
      { gen: initial.rendering.gen, synchronous: mode === 'refused' }, { timeout: 60000 });
    const firstRun = await page.evaluate(() => window.__burgmap.rendering().gen);
    await page.click('#newMap');
    await page.waitForFunction(gen => window.__burgmap.rendering().gen > gen, firstRun, { timeout: 60000 });
    const target = await page.evaluate(() => window.__burgmap.rendering().gen);
    await ready(page); await paint(page);
    const final = await page.evaluate(() => window.__burgmap.rendering());
    assert(final.gen === target && final.displayedGen === target && target > initial.rendering.gen, `${mode}: stale generation presented`);
    assert(errors.length === 0, `${mode}: ${errors.join('; ')}`);
    if (mode === 'offline') assert(!requests.some(url => /^https?:/.test(url)), 'Offline app requested the network');
    checks.push({ mode, initial, final, ...exports, errors, networkRequests: requests.filter(url => /^https?:/.test(url)).length });
    writeFileSync(resolve(out, 'results.json'), JSON.stringify(checks, null, 2));
    console.log(`PASS ${mode}: ${exports.buildings} buildings; SVG/JSON/PNG; style; pan; generation supersession`);
    await context.close();
  }
  assert(new Set(checks.map(check => check.worldHash)).size === 1, 'Exported Worlds differ between main/offscreen/offline');
  assert(new Set(checks.map(check => check.svgHash)).size === 1, 'SVG exports differ between main/offscreen/offline');
  console.log('PASS native export parity and offline network isolation');
} finally {
  writeFileSync(resolve(out, 'results.json'), JSON.stringify(checks, null, 2));
  await browser.close(); await new Promise(ok => server.close(ok));
}
