import { describe, expect, it } from 'vitest';
import { DebugGeneration, debugConfigurationKey } from '../src/gen/debugPipeline';
import { generate } from '../src/gen/pipeline';
import { terrainForExtent } from '../src/gen/terrain/hydrology';
import { makeOptions } from '../src/gen/options';
import { worldToJson } from '../src/ui/exportWorld';
import { createHash } from 'node:crypto';
const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v, (_key, item: unknown) => ArrayBuffer.isView(item) ? createHash('sha256').update(new Uint8Array(item.buffer, item.byteOffset, item.byteLength)).digest('hex') : item)).digest('hex');
const terrainHash = (v: object): Record<string, string> => Object.fromEntries(Object.entries(v).map(([key, value]) => [key, hash(key === 'rivers' ? (value as { name?: string }[]).map(({ name: _name, ...river }) => river) : value)]));

const options = makeOptions({ seed: 'debug-stages', workflow: 'list', mapSize: 2400, river: 'river',
  settlements: { list: [{ population: 140 }, { population: 30, position: { x: 300, y: 400 } }] } });

describe('developer generation stages', () => {
  it('keeps display changes out of the session identity, including imported pixels in it', () => {
    expect(debugConfigurationKey({ ...options, style: 'parchment', labels: false, contours: true, landuse: false, legend: true })).toBe(debugConfigurationKey(options));
    expect(debugConfigurationKey({ ...options, eagerPop: 500 })).not.toBe(debugConfigurationKey(options));
    const importedHeight = { w: 1, h: 1, rgba: new Uint8Array([1, 2, 3, 255]) };
    expect(debugConfigurationKey({ ...options, importedHeight })).not.toBe(debugConfigurationKey({ ...options, importedHeight: { ...importedHeight, rgba: new Uint8Array([4, 2, 3, 255]) } }));
  });
  it('stops at each boundary, preserves upstream geometry and clones snapshots', () => {
    const session = new DebugGeneration(options);
    const empty = session.advance(0);
    expect(empty.terrain.rivers).toEqual([]);
    expect(empty.terrain.lakes).toEqual([]);
    expect(empty.terrain.flow.data.every(x => x === 0)).toBe(true);
    expect(empty.site).toBeUndefined();
    const rivers = session.advance(1);
    expect(terrainHash(rivers.terrain)).toEqual(terrainHash(terrainForExtent(options, 2400).terrain));
    expect(rivers.site).toBeUndefined();
    const centroids = session.advance(2);
    expect(centroids.settlements).toHaveLength(2);
    expect(centroids.settlements![0].population).toBe(140);
    expect(centroids.roads).toBeUndefined();
    expect(centroids.urban).toBeUndefined();
    expect(centroids.landuse).toBeUndefined();
    expect(centroids.names).toBeUndefined();
    const centers = centroids.settlements!.map(s => ({ ...s.center }));
    centroids.settlements![0].center.x = -100;
    const roads = session.advance(3);
    expect(roads.settlements!.map(s => s.center)).toEqual(centers);
    expect(roads.roads!.length).toBeGreaterThan(0);
    expect(roads.urban).toBeUndefined();
    expect(roads.settlements!.every(s => !s.urban)).toBe(true);
    expect(roads.landuse).toBeUndefined();
    expect(roads.names).toBeUndefined();
    const full = session.advance(4);
    expect(terrainHash(full.terrain)).toEqual(terrainHash(rivers.terrain));
    expect(full.settlements!.map(s => s.center)).toEqual(centers);
    expect(full.roads).toEqual(roads.roads);
    expect(full.urban!.buildings.length).toBeGreaterThan(0);
    expect(full.settlements![1].urban).toBeDefined();
    expect(full.landuse).toBeDefined();
    expect(full.names).toBeDefined();
    expect(empty.terrain.rivers).toEqual([]);
    expect(() => session.advance(2)).toThrow('Restart');
    expect(() => session.advance(5 as 4)).toThrow('Unknown');
    const exported = JSON.parse(worldToJson(roads));
    expect(exported.world.stats['developer.stage']).toBe(3);
    expect(exported.note).toContain('Shared IDs open normal generation');
  }, 120000);

  it('keeps a single main settlement identical to normal production generation', () => {
    const o = makeOptions({ seed: 'debug-parity', size: 'hamlet', population: 80, settlements: 'none', workflow: 'automatic', river: 'stream', coast: 'none' });
    const normal = generate(o);
    const debug = new DebugGeneration(o).advance(4);
    expect(debug.site).toEqual(normal.site);
    expect(terrainHash(debug.terrain)).toEqual(terrainHash(normal.terrain));
    expect(debug.roads).toEqual(normal.roads);
    expect(debug.urban).toEqual(normal.urban);
    expect(debug.bridges).toEqual(normal.bridges);
    expect(hash(debug.names)).toBe(hash(normal.names));
    expect(hash(debug.landuse)).toBe(hash(normal.landuse));
  }, 120000);

  it('supports environment-only and reproduces all stages deterministically', () => {
    const o = makeOptions({ seed: 'debug-environment', workflow: 'environment', size: 'hamlet', river: 'stream', biome: 'underdark' });
    const a = new DebugGeneration(o).advance(4);
    const b = new DebugGeneration(o).advance(4);
    expect(a.terrain).toEqual(b.terrain);
    expect(a.landuse).toEqual(b.landuse);
    expect(a.terrain).toEqual(generate(o).terrain);
    expect(a.landuse).toEqual(generate(o).landuse);
    expect(a.site).toBeUndefined();
    expect(a.settlements).toBeUndefined();
    expect(a.roads).toBeUndefined();
    expect(a.urban).toBeUndefined();
  }, 120000);
});
