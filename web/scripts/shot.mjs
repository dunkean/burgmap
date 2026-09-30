// Usage: node scripts/shot.mjs <url> <out.png> [waitMs]
import { chromium } from 'playwright';
const [url, out, wait = '15000'] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
const logs = [];
p.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
p.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
await p.goto(url);
await p.waitForTimeout(Number(wait));
await p.screenshot({ path: out });
console.log(logs.slice(0, 40).join('\n'));
await b.close();
