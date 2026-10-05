// Repeatable browser measurements on a frozen source checkout. Instrumentation is build-only.
// node scripts/optimization_display.mjs --source ../web --workers 4 --samples 3 --out out/optimization/display
import { build } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const source = resolve(arg('--source', '.'));
const out = resolve(arg('--out', 'out/optimization-implementation-2026-10-05/display'));
const workers = Number(arg('--workers', '0'));
const samples = Number(arg('--samples', '3'));
const dpr = Number(arg('--dpr', '1'));
if (!Number.isInteger(workers) || workers < 0 || workers > 8 || !Number.isInteger(samples) || samples < 1 || ![1, 2].includes(dpr)) throw new Error('Invalid workers/samples/DPR');
mkdirSync(out, { recursive: true });
const prefix = 'BURGMAP_OPT ';
const header = `const optNow = () => performance.timeOrigin + performance.now();
const optEmit = (event: string, data: any) => console.log('${prefix}' + JSON.stringify({ event, t: optNow(), ...data }));\n`;
function instrument() {
  return { name: 'optimization-display', enforce: 'pre', transform(code, id) {
    const path = id.replaceAll('\\', '/').split('?')[0];
    if (!path.includes('/src/') || /[?&]worker(?:&|$)/.test(id)) return;
    let next = code.replaceAll('\r\n', '\n');
    if (path.endsWith('/quarterPool.ts') && workers) {
      const pattern = /new QuarterPool\(world, \(\) => new QuarterWorker\(\), [^;]+\)/;
      if (!pattern.test(next)) throw new Error('Pool override anchor changed');
      return next.replace(pattern, `new QuarterPool(world, () => new QuarterWorker(), ${workers})`);
    }
    if (path.endsWith('/quarterWorker.ts')) {
      const anchor = 'result.layer = megaQuarterDetail(world, request.key);';
      if (!next.includes(anchor)) throw new Error('Quarter measurement anchor changed');
      return header + next.replace(anchor, `const optStart = optNow(); ${anchor}
        optEmit('quarter', { key: request.key, ms: optNow() - optStart, buildings: result.layer?.buildings.length ?? 0 });`);
    }
    if (path.endsWith('/main.ts')) {
      const anchor = 'if (!presented) return;';
      if (next.split(anchor).length !== 2) throw new Error('Presentation measurement anchor changed');
      return next.replace(anchor, `${anchor}
        const optPresented = { t: performance.timeOrigin + performance.now(), gen: f.gen, ver: f.ver, seq: f.seq, view: f.view };
        (window as any).__optPresented.push(optPresented);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          (optPresented as any).paint = performance.timeOrigin + performance.now();
        }));`);
    }
    if (path.endsWith('/renderWorker.ts')) {
      // Wrapping public native APIs survives changes to scene and renderer internals.
      return header + `
const optTransfer = OffscreenCanvas.prototype.transferToImageBitmap;
OffscreenCanvas.prototype.transferToImageBitmap = function() {
  const start = optNow(); const bitmap = optTransfer.call(this);
  optEmit('bitmap', { ms: optNow() - start, width: this.width, height: this.height }); return bitmap;
};
const optPost = self.postMessage.bind(self) as (...values: any[]) => void;
(self as any).addEventListener('message', (e: MessageEvent) => {
  if (e.data?.type === 'opt-world') optPost({ type: 'opt-world', world });
});
(self as any).postMessage = (...values: any[]) => {
  const m = values[0];
  if (m?.type === 'content' || m?.type === 'frame') optEmit(m.type, { gen: m.gen, ver: m.ver, seq: m.seq,
    ms: m.ms, sceneMs: m.sceneMs, details: Object.keys(world?.megaDetail ?? {}).length });
  optPost(...values);
};\n` + next;
    }
  } };
}
await build({ configFile: false, root: resolve(source, 'src/ui'), plugins: [viteSingleFile(), instrument()],
  build: { target: 'es2022', outDir: resolve(out, 'app'), emptyOutDir: false, chunkSizeWarningLimit: 7000 },
  worker: { format: 'es', plugins: () => [instrument()] } });
const html = readFileSync(resolve(out, 'app/index.html'));
const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html); });
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true, ...(arg('--channel', '') ? { channel: arg('--channel', '') } : {}) });
const cdp = await browser.newBrowserCDPSession();
const gpu = await cdp.send('SystemInfo.getInfo').then(info => info.gpu).catch(() => null);
const revision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
const cases = {
  '60k': 'seed=1&size=capital&culture=european-organic&population=60000',
  capital: 'seed=1&size=capital&culture=european-organic',
  town: 'seed=4&size=town',
  open20k: 'seed=1&size=city&mode=a&map=10000&relief=valley&biome=forest&population=20000&walls=none&seaLevel=0',
};
const result = [];
try {
  for (const name of arg('--case', '60k').split(',')) for (let sample = 1; sample <= samples; sample++) {
    if (!cases[name]) throw new Error('Unknown case');
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: dpr });
    const page = await context.newPage();
    const records = [], errors = [];
    page.on('console', m => { if (m.text().startsWith(prefix)) records.push(JSON.parse(m.text().slice(prefix.length))); });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__optMessages = [];
      window.__optPresented = [];
      window.__optWorkers = [];
      const OriginalWorker = window.Worker;
      window.Worker = class extends OriginalWorker {
        constructor(...values) {
          super(...values);
          window.__optWorkers.push(this);
          this.addEventListener('message', e => {
            const m = e.data;
            if (m?.type === 'ready') this.__optRender = true;
            if (m?.type === 'opt-world') { window.__optWorld = m.world; return; }
            if (!['done', 'content', 'frame', 'quartersDone'].includes(m?.type)) return;
            const record = { t: performance.timeOrigin + performance.now(), type: m.type, id: m.id, gen: m.gen, ver: m.ver, seq: m.seq,
              done: m.done, queued: m.queued, total: m.total, failed: m.failed, ms: m.ms, bitmap: !!m.bitmap };
            if (m.type === 'done') record.mega = !!m.meta?.mega;
            window.__optMessages.push(record);
          });
        }
      };
    });
    const started = Date.now();
    console.log(`START ${name} ${sample}, workers=${workers || 'auto'}, DPR=${dpr}`);
    await page.goto(base + '?' + cases[name]);
    let complete = false, fullFrame = null, lastUpdate = Date.now();
    while (Date.now() - started < 600000 && !errors.length) {
      await page.waitForTimeout(100);
      const state = await page.evaluate(() => {
        const messages = window.__optMessages;
        const ui = window.__burgmap?.rendering();
        return { ui, done: messages.filter(m => m.type === 'done' && m.id === ui?.gen).at(-1),
          progress: messages.filter(m => m.type === 'quartersDone' && m.id === ui?.gen).at(-1),
          frame: window.__optPresented.filter(m => m.gen === ui?.gen && m.paint).at(-1) };
      });
      const content = records.filter(r => r.event === 'content' && r.gen === state.ui?.gen).at(-1);
      if (state.done && state.ui?.ready && state.frame?.ver >= (content?.ver ?? 0)
        && (!state.done.mega || state.progress?.queued === 0 && !state.progress.failed
          && state.progress.done >= state.progress.total && content?.details >= state.progress.done)) {
        complete = true; fullFrame = state.frame; break;
      }
      if (Date.now() - lastUpdate > 15000) { console.log(`WAIT ${name} ${((Date.now() - started) / 1000).toFixed(1)}s ${state.progress?.done ?? 0}/${state.progress?.total ?? '?'}`); lastUpdate = Date.now(); }
    }
    const loadingRecords = records.length;
    const warm = [];
    if (complete) {
      await page.screenshot({ path: resolve(out, `${name}-${sample}-fit.png`) });
      const center = await page.evaluate(() => window.__burgmap.center());
      for (const scale of [0.6, 1.5]) for (let pan = 0; pan < 5; pan++) {
        const begin = records.length;
        const tick = await page.evaluate(({ center, scale, pan }) => {
          const previous = window.__optPresented.at(-1)?.seq ?? 0;
          const start = performance.timeOrigin + performance.now();
          window.__burgmap.setView({ cx: center.x + pan * 2 + 1, cy: center.y, scale });
          return { previous, start, target: window.__burgmap.getView(), gen: window.__burgmap.rendering().gen };
        }, { center, scale, pan });
        await page.waitForFunction(tick => window.__optPresented.some(m => m.seq > tick.previous && m.gen === tick.gen && m.paint
          && m.view.cx === tick.target.cx && m.view.cy === tick.target.cy && m.view.scale === tick.target.scale), tick, { timeout: 60000 });
        const frame = await page.evaluate(tick => window.__optPresented.find(m => m.seq > tick.previous && m.gen === tick.gen && m.paint
          && m.view.cx === tick.target.cx && m.view.cy === tick.target.cy && m.view.scale === tick.target.scale), tick);
        warm.push({ scale, pan, presentedMs: frame.paint - tick.start, records: records.slice(begin) });
      }
    }
    await page.screenshot({ path: resolve(out, `${name}-${sample}.png`) });
    if (complete && sample === 1 && args.includes('--save-world')) {
      // Export after all timed views; the large structured clone must not enter the performance window.
      await page.evaluate(() => window.__optWorkers.find(worker => worker.__optRender).postMessage({ type: 'opt-world' }));
      await page.waitForFunction(() => !!window.__optWorld, null, { timeout: 60000 });
      const json = await page.evaluate(() => JSON.stringify(window.__optWorld, (_key, value) =>
        ArrayBuffer.isView(value) ? { __typed: value.constructor.name, data: Array.from(value) } : value));
      writeFileSync(resolve(out, `${name}-${sample}.world.json`), json);
    }
    const messages = await page.evaluate(() => window.__optMessages);
    const accepted = await page.evaluate(() => window.__optPresented.filter(m => m.paint));
    const data = { name, sample, query: cases[name], source, revision, dirty, workers: workers || 'auto', dpr,
      browser: browser.version(), gpu, started, complete, errors, firstImageMs: accepted[0]?.paint - started,
      completeImageMs: fullFrame?.paint - started,
      loadingRecords, records, messages, warm };
    writeFileSync(resolve(out, `${name}-${sample}.json`), JSON.stringify(data, null, 2));
    result.push(data);
    console.log(`DONE ${name}: first=${data.firstImageMs.toFixed(0)}ms, full=${data.completeImageMs.toFixed(0)}ms, complete=${complete}, errors=${errors.length}`);
    await context.close();
    if (!complete || errors.length) throw new Error(`Browser verification failed for ${name}`);
  }
} finally {
  writeFileSync(resolve(out, 'results.json'), JSON.stringify(result, null, 2));
  await browser.close(); await new Promise(ok => server.close(ok));
}
