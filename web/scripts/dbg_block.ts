/** Parcels and buildings of the block containing a point: npx tsx scripts/dbg_block.ts seed size x y */
import { generate } from '../src/gen/pipeline';
import { makeOptions, SizeName } from '../src/gen/options';
import { pointInRing, area, obb } from '../src/gen/geo/poly';
import { dist } from '../src/gen/core/geom';

const [seed, size, xs, ys] = process.argv.slice(2);
const w = generate(makeOptions({ seed, size: size as SizeName }));
const u = w.urban!;
const p = { x: Number(xs), y: Number(ys) };
const bi = u.blocks.findIndex((b) => pointInRing(b, p));
console.log('block', bi, u.blockInfo[bi], 'area', area(u.blocks[bi]).toFixed(0));
u.parcels.forEach((pc, i) => {
  if (pc.block !== bi) return;
  const o = obb(pc.poly);
  const bl = u.buildings.filter((b) => b.parcel === i);
  console.log(i, pc.use, 'area', area(pc.poly).toFixed(0), 'obb', (2 * o.hu).toFixed(1), 'x', (2 * o.hv).toFixed(1), 'front', pc.front ? dist(pc.front[0], pc.front[1]).toFixed(1) : '-', 'bldgs', bl.length, bl.map((b) => b.kind + ':' + area(b.poly).toFixed(0)).join(' '));
});
