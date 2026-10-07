// Keep the ordinary TypeScript build independent of the generated Rust package.
declare module '*burgmap_wasm.js' {
  export default function init(options: { module_or_path: ArrayBuffer }): Promise<unknown>;
  export interface HydrologyOutput {
    readonly width: number; readonly resolution: number;
    readonly receivers: Uint32Array; readonly accumulation: Float32Array; readonly basins: Uint32Array;
    readonly raw_receivers: Uint32Array; readonly raw_accumulation: Float32Array; readonly raw_basins: Uint32Array;
    readonly flat_labels: Uint32Array; readonly flat_rank: Uint32Array; readonly external_inflow_area: number;
    readonly raw_filled: Float32Array; readonly raw_drainage_height: Float32Array;
    readonly breach_count: number; readonly breach_cut_volume_m3: number; readonly avoided_fill_volume_m3: number;
    readonly filled: Float32Array; readonly lake_depth: Float32Array; readonly lake_labels: Uint32Array;
    readonly drainage_height: Float32Array; readonly surface_height: Float32Array; readonly adjusted_height: Float32Array;
    readonly river_points: Float32Array; readonly river_offsets: Uint32Array; readonly river_meta: Uint32Array;
    readonly node_points: Float32Array; readonly node_meta: Uint32Array;
    readonly lake_points: Float32Array; readonly lake_offsets: Uint32Array;
    readonly lake_ring_meta: Uint32Array; readonly lake_meta: Float32Array;
    free(): void;
  }
  export class HydrologyEngine {
    constructor(seed: string, width: number, resolution: number, height: Float32Array, seaEnabled: boolean);
    static with_drainage(seed: string, width: number, resolution: number, height: Float32Array, seaEnabled: boolean, filled: Float32Array, receivers: Uint32Array, accumulation: Float32Array): HydrologyEngine;
    filled(): Float32Array; receivers(): Uint32Array; accumulation(): Float32Array;
    generate(main: string, density: number, wetness: number, lakes: string, meanders: string, meanderIntensity: number, estuary: string, widthScale: number, incision: number, minLakeArea: number, lakeAbundance?: number, lakeCoverage?: number, maxLakeArea?: number, depressionPolicy?: string, maxBreachDepth?: number, maxBreachLength?: number): HydrologyOutput;
    free(): void;
  }
  export interface TerrainOutput {
    readonly x: number; readonly y: number; readonly width: number; readonly resolution: number;
    readonly min_height: number; readonly max_height: number;
    readonly height: Float32Array; readonly cave_mask: Uint8Array;
    readonly normal_x: Float32Array; readonly normal_y: Float32Array; readonly normal_z: Float32Array;
    free(): void;
  }
  export function generate_terrain(seed: string, width: number, relief: string, erosion: number, resolution: number): TerrainOutput;
  export class TerrainEngine {
    static with_source(seed: string, width: number, relief: string, erosion: number, motif: number, mix: number, source: Float32Array, environment?: string): TerrainEngine;
    static with_generation_noise(seed: string, width: number, relief: string, erosion: number, motif: number, mix: number, coarse: Float32Array, fine: Float32Array, environment?: string): TerrainEngine;
    static prepare_environment(seed: string, width: number, relief: string, erosion: number, motif: number): Float32Array;
    constructor(seed: string, map_width: number, relief: string, erosion: number, motif_size: number, mountain_mix?: number, environment?: string);
    readonly min_height: number; readonly max_height: number;
    sampling_field(): Float32Array;
    set_coast(mask: number, mode: string): void;
    coast_parameters(): Float32Array;
    configure_coast(mask: number, mode: string): void;
    coast_erosion_parameters(): Float32Array;
    set_coast_surface(heights: Float32Array): void;
    sampling_parameters(): Float64Array;
    sampling_permutations(): Uint32Array;
    sampling_gradients(): Float32Array;
    sampling_branches(): Float32Array;
    sample_region(x: number, y: number, extent: number, resolution: number): TerrainOutput;
    free(): void;
  }
  export class GenerationNoisePlan {
    static generation(seed: string, width: number, relief: string, motif: number): GenerationNoisePlan;
    static finite_shape(seed: string, motif: number, relief: string, erosion: number): GenerationNoisePlan;
    static erosion(seed: string, width: number, relief: string, erosion: number, motif: number, mix: number): GenerationNoisePlan;
    constructor(seed: string, width: number, motif: number);
    parameters(): Float32Array; permutations(): Uint32Array; gradients(): Float32Array;
    free(): void;
  }
}
