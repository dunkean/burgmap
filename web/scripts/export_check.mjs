// Usage: node scripts/export_check.mjs <baseUrl> <outDir>
// Exercises the three export paths: plain <a download>, the Artifact viewer "downloads" capability, and its error codes.
import { chromium } from 'playwright';
import fs from 'node:fs';
const [base, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const b = await chromium.launch();
let fail = 0;
const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fail++; };

async function open(init) {
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  if (init) await p.addInitScript(init);
  const logs = [];
  p.on('pageerror', (e) => logs.push(e.message));
  await p.goto(base + '?seed=7&size=village&legend=1&style=illuminated');
  await p.waitForFunction(() => /Generated in|failed/.test(document.getElementById('gentime')?.textContent ?? ''), null, { timeout: 120000 });
  await p.waitForTimeout(600);
  return { ctx, p, logs };
}

// A: plain browser
{
  const { ctx, p } = await open();
  for (const [id, ext] of [['exportSvg', '.svg'], ['exportJson', '.json'], ['exportPng', '.png']]) {
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 60000 }).catch(() => null), p.click('#' + id)]);
    ok(!!dl && dl.suggestedFilename().endsWith(ext), `plain ${id} downloads ${dl?.suggestedFilename()}`);
    if (dl) { const f = `${outDir}/plain_${dl.suggestedFilename()}`; await dl.saveAs(f); console.log('    ', f, fs.statSync(f).size, 'bytes'); }
  }
  await ctx.close();
}
// B: Artifact viewer capability
for (const mode of ['granted', 'declined', 'unavailable', 'not_granted', 'nullcap']) {
  const init = `window.__saves = []; window.claude = { use: async (n) => {
    if (n !== 'downloads') return null;
    if ('${mode}' === 'nullcap') return null;
    return { save: async (o) => { window.__saves.push({ filename: o.filename, type: o.data && o.data.constructor ? o.data.constructor.name : typeof o.data, size: o.data.size ?? o.data.length });
      if ('${mode}' !== 'granted') throw { code: '${mode}' }; } }; } };`;
  const { ctx, p, logs } = await open(init);
  let downloads = 0;
  p.on('download', () => downloads++);
  for (const id of ['exportSvg', 'exportJson', 'exportPng']) { await p.click('#' + id); await p.waitForTimeout(id === 'exportPng' ? 4000 : 1200); }
  const saves = await p.evaluate(() => window.__saves);
  const expectFallback = mode === 'unavailable' || mode === 'not_granted' || mode === 'nullcap';
  console.log(mode, JSON.stringify(saves), 'anchor downloads:', downloads);
  if (mode === 'nullcap') ok(saves.length === 0 && downloads === 3, 'null capability -> anchor fallback x3');
  else {
    ok(saves.length === 3 && saves.map((s) => s.filename.split('.').pop()).join() === 'svg,json,png', `${mode}: save() called for svg,json,png`);
    ok(expectFallback ? downloads === 3 : downloads === 0, `${mode}: ${expectFallback ? 'fell back to <a download>' : 'no fallback download'}`);
  }
  ok(logs.length === 0, `${mode}: no page errors ${logs.join('|')}`);
  await ctx.close();
}
await b.close();
console.log(fail ? `${fail} FAILED` : 'all export checks passed');
process.exit(fail ? 1 : 0);
