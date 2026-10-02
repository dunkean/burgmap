// Usage: node scripts/perf_report.mjs  - prints markdown tables from out/perf/{before3,after,after2}.json (seed 1 rows)
import fs from 'node:fs';
const rd = (f) => (fs.existsSync('out/perf/' + f) ? JSON.parse(fs.readFileSync('out/perf/' + f, 'utf8')) : []);
const before = rd('before3.json'), after = [...rd('after.json'), ...rd('after2.json')];
const pick = (arr, size) => arr.find((r) => r.size === size && r.seed === '1');
const f = (v, d = 0) => (v === undefined || v === null ? '-' : Number(v).toFixed(d));
const sizes = ['hamlet', 'town', 'city', 'capital'];
let o = '';
o += '| size | gen (worker) ms | clone to page ms | buildScene ms | time to first map (before / after) ms | time to final map (before / after) ms | main-thread long tasks on load (before / after) ms |\n|---|---|---|---|---|---|---|\n';
for (const s of sizes) {
  const b = pick(before, s), a = pick(after, s);
  if (!b || !a) continue;
  o += `| ${s} | ${f(b.t.genWorker)} | ${f(b.t.transfer)} | ${f(b.t.buildScene)} | ${f(b.t.startToFrame)} / ${f(a.t.firstFrame)} | ${f(b.t.startToFrame)} / ${f(a.t.startToFrame)} | ${f(b.longTasks.sum)} / ${f(a.longTasks.sum)} |\n`;
}
o += '\nPan, 90 scripted frames (rAF interval p50 / p95 ms, main-thread long tasks ms) before -> after\n\n| size | fit | 0.25 px/m | 0.6 px/m | 1.5 px/m |\n|---|---|---|---|---|\n';
for (const s of sizes) {
  const b = pick(before, s), a = pick(after, s);
  if (!b || !a) continue;
  const c = (k, m) => `${f(b[m][k].interval.p50)}/${f(b[m][k].interval.p95)} (${f(b[m][k].longTaskMs)}) -> ${f(a[m][k].interval.p50)}/${f(a[m][k].interval.p95)} (${f(a[m][k].longTaskMs)})`;
  o += `| ${s} | ${['fit', '0.25', '0.6', '1.5'].map((k) => c(k, 'pan')).join(' | ')} |\n`;
}
o += '\nZoom (same format)\n\n| size | fit | 0.25 px/m | 0.6 px/m | 1.5 px/m |\n|---|---|---|---|---|\n';
for (const s of sizes) {
  const b = pick(before, s), a = pick(after, s);
  if (!b || !a) continue;
  const c = (k, m) => `${f(b[m][k].interval.p50)}/${f(b[m][k].interval.p95)} (${f(b[m][k].longTaskMs)}) -> ${f(a[m][k].interval.p50)}/${f(a[m][k].interval.p95)} (${f(a[m][k].longTaskMs)})`;
  o += `| ${s} | ${['fit', '0.25', '0.6', '1.5'].map((k) => c(k, 'zoom')).join(' | ')} |\n`;
}
o += '\nIn-worker frame cost after (ms, p50; the canvas command recording) and settle time after the last view change (ms, pan at 0.6):\n\n| size | draw p50 @0.6 | settle |\n|---|---|---|\n';
for (const s of sizes) { const a = pick(after, s); if (a) o += `| ${s} | ${f(a.pan['0.6'].draw?.p50, 1)} | ${f(a.pan['0.6'].settleMs)} |\n`; }
o += '\nExports (wall ms / worst main-thread frame gap ms / long-task ms) before -> after\n\n| size | SVG | PNG |\n|---|---|---|\n';
for (const s of sizes) {
  const b = pick(before, s), a = pick(after, s);
  if (!b || !a) continue;
  const e = (x) => `${f(x.wall)} / ${f(x.worstFrameGap)} / ${f(x.longTaskMs)}`;
  o += `| ${s} | ${e(b.exportSvg)} -> ${e(a.exportSvg)} | ${e(b.exportPng)} -> ${e(a.exportPng)} |\n`;
}
console.log(o);
