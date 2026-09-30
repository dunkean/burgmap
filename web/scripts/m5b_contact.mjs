// Usage: node scripts/m5b_contact.mjs <outDir> <case> <scale>  -> <outDir>/contact_<case>_<scale>.png (all styles in a 3x3 grid)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const [dir, c, sc] = process.argv.slice(2);
const ALL = ['parchment', 'atlas', 'watabou', 'engraving', 'cadastre', 'blueprint', 'illuminated', 'topographic', 'night'];
const abs = path.resolve(dir);
const cells = ALL.map((s) => {
  const b64 = fs.readFileSync(`${abs}/${s}_${c}_${sc}.png`).toString('base64');
  return `<figure><img src="data:image/png;base64,${b64}"><figcaption>${s}</figcaption></figure>`;
}).join('');
const html = `<body style="margin:0;background:#222;font:14px sans-serif;color:#fff"><div style="display:grid;grid-template-columns:repeat(3,520px);gap:4px;padding:4px">${cells}</div><style>figure{margin:0;position:relative}img{width:520px;display:block}figcaption{position:absolute;left:6px;bottom:6px;background:#000a;padding:2px 8px;border-radius:3px}</style></body>`;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 1300 } });
await p.setContent(html);
await p.waitForTimeout(500);
await p.screenshot({ path: `${abs}/contact_${c}_${sc}.png`, fullPage: true });
await b.close();
console.log('ok');
