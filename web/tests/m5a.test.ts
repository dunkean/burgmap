import { describe, it, expect } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { fromQuery, toQuery, wantsCustomHeight } from '../src/gen/options';
import { Rng } from '../src/gen/core/rng';
import { VOCAB } from '../src/gen/names/grammar';
import { familyFor, generateNames, NAME_FAMILIES } from '../src/gen/names';
import { heightFromImage } from '../src/gen/terrain/import';
import { PALETTES } from '../src/render/styles';
import { buildMapLabels, placeMapLabels, layoutGlyphs, estimateWidth } from '../src/render/mapLabels';
import { renderSvg } from '../src/render/svg';
import { cartoucheModel, legendModel, niceLength, fmtPop } from '../src/render/legend';
import type { World } from '../src/gen/types';

const measure = estimateWidth;

describe('toponym grammars', () => {
  it('every family generates distinct, non-empty, deterministic names', () => {
    for (const f of NAME_FAMILIES) {
      const V = VOCAB[f];
      const names = new Set<string>();
      for (let i = 0; i < 40; i++) {
        const n = V.place(new Rng('t' + i), (i % 3) as 0 | 1 | 2);
        expect(n.length).toBeGreaterThan(2);
        expect(n).not.toMatch(/undefined|NaN/);
        names.add(n);
      }
      expect(names.size, f).toBeGreaterThan(25);
      expect(V.place(new Rng('same'), 0)).toBe(V.place(new Rng('same'), 0));
      expect(V.saint(new Rng('s')).length).toBeGreaterThan(1);
      expect(V.st.minor(new Rng('m')).length).toBeGreaterThan(2);
    }
  });
  it('culture ids map to a family; language overrides; european default is french or english', () => {
    expect(familyFor('medina', 'auto', 'x')).toBe('arabic');
    expect(familyFor('chinese', undefined, 'x')).toBe('chinese');
    expect(familyFor('japanese-jokamachi', 'auto', 'x')).toBe('japanese');
    expect(familyFor('dwarven', 'auto', 'x')).toBe('dwarven');
    expect(familyFor('european-organic', 'german', 'x')).toBe('german');
    const eu = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((s) => familyFor('european-organic', 'auto', s)));
    for (const f of eu) expect(['french', 'english']).toContain(f);
    expect(familyFor('some-future-culture', 'auto', 'x')).toMatch(/french|english/);
  });
});

describe('names on a generated world', () => {
  const w = generate(makeOptions({ seed: '7', size: 'town', language: 'french' }));
  it('layer is complete, anchored and deterministic', () => {
    const n = w.names!;
    expect(n.family).toBe('french');
    const kinds = new Set(n.entries.map((e) => e.kind));
    for (const k of ['town', 'street', 'river', 'church', 'gate', 'village', 'quarter', 'forest']) expect(kinds.has(k as never), k).toBe(true);
    for (const e of n.entries) {
      expect(e.text.length).toBeGreaterThan(1);
      expect(Number.isFinite(e.anchor.x + e.anchor.y)).toBe(true);
      if (e.kind === 'street' || e.kind === 'river') expect(e.path!.length).toBeGreaterThan(1);
    }
    const streets = n.entries.filter((e) => e.kind === 'street').map((e) => e.text);
    expect(new Set(streets).size).toBe(streets.length);
    expect(streets.some((s) => /^(Grand-Rue|Rue Maîtresse|Rue Principale)$/.test(s))).toBe(true);
    const again = generateNames(w, new Rng('magna-urbis:' + w.seed));
    // (the settlement labels of the M3c system are appended after generateNames)
    expect(again.entries.map((e) => e.text)).toEqual(n.entries.filter((e) => !e.sub?.startsWith('settlement:')).map((e) => e.text));
  });
  it('degrades gracefully without urban / landuse / roads layers', () => {
    const bare = { ...w, urban: undefined, landuse: undefined, roads: undefined, bridges: undefined, names: undefined } as World;
    const n = generateNames(bare, new Rng('magna-urbis:7'));
    expect(n.town.length).toBeGreaterThan(2);
    expect(n.entries.some((e) => e.kind === 'town')).toBe(true);
  });
});

describe('label engine', () => {
  const w = generate(makeOptions({ seed: '7', size: 'town' }));
  const pal = PALETTES.parchment;
  const labels = buildMapLabels(w, 'parchment', pal);
  const c = w.site!.center;
  const box = (p: ReturnType<typeof placeMapLabels>[number]) => {
    const xs = p.glyphs.map((g) => g.x), ys = p.glyphs.map((g) => g.y);
    return { x0: Math.min(...xs) - p.size * 0.3, x1: Math.max(...xs) + p.size * 0.3, y0: Math.min(...ys) - p.size * 0.3, y1: Math.max(...ys) + p.size * 0.3 };
  };
  it('town name wins when far, street names appear when near', () => {
    const far = placeMapLabels(labels, { cx: w.mapSize / 2, cy: w.mapSize / 2, scale: 0.1 }, 1100, 800, measure);
    expect(far.some((p) => p.label.kind === 'town')).toBe(true);
    expect(far.some((p) => p.label.kind === 'street' && (p.label.rank ?? 9) >= 3)).toBe(false);
    const near = placeMapLabels(labels, { cx: c.x, cy: c.y, scale: 1.4 }, 1100, 800, measure);
    expect(near.filter((p) => p.label.kind === 'street').length).toBeGreaterThan(5);
    expect(near.some((p) => p.label.kind === 'town')).toBe(false);
  });
  it('placed labels stay on screen and (as padded boxes of straight labels) never overlap', () => {
    for (const s of [0.1, 0.36, 0.8, 1.4]) {
      const placed = placeMapLabels(labels, { cx: c.x, cy: c.y, scale: s }, 1100, 800, measure);
      for (const p of placed) for (const g of p.glyphs) { expect(g.x).toBeGreaterThan(-2); expect(g.x).toBeLessThan(1102); }
      const straight = placed.filter((p) => !p.path);
      for (let i = 0; i < straight.length; i++) for (let j = i + 1; j < straight.length; j++) {
        const a = box(straight[i]), b = box(straight[j]);
        const ov = a.x0 < b.x1 - 1 && a.x1 > b.x0 + 1 && a.y0 < b.y1 - 1 && a.y1 > b.y0 + 1;
        expect(ov, `${straight[i].label.text} / ${straight[j].label.text} @${s}`).toBe(false);
      }
    }
  });
  it('curved labels follow the path: glyph angles vary, text reads left to right', () => {
    const placed = placeMapLabels(labels, { cx: c.x, cy: c.y, scale: 1.4 }, 1100, 800, measure);
    const curved = placed.filter((p) => p.path);
    expect(curved.length).toBeGreaterThan(3);
    for (const p of curved) {
      // first glyph never upside down; up to ~96° is still read left to right on near-vertical paths
      expect(Math.cos(p.glyphs[0].a)).toBeGreaterThanOrEqual(-0.1);
      expect(p.glyphs.length).toBe(p.label.text.length);
    }
  });
  it('small caps shrink the non-initial letters', () => {
    const q = labels.find((l) => l.kind === 'town')!;
    const lay = layoutGlyphs('Saint Foy', q.st, 20, 0, measure);
    expect(lay.glyphs[0].size).toBe(20);
    expect(lay.glyphs[1].size).toBeLessThan(20);
    expect(lay.glyphs[6].size).toBe(20);
  });
});

describe('legend, cartouche and SVG', () => {
  const w = generate(makeOptions({ seed: '7', size: 'village', legend: true }));
  it('SVG export carries textPath labels, cartouche and legend', () => {
    const svg = renderSvg(w, { style: 'parchment' });
    expect(svg).toContain('class="layer-labels"');
    expect(svg).toContain('<textPath');
    expect(svg).toContain('class="cartouche"');
    expect(svg).toContain('class="legend"');
    expect(svg).toContain(w.names!.town.toUpperCase());
    expect(renderSvg(w, { style: 'atlas', labels: false, legend: false, cartouche: false })).not.toContain('layer-labels');
    expect(renderSvg(w, { style: 'parchment' })).toBe(svg);
  });
  it('model helpers', () => {
    expect(niceLength(0.5, 120)).toBe(250);
    expect(fmtPop(12345)).toBe('12 345');
    expect(cartoucheModel(w, PALETTES.atlas, 0.4).prims.length).toBeGreaterThan(8);
    expect(legendModel(w, PALETTES.parchment).prims.some((p) => p.t === 'text' && p.s === 'Houses')).toBe(true);
  });
});

describe('options: share state', () => {
  it('heightmap stays out of the URL, leaves only a marker', () => {
    const o = makeOptions({ seed: 'abc', language: 'german', labels: false, legend: true, heightScale: 200, importSea: 12 });
    expect(toQuery(o)).toContain('lang=german');
    expect(toQuery(o)).toContain('labels=0');
    expect(toQuery(o)).not.toContain('hm=');
    const withImg = { ...o, importedHeight: { w: 2, h: 2, rgba: new Uint8ClampedArray(16) } };
    const q = toQuery(withImg);
    expect(q).toContain('hm=custom');
    expect(q.length).toBeLessThan(200);
    expect(wantsCustomHeight(q)).toBe(true);
    const back = fromQuery(q);
    expect(back.language).toBe('german');
    expect(back.heightScale).toBe(200);
    expect(back.importSea).toBe(12);
    expect(back.importedHeight).toBeUndefined();
  });
});

describe('imported heightmap', () => {
  const N = 96;
  const rgba = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const r = Math.hypot(x - N * 0.5, y - N * 0.5) / (N * 0.5);
    const v = Math.round(255 * Math.max(0.05, 1 - r));
    rgba.set([v, v, v, 255], (y * N + x) * 4);
  }
  it('heightFromImage maps luminance to meters', () => {
    const g = heightFromImage(rgba, N, N, { mapSize: 1200, gridSize: 48, minHeight: 0, maxHeight: 100 });
    expect(g.data[24 * 48 + 24]).toBeGreaterThan(85);
    expect(g.data[0]).toBeLessThan(15);
  });
  it('same image + seed gives the same town; image changes the terrain; the scale matters', () => {
    const base = { seed: 'hm1', size: 'hamlet' as const, importedHeight: { w: N, h: N, rgba }, heightScale: 90 };
    const a = generate(makeOptions(base));
    const b = generate(makeOptions(base));
    expect(a.names!.town).toBe(b.names!.town);
    expect(a.urban!.buildings.length).toBe(b.urban!.buildings.length);
    expect(Array.from(a.terrain.height.data.slice(1000, 1040))).toEqual(Array.from(b.terrain.height.data.slice(1000, 1040)));
    const plain = generate(makeOptions({ seed: 'hm1', size: 'hamlet' }));
    expect(plain.terrain.height.data[1000]).not.toBe(a.terrain.height.data[1000]);
    const tall = generate(makeOptions({ ...base, heightScale: 400 }));
    const hi = (w: World) => Math.max(...w.terrain.height.data);
    expect(hi(tall)).toBeGreaterThan(hi(a) * 1.5);
    const flooded = generate(makeOptions({ ...base, importSea: 60 }));
    expect(flooded.stats.seaFraction).toBeGreaterThan(0.05);
  });
});
