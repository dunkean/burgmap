/** Side-by-side comparison: npx tsx scripts/sidebyside.ts out.png "left label" left.png "right label" right.png [...] */
import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const args = process.argv.slice(2);
const out = args[0];
const items: { label: string; file: string }[] = [];
for (let i = 1; i + 1 < args.length; i += 2) items.push({ label: args[i], file: args[i + 1] });
const W = 900, H = 900, pad = 10, top = 34;
const total = items.length * (W + pad) + pad;
let body = `<rect width="${total}" height="${H + top + pad}" fill="#fff"/>`;
items.forEach((it, k) => {
  const x = pad + k * (W + pad);
  const b64 = readFileSync(it.file).toString('base64');
  body += `<text x="${x + 4}" y="24" font-family="sans-serif" font-size="20" fill="#222">${it.label}</text>`;
  body += `<image x="${x}" y="${top}" width="${W}" height="${H}" href="data:image/png;base64,${b64}" preserveAspectRatio="xMidYMid slice"/>`;
});
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${H + top + pad}" viewBox="0 0 ${total} ${H + top + pad}">${body}</svg>`;
writeFileSync(out, new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng());
