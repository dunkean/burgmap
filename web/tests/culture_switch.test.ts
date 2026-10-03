/**
 * Culture switch (UI bug: "after trying other town plans, Medieval organic gives another plan type"): switching the
 * culture drops the previous culture's plan override and mix (`withCulture`), the link no longer carries them, and
 * generating other cultures in the same process (a long-lived worker) leaves a culture's plan unchanged.
 */
import { describe, it, expect } from 'vitest';
import { makeOptions, withCulture, toQuery, fromQuery } from '../src/gen/options';
import { generate } from '../src/gen/pipeline';

const T = 600000;

describe('culture switch', () => {
  it('drops the plan override, the mix and the site preferences of the previous culture', () => {
    const o = makeOptions({ seed: '3', culture: 'medina', cultureMix: { id: 'persian', t: 0.4, mode: 'blend' }, plan: { nucleus: { kind: 'castle' } }, sitePrefs: { margin: 0.2 } });
    const b = withCulture(o, 'european-organic');
    expect(b.culture).toBe('european-organic');
    expect(b.plan).toBeUndefined();
    expect(b.cultureMix).toBeUndefined();
    expect(b.sitePrefs).toBeUndefined();
    expect(toQuery(b)).toBe(toQuery(makeOptions({ seed: '3' })));
    // unchanged culture: same object (no spurious regeneration)
    expect(withCulture(o, 'medina')).toBe(o);
    // the URL round trip of a switched link carries neither
    expect(fromQuery(toQuery(b)).plan).toBeUndefined();
  });

  it('a culture gives the same plan before and after other cultures were generated (no module state leak)', () => {
    const sig = (culture: string): string => JSON.stringify(generate(makeOptions({ seed: '7', size: 'village', culture: culture as never })).urban);
    const base = sig('european-organic');
    for (const c of ['medina', 'bastide', 'chinese', 'germanic-village', 'venetian-lagoon']) {
      try { sig(c); } catch { /* an unknown id falls back to the default culture */ }
    }
    let o = makeOptions({ seed: '7', size: 'village', culture: 'medina', cultureMix: { id: 'bastide', t: 0.5, mode: 'phases' } });
    generate(o);
    o = withCulture(o, 'european-organic');
    expect(JSON.stringify(generate(o).urban)).toBe(base);
  }, T);
});
