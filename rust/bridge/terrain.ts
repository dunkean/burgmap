import init, { TerrainEngine } from '../pkg/wasm/burgmap_wasm.js';
import wasmUrl from '../pkg/wasm/burgmap_wasm_bg.wasm?url&inline';

export const RELIEFS = ['flat', 'hills', 'valley', 'canyon', 'mountains', 'plateau', 'high-mountains', 'volcano', 'caldera', 'cavern'] as const;
export type TerrainRelief = typeof RELIEFS[number];
export interface TerrainSettings { seed: string; width: number; motifSize: number; relief: TerrainRelief; erosion: number; resolution: number }
export interface TerrainRegion { x: number; y: number; extent: number; resolution: number }
export interface TerrainData {
  x: number; y: number; width: number; resolution: number; minHeight: number; maxHeight: number;
  globalMinHeight: number; globalMaxHeight: number; motifSize: number;
  height: Float32Array; caveMask: Uint8Array;
  normalX: Float32Array; normalY: Float32Array; normalZ: Float32Array; generationMs: number;
}
export interface TerrainRequest { id: number; generation: number; kind: 'overview' | 'detail'; settings: TerrainSettings; region: TerrainRegion }
export type TerrainResponse = Pick<TerrainRequest, 'id' | 'generation' | 'kind'> & ({ terrain: TerrainData } | { error: string });

let ready: Promise<unknown> | undefined;
let engine: TerrainEngine | undefined, engineKey = '';
export async function sampleRustTerrain({ settings, region }: TerrainRequest): Promise<TerrainData> {
  // Vite embeds this asset in the standalone HTML (and in the inline worker).
  ready ??= (async () => init({ module_or_path: await (await fetch(wasmUrl)).arrayBuffer() }))();
  await ready;
  const started = performance.now();
  const key = JSON.stringify([settings.seed, settings.width, settings.relief, settings.relief === 'cavern' ? 0 : settings.erosion, settings.motifSize]);
  if (!engine || engineKey !== key) {
    engine?.free(); engine = undefined; engineKey = '';
    engine = new TerrainEngine(settings.seed, settings.width, settings.relief, settings.erosion, settings.motifSize);
    engineKey = key;
  }
  const result = engine.sample_region(region.x, region.y, region.extent, region.resolution);
  try {
    return {
      x: result.x, y: result.y, width: result.width, resolution: result.resolution,
      minHeight: result.min_height, maxHeight: result.max_height,
      globalMinHeight: engine.min_height, globalMaxHeight: engine.max_height, motifSize: settings.motifSize,
      height: result.height, caveMask: result.cave_mask,
      normalX: result.normal_x, normalY: result.normal_y, normalZ: result.normal_z,
      generationMs: performance.now() - started,
    };
  } finally { result.free(); }
}
