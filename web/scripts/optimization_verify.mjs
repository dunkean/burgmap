// Native integration checks against a built single-file app, including file:// and main fallback.
// node scripts/optimization_verify.mjs --html dist/index.html --out out/optimization/native
// Add --url https://dunkean.github.io/burgmap/ to check the identical published build.
// --query selects a non-macro village/town fixture for native regression checks.
// --views adds JSON [{tag,cx,cy,scale}] views for matched close-up screenshots.
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
const publishedUrl = arg('--url', null);
const fixtureQuery = arg('--query', 'seed=7&size=village&legend=1&style=illuminated');
const extraViews = JSON.parse(arg('--views', '[]'));
if (!Array.isArray(extraViews) || extraViews.some(view => !/^[a-z0-9-]+$/i.test(view.tag ?? '')
  || ![view.cx, view.cy, view.scale].every(Number.isFinite) || view.scale <= 0)) {
  throw new Error('--views must contain tagged views with finite coordinates and positive scales');
}
if (publishedUrl) {
  const url = new URL(publishedUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.search || url.hash) {
    throw new Error('--url must be an HTTP(S) application URL without a query or fragment');
  }
}
mkdirSync(out, { recursive: true });
const html = readFileSync(htmlPath);
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html);
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const local = publishedUrl ?? `http://127.0.0.1:${server.address().port}/`;
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
  if (publishedUrl) {
    const url = new URL(publishedUrl);
    url.searchParams.set('verification', String(Date.now()));
    const response = await fetch(url);
    assert(response.ok && html.equals(Buffer.from(await response.arrayBuffer())),
      'Published HTML does not match the supplied single-file build');
  }
  for (const mode of ['offscreen', 'main', 'offline', 'refused']) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    if (mode === 'refused') await context.addInitScript(() => {
      window.Worker = class { constructor() { throw new Error('Native verification: Worker refused'); } };
    });
    const page = await context.newPage();
    const errors = [], requests = [];
    let documentVerified = false;
    if (mode !== 'offline') await page.route('**/*', async route => {
      const request = route.request();
      if (!request.isNavigationRequest() || request.resourceType() !== 'document') {
        await route.continue(); return;
      }
      // Read the navigation bytes outside Chromium's bounded inspector cache: the
      // offline app can exceed its per-resource limit before generation finishes.
      const response = await route.fetch();
      documentVerified = response.ok() && html.equals(await response.body());
      await route.fulfill({ response });
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    const base = mode === 'offline' ? pathToFileURL(htmlPath).href : local;
    const query = new URLSearchParams(fixtureQuery);
    query.delete('render');
    if (mode === 'main') query.set('render', 'main');
    const navigation = await page.goto(base + '?' + query.toString());
    if (mode !== 'offline') assert(navigation?.ok() && documentVerified,
      `${mode}: navigated HTML differs from the supplied build`);
    await ready(page); await paint(page);
    const actualMode = await page.evaluate(() => window.__burgmap.mode());
    // file:// can refuse module workers; the native main fallback remains an offline-supported backend.
    assert(mode === 'offline' ? ['main', 'offscreen'].includes(actualMode)
      : actualMode === (['main', 'refused'].includes(mode) ? 'main' : 'offscreen'), `${mode}: unexpected renderer ${actualMode}`);
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
        assert(!world.urban?.macro && !(world.settlements ?? []).some(settlement => settlement.urban?.macro),
          `${mode}: use a non-macro fixture; this harness does not wait for all macro quarters`);
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
    const views = [0.6, 1.5].map(scale => ({ tag: String(scale), cx: center.x + 0.37, cy: center.y - 0.63, scale })).concat(extraViews);
    for (const view of views) {
      const tick = await page.evaluate(view => {
        const previous = window.__perf.frames.length;
        window.__burgmap.setView(view);
        return { previous, target: window.__burgmap.getView() };
      }, { cx: view.cx, cy: view.cy, scale: view.scale });
      await page.waitForFunction(({ previous, target }) => {
        if (window.__perf.frames.length <= previous) return false;
        const view = window.__burgmap.mode() === 'offscreen' ? window.__perf.extra.lastFrameView : window.__burgmap.getView();
        return view?.cx === target.cx && view.cy === target.cy && view.scale === target.scale;
      }, tick, { timeout: 60000 });
      await paint(page);
      await page.screenshot({ path: resolve(out, `${mode}-zoom-${view.tag}.png`) });
    }
    const beforeStyleImage = await page.locator('#view').screenshot();
    const styleTick = await page.evaluate(() => ({ frames: window.__perf.frames.length, ver: window.__burgmap.rendering().frameVer }));
    await page.click('#menuBtn'); await page.click('#appearanceTab');
    const nextStyle = initial.options.style === 'parchment' ? 'night' : 'parchment';
    await page.selectOption('#style', nextStyle);
    await page.click('#closeSettings');
    await page.waitForFunction(({ frames, ver }) => window.__perf.frames.length > frames
      && (window.__burgmap.mode() === 'main' || window.__burgmap.rendering().frameVer > ver), styleTick, { timeout: 60000 });
    await ready(page); await paint(page);
    const afterStyle = await page.evaluate(() => ({ options: window.__burgmap.options(), rendering: window.__burgmap.rendering() }));
    assert(afterStyle.options.style === nextStyle && afterStyle.rendering.gen === initial.rendering.gen, `${mode}: appearance regenerated the World`);
    assert(!beforeStyleImage.equals(await page.locator('#view').screenshot()), `${mode}: appearance failed to change native image`);
    await page.screenshot({ path: resolve(out, `${mode}-style.png`) });
    // Two real generation requests; require the latest requested generation to be presented.
    // The synchronous refused-Worker path cannot overlap its calculations.
    await page.click('#newMap');
    await page.waitForFunction(({ gen, allowCompleted }) => window.__burgmap.rendering().gen > gen
      && (allowCompleted || !window.__burgmap.rendering().ready),
      { gen: initial.rendering.gen, allowCompleted: ['refused', 'offline'].includes(mode) }, { timeout: 60000 });
    const firstRun = await page.evaluate(() => window.__burgmap.rendering().gen);
    await page.click('#newMap');
    await page.waitForFunction(gen => window.__burgmap.rendering().gen > gen, firstRun, { timeout: 60000 });
    const target = await page.evaluate(() => window.__burgmap.rendering().gen);
    await ready(page); await paint(page);
    const final = await page.evaluate(() => window.__burgmap.rendering());
    assert(final.gen === target && final.displayedGen === target && target > initial.rendering.gen, `${mode}: stale generation presented`);
    assert(errors.length === 0, `${mode}: ${errors.join('; ')}`);
    if (mode === 'offline') assert(!requests.some(url => /^https?:/.test(url)), 'Offline app requested the network');
    checks.push({ mode, actualMode, initial, final, ...exports, errors, networkRequests: requests.filter(url => /^https?:/.test(url)).length });
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
