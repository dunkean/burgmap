import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
const logs = []; p.on('console', m => logs.push(m.text()));
await p.goto('http://localhost:5173/?seed=4&size=town');
const wait = async () => { await p.waitForTimeout(500); await p.waitForFunction(() => !document.querySelector('#gentime')?.textContent?.includes('…'), null, { timeout: 60000 }).catch(() => {}); await p.waitForTimeout(6000); };
await wait();
const status = async (tag) => console.log(tag, '| url:', p.url().split('?')[1], '| status:', (await p.textContent('#status').catch(() => '') || (await p.textContent('#gentime').catch(() => ''))).slice(0, 160));
await p.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true)); await status('initial');
for (const c of ['kraal', 'european-organic', 'barbarian-germanic', 'european-organic']) {
  await p.evaluate((v) => { const e = document.getElementById('culture'); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); e.dispatchEvent(new Event('input', { bubbles: true })); }, c); await wait(); await status('after ' + c);
}
await p.screenshot({ path: 'out/repro_after.png' });
await b.close();
