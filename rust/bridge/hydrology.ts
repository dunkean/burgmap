import { HydrologyEngine } from '../pkg/wasm/magna_urbis_wasm.js';
import { prepareHydrologyGpu } from './hydrologyGpu';
export { applyHydrologySurface } from './hydrologySurface';

export interface HydrologySettings {
  enabled: boolean;
  main: 'auto' | 'none' | 'stream' | 'river' | 'major';
  density: number; wetness: number;
  lakes: 'auto' | 'none' | 'some';
  meanders: 'natural' | 'reduced' | 'none'; meanderIntensity: number;
  estuary: 'auto' | 'simple' | 'widening' | 'funnel' | 'tidal';
  widthScale: number; incision: number; minLakeArea: number;
  lakeAbundance: number; lakeCoverage: number; maxLakeArea: number;
  depressionPolicy: 'auto' | 'fill'; maxBreachDepth: number; maxBreachLength: number;
  resolution: 256 | 512 | 1024; compute: 'auto' | 'cpu' | 'gpu';
}

export const DEFAULT_HYDROLOGY: HydrologySettings = {
  enabled: true, main: 'auto', density: 1, wetness: 1, lakes: 'auto',
  meanders: 'natural', meanderIntensity: 1, estuary: 'auto', widthScale: 1,
  incision: 1, minLakeArea: 2500, resolution: 512, compute: 'auto',
  lakeAbundance: 0.5, lakeCoverage: 0.05, maxLakeArea: 0.02,
  depressionPolicy: 'auto', maxBreachDepth: 12, maxBreachLength: 1000,
};
export type HydrologyOverlay = 'none' | 'basins' | 'accumulation' | 'flow' | 'depressions' | 'lakes' | 'channels' | 'raw-basins' | 'raw-accumulation' | 'raw-flow' | 'raw-depressions' | 'flats' | 'flat-rank';

/** Retained physical grids and packed vector topology; lengths are metres, areas m².
 * UINT_MAX is the receiver outlet sentinel. Vector offsets count vertices.
 * riverPoints: x,y,width,waterZ; riverMeta: id,from,to,host+1,flags,estuary.
 * lakePoints: x,y; lakeMeta: id,waterZ,area,maxDepth,outletX,outletY.
 */
export interface HydrologyData {
  width: number; resolution: number;
  receivers: Uint32Array; accumulation: Float32Array; basins: Uint32Array;
  rawReceivers: Uint32Array; rawAccumulation: Float32Array; rawBasins: Uint32Array;
  flatLabels: Uint32Array; flatRank: Uint32Array;
  externalInflowArea: number;
  rawFilled: Float32Array; rawDrainageHeight: Float32Array;
  breachCount: number; breachCutVolumeM3: number; avoidedFillVolumeM3: number;
  filled: Float32Array; lakeDepth: Float32Array; lakeLabels: Uint32Array;
  baseHeight: Float32Array; drainageHeight: Float32Array; surfaceHeight: Float32Array; adjustedHeight: Float32Array;
  riverPoints: Float32Array; riverOffsets: Uint32Array; riverMeta: Uint32Array;
  lakePoints: Float32Array; lakeOffsets: Uint32Array; lakeMeta: Float32Array; lakeRingMeta: Uint32Array;
  nodePoints: Float32Array; nodeMeta: Uint32Array;
  riverCount: number; lakeCount: number; basinCount: number;
  lakeFraction: number;
  incision: number;
  backend: 'cpu' | 'gpu-f32'; backendReason?: string;
  drainageMs: number; vectorMs: number; generationMs: number;
  stageMs?: Record<string, number>;
  routingPotential?: Float32Array; seaMask?: Uint8Array;
  gpuComputeMs?: number; gpuReadbackMs?: number; gpuFloodPasses?: number;
}

export class PreparedHydrology {
  private constructor(private engine: HydrologyEngine, readonly baseHeight: Float32Array,
    readonly backend: HydrologyData['backend'], readonly backendReason: string | undefined,
    readonly drainageMs: number, private gpu?: Awaited<ReturnType<typeof prepareHydrologyGpu>>) {}

  static async create(seed: string, width: number, resolution: number, height: Float32Array,
    compute: HydrologySettings['compute'], seaEnabled: boolean): Promise<PreparedHydrology> {
    const start = performance.now();
    let engine: HydrologyEngine | undefined, reason: string | undefined;
    let gpu: Awaited<ReturnType<typeof prepareHydrologyGpu>> | undefined;
    if (compute !== 'cpu') {
      try {
        const drainage = await prepareHydrologyGpu(height, width, resolution, seed, seaEnabled);
        engine = HydrologyEngine.with_drainage(seed, width, resolution, height, seaEnabled,
          drainage.filled, drainage.receivers, drainage.accumulation);
        gpu = drainage;
      } catch (error) { reason = `Hydrologie GPU indisponible : ${error instanceof Error ? error.message : String(error)}`; }
    }
    const backend = engine ? 'gpu-f32' : 'cpu';
    engine ??= new HydrologyEngine(seed, width, resolution, height, seaEnabled);
    return new PreparedHydrology(engine, height, backend, reason, performance.now() - start, gpu);
  }

  generate(settings: HydrologySettings): HydrologyData {
    const start = performance.now();
    const output = this.engine.generate(settings.main, settings.density, settings.wetness,
      settings.lakes, settings.meanders, settings.meanderIntensity, settings.estuary,
      settings.widthScale, settings.incision, settings.minLakeArea,
      settings.lakeAbundance, settings.lakeCoverage, settings.maxLakeArea,
      settings.depressionPolicy, settings.maxBreachDepth, settings.maxBreachLength);
    try {
      const stageTimes = output.stage_ms;
      const stageMs = output.stage_labels ? Object.fromEntries(output.stage_labels.split(',').map((label, i) => [label, stageTimes[i]])) : undefined;
      const basins = output.basins;
      let basinCount = 0;
      let landCells = 0;
      for (const value of basins) { basinCount = Math.max(basinCount, value); if (value) landCells++; }
      const riverOffsets = output.river_offsets, lakeMeta = output.lake_meta;
      let lakeArea = 0;
      for (let i = 2; i < lakeMeta.length; i += 6) lakeArea += lakeMeta[i];
      const riverMeta = output.river_meta;
      let externalInflow = false;
      for (let i = 4; i < riverMeta.length; i += 6) externalInflow ||= (riverMeta[i] & 2) !== 0;
      return {
        width: output.width, resolution: output.resolution,
        receivers: output.receivers, accumulation: output.accumulation, basins,
        rawReceivers: output.raw_receivers ?? output.receivers,
        rawAccumulation: output.raw_accumulation ?? output.accumulation,
        rawBasins: output.raw_basins ?? basins,
        flatLabels: output.flat_labels ?? new Uint32Array(basins.length),
        flatRank: output.flat_rank ?? new Uint32Array(basins.length),
        externalInflowArea: output.external_inflow_area ?? 0,
        rawFilled: output.raw_filled ?? output.filled,
        rawDrainageHeight: output.raw_drainage_height ?? output.drainage_height,
        breachCount: output.breach_count ?? 0,
        breachCutVolumeM3: output.breach_cut_volume_m3 ?? 0,
        avoidedFillVolumeM3: output.avoided_fill_volume_m3 ?? 0,
        filled: output.filled, lakeDepth: output.lake_depth, lakeLabels: output.lake_labels,
        baseHeight: this.baseHeight, drainageHeight: output.drainage_height, surfaceHeight: output.surface_height, adjustedHeight: output.adjusted_height,
        riverPoints: output.river_points, riverOffsets, riverMeta,
        lakePoints: output.lake_points, lakeOffsets: output.lake_offsets, lakeMeta, lakeRingMeta: output.lake_ring_meta,
        nodePoints: output.node_points, nodeMeta: output.node_meta,
        riverCount: riverOffsets.length - 1, lakeCount: lakeMeta.length / 6, basinCount,
        lakeFraction: lakeArea / Math.max(1, landCells * (output.width / output.resolution) ** 2),
        incision: settings.incision,
        backend: this.backend,
        backendReason: [this.backendReason,
          this.backend === 'gpu-f32' && settings.lakes === 'some' ? 'Aménagement des lacs et drainage associé en Rust.' : undefined,
          ['stream', 'river', 'major'].includes(settings.main) && !externalInflow ? 'Aucune entrée terrestre adaptée : cours principal limité à son bassin local.' : undefined,
        ].filter(Boolean).join(' · ') || undefined,
        drainageMs: this.drainageMs, vectorMs: performance.now() - start,
        stageMs,
        generationMs: this.drainageMs + performance.now() - start,
        routingPotential: settings.lakes === 'some' ? undefined : this.gpu?.potential,
        seaMask: this.gpu?.seaMask, gpuComputeMs: this.gpu?.computeMs,
        gpuReadbackMs: this.gpu?.readbackMs, gpuFloodPasses: this.gpu?.floodPasses,
      };
    } finally { output.free(); }
  }

  dispose(): void { this.engine.free(); }
}
