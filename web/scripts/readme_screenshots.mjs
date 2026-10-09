// Capture the actual Canvas application from its self-contained build.
// Run npm run build first, then node scripts/readme_screenshots.mjs from web/.
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const web = fileURLToPath(new URL('..', import.meta.url));
const output = path.resolve(web, '../docs/images');
const cases = [
  { name: 'medieval-city', seed: '42', size: 'city', population: '30000', culture: 'european-organic', style: 'parchment', biome: 'temperate', relief: 'flat', river: 'river', extent: 3000 },
  { name: 'desert-medina', seed: '73', size: 'city', population: '30000', culture: 'medina', style: 'atlas', biome: 'desert', relief: 'flat', river: 'none', extent: 2400 },
  { name: 'chinese-city', seed: '19', size: 'city', population: '30000', culture: 'chinese', style: 'atlas', biome: 'temperate', relief: 'flat', river: 'river', extent: 3000 },
  { name: 'village', seed: '7', size: 'village', population: '600', culture: 'european-organic', style: 'parchment', biome: 'temperate', relief: 'hills', river: 'stream', extent: 1800 },
];

await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const selected = new Set(process.argv.slice(2));
const manifest = selected.size ? JSON.parse(await readFile(path.join(output, 'screenshots.json'), 'utf8')).screenshots : [];
try {
  for (const { name, extent, ...settings } of cases) {
    if (selected.size && !selected.has(name)) continue;
    console.log(`Generating ${name}`);
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const query = new URLSearchParams({ ...settings, coast: 'none', labels: '0', legend: '0' });
    const url = pathToFileURL(path.join(web, 'dist/index.html'));
    url.search = query.toString();
    await page.goto(url.href);
    await page.waitForFunction(() => window.__magnaUrbis?.rendering().gen > 0 && window.__magnaUrbis.rendering().ready, null, { timeout: 300000 });
    console.log(`Rendered ${name}`);
    const view = await page.evaluate(extent => {
      const app = window.__magnaUrbis;
      const center = app.center();
      // These examples use the ordinary city/village preset extents.
      const mapExtent = app.options().size === 'village' ? 1600 : 3600;
      const scale = Math.max(Math.min(innerWidth, innerHeight) / extent, innerWidth / mapExtent);
      const halfWidth = innerWidth / (2 * scale), halfHeight = innerHeight / (2 * scale);
      const view = { cx: Math.max(halfWidth, Math.min(mapExtent - halfWidth, center.x)), cy: Math.max(halfHeight, Math.min(mapExtent - halfHeight, center.y)), scale };
      app.setView(view);
      return view;
    }, extent);
    // Let the final view and painted assets reach the Canvas.
    await page.waitForTimeout(1800);
    if (errors.length) throw new Error(`${name}: ${errors.join('; ')}`);
    if (!(await page.title()).includes('Magna Urbis')) throw new Error('Unexpected application title');
    await page.screenshot({ path: path.join(output, name + '.png'), timeout: 90000 });
    const capture = { image: name + '.png', implementation: 'typescript', settings: Object.fromEntries(query), view, viewport: { width: 1600, height: 1000 }, capture: 'Application screenshot; no retouching' };
    const index = manifest.findIndex(item => item.image === capture.image);
    if (index < 0) manifest.push(capture); else manifest[index] = capture;
    console.log(`Captured ${name}`);
    await page.close();
  }
  await writeFile(path.join(output, 'screenshots.json'), JSON.stringify({ project: 'Magna Urbis', screenshots: manifest }, null, 2) + '\n');
} finally {
  await browser.close();
}
