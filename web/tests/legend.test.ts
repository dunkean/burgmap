import { describe, it, expect } from 'vitest';
import { generate } from '../src/gen/pipeline';
import { renderSvg } from '../src/render/svg';
import { makeOptions } from '../src/gen/options';

const world = generate(makeOptions({ seed: '1', size: 'village', relief: 'hills', river: 'river' }));

describe('legend', () => {
  it('SVG export draws the legend panel only when asked', () => {
    expect(renderSvg(world, { legend: true })).toContain('class="legend"');
    expect(renderSvg(world, { legend: false })).not.toContain('class="legend"');
  });
  it('follows world.options.legend by default', () => {
    expect(renderSvg({ ...world, options: { ...world.options, legend: true } })).toContain('class="legend"');
  });
});
