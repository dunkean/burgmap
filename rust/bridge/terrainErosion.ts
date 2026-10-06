import shader from './terrainErosion.wgsl?raw';
import noiseShader from './terrainNoise.wgsl?raw';
import volcanicShader from './terrainFinite.wgsl?raw';
import { GenerationNoisePlan, TerrainEngine } from '../pkg/wasm/burgmap_wasm.js';
import type { Context } from './terrainGpu';
import type { TerrainSettings } from './terrain';

const ENTRIES = ['initialize', 'uplift', 'start', 'clearNext', 'floodInit', 'solveTile', 'receivers', 'flow', 'graphInit', 'graphFinish', 'floodCheck', 'pitInit', 'pitUnion', 'pitCompress', 'pitReduce', 'pitPour', 'pitFill', 'breachInit', 'breach', 'breachFinish', 'thermalFlux', 'thermalApply', 'copyHeight', 'bounds', 'diffuse', 'reconstruct', 'percentileInit', 'histogramClear', 'histogram', 'percentileSelect', 'detail', 'normalize', 'volcanicInitial', 'surfaceLoad', 'surfaceFlowInit', 'surfaceDelta', 'surfaceReconstruct', 'canyonSeed', 'canyonSpread', 'canyonApply'] as const;
type Entry = typeof ENTRIES[number];
interface Pipelines { layout: GPUBindGroupLayout; values: Map<Entry, GPUComputePipeline> }
const compiled = new WeakMap<GPUDevice, Promise<Pipelines>>();
function pipelines(device: GPUDevice): Promise<Pipelines> {
  let result = compiled.get(device);
  if (!result) {
    result = (async () => {
      const layout = device.createBindGroupLayout({ entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 192 } },
        ...[1, 2].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' as const } })),
        ...[3, 4, 5].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' as const } })),
      ] });
      const module = device.createShaderModule({ code: shader.replace('// NOISE_KERNEL', noiseShader).replace('// VOLCANIC_KERNEL', volcanicShader) });
      const messages = await module.getCompilationInfo();
      const errors = messages.messages.filter(message => message.type === 'error');
      if (errors.length) throw new Error(errors.map(error => `${error.lineNum}: ${error.message}`).join('\n'));
      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
      const values = await Promise.all(ENTRIES.map(async entryPoint => [entryPoint, await device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint } })] as const));
      return { layout, values: new Map(values) };
    })();
    compiled.set(device, result);
  }
  return result;
}

class ConvergenceError extends Error {}

/** All simulation state stays on the device; only the final physical raster is read. */
export async function generateGpuTerrain(state: Context, settings: TerrainSettings, timing?: { nativeEnvironmentMs: number }): Promise<Float32Array> {
  if (settings.relief === 'volcano' || settings.relief === 'caldera' || settings.relief === 'plateau' || settings.relief === 'canyon') {
    let shape: Float32Array | undefined;
    if (settings.relief !== 'canyon') {
      const plan = GenerationNoisePlan.finite_shape(settings.seed, settings.motifSize, settings.relief, settings.erosion);
      shape = plan.parameters(); plan.free();
    }
    const environment = settings.environment ?? 'mixed';
    const motif = settings.motifSize * (shape?.[15] ?? 1);
    // Plains retain the native analytic/shape-erosion path; geological erosion stays GPU.
    let background: Float32Array;
    if (environment === 'flat') {
      const started = performance.now();
      background = TerrainEngine.prepare_environment(settings.seed, settings.width, environment, settings.erosion, motif);
      if (timing) timing.nativeEnvironmentMs = performance.now() - started;
    } else {
      background = await generateWithBudget(state, { ...settings, motifSize: motif, relief: environment, mountainMix: .5 });
    }
    const local = await generateWithBudget(state, { ...settings, width: settings.motifSize }, shape);
    const fields = new Float32Array(local.length + background.length);
    fields.set(local); fields.set(background, local.length); return fields;
  }
  return generateWithBudget(state, settings);
}
async function generateWithBudget(state: Context, settings: TerrainSettings, shape?: Float32Array): Promise<Float32Array> {
  // A difficult drainage network gets more GPU passes, rather than truncated erosion.
  for (const factor of [1, 2, 4]) {
    try { return await generateOnce(state, settings, factor, shape); }
    catch (error) { if (!(error instanceof ConvergenceError) || factor === 4) throw error; }
  }
  throw new Error('Érosion GPU non convergée.');
}

async function generateOnce(state: Context, settings: TerrainSettings, factor: number, shape?: Float32Array): Promise<Float32Array> {
  const device = state.device;
  const plan = GenerationNoisePlan.erosion(settings.seed, settings.width, shape ? 'mixed' : settings.relief, settings.erosion, settings.motifSize, settings.mountainMix);
  const buffers: GPUBuffer[] = [];
  try {
    const parameters = plan.parameters(), base = parameters.slice(0, 24), tuning = parameters.slice(24, 32);
    const n = base[2], iterations = base[13], strength = base[18];
    const surface = base.slice();
    surface[2] = tuning[0]; surface[4] = tuning[1]; surface[5] = tuning[2];
    surface[15] = shape ? shape[13] : tuning[4]; surface[18] = tuning[5]; surface[22] = tuning[6];
    const program = await pipelines(device);
    const create = (size: number, usage: GPUBufferUsageFlags) => {
      const buffer = device.createBuffer({ size, usage }); buffers.push(buffer); return buffer;
    };
    const upload = (data: Uint32Array | Float32Array) => {
      const buffer = create(data.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      device.queue.writeBuffer(buffer, 0, data as GPUAllowSharedBufferSource); return buffer;
    };
    const uniform = create(65536, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const nodes = create(Math.max(n, surface[2]) ** 2 * 112, GPUBufferUsage.STORAGE);
    const fine = create(1024 * 1024 * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const control = create(1088, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const readback = create(1024 * 1024 * 16 + 1088, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const group = device.createBindGroup({ layout: program.layout, entries: [
      { binding: 0, resource: { buffer: uniform, size: 192 } },
      ...[upload(plan.permutations()), upload(plan.gradients()), nodes, fine, control].map((buffer, i) => ({ binding: i + 1, resource: { buffer } })),
    ] });
    const variants = new Map<string, number>();
    const offset = (extra: number[], config: Float32Array) => {
      const key = [...config, ...extra].join(','); let value = variants.get(key);
      if (value === undefined) {
        value = variants.size * 256; if (value + 192 > 65536) throw new Error('Trop de variantes GPU.');
        variants.set(key, value); device.queue.writeBuffer(uniform, value, new Float32Array([...config, ...extra, ...(shape ?? new Float32Array(16))]));
      }
      return value;
    };
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    const normal = [0, 0, 1, 0, 0, 0, .6, 0];
    normal[4] = parameters[32];
    const tail = [0, 0, .95, strength * .5, 0, 0, .5, 0];
    let config = base;
    const dispatch = (entry: Entry, extra = normal, groups = Math.ceil(config[2] ** 2 / 256), y = 1) => {
      pass.setPipeline(program.values.get(entry)!); pass.setBindGroup(0, group, [offset(extra, config)]); pass.dispatchWorkgroups(groups, y);
    };
    const solve = (mode: number, passes: number) => {
      const extras = normal.slice(); extras[1] = mode;
      dispatch(mode === 0 ? 'floodInit' : 'graphInit', extras); dispatch('start', extras, 1);
      for (let step = 0; step < passes; step++) {
        extras[0] = step & 1;
        dispatch('clearNext', extras, 1); dispatch('solveTile', extras, Math.ceil(config[2] / 16), Math.ceil(config[2] / 16));
      }
      extras[0] = 0;
      if (mode === 0) { dispatch('floodCheck', extras, 1); dispatch('receivers'); }
      else dispatch('graphFinish', extras);
    };
    const pits = (extra = normal) => {
      dispatch('pitInit');
      for (let k = 0; k < 8 * factor; k++) { dispatch('pitUnion'); dispatch('pitCompress'); }
      for (const entry of ['pitReduce', 'pitPour', 'pitFill'] as const) dispatch(entry, extra);
    };
    const thermal = (passes: number, extra = normal) => {
      for (let k = 0; k < passes; k++) for (const entry of ['thermalFlux', 'thermalApply', 'copyHeight'] as const) dispatch(entry, extra);
    };
    const diffuse = (weight: number, extra = normal) => {
      const values = extra.slice(); values[3] = weight; dispatch('diffuse', values); dispatch('copyHeight', values);
    };
    const percentile = (source: number) => {
      const extras = normal.slice(); extras[4] = source; dispatch('percentileInit', extras, 1);
      for (const shift of [24, 16, 8, 0]) {
        extras[5] = shift; dispatch('histogramClear', extras, 1); dispatch('histogram', extras, 4096); dispatch('percentileSelect', extras, 1);
      }
    };
    if (!shape) {
      dispatch('initialize');
      for (let iteration = 0; iteration < iterations; iteration++) {
        dispatch('uplift');
        if (strength > 0) {
          solve(0, 64 * factor); pits(); dispatch('flow'); solve(1, 128 * factor); solve(2, 128 * factor); thermal(3);
          const dose = base[17] * 3 * strength;
          for (let k = 0; k < Math.floor(dose); k++) diffuse(.5);
          if (dose % 1 > 0) diffuse(.5 * (dose % 1));
        }
        dispatch('bounds');
      }
      const clamp = normal.slice(); clamp[7] = 1; dispatch('bounds', clamp);
      if (strength > 0) {
        thermal(4, tail);
        for (let k = 0; k < 2; k++) { solve(0, 64 * factor); pits(tail); }
        diffuse(strength * .5, tail);
      }
      dispatch('reconstruct', normal, 4096);
      percentile(0); dispatch('detail', normal, 4096);
    } else {
      config = surface; dispatch('volcanicInitial', normal, 4096);
    }
    if (settings.erosion > 0) {
      config = surface; dispatch('surfaceLoad');
      if (settings.relief === 'canyon') {
        // Basin routing supplies continuous trunk rivers. Only this relief
        // deliberately enlarges their incision into deep, broad canyons.
        solve(0, 128 * factor); dispatch('flow'); solve(1, 128 * factor);
        dispatch('canyonSeed');
        let phase = 0;
        const jumps: number[] = [];
        for (let jump = 2 ** (Math.ceil(Math.log2(surface[2])) - 1); jump >= 1; jump /= 2) jumps.push(jump);
        jumps.push(1, 1);
        for (const jump of jumps) {
          const extras = normal.slice(); extras[0] = phase; extras[1] = jump;
          dispatch('canyonSpread', extras); phase = 1 - phase;
        }
        const extras = normal.slice(); extras[0] = phase; dispatch('canyonApply', extras);
      }
      for (let step = 0; step < tuning[3]; step++) {
        dispatch('surfaceFlowInit'); dispatch('receivers'); dispatch('flow');
        solve(1, 128 * factor); solve(3, 128 * factor); thermal(1);
        diffuse(tuning[7]);
      }
      dispatch('surfaceDelta'); dispatch('surfaceReconstruct', normal, 4096);
    }
    percentile(1); dispatch('normalize', normal, 4096);
    pass.end();
    const bytes = 1024 * 1024 * 16;
    encoder.copyBufferToBuffer(fine, 0, readback, 0, bytes); encoder.copyBufferToBuffer(control, 0, readback, bytes, 1088);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const mapped = readback.getMappedRange(); const status = new Uint32Array(mapped, bytes, 272);
    if (status[2] !== 0) { readback.unmap(); throw new ConvergenceError(`Érosion GPU non convergée (${status[2]} cellules/étapes, budget ×${factor}).`); }
    const packed = new Float32Array(mapped, 0, 1024 * 1024 * 4), height = new Float32Array(1024 * 1024);
    for (let i = 0; i < height.length; i++) height[i] = packed[i * 4];
    readback.unmap();
    if (!height.every(value => Number.isFinite(value) && value >= .3 - 1e-7)) throw new Error('Champ GPU invalide.');
    return height;
  } finally { plan.free(); buffers.forEach(buffer => buffer.destroy()); }
}
