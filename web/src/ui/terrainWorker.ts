import { sampleRustTerrain, type TerrainRequest, type TerrainResponse } from '../../../rust/bridge/terrain';

let latestGeneration = 0;
let pending: TerrainRequest | undefined;
let running = false;
self.onmessage = (event: MessageEvent<TerrainRequest>) => {
  const { generation } = event.data;
  if (generation < latestGeneration) return;
  latestGeneration = generation;
  pending = event.data;
  if (!running) void drain();
};
async function drain(): Promise<void> {
  running = true;
  try {
    while (pending) {
      const request = pending; pending = undefined;
      const { id, generation, kind } = request;
      try {
        const terrain = await sampleRustTerrain(request);
        const waiting = pending as TerrainRequest | undefined;
        if (generation !== latestGeneration || (waiting && waiting.id > id)) continue;
        self.postMessage({ id, generation, kind, terrain } satisfies TerrainResponse, { transfer: [terrain.height.buffer, terrain.caveMask.buffer, terrain.normalX.buffer, terrain.normalY.buffer, terrain.normalZ.buffer] });
      } catch (error) {
        if (generation === latestGeneration) self.postMessage({ id, generation, kind, error: error instanceof Error ? error.message : String(error) } satisfies TerrainResponse);
      }
    }
  } finally { running = false; }
}
