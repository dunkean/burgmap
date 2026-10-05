// Build-only instrumentation of the current app; production sources are never rewritten.
// Usage: node scripts/audit_display.mjs [--samples 3] [--case capital,60k] [--baseline]
import { build } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const arg = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const out = resolve(arg('--out', 'out/optimization-audit-2026-10-05/display'));
mkdirSync(out, { recursive: true });
const baseline = args.includes('--baseline');
const replacements = {
  'quarterWorker.ts': [
    ['result.layer = megaQuarterDetail(world, request.key);', `const auditStart = auditNow();
    result.layer = megaQuarterDetail(world, request.key);
    (result as any).__audit = { start: auditStart, end: auditNow(), buildings: result.layer?.buildings.length ?? 0 };`],
    ['ctx.postMessage(result);', `(result as any).__auditPost = auditNow();
  const auditCloneStart = auditNow(); ctx.postMessage(result);
  auditEmit('quarterPost', { key: request.key, ms: auditNow() - auditCloneStart });`],
  ],
  'quarterPoolCore.ts': [
    ['slot.job = { id, key, revision, resolve, reject, timer };', `slot.job = { id, key, revision, resolve, reject, timer };
        (slot.job as any).__auditStart = auditNow();
        auditEmit('quarterDispatch', { key, job: id, slot: this.slots.indexOf(slot) });`],
    ['clearTimeout(job.timer); slot.job = undefined;', `auditEmit('quarterResult', { key: job.key, job: job.id, slot: this.slots.indexOf(slot),
      dispatched: (job as any).__auditStart, received: auditNow(),
      worker: (result as any).__audit, posted: (result as any).__auditPost, error: result.error ?? null });
    clearTimeout(job.timer); slot.job = undefined;`],
    ["this.stopped = true;\n    for (const slot of this.slots)", "auditEmit('poolFailed', { error: error.message });\n    this.stopped = true;\n    for (const slot of this.slots)"],
  ],
  'megaQueue.ts': [
    ['this.emit(layers, drop, { done: this.cache.size, queued, total: this.total, ms: Math.round(this.batchMs), failed });',
      `auditEmit('queueEmit', { keys: Object.keys(layers).map(Number), drop, done: this.cache.size, queued, total: this.total, failed });
      this.emit(layers, drop, { done: this.cache.size, queued, total: this.total, ms: Math.round(this.batchMs), failed });`],
    ['const vis = this.visible(r).slice(0, this.cap);', `const vis = this.visible(r).slice(0, this.cap);
    auditEmit('queueRequest', { rect: r, visible: vis.length, total: this.total, cap: this.cap });`],
  ],
  'renderWorker.ts': [
    ['const t0 = performance.now();', 'const t0 = performance.now(); let auditSceneMs = 0; const auditStart = auditNow();'],
    ['sceneCache = { world, contours: !!display.contours, scene: buildScene(w) };', `const auditSceneStart = performance.now();
    sceneCache = { world, contours: !!display.contours, scene: buildScene(w) };
    auditSceneMs = performance.now() - auditSceneStart;`],
    ['const next = createCanvasRenderer(', 'const auditRendererStart = performance.now();\n  const next = createCanvasRenderer('],
    ['next.setOverlays({ cartouche: final });', 'const auditRendererMs = performance.now() - auditRendererStart;\n  next.setOverlays({ cartouche: final });'],
    ['return performance.now() - t0;', `auditEmit('rebuild', { start: auditStart, ms: performance.now() - t0, sceneMs: auditSceneMs,
    rendererMs: auditRendererMs, details: Object.keys(world.megaDetail ?? {}).length, ver });
  return performance.now() - t0;`],
    ['const det = { ...(world.megaDetail ?? {}), ...m.layers };', `auditEmit('quartersArrive', { keys: Object.keys(m.layers).map(Number), drop: m.drop });
  const det = { ...(world.megaDetail ?? {}), ...m.layers };`],
    ['const st = renderer.draw(v.view);', 'const auditFrameStart = auditNow();\n  const st = renderer.draw(v.view);'],
    ['const bitmap = canvas.transferToImageBitmap();', `const auditBitmapStart = auditNow();
  const bitmap = canvas.transferToImageBitmap(); const auditBitmapMs = auditNow() - auditBitmapStart;
  let auditMiniMs = 0, auditMiniBitmapMs = 0;`],
    ['renderer.drawMinimap(miniCanvas as unknown as CanvasLike, v.view, v.w, v.h, false);', `const auditMiniStart = auditNow();
    renderer.drawMinimap(miniCanvas as unknown as CanvasLike, v.view, v.w, v.h, false);
    auditMiniMs = auditNow() - auditMiniStart;`],
    ['mini = miniCanvas.transferToImageBitmap();', `const auditMiniBitmapStart = auditNow(); mini = miniCanvas.transferToImageBitmap();
    auditMiniBitmapMs = auditNow() - auditMiniBitmapStart;`],
    ["post({ type: 'frame', gen: worldGen, seq: v.seq, ver, view: v.view, w: v.w, h: v.h, dpr: v.dpr, bitmap, mini, ms: st.ms, band: st.band, scale: st.scale, labels }, out);",
      `const auditFrameEnd = auditNow();
  auditEmit('frame', { start: auditFrameStart, ms: auditFrameEnd - auditFrameStart, drawMs: st.ms, ver, seq: v.seq,
    details: Object.keys(world?.megaDetail ?? {}).length, scale: v.view.scale,
    bitmapMs: auditBitmapMs, miniMs: auditMiniMs, miniBitmapMs: auditMiniBitmapMs,
    pathsBuilt: st.pathsBuilt, pathCache: st.pathCache });
  post({ type: 'frame', gen: worldGen, seq: v.seq, ver, view: v.view, w: v.w, h: v.h, dpr: v.dpr, bitmap, mini, ms: st.ms, band: st.band, scale: st.scale, labels, __auditPost: auditNow() } as any, out);`],
  ],
  'worker.ts': [
    ['lastWorld = world;\n    port.postMessage', `lastWorld = world;
    auditEmit('generated', { ms: performance.now() - t0, stats: world.stats, mapSize: world.mapSize,
      quarters: world.urban?.macro?.quarters.map(q => ({ id: q.id, district: q.district, kind: q.kind })) ?? [] });
    port.postMessage`],
  ],
  'canvas.ts': [
    ['const r = renderTerrainRaster(world, pal);', `const auditRasterStart = auditNow();
        const r = renderTerrainRaster(world, pal);
        auditEmit('terrainRaster', { ms: auditNow() - auditRasterStart });`],
  ],
  'landscapeGround.ts': [
    ['return urbanLandscapeGround(world);', `const auditGroundStart = auditNow(); const auditGround = urbanLandscapeGround(world);
  auditEmit('landscapeGround', { ms: auditNow() - auditGroundStart, details: Object.keys(world.megaDetail ?? {}).length });
  return auditGround;`],
  ],
  'main.ts': [
    ['megaProgress(d.done, d.queued, d.total, d.failed);', `auditEmit('progress', { done: d.done, queued: d.queued, total: d.total, failed: d.failed });
    megaProgress(d.done, d.queued, d.total, d.failed);`],
    ['const presented = viewer.present(f, handoff.acceptsFrame(f.gen, f.ver));', `const auditPresentStart = auditNow();
    const presented = viewer.present(f, handoff.acceptsFrame(f.gen, f.ver));
    auditEmit('present', { start: auditPresentStart, ms: auditNow() - auditPresentStart, ver: f.ver,
      seq: f.seq, accepted: presented, posted: (f as any).__auditPost ?? null });`],
  ],
};
function auditPlugin() {
  return { name: 'generation-display-audit', enforce: 'pre', transform(code, id) {
    const path = id.replaceAll('\\', '/').split('?')[0];
    const name = path.split('/').at(-1);
    if (!path.includes('/src/') || !replacements[name] || /[?&]worker(?:&|$)/.test(id)) return;
    let next = code.replaceAll('\r\n', '\n');
    for (const [before, after] of replacements[name]) {
      if (next.split(before).length !== 2) throw new Error(`Audit anchor changed: ${name}: ${before}`);
      next = next.replace(before, after);
    }
    const header = `const auditNow = () => performance.timeOrigin + performance.now();
const auditEmit = (event: string, data: any) => console.log('BURGMAP_AUDIT ' + JSON.stringify({ event, t: auditNow(), ...data }));\n`;
    return { code: header + next, map: null };
  } };
}
await build({ configFile: false, root: resolve('src/ui'), plugins: [viteSingleFile(), ...(baseline ? [] : [auditPlugin()])],
  build: { target: 'es2022', outDir: resolve(out, baseline ? 'baseline-app' : 'app'), emptyOutDir: false, chunkSizeWarningLimit: 6000 },
  worker: { format: 'es', plugins: () => baseline ? [] : [auditPlugin()] } });
const html = readFileSync(resolve(out, baseline ? 'baseline-app/index.html' : 'app/index.html'));
const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html); });
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const selections = [
  { id: 'capital', query: 'seed=1&size=capital&culture=european-organic' },
  { id: '60k', query: 'seed=1&size=capital&culture=european-organic&population=60000' },
];
const results = [];
try {
  for (const c of selections.filter(c => arg('--case', 'capital,60k').split(',').includes(c.id))) {
    for (let sample = 1; sample <= Number(arg('--samples', '3')); sample++) {
      const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const records = [], errors = [], otherLogs = [];
      page.on('console', (m) => {
        if (m.text().startsWith('BURGMAP_AUDIT ')) records.push(JSON.parse(m.text().slice(14)));
        else if (m.type() === 'error' || m.type() === 'warning') otherLogs.push(m.text());
      });
      page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(() => {
        window.__auditLongTasks = [];
        window.__auditWorkerMessages = [];
        const OriginalWorker = window.Worker;
        window.Worker = class extends OriginalWorker {
          constructor(...workerArgs) {
            super(...workerArgs);
            this.addEventListener('message', e => {
              const d = e.data;
              if (['done', 'quartersDone', 'content', 'frame'].includes(d?.type)) {
                window.__auditWorkerMessages.push({ t: performance.timeOrigin + performance.now(),
                  type: d.type, ver: d.ver, seq: d.seq, done: d.done, queued: d.queued,
                  total: d.total, ms: d.ms, sceneMs: d.sceneMs, bitmap: !!d.bitmap });
              }
            });
          }
        };
        new PerformanceObserver(list => { for (const e of list.getEntries()) window.__auditLongTasks.push({ start: e.startTime, ms: e.duration }); }).observe({ type: 'longtask', buffered: true });
      });
      const started = Date.now();
      console.log(`DISPLAY START ${c.id} ${sample} ${baseline ? 'baseline' : 'instrumented'}`);
      await page.goto(`${url}/?${c.query}`);
      let settled = false, timedOut = false, lastLog = Date.now();
      while (Date.now() - started < 600000) {
        await page.waitForTimeout(500);
        const progress = records.filter(r => r.event === 'progress').at(-1);
        const presented = records.filter(r => r.event === 'present' && r.accepted).at(-1);
        const rebuild = records.filter(r => r.event === 'rebuild').at(-1);
        const ui = await page.evaluate(() => ({ ready: window.__burgmap?.rendering().ready,
          progress: document.querySelector('#status')?.textContent,
          status: document.querySelector('#gentime')?.textContent }));
        if (Date.now() - lastLog > 10000) { console.log(`DISPLAY ${c.id} ${sample} ${((Date.now() - started) / 1000).toFixed(1)}s ${progress ? `${progress.done}/${progress.total}, queue ${progress.queued}` : ui.status}`); lastLog = Date.now(); }
        if (!baseline && ui.ready && progress && progress.queued === 0 && rebuild && rebuild.details >= progress.done && presented?.ver >= rebuild.ver && Date.now() - presented.t > 1500) { settled = true; break; }
        if (baseline && ui.ready) {
          const done = await page.evaluate(() => {
            const messages = window.__auditWorkerMessages;
            const progress = messages.filter(x => x.type === 'quartersDone').at(-1);
            const frame = messages.filter(x => x.type === 'frame' && x.bitmap).at(-1);
            const content = messages.filter(x => x.type === 'content').at(-1);
            return progress?.queued === 0 && content && frame?.ver >= content.ver &&
              performance.timeOrigin + performance.now() - messages.at(-1).t > 8000;
          });
          if (done) { settled = true; break; }
        }
        if (errors.length) break;
      }
      if (!settled && !errors.length) timedOut = true;
      const completionWallMs = Date.now() - started;
      const load = await page.evaluate(() => ({ perf: window.__perf, mode: window.__burgmap.mode(),
        options: window.__burgmap.options(), settlements: window.__burgmap.settlements(),
        view: window.__burgmap.getView(), hardwareConcurrency: navigator.hardwareConcurrency,
        longTasks: window.__auditLongTasks, workerMessages: window.__auditWorkerMessages,
        progressText: document.getElementById('status')?.textContent,
        status: document.querySelector('#gentime')?.textContent }));
      const settledRecordCount = records.length;
      const warm = [];
      if (settled && !args.includes('--no-warm')) {
        const center = await page.evaluate(() => window.__burgmap.center());
        for (const scale of [null, 0.6, 1.5]) {
          for (let i = 0; i < 5; i++) {
            const begin = records.length;
            await page.evaluate(({ center, scale, i }) => {
              if (scale === null) window.__burgmap.fit();
              else window.__burgmap.setView({ cx: center.x + i, cy: center.y, scale });
            }, { center, scale, i });
            await page.waitForTimeout(1000);
            warm.push({ scale: scale ?? 'fit', frames: records.slice(begin).filter(r => r.event === 'frame'),
              presents: records.slice(begin).filter(r => r.event === 'present') });
          }
        }
      }
      await page.screenshot({ path: resolve(out, `${c.id}-${sample}${baseline ? '-baseline' : ''}.png`) });
      const data = { case: c.id, query: c.query, sample, baseline, revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        browser: browser.version(), viewport: { width: 1400, height: 900, dpr: 1 }, started, completionWallMs,
        settled, timedOut, errors, otherLogs, load, settledRecordCount, records, warm };
      writeFileSync(resolve(out, `${c.id}-${sample}${baseline ? '-baseline' : ''}.json`), JSON.stringify(data, null, 2));
      results.push(data);
      console.log(`DISPLAY DONE ${c.id} ${sample} ${(completionWallMs / 1000).toFixed(2)}s, ${records.filter(r => r.event === 'quarterResult').length} quarters, settled=${settled}`);
      await context.close();
    }
  }
  writeFileSync(resolve(out, baseline ? 'baseline-results.json' : 'results.json'), JSON.stringify(results, null, 2));
} finally { await browser.close(); await new Promise(ok => server.close(ok)); }
