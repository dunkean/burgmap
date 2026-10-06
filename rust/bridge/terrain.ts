import init, { TerrainEngine } from '../pkg/wasm/burgmap_wasm.js';
import wasmUrl from '../pkg/wasm/burgmap_wasm_bg.wasm?url&inline';
import { GpuTerrainSampler, prepareGpu, generateGpuNoise, GPU_RELIEFS, GPU_GENERATION_RELIEFS } from './terrainGpu';
import { generateGpuTerrain } from './terrainErosion';

export const RELIEFS = ['flat', 'hills', 'valley', 'canyon', 'mountains', 'mixed', 'plateau', 'high-mountains', 'volcano', 'caldera', 'cavern'] as const;
export type TerrainRelief = typeof RELIEFS[number];
export const GEOLOGICAL_RELIEFS = ['plateau', 'volcano', 'caldera'] as const;
export const ENVIRONMENT_RELIEFS = ['flat', 'hills', 'mixed', 'mountains', 'high-mountains'] as const;
export type TerrainEnvironment = typeof ENVIRONMENT_RELIEFS[number];
export const COMPUTE_MODES = ['wasm', 'gpu-f32'] as const;
export type TerrainCompute = typeof COMPUTE_MODES[number];
export interface TerrainSettings { seed: string; width: number; motifSize: number; relief: TerrainRelief; environment?: TerrainEnvironment; erosion: number; mountainMix: number; resolution: number; compute?: TerrainCompute; generationCompute?: 'cpu' | 'gpu' | 'gpu-all' | 'gpu-erosion' }
export interface TerrainRegion { x: number; y: number; extent: number; resolution: number }
export interface TerrainData {
  x: number; y: number; width: number; resolution: number; minHeight: number; maxHeight: number;
  globalMinHeight: number; globalMaxHeight: number; motifSize: number;
  height: Float32Array; caveMask: Uint8Array;
  normalX: Float32Array; normalY: Float32Array; normalZ: Float32Array; generationMs: number;
  backend?: TerrainCompute; backendReason?: string; prepareMs?: number; samplingMs?: number; gpuSetupMs?: number;
  generationBackend?: 'cpu' | 'gpu-noise-f32' | 'gpu-noise-all-f32' | 'gpu-erosion-f32'; generationReason?: string; noiseMs?: number; erosionMs?: number; gpuSimulationMs?: number; nativeEnvironmentMs?: number;
}
export interface TerrainRequest { id: number; generation: number; kind: 'overview' | 'detail'; settings: TerrainSettings; region: TerrainRegion }
export type TerrainResponse = Pick<TerrainRequest, 'id' | 'generation' | 'kind'> & ({ terrain: TerrainData } | { error: string });

let ready: Promise<unknown> | undefined;
let engine: TerrainEngine | undefined, engineKey = '';
let sampler: GpuTerrainSampler | undefined, samplerMode: TerrainCompute | undefined;
let generationBackend: TerrainData['generationBackend'] = 'cpu', generationReason: string | undefined;
let queue: Promise<unknown> = Promise.resolve();
export function sampleRustTerrain(request: TerrainRequest): Promise<TerrainData> {
  const result = queue.then(() => sampleTerrain(request));
  queue = result.catch(() => undefined);
  return result;
}
async function sampleTerrain({ settings, region }: TerrainRequest): Promise<TerrainData> {
  const mode = settings.compute === 'wasm' ? 'wasm' : 'gpu-f32';
  const generationMode = settings.generationCompute ?? 'gpu-erosion';
  const environment = (GEOLOGICAL_RELIEFS as readonly string[]).includes(settings.relief) ? settings.environment ?? 'mixed' : 'mixed';
  const supported = GPU_RELIEFS.includes(settings.relief);
  const gpu = mode !== 'wasm' && supported ? prepareGpu(mode, settings.relief).catch(() => undefined) : undefined;
  // Vite embeds this asset in the standalone HTML (and in the inline worker).
  ready ??= (async () => init({ module_or_path: await (await fetch(wasmUrl)).arrayBuffer() }))();
  await ready;
  const started = performance.now();
  const readyGpu = await gpu;
  // Handle compilation failure immediately while preparation runs synchronously.
  const pipelineReady = readyGpu?.pipeline.then(pipeline => ({ pipeline }), () => undefined);
  const requestedGpuGeneration = generationMode !== 'cpu' && mode !== 'wasm' && GPU_GENERATION_RELIEFS.includes(settings.relief);
  const gpuGeneration = requestedGpuGeneration && !!readyGpu;
  // Device loss affects sampling; it must not replace an already prepared landscape.
  const key = JSON.stringify([settings.seed, settings.width, settings.relief, settings.relief === 'cavern' ? 0 : settings.erosion, settings.motifSize, settings.relief === 'mixed' ? settings.mountainMix : 0.5, requestedGpuGeneration ? generationMode : 'cpu', environment]);
  let prepareMs = 0, noiseMs = 0, erosionMs = 0, gpuSimulationMs = 0, nativeEnvironmentMs = 0;
  if (!engine || engineKey !== key) {
    sampler?.dispose(); sampler = undefined; samplerMode = undefined;
    engine?.free(); engine = undefined; engineKey = '';
    const prepareStarted = performance.now();
    generationBackend = 'cpu'; generationReason = undefined;
    const mix = settings.relief === 'mixed' ? settings.mountainMix : 0.5;
    if (gpuGeneration && readyGpu) {
      try {
        if (generationMode === 'gpu-erosion' || settings.relief === 'volcano' || settings.relief === 'caldera' || settings.relief === 'plateau' || settings.relief === 'canyon') {
          const timing = { nativeEnvironmentMs: 0 };
          const source = await generateGpuTerrain(readyGpu.context, settings, timing);
          nativeEnvironmentMs = timing.nativeEnvironmentMs;
          gpuSimulationMs = performance.now() - prepareStarted - nativeEnvironmentMs;
          engine = TerrainEngine.with_source(settings.seed, settings.width, settings.relief, settings.erosion, settings.motifSize, mix, source, environment);
          generationBackend = 'gpu-erosion-f32';
        } else {
          const noise = await generateGpuNoise(readyGpu.context, settings);
          noiseMs = performance.now() - prepareStarted;
          const erosionStarted = performance.now();
          engine = TerrainEngine.with_generation_noise(settings.seed, settings.width, settings.relief, settings.erosion, settings.motifSize, mix, noise.coarse, noise.fine, environment);
          erosionMs = performance.now() - erosionStarted;
          generationBackend = generationMode === 'gpu-all' ? 'gpu-noise-all-f32' : 'gpu-noise-f32';
        }
      } catch (error) {
        generationReason = `Génération GPU indisponible : ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (!engine) engine = new TerrainEngine(settings.seed, settings.width, settings.relief, settings.erosion, settings.motifSize, mix, environment);
    prepareMs = performance.now() - prepareStarted;
    engineKey = key;
  }
  let backendReason: string | undefined;
  let gpuSetupMs = 0;
  if (mode !== 'wasm' && supported) {
    const setupStarted = performance.now();
    try {
      const compiled = await pipelineReady;
      if (readyGpu && compiled && !readyGpu.context.lost) {
        if (!sampler || samplerMode !== mode || sampler.lost) {
          sampler?.dispose(); sampler = undefined;
          sampler = new GpuTerrainSampler(readyGpu.context, compiled.pipeline, mode, engine);
          samplerMode = mode;
        }
        gpuSetupMs = performance.now() - setupStarted;
        const data = await sampler.sample(region, settings, engine.min_height, engine.max_height);
        return { ...data, generationMs: performance.now() - started, prepareMs, gpuSetupMs, generationBackend, generationReason, noiseMs, erosionMs, gpuSimulationMs, nativeEnvironmentMs };
      }
      backendReason = 'WebGPU indisponible';
    } catch (error) {
      backendReason = `GPU indisponible : ${error instanceof Error ? error.message : String(error)}`;
      sampler?.dispose(); sampler = undefined; samplerMode = undefined;
    }
  } else if (mode !== 'wasm') backendReason = 'relief actuellement échantillonné en WASM';
  const samplingStarted = performance.now();
  const result = engine.sample_region(region.x, region.y, region.extent, region.resolution);
  try {
    return {
      x: result.x, y: result.y, width: result.width, resolution: result.resolution,
      minHeight: result.min_height, maxHeight: result.max_height,
      globalMinHeight: engine.min_height, globalMaxHeight: engine.max_height, motifSize: settings.motifSize,
      height: result.height, caveMask: result.cave_mask,
      normalX: result.normal_x, normalY: result.normal_y, normalZ: result.normal_z,
      generationMs: performance.now() - started,
      backend: 'wasm', backendReason, prepareMs, samplingMs: performance.now() - samplingStarted, gpuSetupMs,
      generationBackend, generationReason, noiseMs, erosionMs, gpuSimulationMs, nativeEnvironmentMs,
    };
  } finally { result.free(); }
}
