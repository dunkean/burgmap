import { describe, it, expect } from 'vitest';
import { makeOptions, fromQuery, toQuery, applyOverride, DEFAULTS } from '../src/gen/options';
import { generate } from '../src/gen/pipeline';
import { fullQuery, uiStateFromQuery, pinsToString, pinsFromString, previewFlags, cropAround, bugReport } from '../src/ui/share';

const pins = [{ x: 123.4, y: 567.8, note: 'roof, odd; "shape" & more' }, { x: 10, y: 20, note: '' }, { x: 5.5, y: 6.5, note: 'café ☃' }];
const view = { cx: 800.2, cy: 900.1, scale: 0.4123 };

describe('share state (pins, view)', () => {
  it('round-trips pins and view through the query', () => {
    const o = makeOptions({ seed: 'abc' });
    const ui = uiStateFromQuery('?' + fullQuery(o, pins, view));
    expect(ui.pins).toEqual(pins);
    expect(ui.view).toEqual({ cx: 800.2, cy: 900.1, scale: 0.4123 });
    expect(pinsFromString(pinsToString(pins))).toEqual(pins);
  });
  it('old links (no pins / view) still work, bad values are ignored', () => {
    expect(uiStateFromQuery('?seed=1&size=town')).toEqual({ pins: [], view: null });
    expect(uiStateFromQuery('?pins=oops;1,2&view=a,b,c').pins).toEqual([{ x: 1, y: 2, note: '' }]);
    expect(uiStateFromQuery('?view=a,b,c').view).toBeNull();
  });
  it('never changes the options, the options hash or the generated world', () => {
    const base = 'seed=share1&size=hamlet&culture=french-organic';
    const o = fromQuery(base);
    const withUi = fromQuery(base + '&' + new URLSearchParams(fullQuery(o, pins, view)).toString().split('&').filter((kv) => /^(pins|view)=/.test(kv)).join('&'));
    expect(withUi).toEqual(o);
    expect(toQuery(withUi)).toBe(toQuery(o));
    expect(fromQuery(fullQuery(o, [], null))).toEqual(o);
    expect(fullQuery(o, [], null)).toMatch(/^id=1[rz][A-Za-z0-9_-]+$/);
    const a = generate(withUi), b = generate(o);
    expect(JSON.stringify(a.urban)).toBe(JSON.stringify(b.urban));
    // The vertex count of the slowest measured block follows wall-clock timing too.
    const det = (st: Record<string, unknown>): string => JSON.stringify(Object.entries(st)
      .filter(([k]) => !/(^|\.)ms(\.|$)/.test(k) && k !== 'urban.slowestBlockVerts'));
    expect(det(a.stats)).toBe(det(b.stats));
    const worldData = (w: unknown): string => JSON.stringify(w, (key, value) => key === 'stats' ? undefined : value);
    expect(worldData(a)).toBe(worldData(b));
  });
});

describe('bug report', () => {
  it('previewFlags are accepted by scripts/preview.ts (applyOverride round trip)', () => {
    const o = fromQuery('seed=x%20y&size=village&style=atlas&culture=roman-core&walls=single&suburbs=some&shanty=many&lang=english&site=hill&eager=20000&map=3000&sprawl=1.5&contours=0&roads=3&seaLevel=0.2&settl=3&cathedral=yes');
    const flags = previewFlags(o).match(/'[^']*'|\S+/g)!.map((t) => t.replace(/^'|'$/g, ''));
    const t = makeOptions({});
    for (let i = 0; i < flags.length; i++) {
      const [a, v] = [flags[i], flags[i + 1]];
      if (a === '--seed') t.seed = v; else if (a === '--size') t.size = v as never; else if (a === '--style') t.style = v as never;
      else if (a === '--opt') { const eq = v.indexOf('='); applyOverride(t, v.slice(0, eq), v.slice(eq + 1)); } else continue;
      i++;
    }
    expect(toQuery(t)).toBe(toQuery(o));
  });
  it('crops stay inside the map and the report has the link, pins and command', () => {
    expect(cropAround(10, 3000, 200, 1000)).toBe('0,800,200');
    const o = makeOptions({ seed: 'abc' });
    const r = bugReport(o, pins.slice(0, 2), view, 'http://x/', 1000);
    expect(r).toContain('http://x/?id=');
    expect(r).toContain('npm run preview:png -- --seed abc --size ' + DEFAULTS.size);
    expect(r).toMatch(/--crop \d+,\d+,\d+ --out out\/bug-1\.png/);
    expect(r).toContain('2. 10, 20');
  });
});
