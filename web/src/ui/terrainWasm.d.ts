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
    constructor(seed: string, map_width: number, relief: string, erosion: number, motif_size: number);
    readonly min_height: number; readonly max_height: number;
    sample_region(x: number, y: number, extent: number, resolution: number): TerrainOutput;
    free(): void;
  }
}
