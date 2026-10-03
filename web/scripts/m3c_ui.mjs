// M3c UI check: node scripts/m3c_ui.mjs [query]   (needs `npm run build`; writes out/m3c_ui_*.png)
// Opens dist/index.html, waits for the map, screenshots the panel + map, focuses a lazy settlement by clicking its
// label position, waits for its detail to arrive from the worker, and tests list mode + click-to-place.
import { chromium } from 'playwright';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const query = process.argv[2] ?? 'seed=3&map=20000&population=45000';
const BASE = process.env.BASE ?? pathToFileURL(path.resolve('dist/index.html')).href;
const url = BASE + '?' + query;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
const logs = [];
p.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
p.on('pageerror', (e) => logs.push('pageerror ' + e.message));
await p.goto(url);
const done = () => p.waitForFunction(() => /Generated in|failed/.test(document.getElementById('gentime')?.textContent ?? ''), null, { timeout: 600000 });
await done();
await p.waitForTimeout(1500);
console.log('mode', await p.evaluate(() => window.__burgmap.mode()));
console.log('status', await p.evaluate(() => document.getElementById('status').textContent));
console.log('warn', await p.evaluate(() => document.getElementById('settlWarn').textContent));
await p.screenshot({ path: 'out/m3c_ui_fit.png' });
const list = await p.evaluate(() => window.__burgmap.settlements());
console.log('settlements', list.length, 'lazy', list.filter((s) => s.detail === 'lazy').length);
const lazy = list.find((s) => s.detail === 'lazy' && s.cls === 'village') ?? list.find((s) => s.detail === 'lazy');
if (lazy) {
  // click on the settlement in the fitted view: screen position from the view
  const v = await p.evaluate(() => window.__burgmap.getView());
  const box = await p.locator('#map').boundingBox();
  const sx = box.x + box.width / 2 + (lazy.center.x - v.cx) * v.scale, sy = box.y + box.height / 2 + (lazy.center.y - v.cy) * v.scale;
  await p.mouse.click(sx, sy);
  await p.waitForFunction((i) => window.__burgmap.settlements()[i]?.hasUrban, lazy.index, { timeout: 120000 }).catch(() => console.log('detail not received'));
  await p.waitForTimeout(1500);
  console.log('focused', lazy.name, JSON.stringify(await p.evaluate(() => window.__burgmap.getView())), 'hasUrban', await p.evaluate((i) => window.__burgmap.settlements()[i].hasUrban, lazy.index));
  await p.screenshot({ path: 'out/m3c_ui_lazy.png' });
}
// list mode with click-to-place on a small map
await p.goto(BASE + '?seed=2&map=3000&population=900');
await done();
await p.selectOption('#settlMode', 'list');
await p.waitForTimeout(300);
await p.locator('.settl-row button', { hasText: 'Place on map' }).first().click();
const box = await p.locator('#map').boundingBox();
await p.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.7);
await p.waitForTimeout(400);
console.log('url', await p.evaluate(() => location.search));
await done();
await p.waitForTimeout(2500);
await p.waitForFunction(() => /Generated in/.test(document.getElementById('gentime')?.textContent ?? ''), null, { timeout: 600000 });
await p.waitForTimeout(1500);
console.log('list status', await p.evaluate(() => document.getElementById('settlWarn').textContent), JSON.stringify(await p.evaluate(() => window.__burgmap.settlements().map((s) => [s.name, s.cls, Math.round(s.center.x), Math.round(s.center.y)]))));
await p.screenshot({ path: 'out/m3c_ui_list.png' });
console.log(logs.length ? 'ERRORS:\n' + logs.join('\n') : 'no console errors');
await b.close();
