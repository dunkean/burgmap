// Usage: node scripts/ui_check.mjs <baseUrl> <outDir> [--set "seed=1&size=town&style=atlas"] [--name tag] [--scales 0.04,0.12,0.6] [--exports]
// Screenshots the UI at several zooms on the settlement centre (via window.__burgmap) and optionally tests the exports.
import { chromium } from 'playwright';
import fs from 'node:fs';
const a = process.argv.slice(2);
const base = a[0], outDir = a[1];
const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const query = opt('--set', 'seed=1'), tag = opt('--name', 'shot');
const scales = opt('--scales', 'fit,0.12,0.5').split(',');
fs.mkdirSync(outDir, { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const p = await ctx.newPage();
const logs = [];
p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
p.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
const url = base + (base.includes('?') ? '&' : '?') + query;
await p.goto(url);
await p.waitForFunction(() => /ms total|Error/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 120000 });
await p.waitForTimeout(800);
console.log('status:', await p.evaluate(() => document.getElementById('status').textContent));
for (const sc of scales) {
  await p.evaluate((sc) => {
    const h = window.__burgmap;
    if (sc === 'fit') h.fit(); else { const c = h.center(); h.setView({ cx: c.x, cy: c.y, scale: Number(sc) }); }
  }, sc);
  await p.waitForTimeout(500);
  const f = `${outDir}/${tag}_${sc}.png`;
  await p.screenshot({ path: f });
  console.log('shot', f, await p.evaluate(() => document.getElementById('hud')?.textContent));
}
if (a.includes('--exports')) {
  for (const id of ['exportSvg', 'exportPng']) {
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 60000 }).catch(() => null), p.click('#' + id)]);
    if (dl) { const f = `${outDir}/${tag}_${dl.suggestedFilename()}`; await dl.saveAs(f); console.log(id, 'download', f, fs.statSync(f).size, 'bytes'); }
    else console.log(id, 'NO DOWNLOAD');
  }
}
console.log(logs.length ? 'CONSOLE:\n' + logs.slice(0, 30).join('\n') : 'no console errors');
await b.close();
