// Usage: node scripts/m5b_shots.mjs <baseUrl> <outDir> [--styles a,b] [--cases s7,s11c] [--scales fit,1]
// One browser session per case; the style is switched through the UI select (must re-render, never regenerate).
import { chromium } from 'playwright';
import fs from 'node:fs';
const a = process.argv.slice(2);
const base = a[0], outDir = a[1];
const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const ALL = ['parchment', 'atlas', 'watabou', 'engraving', 'cadastre', 'blueprint', 'illuminated', 'topographic', 'night'];
const styles = opt('--styles', ALL.join(',')).split(',');
const CASES = { s7: 'seed=7&size=town', s11c: 'seed=11&size=town&coast=random', s3v: 'seed=3&size=village', s5c: 'seed=5&size=city' };
const cases = opt('--cases', 's7,s11c').split(',');
const scales = opt('--scales', 'fit,1').split(',');
fs.mkdirSync(outDir, { recursive: true });
const b = await chromium.launch();
let bad = 0;
for (const c of cases) {
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
  const p = await ctx.newPage();
  const logs = [];
  p.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
  p.on('pageerror', (e) => logs.push('pageerror ' + e.message));
  await p.goto(base + '?' + CASES[c]);
  await p.waitForFunction(() => /Generated in|failed/.test(document.getElementById('gentime')?.textContent ?? ''), null, { timeout: 120000 });
  await p.waitForTimeout(500);
  await p.evaluate(() => { window.__w0 = window.__burgmap.world(); });
  for (const st of styles) {
    await p.selectOption('#style', st);
    await p.waitForTimeout(400);
    const same = await p.evaluate(() => window.__burgmap.world() === window.__w0);
    if (!same) { bad++; console.log('REGENERATED on style switch!', st); }
    for (const sc of scales) {
      await p.evaluate((sc) => {
        const h = window.__burgmap;
        if (sc === 'fit') h.fit(); else { const cc = h.center(); h.setView({ cx: cc.x, cy: cc.y, scale: Number(sc) }); }
      }, sc);
      await p.waitForTimeout(450);
      await p.locator('#map').screenshot({ path: `${outDir}/${st}_${c}_${sc}.png` });
    }
    console.log('done', c, st);
  }
  if (logs.length) console.log('CONSOLE', c, logs.slice(0, 10).join('\n'));
  await ctx.close();
}
console.log(bad ? `FAIL: ${bad} regenerations` : 'style switch never regenerated');
await b.close();
