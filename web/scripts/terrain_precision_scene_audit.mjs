// Compare decoded complete SVG scenes, including the existing contour renderer.
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto('http://127.0.0.1:5175/precision.html');
  const results = await page.evaluate(async () => {
    async function pixels(svg) {
      const clone = svg.cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', '768'); clone.setAttribute('height', '768');
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
      try {
        const img = new Image(); img.src = url; await img.decode();
        const canvas = new OffscreenCanvas(768,768), ctx = canvas.getContext('2d');
        ctx.drawImage(img,0,0); return ctx.getImageData(0,0,768,768).data;
      } finally { URL.revokeObjectURL(url); }
    }
    const results = [];
    for (const section of document.querySelectorAll('section')) {
      const articles = [...section.querySelectorAll('article')];
      const reference = await pixels(articles[0].querySelector('svg'));
      for (const article of articles.slice(1)) {
        const actual = await pixels(article.querySelector('svg'));
        let max = 0, changed = 0, over2 = 0, over8 = 0, sq = 0;
        for (let i = 0; i < 768*768; i++) {
          let pixelMax = 0;
          for (let k = 0; k < 4; k++) { const d = Math.abs(actual[i*4+k] - reference[i*4+k]); pixelMax = Math.max(pixelMax,d); sq += d*d; }
          max=Math.max(max,pixelMax); if(pixelMax)changed++; if(pixelMax>=2)over2++; if(pixelMax>=8)over8++;
        }
        results.push({ title: article.querySelector('h2').textContent, maxChannel: max, rms: Math.sqrt(sq/reference.length), changedPercent: changed/(768*768)*100, over2Percent: over2/(768*768)*100, over8Percent: over8/(768*768)*100 });
      }
    }
    return results;
  });
  await page.goto('http://127.0.0.1:5175/terrainbench.html?seed=42&width=3000&motif=3000&relief=flat&erosion=0.5');
  await page.waitForFunction(() => document.getElementById('status')?.textContent.includes('détail 768'), { timeout: 60000 });
  const status = await page.locator('#status').textContent();
  const result = { browser: browser.version(), errors, status, results };
  await writeFile(fileURLToPath(new URL('../../rust/out/perf-audit/precision-scenes.json', import.meta.url)), JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
  if (errors.length) throw new Error(JSON.stringify(errors));
} finally { await browser.close(); }
