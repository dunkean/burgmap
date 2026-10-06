// Keep the ordinary TypeScript build independent of the generated Rust package.
declare module '*burgmap_wasm.js' {
  export default function init(options: { module_or_path: ArrayBuffer }): Promise<unknown>;
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
