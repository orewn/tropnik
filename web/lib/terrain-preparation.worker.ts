import {createTerrainModel} from '../public/terrain/terrain-renderer.js';
import type {TerrainPreparationRequest, TerrainPreparationResponse} from './terrain-preparation';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<TerrainPreparationRequest>) => void) | null;
  postMessage: (message: TerrainPreparationResponse, transfer: Transferable[]) => void;
};
let started = false;

scope.onmessage = ({data}) => {
  if (started || data?.type !== 'prepare-terrain' || data.protocol !== 1 || !Number.isInteger(data.requestId)) return;
  started = true;
  try {
    const model = createTerrainModel(data.grid);
    // Transfer only worker-owned derivatives. The caller's canonical grid stays attached.
    const transfer = [model.heights.buffer, model.normals.buffer, model.normalTexture.buffer] as ArrayBuffer[];
    scope.postMessage({type: 'terrain-prepared', protocol: 1, requestId: data.requestId, model}, transfer);
  } catch (error) {
    scope.postMessage({type: 'terrain-error', protocol: 1, requestId: data.requestId, error: error instanceof Error ? error.message : 'Terrain preparation failed'}, []);
  }
};
