import { describe, expect, it } from 'vitest';
import { decodeMapId, encodeMapId, expandMapQuery } from '../src/gen/mapId';
import { fromQuery, makeOptions, mapId, toQuery, generationUid, wantsCustomHeight } from '../src/gen/options';
import { fullQuery, uiStateFromQuery } from '../src/ui/share';
import { appearanceQuery, paintedFromQuery } from '../src/ui/renderAppearance';
import { planToString } from '../src/gen/urban/culture';

const plan = { nucleus: { kind: 'market' }, phases: [
  { morphology: 'posad', enclosure: { shape: 'organic', wall: 'palisade', fossil: 'street', towers: 'square' } },
  { morphology: 'celtic-oppidum-town', enclosure: { shape: 'oval', wall: 'wall', fossil: 'street', towers: 'square' } },
  { morphology: 'oppidum', enclosure: { shape: 'circle', wall: 'wall', fossil: 'street', towers: 'square' } },
] } as const;

describe('compact reproducible map IDs', () => {
  it('keeps fixed v1 fixtures and short seeds small without compression overhead', () => {
    expect(mapId(makeOptions())).toBe('1rAAI');
    expect(toQuery(fromQuery('?id=1rAAI'))).toBe('seed=1');
    for (const seed of ['42', 'owrcg3', '', '001', 'x y & = + / ? #', 'cité 🌳 城']) {
      const o = makeOptions({ seed });
      expect(fromQuery('id=' + mapId(o)).seed).toBe(seed);
      expect(mapId(o)).toMatch(/^1[rz][A-Za-z0-9_-]+$/);
    }
  });

  it('round-trips every serialized field, workflow, list draft and imported-height marker', () => {
    const query = 'seed=owrcg3&size=city&relief=mountains&coast=S&river=major&walls=double&castle=yes&roads=8&style=atlas'
      + '&culture=russian-kremlin&population=3000&biome=underdark-caverns&moat=yes&cathedral=no&palace=yes'
      + '&monasteries=no&port=yes&arena=yes&activities=yes&suburbs=many&castles=3&shanty=many&site=auto'
      + '&center=123.456,789.1&seaLevel=-0.123456&contours=0&landuse=0&lang=english&labels=0&legend=1'
      + '&sprawl=1.2345&mix=wizard-city:0.5:blend&plan=' + planToString(plan as never)
      + '&map=2500&settl=L300&eager=20000&hm=custom&hscale=145&hsea=-5';
    for (const mode of ['', '&mode=a', '&mode=l', '&mode=e&compose=l']) {
      const original = fromQuery(query + mode + '&set2=' + encodeURIComponent(JSON.stringify([
        [3000, 'russian-kremlin', null, 123.456, 789.1], [300, 'elven', 'hilltop', 800, 900],
      ])) + '&prefs=' + encodeURIComponent('{"weights":{"hilltop":2},"waterSide":"S","margin":0.25}'));
      const id = mapId(original), loaded = fromQuery(new URLSearchParams({ id }));
      expect(toQuery(loaded)).toBe(toQuery(original));
      expect(generationUid(loaded)).toBe(generationUid(original));
      expect(wantsCustomHeight('?id=' + encodeMapId(query))).toBe(true);
      expect(id.length).toBeLessThan(toQuery(original).length * 0.6);
    }
  });

  it('preserves the reported plan and compresses it substantially', () => {
    const o = fromQuery('seed=owrcg3&relief=mountains&walls=none&culture=russian-kremlin&population=3000'
      + '&port=yes&activities=yes&suburbs=many&shanty=many&seaLevel=0&mix=wizard-city:0.5:blend'
      + '&plan=' + planToString(plan as never) + '&map=2500&mode=a');
    const id = mapId(o);
    expect(id.startsWith('1z')).toBe(true);
    // Frozen compressed fixture guards the v1 vocabulary/dictionary against incompatible edits.
    expect(id).toBe('1zwgNj4M0vL0pON2bSYOXjlEdzKRcnKPkIcAlxCQuJCkkwyGsjOR0Yg6ZWYDMUnrNW48wr4FDGlVMQaRaaVWAxRmR20UGzDEsk4rQamGzIyqLodkIto01hgLt0qlXkNDI1MFAJAAA');
    expect(toQuery(fromQuery('id=' + id))).toBe(toQuery(o));
    expect(id.length).toBeLessThan(toQuery(o).length * 0.5);
    expect(mapId(o)).toBe(mapId(o));
  });

  it('keeps pins, camera, painted brushes and extended UI styles with the shared link', () => {
    const o = makeOptions({ seed: '42', style: 'blueprint' as never });
    const pins = [{ x: 123.4, y: 456.7, note: 'café, ici; 🌳' }];
    const view = { cx: 200, cy: 300, scale: 0.5 };
    const query = appearanceQuery(fullQuery(o, pins, view), true);
    expect(expandMapQuery(query).get('style')).toBe('blueprint');
    expect(uiStateFromQuery(query)).toEqual({ pins, view });
    expect(paintedFromQuery(query)).toBe(true);
    expect(generationUid(fromQuery(query))).toBe(generationUid(o));
    expect(expandMapQuery(query + '&seed=override').get('seed')).toBe('override');
  });

  it('ignores malformed IDs without crashing and rejects truncated or oversized data', () => {
    for (const id of ['2rAAI', '1r!', '1rA', '1rAA', '1r_wA', '1zAAAA', '1z_____w8', '1rAAJ=']) {
      expect(() => decodeMapId(id)).toThrow();
      expect(fromQuery(new URLSearchParams({ id, seed: 'fallback' })).seed).toBe('fallback');
    }
    const id = encodeMapId('seed=' + 'abc'.repeat(5000));
    expect(decodeMapId(id).get('seed')).toBe('abc'.repeat(5000));
    expect(() => decodeMapId(id.slice(0, -4))).toThrow();
  });
});
