// Usage: node scripts/perf_look.mjs <url> <out-prefix> [timeline]   - waits for the map, prints mode + perf marks, screenshots (and with `timeline` shots during generation).
import { chromium } from 'playwright';
const [url, out, tl] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
const logs = [];
p.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await p.goto(url);
if (tl) {
  for (let i = 0; i < 12; i++) {
    await p.waitForTimeout(Number(tl));
    const done = await p.evaluate(() => !!(window.__perf && window.__perf.extra.doneAt));
    await p.screenshot({ path: `${out}-t${i}.png` });
    console.log('t' + i, 'done', done, await p.evaluate(() => JSON.stringify(window.__perf.t)));
    if (done) break;
  }
}
await p.waitForFunction(() => window.__perf && window.__perf.extra.doneAt, null, { timeout: 240000 });
await p.waitForTimeout(800);
console.log('mode', await p.evaluate(() => window.__burgmap.mode?.() ?? 'legacy-build'));
console.log(await p.evaluate(() => JSON.stringify(window.__perf.t)));
await p.screenshot({ path: `${out}.png` });
await p.evaluate(() => { const b = window.__burgmap; const c = b.center(); b.setView({ cx: c.x, cy: c.y, scale: 0.8 }); });
await p.waitForTimeout(1500);
await p.screenshot({ path: `${out}-z.png` });
console.log(logs.slice(0, 30).join('\n'));
await b.close();
