// Usage: node scripts/perf.mjs <baseUrl> <out.json> [sizes=hamlet,town,city,capital] [seeds=1,2,3]
// Measures load (generation/transfer/scene/first frame), main-thread long tasks, pan/zoom frame times, SVG/PNG export.
import { chromium } from 'playwright';
import fs from 'node:fs';
const [base, out, sizesArg = 'hamlet,town,city,capital', seedsArg = '1,2,3'] = process.argv.slice(2);
const sizes = sizesArg.split(','), seeds = seedsArg.split(',');
const q = (a) => { const s = [...a].sort((x, y) => x - y); return { p50: s[Math.floor(s.length * 0.5)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1], mean: s.reduce((x, y) => x + y, 0) / s.length }; };
const b = await chromium.launch();
const results = [];
for (const size of sizes) for (const seed of seeds) {
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript(() => {
    window.__lt = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]); }).observe({ entryTypes: ['longtask'] }); } catch {}
  });
  const t0 = Date.now();
  await p.goto(`${base}/?seed=${seed}&size=${size}`);
  await p.waitForFunction(() => window.__perf && window.__perf.extra.doneAt, null, { timeout: 240000 });
  const wall = Date.now() - t0;
  await p.waitForTimeout(500);
  const load = await p.evaluate(() => ({ t: { ...window.__perf.t }, lt: window.__lt.slice(), stats: window.__perf.extra.stats }));
  const ltSum = load.lt.reduce((a, e) => a + e[1], 0), ltMax = load.lt.reduce((a, e) => Math.max(a, e[1]), 0);
  const r = { size, seed, wall, t: load.t, stats: Object.fromEntries(Object.entries(load.stats || {}).filter(([k]) => k.startsWith('ms.'))), longTasks: { n: load.lt.length, sum: ltSum, max: ltMax }, pan: {}, zoom: {} };
  const scales = { fit: null, '0.25': 0.25, '0.6': 0.6, '1.5': 1.5 };
  for (const [name, sc] of Object.entries(scales)) {
    const res = await p.evaluate(async ([sc]) => {
      const bm = window.__burgmap;
      if (sc == null) bm.fit(); else { const c = bm.center(); bm.setView({ cx: c.x, cy: c.y, scale: sc }); }
      await new Promise((r) => setTimeout(r, 2500));
      const tick = () => new Promise((r) => requestAnimationFrame(r));
      const run = async (step, n) => {
        const ts = []; let last = performance.now(); const lt0 = window.__lt.length; const f0 = window.__perf.frames.length;
        for (let i = 0; i < n; i++) { await tick(); const t = performance.now(); ts.push(t - last); last = t; step(i); }
        await tick();
        return { ts, lt: window.__lt.slice(lt0).reduce((a, e) => a + e[1], 0), draws: window.__perf.frames.slice(f0) };
      };
      const settle = async () => { const t = performance.now(); const e = window.__perf.extra; if (!e.lastFrameView) return 0; for (let i = 0; i < 400; i++) { await tick(); const v = bm.getView(), f = e.lastFrameView; if (f.cx === v.cx && f.cy === v.cy && f.scale === v.scale) break; } return performance.now() - t; };
      const pan = await run(() => { const v = bm.getView(); bm.setView({ ...v, cx: v.cx + 9 / v.scale, cy: v.cy + 5 / v.scale }); }, 90);
      pan.settle = await settle();
      await new Promise((r) => setTimeout(r, 1500));
      const zoom = await run((i) => { const v = bm.getView(); bm.setView({ ...v, scale: v.scale * (i < 45 ? 1.03 : 1 / 1.03) }); }, 90);
      zoom.settle = await settle();
      await new Promise((r) => setTimeout(r, 1500));
      return { pan, zoom };
    }, [sc]);
    for (const k of ['pan', 'zoom']) { const o = res[k]; r[k][name] = { interval: q(o.ts), draw: o.draws.length ? q(o.draws) : null, drawn: o.draws.length, longTaskMs: o.lt, settleMs: o.settle }; }
  }
  // exports: wall time click -> done, and how long the page's main thread was blocked meanwhile (long tasks + worst rAF gap)
  const exportRun = (id, key) => p.evaluate(async ([id, key]) => {
    const lt0 = window.__lt.length; let worst = 0, last = performance.now(), stop = false;
    (async () => { while (!stop) { await new Promise((r) => requestAnimationFrame(r)); const t = performance.now(); worst = Math.max(worst, t - last); last = t; } })();
    const t0 = performance.now(); delete window.__perf.t[key];
    document.getElementById(id).click();
    while (window.__perf.t[key] === undefined && performance.now() - t0 < 200000) await new Promise((r) => setTimeout(r, 20));
    const wall = performance.now() - t0; stop = true;
    return { wall, worstFrameGap: worst, longTaskMs: window.__lt.slice(lt0).reduce((a, e) => a + e[1], 0), svgBytes: window.__perf.extra.svgBytes };
  }, [id, key]);
  r.exportSvg = await exportRun('exportSvg', 'exportSvg');
  r.exportPng = await exportRun('exportPng', 'exportPng');
  if (await p.evaluate(() => !!window.__burgmap.mode)) r.exportJson = await exportRun('exportJson', 'exportJson');
  r.export = { svgMs: r.exportSvg.wall, pngMs: r.exportPng.wall };
  r.errors = errs;
  results.push(r);
  console.log(size, seed, 'wall', wall, JSON.stringify(r.t), 'lt', JSON.stringify(r.longTasks), 'svg', r.export.svgMs, 'png', r.export.pngMs);
  await ctx.close();
  fs.writeFileSync(out, JSON.stringify(results, null, 1));
}
await b.close();
