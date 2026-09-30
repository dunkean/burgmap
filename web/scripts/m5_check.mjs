// Usage: node scripts/m5_check.mjs <baseUrl> <outDir>
// M5a UI checks: heightmap import (radial hill PNG via fflate), share/copy link, random + R key, history back/forward, exports.
import { chromium } from 'playwright';
import { zlibSync } from 'fflate';
import fs from 'node:fs';
const [base, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });

const CT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = CT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
  return out;
}
/** Radial hill (+ a ridge) as an 8-bit grayscale PNG. */
function hillPng(n) {
  const raw = new Uint8Array((n + 1) * n);
  for (let y = 0; y < n; y++) {
    raw[y * (n + 1)] = 0;
    for (let x = 0; x < n; x++) {
      const dx = (x - n * 0.42) / n, dy = (y - n * 0.45) / n;
      const r = Math.hypot(dx, dy);
      const hill = Math.max(0, 1 - r / 0.5) ** 1.3;
      const ridge = 0.25 * Math.exp(-(((x - n * 0.8) / n) ** 2) / 0.01);
      raw[y * (n + 1) + 1 + x] = Math.round(255 * Math.min(1, 0.12 + 0.75 * hill + ridge));
    }
  }
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, n); dv.setUint32(4, n); ihdr[8] = 8; ihdr[9] = 0;
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return Buffer.from(out);
}
const hm = `${outDir}/hill.png`;
fs.writeFileSync(hm, hillPng(384));

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
const p = await ctx.newPage();
const logs = [];
p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const ready = () => p.waitForFunction(() => /Generated in|failed/.test(document.getElementById('gentime')?.textContent ?? ''), null, { timeout: 120000 });
const reset = () => p.evaluate(() => { document.getElementById('gentime').textContent = ''; });
const step = async (name, f) => { const t0 = Date.now(); await f(); console.log(`ok ${name} (${Date.now() - t0} ms)`); };

await p.goto(`${base}?seed=5&size=village`);
await ready();
await p.waitForTimeout(400);

await step('import heightmap', async () => {
  await reset();
  await p.setInputFiles('#hmFile', hm);
  await ready();
  await p.waitForTimeout(600);
  console.log('  url:', await p.evaluate(() => location.search));
  console.log('  info:', await p.evaluate(() => document.getElementById('hmInfo').textContent), '|', await p.evaluate(() => document.getElementById('shareState').textContent));
  await p.screenshot({ path: `${outDir}/hm_import.png` });
});

await step('determinism with heightmap', async () => {
  const sig = () => p.evaluate(() => { const w = window.__burgmap.world(); return JSON.stringify([w.names.town, w.urban.population, w.urban.buildings.length, Math.round(w.terrain.height.data[5000] * 100)]); });
  const a = await sig();
  await reset();
  await p.fill('#hmScale', '200'); await p.dispatchEvent('#hmScale', 'change');
  await ready();
  const c = await sig();
  await reset();
  await p.fill('#hmScale', '120'); await p.dispatchEvent('#hmScale', 'change');
  await ready();
  const d = await sig();
  console.log('  same after scale round trip:', a === d, ' differs at other scale:', a !== c);
  await p.screenshot({ path: `${outDir}/hm_back.png` });
});

await step('sea level', async () => {
  await reset();
  await p.fill('#hmSea', '25'); await p.dispatchEvent('#hmSea', 'change');
  await ready(); await p.waitForTimeout(500);
  console.log('  seaFraction', await p.evaluate(() => window.__burgmap.world().stats.seaFraction), 'url', await p.evaluate(() => location.search));
  await p.screenshot({ path: `${outDir}/hm_sea.png` });
  await reset();
  await p.fill('#hmSea', '0'); await p.dispatchEvent('#hmSea', 'change');
  await ready();
});

await step('copy link', async () => {
  await p.click('#copyLink');
  await p.waitForTimeout(300);
  const clip = await p.evaluate(() => navigator.clipboard.readText().catch((e) => 'ERR ' + e.message));
  console.log('  clipboard:', clip, '| button:', await p.evaluate(() => document.getElementById('copyLink').textContent));
  console.log('  chip:', await p.evaluate(() => document.getElementById('shareState').textContent));
  await p.screenshot({ path: `${outDir}/copy_link.png` });
});

await step('random button + R key + history', async () => {
  const seed0 = await p.inputValue('#seed');
  await reset(); await p.click('#dice'); await ready();
  const seed1 = await p.inputValue('#seed');
  await reset(); await p.keyboard.press('r'); await ready();
  const seed2 = await p.inputValue('#seed');
  console.log('  seeds:', seed0, seed1, seed2, 'distinct:', new Set([seed0, seed1, seed2]).size === 3);
  await reset(); await p.goBack(); await ready();
  console.log('  back ->', await p.inputValue('#seed'), 'expected', seed1);
  await reset(); await p.goBack(); await ready();
  console.log('  back ->', await p.inputValue('#seed'), 'expected', seed0, 'custom still on:', await p.evaluate(() => !!window.__burgmap.options().importedHeight));
  await reset(); await p.goForward(); await ready();
  console.log('  fwd ->', await p.inputValue('#seed'), 'expected', seed1);
});

await step('collapsible sections + plan slot', async () => {
  await p.click('#sec-terrain > summary');
  await p.click('#sec-plan > summary');
  await p.waitForTimeout(200);
  await p.screenshot({ path: `${outDir}/panel_sections.png` });
  await p.click('#sec-terrain > summary');
  await p.click('#sec-plan > summary');
});

await step('legend toggle + labels toggle (no regeneration)', async () => {
  await reset();
  await p.check('#legend');
  await p.waitForTimeout(500);
  console.log('  regenerated?', (await p.textContent('#gentime')) === '' ? 'no' : 'YES');
  await p.screenshot({ path: `${outDir}/legend_on.png` });
  await p.uncheck('#labels');
  await p.waitForTimeout(400);
  console.log('  labels placed with labels off:', await p.evaluate(() => window.__burgmap.labels().length));
  await p.check('#labels');
});

await step('exports', async () => {
  for (const id of ['exportSvg', 'exportPng']) {
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 60000 }).catch(() => null), p.click('#' + id)]);
    if (dl) { const f = `${outDir}/${dl.suggestedFilename()}`; await dl.saveAs(f); console.log('  ', id, f, fs.statSync(f).size, 'bytes'); } else console.log('  ', id, 'NO DOWNLOAD');
  }
});

await p.setViewportSize({ width: 600, height: 800 });
await p.waitForTimeout(400);
await p.screenshot({ path: `${outDir}/mobile_closed.png` });
await p.click('#menuBtn');
await p.waitForTimeout(400);
await p.screenshot({ path: `${outDir}/mobile_open.png` });

console.log(logs.length ? 'CONSOLE:\n' + logs.slice(0, 30).join('\n') : 'no console errors');
await b.close();
