import { describe, expect, it } from 'vitest';
import { pruneWays, type FieldNet } from '../src/gen/landuse/fields';

const net = (ways: FieldNet['ways']): FieldNet => ({ furlongs: [], ways, headlands: [] });

describe('cart-way connectivity', () => {
  it('demotes a way merely near a road despite a broad search tolerance', () => {
    const field = net([[{ x: 10, y: 20 }, { x: 50, y: 20 }]]);
    const result = pruneWays(field, [{ path: [{ x: 0, y: 0 }, { x: 100, y: 0 }], width: 6 }], 100);
    expect(result.demoted).toBe(1);
    expect(field.ways).toHaveLength(0);
    expect(field.headlands).toHaveLength(1);
  });

  it('keeps a physical ribbon contact and its connected field branch', () => {
    const field = net([
      [{ x: 10, y: 3 }, { x: 50, y: 30 }],
      [{ x: 50, y: 30 }, { x: 80, y: 40 }],
    ]);
    const result = pruneWays(field, [{ path: [{ x: 0, y: 0 }, { x: 100, y: 0 }], width: 6 }], 100);
    expect(result.demoted).toBe(0);
    expect(field.ways).toHaveLength(2);
  });
});
