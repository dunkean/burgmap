import shader from './terrainErosion.wgsl?raw';
import noiseShader from './terrainNoise.wgsl?raw';
import volcanicShader from './terrainFinite.wgsl?raw';
import { GenerationNoisePlan, TerrainEngine } from '../pkg/wasm/magna_urbis_wasm.js';
import type { Context } from './terrainGpu';
import type { TerrainSettings } from './terrain';

const ENTRIES = ['initialize', 'uplift', 'start', 'clearNext', 'solveStats', 'floodInit', 'solveTile', 'receivers', 'flow', 'graphInit', 'graphFinish', 'floodCheck', 'pitInit', 'pitUnion', 'pitCompress', 'pitReduce', 'pitPour', 'pitFill', 'breachInit', 'breach', 'breachFinish', 'thermalFlux', 'thermalApply', 'copyHeight', 'bounds', 'diffuse', 'reconstruct', 'percentileInit', 'histogramClear', 'histogram', 'percentileSelect', 'detail', 'normalize', 'volcanicInitial', 'surfaceLoad', 'surfaceFlowInit', 'surfaceDelta', 'surfaceReconstruct', 'canyonSeed', 'canyonSpread', 'canyonApply', 'coastLoad', 'coastResult', 'packHeight'] as const;
type Entry = typeof ENTRIES[number];
interface Pipelines {
  layout: GPUBindGroupLayout; values: Map<string, GPUComputePipeline>;
  module: GPUShaderModule; pipelineLayout: GPUPipelineLayout;
  pending: Map<string, Promise<GPUComputePipeline>>;
}
const compiled = new WeakMap<GPUDevice, Promise<Pipelines>>();
const scratch = new WeakMap<GPUDevice, GPUBuffer[]>();
const pending = new WeakMap<GPUDevice, Promise<unknown>>();
const queries = new WeakMap<GPUDevice, GPUQuerySet>();
function serialized<T>(state: Context, operation: () => Promise<T>): Promise<T> {
  const result = (pending.get(state.device) ?? Promise.resolve()).then(operation);
  pending.set(state.device, result.catch(() => undefined));
  return result;
}
async function pipelines(device: GPUDevice, entries: Set<Entry>, modes: Set<number>): Promise<Pipelines> {
  let result = compiled.get(device);
  if (!result) {
    result = (async () => {
      const layout = device.createBindGroupLayout({ entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 192 } },
        ...[1, 2].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' as const } })),
        ...[3, 4, 5, 6, 7].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' as const } })),
      ] });
      const module = device.createShaderModule({ code: shader.replace('// NOISE_KERNEL', noiseShader).replace('// VOLCANIC_KERNEL', volcanicShader) });
      const messages = await module.getCompilationInfo();
      const errors = messages.messages.filter(message => message.type === 'error');
      if (errors.length) throw new Error(errors.map(error => `${error.lineNum}: ${error.message}`).join('\n'));
      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
      return { layout, module, pipelineLayout, values: new Map<string, GPUComputePipeline>(), pending: new Map<string, Promise<GPUComputePipeline>>() };
    })();
    compiled.set(device, result);
  }
  const program = await result;
  const ready: Promise<GPUComputePipeline>[] = [];
  for (const entryPoint of entries) for (const mode of entryPoint === 'solveTile' ? modes : [undefined]) {
    const key = mode === undefined ? entryPoint : `solveTile:${mode}`;
    let pipeline = program.pending.get(key);
    if (!pipeline) {
      pipeline = device.createComputePipelineAsync({ layout: program.pipelineLayout, compute: { module: program.module, entryPoint, ...(mode === undefined ? {} : { constants: { SOLVE_MODE: mode } }) } });
      pipeline = pipeline.then(value => { program.values.set(key, value); return value; });
      program.pending.set(key, pipeline);
    }
    ready.push(pipeline);
  }
  await Promise.all(ready);
  return program;
}

class ConvergenceError extends Error {}
export interface ErosionProfile {
  factor: number; coarseSize: number; surfaceSize: number; pipelineMs: number;
  encodeMs: number; submitReadbackMs: number; unpackMs: number;
  maxSolveSteps: number[];
  gpuStagesMs?: { coarse: number; surface: number; normalization: number };
}
interface Timing { nativeEnvironmentMs: number; profiles?: ErosionProfile[] }

/** Cut/assembled coast -> the existing hydraulic/thermal surface pass, without normalization. */
export async function erodeGpuCoast(state: Context, settings: TerrainSettings, source: GPUBuffer, tuning: Float32Array): Promise<Float32Array> {
  return serialized(state, () => erodeCoast(state, settings, source, tuning));
}
async function erodeCoast(state: Context, settings: TerrainSettings, source: GPUBuffer, tuning: Float32Array): Promise<Float32Array> {
  for (const factor of [1, 2, 4, 8, 16]) {
    try { return await generateOnce(state, settings, factor, undefined, { source, tuning }); }
    catch (error) { if (!(error instanceof ConvergenceError) || factor === 16) throw error; }
  }
  throw new Error('Érosion littorale GPU non convergée.');
}

/** All simulation state stays on the device; only the final physical raster is read. */
export async function generateGpuTerrain(state: Context, settings: TerrainSettings, timing?: Timing): Promise<Float32Array> {
  return serialized(state, () => generateTerrain(state, settings, timing));
}
async function generateTerrain(state: Context, settings: TerrainSettings, timing?: Timing): Promise<Float32Array> {
  if (settings.relief === 'volcano' || settings.relief === 'caldera' || settings.relief === 'plateau') {
    const plan = GenerationNoisePlan.finite_shape(settings.seed, settings.motifSize, settings.relief, settings.erosion);
    const shape = plan.parameters(); plan.free();
    const environment = settings.environment ?? 'mixed';
    const motif = settings.motifSize * shape[15];
    // Plains retain the native analytic/shape-erosion path; geological erosion stays GPU.
    let background: Float32Array;
    if (environment === 'flat') {
      const started = performance.now();
      background = TerrainEngine.prepare_environment(settings.seed, settings.width, environment, settings.erosion, motif);
      if (timing) timing.nativeEnvironmentMs = performance.now() - started;
    } else {
      background = await generateWithBudget(state, { ...settings, motifSize: motif, relief: environment, mountainMix: .5 }, undefined, timing);
    }
    const local = await generateWithBudget(state, { ...settings, width: settings.motifSize }, shape, timing);
    const fields = new Float32Array(local.length + background.length);
    fields.set(local); fields.set(background, local.length); return fields;
  }
  return generateWithBudget(state, settings, undefined, timing);
}
async function generateWithBudget(state: Context, settings: TerrainSettings, shape?: Float32Array, timing?: Timing): Promise<Float32Array> {
  // A difficult drainage network gets more GPU passes, rather than truncated erosion.
  for (const factor of [1, 2, 4, 8, 16]) {
    try { return await generateOnce(state, settings, factor, shape, undefined, timing); }
    catch (error) { if (!(error instanceof ConvergenceError) || factor === 16) throw error; }
  }
  throw new Error('Érosion GPU non convergée.');
}

async function generateOnce(state: Context, settings: TerrainSettings, factor: number, shape?: Float32Array, coast?: { source: GPUBuffer; tuning: Float32Array }, timing?: Timing): Promise<Float32Array> {
  const device = state.device;
  const plan = GenerationNoisePlan.erosion(settings.seed, settings.width, coast ? 'hills' : shape ? 'mixed' : settings.relief, settings.erosion, settings.motifSize, settings.mountainMix);
  let buffers = scratch.get(device);
  if (!buffers) {
    buffers = []; scratch.set(device, buffers);
    const owned = buffers;
    void device.lost.then(() => owned.forEach(buffer => buffer.destroy()));
  }
  let bufferIndex = 0;
  try {
    const parameters = plan.parameters(), base = parameters.slice(0, 24), tuning = coast?.tuning ?? parameters.slice(24, 32);
    const n = base[2], iterations = base[13], strength = base[18];
    const coarseFactor = Math.min(factor, 4);
    const surfacePasses = Math.min((shape || coast || settings.relief === 'mixed' ? 64 : 32) * factor, 512);
    const surface = base.slice();
    surface[2] = tuning[0]; surface[4] = tuning[1]; surface[5] = tuning[2];
    surface[15] = shape && !coast ? shape[13] : tuning[4]; surface[18] = tuning[5]; surface[22] = tuning[6];
    const entries = new Set<Entry>(['packHeight']), modes = new Set<number>();
    const require = (...values: Entry[]) => values.forEach(value => entries.add(value));
    const graph = () => require('start', 'clearNext', 'solveStats', 'solveTile', 'receivers', 'flow', 'graphInit', 'graphFinish', 'thermalFlux', 'thermalApply', 'copyHeight', 'diffuse');
    if (coast) require('coastLoad', 'coastResult');
    else require('percentileInit', 'histogramClear', 'histogram', 'percentileSelect', 'normalize');
    if (!coast && !shape) {
      require('initialize', 'uplift', 'bounds', 'reconstruct', 'detail');
      if (strength > 0) {
        graph(); require('floodInit', 'floodCheck', 'pitInit', 'pitUnion', 'pitCompress', 'pitReduce', 'pitPour', 'pitFill');
        [0, 1, 2].forEach(mode => modes.add(mode));
      }
    } else if (shape && !coast) require('volcanicInitial');
    if (settings.erosion > 0) {
      graph(); require('surfaceLoad', 'surfaceFlowInit', 'surfaceDelta', 'surfaceReconstruct'); modes.add(1); modes.add(3);
      if (settings.relief === 'canyon' && !coast) { require('floodInit', 'floodCheck', 'canyonSeed', 'canyonSpread', 'canyonApply'); modes.add(0); }
    }
    const pipelineStarted = performance.now();
    const program = await pipelines(device, entries, modes);
    const pipelineMs = performance.now() - pipelineStarted, encodeStarted = performance.now();
    const create = (size: number, usage: GPUBufferUsageFlags) => {
      const index = bufferIndex++;
      let buffer = buffers[index];
      if (!buffer || buffer.size < size || buffer.usage !== usage) {
        buffer?.destroy(); buffer = device.createBuffer({ size, usage }); buffers[index] = buffer;
      }
      return buffer;
    };
    const upload = (data: Uint32Array | Float32Array) => {
      const buffer = create(data.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      device.queue.writeBuffer(buffer, 0, data as GPUAllowSharedBufferSource); return buffer;
    };
    const uniform = create(65536, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const nodes = create(Math.max(n, surface[2]) ** 2 * 112, GPUBufferUsage.STORAGE);
    const fine = create(1024 * 1024 * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    const control = create(1088, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    const output = create(1024 * 1024 * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const readback = create(1024 * 1024 * 4 + 1088, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const tileFlags = create(Math.ceil(Math.max(n, surface[2]) / 16) ** 2 * 8, GPUBufferUsage.STORAGE);
    let querySet = queries.get(device);
    if (!querySet && device.features.has('timestamp-query')) {
      querySet = device.createQuerySet({ type: 'timestamp', count: 6 }); queries.set(device, querySet);
      const owned = querySet; void device.lost.then(() => owned.destroy());
    }
    const queryBuffer = querySet ? create(48, GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC) : undefined;
    const queryReadback = querySet ? create(48, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ) : undefined;
    const group = device.createBindGroup({ layout: program.layout, entries: [
      { binding: 0, resource: { buffer: uniform, size: 192 } },
      ...[upload(plan.permutations()), upload(plan.gradients()), nodes, fine, control, output, tileFlags].map((buffer, i) => ({ binding: i + 1, resource: { buffer } })),
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
    const encoder = device.createCommandEncoder();
    encoder.clearBuffer(control);
    if (coast) encoder.copyBufferToBuffer(coast.source, 0, fine, 0, 1024 * 1024 * 16);
    const beginPass = (index: number) => encoder.beginComputePass(querySet ? { timestampWrites: { querySet, beginningOfPassWriteIndex: index, endOfPassWriteIndex: index + 1 } } : undefined);
    let pass = beginPass(0);
    const normal = [0, 0, 1, 0, 0, 0, .6, 0];
    normal[4] = parameters[32];
    const tail = [0, 0, .95, strength * .5, 0, 0, .5, 0];
    let config = base;
    const dispatch = (entry: Entry, extra = normal, groups = Math.ceil(config[2] ** 2 / 256), y = 1) => {
      pass.setPipeline(program.values.get(entry === 'solveTile' ? `solveTile:${extra[1]}` : entry)!);
      pass.setBindGroup(0, group, [offset(extra, config)]); pass.dispatchWorkgroups(groups, y);
    };
    const solve = (mode: number, passes: number) => {
      const extras = normal.slice(); extras[1] = mode;
      dispatch(mode === 0 ? 'floodInit' : 'graphInit', extras); dispatch('start', extras, 1);
      const offsets = [0, 1].map(phase => { extras[0] = phase; return offset(extras, config); });
      for (let step = 0; step < passes; step++) {
        const dynamicOffset = [offsets[step & 1]];
        pass.setPipeline(program.values.get('clearNext')!); pass.setBindGroup(0, group, dynamicOffset); pass.dispatchWorkgroups(1);
        pass.setPipeline(program.values.get(`solveTile:${mode}`)!); pass.dispatchWorkgroups(Math.ceil(config[2] / 16), Math.ceil(config[2] / 16));
      }
      extras[0] = 0;
      dispatch('solveStats', extras, 1);
      if (mode === 0) { dispatch('floodCheck', extras, 1); dispatch('receivers'); }
      else dispatch('graphFinish', extras);
    };
    const pits = (extra = normal) => {
      dispatch('pitInit');
      for (let k = 0; k < 8 * coarseFactor; k++) { dispatch('pitUnion'); dispatch('pitCompress'); }
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
    if (coast) {
      config = surface; dispatch('coastLoad', normal, 4096);
    } else if (!shape) {
      dispatch('initialize');
      for (let iteration = 0; iteration < iterations; iteration++) {
        dispatch('uplift');
        if (strength > 0) {
          solve(0, 64 * coarseFactor); pits(); dispatch('flow'); solve(1, 128 * coarseFactor); solve(2, 128 * coarseFactor); thermal(3);
          const dose = base[17] * 3 * strength;
          for (let k = 0; k < Math.floor(dose); k++) diffuse(.5);
          if (dose % 1 > 0) diffuse(.5 * (dose % 1));
        }
        dispatch('bounds');
      }
      const clamp = normal.slice(); clamp[7] = 1; dispatch('bounds', clamp);
      if (strength > 0) {
        thermal(4, tail);
        for (let k = 0; k < 2; k++) { solve(0, 64 * coarseFactor); pits(tail); }
        diffuse(strength * .5, tail);
      }
      dispatch('reconstruct', normal, 4096);
      percentile(0); dispatch('detail', normal, 4096);
    } else {
      config = surface; dispatch('volcanicInitial', normal, 4096);
    }
    pass.end(); pass = beginPass(2);
    if (settings.erosion > 0) {
      config = surface; dispatch('surfaceLoad');
      if (settings.relief === 'canyon' && !coast) {
        // Basin routing supplies continuous trunk rivers. Only this relief
        // deliberately enlarges their incision into deep, broad canyons.
        solve(0, 128 * coarseFactor); dispatch('flow'); solve(1, 128 * coarseFactor);
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
        // Surface graphs converge sooner than the basin-wide coarse graph;
        // mixed/finite/coastal surfaces need a longer initial budget. Retain
        // validation and retries up to the old 512-pass ceiling.
        solve(1, surfacePasses); solve(3, surfacePasses); thermal(1);
        diffuse(tuning[7]);
      }
      dispatch('surfaceDelta'); dispatch('surfaceReconstruct', normal, 4096);
    }
    pass.end(); pass = beginPass(4);
    if (coast) dispatch('coastResult', normal, 4096);
    else { percentile(1); dispatch('normalize', normal, 4096); }
    dispatch('packHeight', normal, 4096);
    pass.end();
    const bytes = 1024 * 1024 * 4;
    encoder.copyBufferToBuffer(output, 0, readback, 0, bytes); encoder.copyBufferToBuffer(control, 0, readback, bytes, 1088);
    if (querySet && queryBuffer && queryReadback) {
      encoder.resolveQuerySet(querySet, 0, 6, queryBuffer, 0); encoder.copyBufferToBuffer(queryBuffer, 0, queryReadback, 0, 48);
    }
    const command = encoder.finish(), encodeMs = performance.now() - encodeStarted;
    const submitStarted = performance.now(); device.queue.submit([command]);
    await Promise.all([readback.mapAsync(GPUMapMode.READ), queryReadback?.mapAsync(GPUMapMode.READ)]);
    const submitReadbackMs = performance.now() - submitStarted, unpackStarted = performance.now();
    const mapped = readback.getMappedRange(); const status = new Uint32Array(mapped, bytes, 272);
    const maxSolveSteps = Array.from(status.slice(267, 271));
    const profile: ErosionProfile = { factor, coarseSize: n, surfaceSize: surface[2], pipelineMs, encodeMs, submitReadbackMs, unpackMs: 0, maxSolveSteps };
    if (queryReadback) {
      const values = new BigUint64Array(queryReadback.getMappedRange());
      profile.gpuStagesMs = { coarse: Number(values[1] - values[0]) / 1e6, surface: Number(values[3] - values[2]) / 1e6, normalization: Number(values[5] - values[4]) / 1e6 };
      queryReadback.unmap();
    }
    if (timing) (timing.profiles ??= []).push(profile);
    if (status[2] !== 0) { readback.unmap(); throw new ConvergenceError(`Érosion GPU non convergée (${status[2]} cellules/étapes, budget ×${factor}).`); }
    const height = new Float32Array(mapped, 0, 1024 * 1024).slice();
    readback.unmap();
    profile.unpackMs = performance.now() - unpackStarted;
    if (!height.every(value => Number.isFinite(value) && (coast || value >= .3 - 1e-7))) throw new Error('Champ GPU invalide.');
    return height;
  } finally {
    plan.free();
    // Also recover a mapped staging buffer if validation/readback failed.
    buffers.forEach(buffer => { if (buffer.mapState !== 'unmapped') buffer.unmap(); });
  }
}
