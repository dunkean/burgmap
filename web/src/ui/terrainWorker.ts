import { sampleRustTerrain, type TerrainRequest, type TerrainResponse } from '../../../rust/bridge/terrain';

let latestGeneration = 0;
self.onmessage = async (event: MessageEvent<TerrainRequest>) => {
  const { id, generation, kind } = event.data;
  if (generation < latestGeneration) return;
  latestGeneration = generation;
  try {
    const terrain = await sampleRustTerrain(event.data);
    if (generation !== latestGeneration) return;
    self.postMessage({ id, generation, kind, terrain } satisfies TerrainResponse, { transfer: [terrain.height.buffer, terrain.caveMask.buffer, terrain.normalX.buffer, terrain.normalY.buffer, terrain.normalZ.buffer] });
  } catch (error) {
    self.postMessage({ id, generation, kind, error: error instanceof Error ? error.message : String(error) } satisfies TerrainResponse);
  }
};
