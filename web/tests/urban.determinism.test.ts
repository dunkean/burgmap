import { describe, it, expect } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { makeOptions } from '../src/gen/options';
import { renderSvg } from '../src/render/svg';

describe('urban determinism', () => {
  it('same seed and options give byte-identical urban layers and SVG', () => {
    for (const o of [{ seed: '7', size: 'town' as const }, { seed: '3', size: 'village' as const, culture: 'bastide' as const }]) {
      const a = generate(makeOptions(o)), b = generate(makeOptions(o));
      expect(JSON.stringify(a.urban)).toBe(JSON.stringify(b.urban));
      expect(renderSvg(a)).toBe(renderSvg(b));
    }
  });
});
