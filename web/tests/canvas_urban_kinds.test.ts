import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { URBAN_PARCEL_USES, URBAN_LANDMARK_KINDS, URBAN_BUILDING_KINDS, URBAN_LINE_KINDS, WALL_LINE_W, CAMP_FENCE_W } from '../src/render/scene';

const src = readFileSync(new URL('../src/render/urban.ts', import.meta.url), 'utf8').replace(/^[\s\S]*?(?=function patterns)/, ''); // (the debug layer is not a map layer)
const grab = (re: RegExp): Set<string> => new Set([...src.matchAll(re)].map((m) => m[1]));
const keysOf = (name: string): string[] => {
  const m = new RegExp(`const ${name}[^=]*=\\s*\\{([^}]*)\\}`).exec(src);
  return m ? [...m[1].matchAll(/'?([a-z-]+)'?\s*:/g)].map((x) => x[1]) : [];
};

describe('urban.ts kinds are all handled by the Canvas scene', () => {
  const uses = new Set<string>(Object.values(URBAN_PARCEL_USES).flat());
  const lines = new Set(URBAN_LINE_KINDS);
  const lms = new Set<string>(URBAN_LANDMARK_KINDS);

  it('parcel uses', () => {
    const drawn = grab(/\.use === '([^']+)'/g);
    drawn.delete('string'); // (typeof p.use === 'string')
    const groundSet = /GROUND_USES = new Set\(\[([^\]]*)\]/.exec(src)![1].match(/'[^']+'/g)!.map((x) => x.slice(1, -1));
    for (const g of groundSet) drawn.add(g);
    expect(drawn.size).toBeGreaterThan(8);
    expect([...drawn].filter((k) => !uses.has(k))).toEqual([]);
  });
  it('plan-line kinds', () => {
    const drawn = new Set([...grab(/\bk === '([^']+)'/g), ...grab(/x\.kind === '([^']+)'/g), ...keysOf('WALL_LINES'), ...keysOf('CAMP_FENCES')]);
    expect(drawn.size).toBeGreaterThan(20);
    expect([...drawn].filter((k) => !lines.has(k))).toEqual([]);
    expect(Object.keys(WALL_LINE_W).sort()).toEqual(keysOf('WALL_LINES').sort());
    expect(Object.keys(CAMP_FENCE_W).sort()).toEqual(keysOf('CAMP_FENCES').sort());
  });
  it('landmark kinds', () => {
    const drawn = grab(/\bl\.kind === '([^']+)'/g);
    expect(drawn.size).toBeGreaterThan(5);
    expect([...drawn].filter((k) => !lms.has(k) && !lines.has(k))).toEqual([]);
  });
  it('building kinds', () => {
    const drawn = grab(/\bb\.kind === '([^']+)'/g);
    for (const m of src.matchAll(/LANDMARK_KINDS = new Set\(\[([^\]]*)\]/g)) for (const k of m[1].match(/'[^']+'/g)!) drawn.add(k.slice(1, -1));
    expect([...drawn].filter((k) => !(URBAN_BUILDING_KINDS as readonly string[]).includes(k))).toEqual([]);
  });
});
