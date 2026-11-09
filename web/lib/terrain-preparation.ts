import type {TerrainGrid, TerrainModel} from '../public/terrain/terrain-renderer.js';

export type TerrainRendererModule = typeof import('../public/terrain/terrain-renderer.js');
export type PreparedTerrain = [TerrainRendererModule, TerrainGrid, TerrainModel];
export type TerrainPreparationRequest = {type: 'prepare-terrain'; protocol: 1; requestId: number; grid: TerrainGrid};
export type TerrainPreparationResponse =
  | {type: 'terrain-prepared'; protocol: 1; requestId: number; model: TerrainModel}
  | {type: 'terrain-error'; protocol: 1; requestId: number; error: string};
export type TerrainPreparationWorker = Pick<Worker, 'onmessage' | 'onerror' | 'onmessageerror' | 'postMessage' | 'terminate'>;
type Options = {
  loadModule: () => Promise<TerrainRendererModule>;
  loadGrid: () => Promise<TerrainGrid>;
  createWorker?: () => TerrainPreparationWorker | undefined;
  timeoutMs?: number;
  onFailure?: (error: unknown) => void;
};
type PreparationInfo = {
  state: 'idle' | 'loading' | 'worker' | 'cooperative' | 'ready' | 'failed';
  method: 'worker' | 'cooperative' | null;
  attempts: number;
  workerStarts: number;
  fallbackReason: string | null;
};

function abortReason(signal: AbortSignal) {
  return signal.reason ?? new DOMException('Terrain preview wait cancelled', 'AbortError');
}

/** Cancels only this consumer's wait; an opened card cannot destroy shared preparation. */
function waitFor<T>(job: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const abort = () => {signal.removeEventListener('abort', abort); reject(abortReason(signal));};
    signal.addEventListener('abort', abort, {once: true});
    job.then(value => {signal.removeEventListener('abort', abort); resolve(value);}, error => {signal.removeEventListener('abort', abort); reject(error);});
  });
}

/** One fixed preview per coordinator. Its successful model lives until the page unloads. */
export class TerrainPreparation {
  private options: Options;
  private job?: Promise<PreparedTerrain>;
  private info: PreparationInfo = {state: 'idle', method: null, attempts: 0, workerStarts: 0, fallbackReason: null};
  constructor(options: Options) {this.options = options;}

  load(signal?: AbortSignal): Promise<PreparedTerrain> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (!this.job) {
      const job = this.prepare().catch(error => {
        if (this.job === job) this.job = undefined;
        this.info.state = 'failed';
        try {this.options.onFailure?.(error);} catch {/* Cleanup must retain the original error. */}
        throw error;
      });
      this.job = job;
    }
    return signal ? waitFor(this.job, signal) : this.job;
  }

  snapshot(): PreparationInfo {return {...this.info};}

  private async prepare(): Promise<PreparedTerrain> {
    this.info.state = 'loading'; this.info.method = null; this.info.fallbackReason = null; this.info.attempts++;
    const [module, grid] = await Promise.all([this.options.loadModule(), this.options.loadGrid()]);
    let model: TerrainModel;
    try {
      this.info.state = 'worker';
      const candidate = await this.prepareInWorker(grid);
      model = module.validatePreparedTerrainModel(grid, candidate);
      this.info.method = 'worker';
    } catch (error) {
      // This is an explicit compatibility path, using the same maths in bounded tasks.
      this.info.state = 'cooperative';
      this.info.fallbackReason = error instanceof Error ? error.message : 'Terrain worker unavailable';
      model = module.validatePreparedTerrainModel(grid, await module.createTerrainModelAsync(grid));
      this.info.method = 'cooperative';
    }
    // Structured cloning sent a second copy of elevations. Keep the canonical source only.
    model.grid = grid;
    this.info.state = 'ready';
    return [module, grid, model];
  }

  private prepareInWorker(grid: TerrainGrid): Promise<TerrainModel> {
    const worker = this.options.createWorker?.();
    if (!worker) return Promise.reject(new Error('Terrain worker unsupported'));
    this.info.workerStarts++;
    const requestId = this.info.attempts;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, model?: TerrainModel) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
        worker.terminate();
        if (error) reject(error); else resolve(model!);
      };
      worker.onmessage = event => {
        const message = event.data as TerrainPreparationResponse | undefined;
        if (!message || message.protocol !== 1 || message.requestId !== requestId) {finish(new Error('Invalid terrain worker response')); return;}
        if (message.type === 'terrain-prepared') finish(undefined, message.model);
        else if (message.type === 'terrain-error') finish(new Error(`Terrain worker: ${String(message.error).slice(0, 400)}`));
        else finish(new Error('Unknown terrain worker response'));
      };
      worker.onerror = event => {event.preventDefault?.(); finish(new Error(event.message || 'Terrain worker failed'));};
      worker.onmessageerror = () => finish(new Error('Terrain worker message could not be decoded'));
      const timeout = this.options.timeoutMs ?? 20000;
      const timer = setTimeout(() => finish(new Error('Terrain worker timed out')), Number.isFinite(timeout) ? Math.max(1, timeout) : 20000);
      try {worker.postMessage({type: 'prepare-terrain', protocol: 1, requestId, grid} satisfies TerrainPreparationRequest);}
      catch (error) {finish(error instanceof Error ? error : new Error('Terrain worker could not receive the grid'));}
    });
  }
}
