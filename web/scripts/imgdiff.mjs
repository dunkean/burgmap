// Usage: node scripts/imgdiff.mjs a.png b.png   - fraction of pixels that differ (channel delta > 24) and the max delta.
import { chromium } from 'playwright';
import fs from 'node:fs';
const [a, b] = process.argv.slice(2);
const br = await chromium.launch();
const p = await br.newPage();
const url = (f) => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
const r = await p.evaluate(async ([ua, ub]) => {
  const load = (u) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = u; });
  const [ia, ib] = await Promise.all([load(ua), load(ub)]);
  const get = (i) => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0); return x.getImageData(0, 0, i.width, i.height).data; };
  const A = get(ia), B = get(ib);
  let n = 0, mx = 0;
  for (let k = 0; k < A.length; k += 4) { const d = Math.max(Math.abs(A[k] - B[k]), Math.abs(A[k + 1] - B[k + 1]), Math.abs(A[k + 2] - B[k + 2])); if (d > 24) n++; if (d > mx) mx = d; }
  return { w: ia.width, h: ia.height, differing: n / (A.length / 4), max: mx };
}, [url(a), url(b)]);
console.log(JSON.stringify(r));
await br.close();
