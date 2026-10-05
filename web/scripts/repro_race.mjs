import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
await p.goto('http://localhost:5173/?seed=4&size=city'); await p.waitForTimeout(15000);
const set = (v) => p.evaluate((v) => { const e = document.getElementById('culture'); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); }, v);
await set('medina'); await p.waitForTimeout(300); await set('chinese'); await p.waitForTimeout(300); await set('european-organic');
await p.waitForTimeout(25000);
console.log('final url:', p.url().split('?')[1], '| status:', (await p.textContent('#status')).slice(0, 170));
await p.screenshot({ path: 'out/repro_race.png' }); await b.close();
