// Interactive precision diagnostics, no screenshots or CI suites.
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
page.on('pageerror', e => errors.push(e.message));
page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.addInitScript(() => {
  window.gpuAudit = [];
  const Original = window.Worker;
  window.Worker = class extends Original {
    constructor(...args) { super(...args); this.addEventListener('message', e => { if (e.data.terrain) {
      const { backend, backendReason, prepareMs, samplingMs, gpuSetupMs, generationMs, resolution } = e.data.terrain;
      window.gpuAudit.push({ backend, backendReason, prepareMs, samplingMs, gpuSetupMs, generationMs, resolution, kind: e.data.kind });
    } }); }
  };
});
try {
  const results = [];
  for (const relief of ['mountains','hills','valley']) {
    await page.goto(`http://localhost:5173/terrainbench.html?seed=42&width=3000&motif=3000&relief=${relief}&erosion=0.5&compute=gpu-fp16&auto=0`);
    await page.waitForFunction(() => document.getElementById('status')?.textContent.includes('détail 768'), { timeout: 120000 });
    results.push({ relief, mode: 'gpu-fp16', status: await page.locator('#status').textContent(), events: await page.evaluate(() => window.gpuAudit) });
    for (const mode of ['gpu-f32','gpu-fp16-accum','gpu-fp16','wasm']) {
      await page.evaluate(() => { window.gpuAudit = []; });
      await page.locator('#compute').selectOption(mode);
      await page.waitForFunction(mode => {
        const events = window.gpuAudit;
        return events?.some(e => e.kind === 'detail' && e.backend === mode) && document.getElementById('status')?.textContent.includes('détail 768');
      }, mode, { timeout: 120000 });
      results.push({ relief, mode, status: await page.locator('#status').textContent(), events: await page.evaluate(() => window.gpuAudit) });
    }
    console.log(JSON.stringify(results.filter(r => r.relief === relief)));
  }
  await writeFile(root + '/rust/out/perf-audit/gpu-live.json',JSON.stringify({ browser:browser.version(),errors,results },null,2));
  if(errors.length)throw new Error(JSON.stringify(errors));
} finally { await browser.close(); }
