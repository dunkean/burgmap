import shader from './hydrology.wgsl?raw';
import { gpuContext } from './terrainGpu';

export interface GpuHydrologyDrainage {
  filled: Float32Array;
  receivers: Uint32Array;
  accumulation: Float32Array;
  /** Weighted outlet potential in metres; physical elevations stay unchanged. */
  potential: Float32Array;
  seaMask: Uint8Array;
  preprocessingMs: number;
  computeMs: number;
  readbackMs: number;
  floodPasses: number;
}

const ENTRIES = ['reset', 'initialize', 'clearNext', 'solveTile', 'receivers', 'accumulateCopy', 'accumulateScatter', 'finish'] as const;
type Entry = typeof ENTRIES[number];
interface Pipelines { layout: GPUBindGroupLayout; values: Map<Entry, GPUComputePipeline> }
const compiled = new WeakMap<GPUDevice, Promise<Pipelines>>();
const worksets = new WeakMap<GPUDevice, Map<number, HydrologyWorkset>>();

function pipelines(device: GPUDevice): Promise<Pipelines> {
  let result = compiled.get(device);
  if (!result) {
    result = (async () => {
      const layout = device.createBindGroupLayout({ entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 32 } },
        ...[1, 2].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' as const } })),
        ...[3, 4, 5].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' as const } })),
      ] });
      const module = device.createShaderModule({ code: shader });
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter(message => message.type === 'error');
      if (errors.length) throw new Error(`Hydrologie WGSL : ${errors.map(error => `${error.lineNum}: ${error.message}`).join('\n')}`);
      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
      const values = await Promise.all(ENTRIES.map(async entryPoint => [entryPoint,
        await device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint } })] as const));
      return { layout, values: new Map(values) };
    })();
    compiled.set(device, result);
  }
  return result;
}

function seedHash(seed: string): number {
  let value = 2166136261;
  for (let i = 0; i < seed.length; i++) value = Math.imul(value ^ seed.charCodeAt(i), 16777619);
  return value >>> 0;
}

/** Border-connected marine datum components need a resolved 2x2 water footprint. */
function connectedSea(height: Float32Array, n: number, enabled: boolean): { mask: Uint32Array; count: number } {
  const mask = new Uint32Array(height.length);
  if (!enabled) return { mask, count: 0 };
  const seen = new Uint8Array(height.length);
  const queue = new Uint32Array(height.length);
  let head = 0, tail = 0, count = 0;
  const visit = (i: number) => {
    if (seen[i] === 0 && height[i] <= 0) { seen[i] = 1; queue[tail++] = i; }
  };
  const component = (start: number) => {
    if (seen[start] !== 0 || height[start] > 0) return;
    head = 0; tail = 0; visit(start);
    let resolved = false;
    while (head < tail) {
      const i = queue[head++], x = i % n, y = Math.floor(i / n);
      // Match Rust sea_mask: a tiny boundary groove is an open river exit;
      // an inlet connected to a resolved ocean retains the complete component.
      resolved ||= x + 1 < n && y + 1 < n && height[i + 1] <= 0
        && height[i + n] <= 0 && height[i + n + 1] <= 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= n) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < n) visit(yy * n + xx);
        }
      }
    }
    if (resolved) {
      for (let i = 0; i < tail; i++) mask[queue[i]] = 1;
      count += tail;
    }
  };
  for (let x = 0; x < n; x++) { component(x); component((n - 1) * n + x); }
  for (let y = 1; y + 1 < n; y++) { component(y * n); component(y * n + n - 1); }
  return { mask, count };
}

/** Dense scratch buffers and compiled kernels survive option/seed changes. */
class HydrologyWorkset {
  private buffers: GPUBuffer[] = [];
  private uniform: GPUBuffer;
  private source: GPUBuffer;
  private sea: GPUBuffer;
  private control: GPUBuffer;
  private output: GPUBuffer;
  private readback: GPUBuffer;
  private statusReadback: GPUBuffer;
  private group: GPUBindGroup;
  private pending: Promise<void> = Promise.resolve();

  constructor(private device: GPUDevice, private n: number, private program: Pipelines) {
    const count = n * n;
    const create = (size: number, usage: GPUBufferUsageFlags) => {
      const buffer = device.createBuffer({ size, usage });
      this.buffers.push(buffer);
      return buffer;
    };
    this.uniform = create(512, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.source = create(count * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.sea = create(count * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const nodes = create(count * 48, GPUBufferUsage.STORAGE);
    this.control = create(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    this.output = create(count * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    this.readback = create(count * 16 + 16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    this.statusReadback = create(16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    this.group = device.createBindGroup({ layout: program.layout, entries: [
      { binding: 0, resource: { buffer: this.uniform, size: 32 } },
      ...[this.source, this.sea, nodes, this.control, this.output].map((buffer, i) => ({ binding: i + 1, resource: { buffer } })),
    ] });
    void device.lost.then(() => this.buffers.forEach(buffer => buffer.destroy()));
  }

  run(height: Float32Array, width: number, seed: string, seaEnabled: boolean): Promise<GpuHydrologyDrainage> {
    // Overlapping UI requests must not mutate a shared workset during readback.
    const result = this.pending.then(() => this.execute(height, width, seed, seaEnabled));
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async execute(height: Float32Array, width: number, seed: string, seaEnabled: boolean): Promise<GpuHydrologyDrainage> {
    const started = performance.now(), n = this.n, count = n * n, cell = width / n;
    const marine = connectedSea(height, n, seaEnabled);
    const preprocessingMs = performance.now() - started;
    const device = this.device;
    device.queue.writeBuffer(this.source, 0, height as GPUAllowSharedBufferSource);
    device.queue.writeBuffer(this.sea, 0, marine.mask as GPUAllowSharedBufferSource);
    for (let phase = 0; phase < 2; phase++) {
      const packed = new ArrayBuffer(32);
      new Uint32Array(packed, 0, 4).set([n, seedHash(seed), phase, seaEnabled ? 1 : 0]);
      new Float32Array(packed, 16, 4).set([cell, cell * cell, Math.max(.1, cell * .1), 0]);
      device.queue.writeBuffer(this.uniform, phase * 256, packed);
    }
    const dispatch = (pass: GPUComputePassEncoder, entry: Entry, phase = 0) => {
      pass.setPipeline(this.program.values.get(entry)!);
      pass.setBindGroup(0, this.group, [phase * 256]);
      if (entry === 'solveTile') pass.dispatchWorkgroups(Math.ceil(n / 16), Math.ceil(n / 16));
      else pass.dispatchWorkgroups(entry === 'reset' || entry === 'clearNext' ? 1 : Math.ceil(count / 256));
    };
    const computeStart = performance.now();
    const initial = device.createCommandEncoder(), initPass = initial.beginComputePass();
    dispatch(initPass, 'reset'); dispatch(initPass, 'initialize'); initPass.end();
    device.queue.submit([initial.finish()]);
    let floodPasses = 0, converged = false;
    // Normally a handful of tile traversals. Tortuous basins get a bounded
    // larger budget; nonconvergence throws for the caller's explicit CPU path.
    const budget = Math.max(256, n);
    while (floodPasses < budget) {
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      for (let step = 0; step < 32; step++) {
        const phase = (floodPasses + step) & 1;
        dispatch(pass, 'clearNext', phase); dispatch(pass, 'solveTile', phase);
      }
      pass.end();
      encoder.copyBufferToBuffer(this.control, 0, this.statusReadback, 0, 16);
      device.queue.submit([encoder.finish()]);
      floodPasses += 32;
      await this.statusReadback.mapAsync(GPUMapMode.READ);
      const changes = new Uint32Array(this.statusReadback.getMappedRange())[0];
      this.statusReadback.unmap();
      if (changes === 0) { converged = true; break; }
    }
    if (!converged) throw new Error(`Drainage hydrique GPU non convergé après ${floodPasses} passes (${n}²) ; repli CPU requis.`);
    const final = device.createCommandEncoder(), finalPass = final.beginComputePass();
    dispatch(finalPass, 'receivers');
    const rounds = Math.ceil(Math.log2(count));
    for (let round = 0; round < rounds; round++) {
      const phase = round & 1;
      dispatch(finalPass, 'accumulateCopy', phase); dispatch(finalPass, 'accumulateScatter', phase);
    }
    dispatch(finalPass, 'finish', rounds & 1); finalPass.end();
    const bytes = count * 16;
    final.copyBufferToBuffer(this.output, 0, this.readback, 0, bytes);
    final.copyBufferToBuffer(this.control, 0, this.readback, bytes, 16);
    device.queue.submit([final.finish()]);
    await this.readback.mapAsync(GPUMapMode.READ);
    const computeMs = performance.now() - computeStart;
    const readStart = performance.now();
    let filled: Float32Array, receivers: Uint32Array, accumulation: Float32Array, potential: Float32Array;
    try {
      const mapped = this.readback.getMappedRange(), status = new Uint32Array(mapped, bytes, 4);
      if (status[2] !== 0 || status[3] !== count - marine.count) {
        throw new Error(`Drainage hydrique GPU invalide (${status[2]} erreurs, ${status[3]}/${count - marine.count} cellules drainées) ; repli CPU requis.`);
      }
      const floats = new Float32Array(mapped, 0, count * 4), integers = new Uint32Array(mapped, 0, count * 4);
      filled = new Float32Array(count); receivers = new Uint32Array(count);
      accumulation = new Float32Array(count); potential = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        filled[i] = floats[i * 4]; receivers[i] = integers[i * 4 + 1];
        accumulation[i] = floats[i * 4 + 2]; potential[i] = floats[i * 4 + 3];
      }
    } finally { this.readback.unmap(); }
    const seaMask = new Uint8Array(marine.mask);
    return { filled, receivers, accumulation, potential, seaMask, preprocessingMs, computeMs,
      readbackMs: performance.now() - readStart, floodPasses };
  }
}

/** FP32 GPU flood/D8 routing, then exact parallel accumulation and bulk readback. */
export async function prepareHydrologyGpu(height: Float32Array, width: number, resolution: number, seed: string,
  seaEnabled = false): Promise<GpuHydrologyDrainage> {
  if (![256, 512, 1024].includes(resolution) || height.length !== resolution * resolution || !Number.isFinite(width) || width <= 0
    || !height.every(Number.isFinite)) throw new Error('Grille hydrique GPU invalide.');
  const state = await gpuContext();
  if (!state || state.lost) throw new Error('WebGPU indisponible pour l’hydrologie ; repli CPU requis.');
  const program = await pipelines(state.device);
  if (state.lost) throw new Error('Device WebGPU perdu pendant la préparation hydrique ; repli CPU requis.');
  let sizes = worksets.get(state.device);
  if (!sizes) { sizes = new Map(); worksets.set(state.device, sizes); }
  let workspace = sizes.get(resolution);
  if (!workspace) { workspace = new HydrologyWorkset(state.device, resolution, program); sizes.set(resolution, workspace); }
  return workspace.run(height, width, seed, seaEnabled);
}
