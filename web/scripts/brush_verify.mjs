// Real single-file UI checks; the classic oracle must be a separate pre-brush build.
// node scripts/brush_verify.mjs --html dist/index.html --classic-results out/.../results.json --out out/brushes/native
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const arg = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const htmlPath = resolve(arg('--html', 'dist/index.html'));
const atlasDir = resolve(arg('--atlas-dir', 'src/render/assets'));
const atlasUris = Object.fromEntries([['vegetation', 'biome-vegetation-v2.png'], ['terrain', 'terrain-cultivation-v1.png']]
  .map(([key, file]) => [key, 'data:image/png;base64,' + readFileSync(resolve(atlasDir, file)).toString('base64')]));
const oraclePath = arg('--classic-results', null);
if (!oraclePath) throw new Error('--classic-results from the separately built pre-brush checkpoint is required');
const oracle = JSON.parse(readFileSync(resolve(oraclePath), 'utf8'));
const out = resolve(arg('--out', 'out/brushes/native'));
const query = arg('--query', 'seed=7&size=village&legend=1&style=illuminated');
const published = arg('--url', null);
if (published) {
  const url = new URL(published);
  if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash) throw new Error('Invalid published application URL');
}
mkdirSync(out, { recursive: true });
const html = readFileSync(htmlPath);
const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); });
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const local = published ?? `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true });
const checks = [], resilience = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(k => k !== 'stats').map(k => [k, canonical(value[k])])) : value;
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value)
  ? value : JSON.stringify(canonical(value))).digest('hex');
const ready = page => page.waitForFunction(() => {
  const r = window.__burgmap?.rendering(); return r?.gen > 0 && r.ready && r.gen === r.displayedGen;
}, null, { timeout: 180000 });
const paint = page => page.evaluate(() => new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok))));
// Canvas pixels exclude the HUD, minimap and pointer overlays that cover its DOM rectangle.
const canvasImage = async page => Buffer.from(await page.evaluate(() => document.getElementById('view').toDataURL('image/png').split(',')[1]), 'base64');
const view = async page => {
  const center = await page.evaluate(() => window.__burgmap.center());
  const intermediate = await page.evaluate(() => window.__burgmap.getView().scale === 1.51 ? 1.52 : 1.51);
  // The viewer suppresses repeated identical views. Force two distinct real views, then restore the exact camera.
  for (const scale of [intermediate, 1.5]) {
    const state = await page.evaluate(({ center, scale }) => {
      const frames = window.__perf.frames.length;
      window.__burgmap.setView({ cx: center.x, cy: center.y, scale });
      return { frames, target: window.__burgmap.getView() };
    }, { center, scale });
    try {
      await page.waitForFunction(({ frames, target }) => {
        const actual = window.__burgmap.mode() === 'offscreen' ? window.__perf.extra.lastFrameView : window.__burgmap.getView();
        return window.__perf.frames.length > frames && actual?.cx === target.cx && actual.cy === target.cy && actual.scale === target.scale;
      }, state, { timeout: 60000 });
    } catch (error) {
      const observed = await page.evaluate(() => ({ url: location.href, mode: window.__burgmap.mode(), rendering: window.__burgmap.rendering(),
        currentView: window.__burgmap.getView(), frames: window.__perf.frames.length, lastFrameView: window.__perf.extra.lastFrameView,
        status: document.getElementById('status').textContent, generation: document.getElementById('gentime').textContent }));
      writeFileSync(resolve(out, 'view-timeout-' + Date.now() + '.json'), JSON.stringify({ requested: state, observed }, null, 2));
      throw error;
    }
  }
  await paint(page);
};
const appearance = async (page, painted, style) => {
  await page.click('#menuBtn'); await page.click('#appearanceTab');
  await page.locator('#paintedTextures').setChecked(painted);
  if (style) await page.selectOption('#style', style);
  await page.click('#closeSettings'); await paint(page);
};
const different = async (page, previous) => {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await ready(page); await paint(page);
    if (!previous.equals(await canvasImage(page))) return;
    await page.waitForTimeout(100);
  }
  throw new Error('Painted textures did not change the native map');
};
const exportOne = async (page, id, path) => {
  await page.locator('#quickShare').evaluate(el => { el.open = true; });
  const downloading = page.waitForEvent('download', { timeout: 180000 });
  // Keep a failed UI export observable without leaving an unhandled download waiter.
  void downloading.catch(() => {});
  await page.click('#' + id);
  await page.waitForFunction(() => !document.getElementById('exportJson').disabled, null, { timeout: 180000 });
  const status = await page.locator('#status').textContent();
  if (status?.startsWith('Export failed:')) {
    const observed = await page.evaluate(() => ({ url: location.href, mode: window.__burgmap.mode(), rendering: window.__burgmap.rendering(),
      options: window.__burgmap.options(), draft: window.__burgmap.draft(), status: document.getElementById('status').textContent }));
    writeFileSync(path + '.failure.json', JSON.stringify(observed, null, 2));
    throw new Error(status);
  }
  const download = await downloading;
  await download.saveAs(path);
  await page.waitForFunction(() => !document.getElementById('exportJson').disabled);
  await page.locator('#quickShare').evaluate(el => { el.open = false; });
  return readFileSync(path);
};
const documents = async (page, prefix, painted, png = false) => {
  const json = await exportOne(page, 'exportJson', resolve(out, prefix + '.json'));
  const svg = await exportOne(page, 'exportSvg', resolve(out, prefix + '.svg'));
  const document = JSON.parse(json.toString());
  assert(document.format === 'burgmap-world' && document.world.urban?.buildings?.length > 0, prefix + ': malformed World');
  assert(!document.world.urban?.macro, 'Use a non-macro fixture');
  assert(!('painted' in document.world.options) && !('brushes' in document.world.options), prefix + ': presentation entered generation options');
  const svgText = svg.toString();
  const brushImages = await page.evaluate(text => {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (doc.querySelector('parsererror')) throw new Error('Malformed SVG XML');
    const brushIds = Array.from(doc.querySelectorAll('[id]')).map(e => e.id).filter(id => id.startsWith('brush-'));
    const images = Array.from(doc.querySelectorAll('image')).filter(e => e.id.startsWith('brush-'))
      .map(e => ({ id: e.id, uri: e.getAttribute('href') ?? e.getAttributeNS('http://www.w3.org/1999/xlink', 'href') }));
    return { brushIds, images };
  }, svgText);
  assert(brushImages.images.length === (painted ? 2 : 0), prefix + ': SVG must embed exactly two brush atlases when painted');
  if (!painted) assert(brushImages.brushIds.length === 0, prefix + ': classic SVG contains brush definitions');
  if (painted) for (const key of ['vegetation', 'terrain']) {
    assert(brushImages.images.find(i => i.id === 'brush-' + key)?.uri === atlasUris[key], prefix + ': incorrect selected atlas');
    assert(svgText.split(atlasUris[key]).length - 1 === 1, prefix + ': atlas repeated in SVG');
  }
  if (painted) await page.evaluate(async text => {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (doc.querySelector('parsererror')) throw new Error('Malformed SVG XML');
    const image = new Image(); image.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(text)));
    await image.decode(); if (!image.naturalWidth) throw new Error('SVG image did not decode');
  }, svg.toString());
  if (png) {
    const data = await exportOne(page, 'exportPng', resolve(out, prefix + '.png'));
    assert(data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && data.readUInt32BE(16) === 3000,
      prefix + ': invalid PNG export');
  }
  return { worldHash: hash(document.world), svgHash: hash(svg), svgBytes: svg.length, buildings: document.world.urban.buildings.length };
};
const contextFor = async (mode, injection) => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  if (mode === 'refused') await context.addInitScript(() => { window.Worker = class { constructor() { throw new Error('Verification: Worker refused'); } }; });
  if (injection) await context.addInitScript(({ mode, injection }) => {
    window.__brushVerification = { started: 0, delivered: 0, settled: 0, failed: 0, workerReady: null, deliveredGen: null, deliveredStyle: null, deliveredPainted: null };
    const delivered = () => {
      const p = window.__brushVerification; p.delivered++;
      p.deliveredGen = window.__burgmap?.rendering().gen;
      p.deliveredStyle = window.__burgmap?.options().style;
      p.deliveredPainted = document.getElementById('paintedTextures')?.checked;
    };
    if (mode === 'offscreen') {
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', e => {
            if (e.data?.type === 'brushStatus') {
              window.__brushVerification.settled++; window.__brushVerification.workerReady = e.data.ready;
            }
          });
        }
        postMessage(message, transfer) {
          if (message?.type === 'brushes') {
            window.__brushVerification.started++;
            if (injection === 'failure') message = { ...message, sources: { ...message.sources, vegetation: 'data:image/png;base64,AAAA' } };
            else { setTimeout(() => { delivered(); super.postMessage(message, transfer); }, 5000); return; }
          }
          super.postMessage(message, transfer);
        }
      };
    } else {
      const native = window.createImageBitmap;
      window.createImageBitmap = async (...args) => {
        if (args[0] instanceof Blob && args[0].type === 'image/png') {
          window.__brushVerification.started++;
          try {
            if (injection === 'failure') throw new Error('Verification: bitmap decode refused');
            await new Promise(ok => setTimeout(ok, 5000));
            const image = await native(...args); delivered(); return image;
          } catch (error) { window.__brushVerification.failed++; throw error; }
          finally { window.__brushVerification.settled++; }
        }
        return native(...args);
      };
    }
  }, { mode, injection });
  return context;
};
const navigate = async (page, mode) => {
  const q = new URLSearchParams(query); q.delete('brushes'); q.delete('render');
  if (mode === 'main') q.set('render', 'main');
  const base = mode === 'offline' ? pathToFileURL(htmlPath).href : local;
  const response = await page.goto(base + '?' + q.toString());
  if (mode !== 'offline') assert(response?.ok() && html.equals(await response.body()), mode + ': HTML differs from checked build');
  await ready(page); await view(page);
};
try {
  for (const mode of ['offscreen', 'main', 'offline', 'refused']) {
    const context = await contextFor(mode), page = await context.newPage();
    const errors = [], requests = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('request', r => requests.push(r.url()));
    await navigate(page, mode);
    const actualMode = await page.evaluate(() => window.__burgmap.mode());
    assert(mode === 'offline' ? ['main', 'offscreen'].includes(actualMode) : actualMode === (mode === 'offscreen' ? 'offscreen' : 'main'), mode + ': wrong backend');
    assert(!await page.locator('#paintedTextures').isChecked(), mode + ': default must remain classic');
    const initialGen = await page.evaluate(() => window.__burgmap.rendering().gen);
    const classicImage = await canvasImage(page);
    writeFileSync(resolve(out, mode + '-classic-canvas.png'), classicImage);
    const classic = await documents(page, mode + '-classic', false);
    const expected = oracle.find(c => c.mode === mode);
    assert(expected && classic.worldHash === expected.worldHash && classic.svgHash === expected.svgHash, mode + ': classic oracle changed');
    await appearance(page, true); await different(page, classicImage);
    assert(new URL(page.url()).searchParams.get('brushes') === 'painted', mode + ': URL lost painted mode');
    await page.locator('#quickShare').evaluate(el => { el.open = true; });
    for (const button of ['copyLink', 'copyBug']) {
      await page.evaluate(() => { delete window.__lastCopied; });
      await page.click('#' + button);
      await page.waitForFunction(() => typeof window.__lastCopied === 'string' && window.__lastCopied.includes('brushes=painted'));
    }
    await page.locator('#quickShare').evaluate(el => { el.open = false; });
    await page.screenshot({ path: resolve(out, mode + '-painted-ui.png') });
    writeFileSync(resolve(out, mode + '-painted-canvas.png'), await canvasImage(page));
    const painted = await documents(page, mode + '-painted', true, true);
    assert(painted.worldHash === classic.worldHash && painted.svgHash !== classic.svgHash, mode + ': brush mode altered World or failed SVG');
    await appearance(page, false); await ready(page); await view(page);
    const restoredImage = await canvasImage(page);
    writeFileSync(resolve(out, mode + '-restored-canvas.png'), restoredImage);
    assert(classicImage.equals(restoredImage), mode + ': native classic image did not restore exactly');
    assert(!new URL(page.url()).searchParams.has('brushes'), mode + ': disabled mode remained in URL');
    assert(await page.evaluate(() => window.__burgmap.rendering().gen) === initialGen, mode + ': toggle regenerated World');
    await appearance(page, true); await different(page, classicImage);
    writeFileSync(resolve(out, mode + '-before-reload.json'), JSON.stringify(await page.evaluate(() => ({ url: location.href,
      rendering: window.__burgmap.rendering(), currentView: window.__burgmap.getView() })), null, 2));
    await page.reload(); await ready(page); await view(page);
    await different(page, classicImage);
    assert(await page.locator('#paintedTextures').isChecked(), mode + ': reload lost painted preference');
    const reloaded = await documents(page, mode + '-reloaded', true);
    assert(reloaded.worldHash === painted.worldHash && reloaded.svgHash === painted.svgHash, mode + ': reload changed seeded exports');
    assert(errors.length === 0, mode + ': ' + errors.join('; '));
    if (mode === 'offline') assert(!requests.some(u => /^https?:/.test(u)), 'Offline brush app requested network');
    checks.push({ mode, actualMode, initialGen, classic, painted, reloaded, errors, networkRequests: requests.filter(u => /^https?:/.test(u)).length });
    writeFileSync(resolve(out, 'results.json'), JSON.stringify({ checks, resilience }, null, 2));
    console.log('PASS ' + mode + ': default oracle; painted exports; exact OFF restoration; World unchanged; reload; offline');
    await context.close();
  }
  assert(new Set(checks.map(c => c.painted.svgHash)).size === 1 && new Set(checks.map(c => c.painted.worldHash)).size === 1, 'Painted exports differ between backends');
  for (const mode of ['main', 'offscreen']) for (const injection of ['failure', 'delay']) {
    const context = await contextFor(mode, injection), page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await navigate(page, mode);
    const gen = await page.evaluate(() => window.__burgmap.rendering().gen);
    const classicImage = await canvasImage(page);
    writeFileSync(resolve(out, mode + '-' + injection + '-classic-canvas.png'), classicImage);
    await appearance(page, true);
    if (injection === 'delay') {
      await appearance(page, false, 'night');
      await page.click('#newMap');
      await page.waitForFunction(previous => window.__burgmap.rendering().gen > previous, gen, { timeout: 60000 });
      await ready(page); await view(page);
      const before = await documents(page, mode + '-delay-before', false);
      await page.waitForFunction(mode => window.__brushVerification.settled >= (mode === 'offscreen' ? 1 : 2), mode, { timeout: 15000 });
      await ready(page); await view(page);
      const after = await documents(page, mode + '-delay-after', false);
      assert(before.worldHash === after.worldHash && before.svgHash === after.svgHash, mode + ': late decode altered current disabled World');
      assert(!await page.locator('#paintedTextures').isChecked() && await page.evaluate(() => window.__burgmap.options().style) === 'night', mode + ': stale appearance after decode');
      assert(await page.evaluate(() => window.__burgmap.rendering().gen) > gen, mode + ': new map did not generate');
      const delivery = await page.evaluate(() => window.__brushVerification);
      assert(delivery.deliveredGen > gen && delivery.deliveredPainted === false && delivery.deliveredStyle === 'night', mode + ': delay did not exercise current generation/style after OFF');
    } else {
      await page.waitForFunction(mode => window.__brushVerification.settled >= (mode === 'offscreen' ? 1 : 2), mode, { timeout: 15000 });
      await ready(page); await view(page);
      const fallbackImage = await canvasImage(page);
      writeFileSync(resolve(out, mode + '-fallback-canvas.png'), fallbackImage);
      assert(classicImage.equals(fallbackImage), mode + ': decode failure did not fall back to classic');
      const fallback = await documents(page, mode + '-decode-fallback', false);
      const expected = oracle.find(c => c.mode === mode);
      assert(fallback.worldHash === expected.worldHash && fallback.svgHash === expected.svgHash, mode + ': decode fallback exports changed');
      assert(await page.evaluate(() => window.__burgmap.rendering().gen) === gen, mode + ': decode failure regenerated World');
    }
    const decode = await page.evaluate(() => window.__brushVerification);
    assert(mode === 'offscreen' ? decode.workerReady === (injection !== 'failure')
      : decode.started === 2 && decode.failed === (injection === 'failure' ? 2 : 0), mode + ': decode completion/failure was not observed');
    assert(errors.length === 0, mode + ' ' + injection + ': ' + errors.join('; '));
    resilience.push({ mode, injection, passed: true, errors, probe: await page.evaluate(() => window.__brushVerification) });
    console.log('PASS ' + mode + ' ' + injection + ': coherent fallback/current appearance');
    await context.close();
  }
} finally {
  writeFileSync(resolve(out, 'results.json'), JSON.stringify({ checks, resilience }, null, 2));
  await browser.close(); await new Promise(ok => server.close(ok));
}
