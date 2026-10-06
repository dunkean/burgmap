import shader from './terrainSampler.wgsl?raw';
import noiseShader from './terrainNoise.wgsl?raw';
import generationShader from './terrainGeneration.wgsl?raw';
import volcanicShader from './terrainFinite.wgsl?raw';
import { GenerationNoisePlan } from '../pkg/wasm/burgmap_wasm.js';
import type { TerrainEngine } from '../pkg/wasm/burgmap_wasm.js';
import type { TerrainData, TerrainRegion, TerrainSettings, TerrainCompute } from './terrain';

export interface Context { device: GPUDevice; pipelines: Map<string, Promise<GPUComputePipeline>>; lost: boolean }
let contextPromise: Promise<Context | undefined> | undefined;
export const GPU_RELIEFS = ['flat', 'hills', 'mountains', 'mixed', 'high-mountains', 'valley', 'volcano', 'caldera', 'plateau', 'canyon'];

async function context(): Promise<Context | undefined> {
  contextPromise ??= (async () => {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return;
    const device = await adapter.requestDevice();
    const result: Context = { device, pipelines: new Map(), lost: false };
    void device.lost.then(() => { result.lost = true; contextPromise = undefined; });
    return result;
  })().catch(() => undefined);
  return contextPromise;
}

export async function prepareGpu(mode: TerrainCompute, relief: string): Promise<{ context: Context; pipeline: Promise<GPUComputePipeline> } | undefined> {
  if (mode === 'wasm') return;
  const state = await context();
  if (!state || state.lost) return;
  const family = relief === 'flat' ? 0 : relief === 'valley' ? 2 : relief === 'volcano' || relief === 'caldera' || relief === 'plateau' || relief === 'canyon' ? 3 : 1;
  const key = `${mode}:${family}`;
  let pipeline = state.pipelines.get(key);
  if (!pipeline) {
    pipeline = (async () => {
      const code = shader.replace('// NOISE_KERNEL', noiseShader).replace('// VOLCANIC_KERNEL', volcanicShader);
      const module = state.device.createShaderModule({ code });
      return state.device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main', constants: { FAMILY: family } } });
    })();
    state.pipelines.set(key, pipeline);
  }
  // Return after submitting compilation so Rust preparation can overlap it.
  return { context: state, pipeline };
}

export const GPU_GENERATION_RELIEFS = ['hills', 'mountains', 'mixed', 'high-mountains', 'valley', 'volcano', 'caldera', 'plateau', 'canyon'];
export async function generateGpuNoise(state: Context, settings: TerrainSettings): Promise<{ coarse: Float32Array; fine: Float32Array }> {
  const device = state.device;
  // Both entry points share an explicit layout, so the seed buffers are uploaded once.
  const layout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
  ] });
  // Store each pipeline separately; subsequent generations reuse shader compilation.
  const stages = settings.generationCompute === 'gpu-all' ? ['coarse', 'fine'] : ['fine'];
  const compiled = stages.map(entryPoint => {
    const key = `generation:${entryPoint}`;
    let result = state.pipelines.get(key);
    if (!result) {
      const module = device.createShaderModule({ code: generationShader.replace('// NOISE_KERNEL', noiseShader) });
      result = device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module, entryPoint } });
      state.pipelines.set(key, result);
    }
    return result;
  });
  const plan = GenerationNoisePlan.generation(settings.seed, settings.width, settings.relief, settings.motifSize);
  const buffers: GPUBuffer[] = [];
  try {
    const params = plan.parameters();
    const upload = (data: Float32Array | Uint32Array, usage: GPUBufferUsageFlags) => {
      const buffer = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
      buffers.push(buffer); device.queue.writeBuffer(buffer, 0, data as GPUAllowSharedBufferSource); return buffer;
    };
    const inputs = [upload(params, GPUBufferUsage.UNIFORM), upload(plan.permutations(), GPUBufferUsage.STORAGE), upload(plan.gradients(), GPUBufferUsage.STORAGE)];
    const resolved = await Promise.all(compiled);
    const sizes = stages.map(stage => stage === 'coarse' ? params[2] : params[1]);
    const readbacks = sizes.map((n, index) => {
      const bytes = n * n * 16;
      const output = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const readback = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      buffers.push(output, readback);
      const group = device.createBindGroup({ layout: resolved[index].getBindGroupLayout(0), entries: [...inputs, output].map((buffer, binding) => ({ binding, resource: { buffer } })) });
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      pass.setPipeline(resolved[index]); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(n / 8), Math.ceil(n / 8)); pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, bytes); device.queue.submit([encoder.finish()]);
      return readback;
    });
    const values = await Promise.all(readbacks.map(async buffer => {
      await buffer.mapAsync(GPUMapMode.READ);
      const copy = new Float32Array(buffer.getMappedRange().slice(0)); buffer.unmap(); return copy;
    }));
    return { coarse: stages.length === 2 ? values[0] : new Float32Array(), fine: values[values.length - 1] };
  } finally { plan.free(); buffers.forEach(buffer => buffer.destroy()); }
}


export class GpuTerrainSampler {
  private buffers: GPUBuffer[] = [];
  private uniform: GPUBuffer;
  private field: GPUBuffer;
  private perm: GPUBuffer;
  private gradients: GPUBuffer;
  private branches: GPUBuffer;
  private output?: GPUBuffer;
  private readback?: GPUBuffer;
  private group?: GPUBindGroup;
  private capacity = 0;
  private parameters: Float64Array;
  private hasField: boolean;
  get lost(): boolean { return this.state.lost; }

  constructor(private state: Context, private pipeline: GPUComputePipeline, private mode: TerrainCompute, engine: TerrainEngine) {
    this.parameters = engine.sampling_parameters();
    const values = engine.sampling_field();
    this.hasField = values.length > 0;
    const data = values.length ? values : new Float32Array(1);
    this.field = this.upload(data);
    this.perm = this.upload(engine.sampling_permutations());
    this.gradients = this.upload(engine.sampling_gradients());
    this.branches = this.upload(engine.sampling_branches());
    this.uniform = this.upload(new Float32Array(36), GPUBufferUsage.UNIFORM);
  }

  private upload(array: Float32Array | Uint32Array, usage = GPUBufferUsage.STORAGE): GPUBuffer {
    const buffer = this.state.device.createBuffer({ size: Math.max(4, array.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
    this.buffers.push(buffer);
    this.state.device.queue.writeBuffer(buffer, 0, array as GPUAllowSharedBufferSource);
    return buffer;
  }

  async sample(region: TerrainRegion, settings: TerrainSettings, globalMinHeight: number, globalMaxHeight: number): Promise<TerrainData> {
    const { x, y, extent, resolution: n } = region;
    if (![x, y, extent, n].every(Number.isFinite) || x < 0 || y < 0 || extent <= 0
      || x + extent > settings.width + 0.0001 || y + extent > settings.width + 0.0001
      || !Number.isInteger(n) || n < 64 || n > 1024) throw new Error('Région d’échantillonnage invalide.');
    const started = performance.now(), device = this.state.device;
    const cell = extent / n, epsilon = Math.max(settings.motifSize / 65536, cell * 0.5);
    const lod = Math.min(10, Math.log2(Math.max(1, cell * (settings.relief === 'flat' ? 2 / settings.motifSize : 1 / settings.width) * 1024)));
    const a = this.parameters;
    const params = new Float32Array([a[0], a[1], a[2], a[3], a[4], a[5], this.hasField ? 1 : 0, n,
      x, y, extent, cell, Math.floor(lod), Math.min(10, Math.floor(lod) + 1), lod - Math.floor(lod), epsilon, a[6], a[7], 0, 0, ...Array.from({ length: 16 }, (_, i) => a[8 + i] ?? 0)]);
    const bytes = n * n * 16;
    if (bytes > this.capacity) {
      this.output?.destroy(); this.readback?.destroy(); this.capacity = bytes;
      this.output = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      this.readback = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      this.group = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries:
        [this.uniform, this.field, this.perm, this.gradients, this.output, this.branches].map((buffer, binding) => ({ binding, resource: { buffer } })) });
    }
    device.queue.writeBuffer(this.uniform, 0, params);
    const commands = device.createCommandEncoder();
    const pass = commands.beginComputePass();
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.group!);
    pass.dispatchWorkgroups(Math.ceil(n / 8), Math.ceil(n / 8)); pass.end();
    commands.copyBufferToBuffer(this.output!, 0, this.readback!, 0, bytes);
    device.queue.submit([commands.finish()]);
    await this.readback!.mapAsync(GPUMapMode.READ, 0, bytes);
    const copy = this.readback!.getMappedRange(0, bytes).slice(0); this.readback!.unmap();
    const packed = new Float32Array(copy);
    const height = new Float32Array(n * n), normalX = new Float32Array(n * n), normalY = new Float32Array(n * n), normalZ = new Float32Array(n * n);
    let minHeight = Infinity, maxHeight = -Infinity;
    for (let i = 0; i < n * n; i++) {
      const j = i * 4;
      height[i] = packed[j];
      normalX[i] = packed[j + 1];
      normalY[i] = packed[j + 2];
      normalZ[i] = packed[j + 3];
      minHeight = Math.min(minHeight, height[i]); maxHeight = Math.max(maxHeight, height[i]);
    }
    if (!Number.isFinite(minHeight) || !Number.isFinite(maxHeight)) throw new Error('Sortie GPU non finie.');
    return { x, y, width: extent, resolution: n, minHeight, maxHeight, globalMinHeight, globalMaxHeight,
      motifSize: settings.motifSize, height, normalX, normalY, normalZ, caveMask: new Uint8Array(),
      generationMs: performance.now() - started, backend: this.mode, samplingMs: performance.now() - started };
  }

  dispose(): void {
    this.buffers.forEach(buffer => buffer.destroy()); this.buffers = [];
    this.output?.destroy(); this.readback?.destroy();
  }
}
