import { mkdirSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { BIOME_NAMES } from '../src/gen/biomes';
import { Rng } from '../src/gen/core/rng';
import { makeOptions } from '../src/gen/options';
import { generate } from '../src/gen/pipeline';
import { generateRural } from '../src/gen/landuse/rural';
import { renderSvg } from '../src/render/svg';
import { area } from '../src/gen/geo/poly';

const base = generate(makeOptions({ seed: '42', size: 'village', settlements: 'none', labels: false, legend: true }));
mkdirSync('out/biomes', { recursive: true });
for (const biome of BIOME_NAMES) {
  const world = { ...base, options: { ...base.options, biome } };
  world.landuse = generateRural(world, new Rng('burgmap:' + world.seed), world.roads!.length).layer;
  const svg = renderSvg(world);
  writeFileSync(`out/biomes/${biome}.svg`, svg);
  writeFileSync(`out/biomes/${biome}.png`, new Resvg(svg, { fitTo: { mode: 'width', value: 1100 } }).render().asPng());
  const cover: Record<string, number> = {};
  for (const a of world.landuse.areas) cover[a.kind] = (cover[a.kind] ?? 0) + (area(a.poly) - (a.holes ?? []).reduce((s, h) => s + area(h), 0)) / 1e4;
  console.log(biome, JSON.stringify(cover));
}
