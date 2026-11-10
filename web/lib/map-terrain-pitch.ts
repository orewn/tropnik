import {terrainPitchForZoom} from './map-camera-profile.ts';

type TerrainPitchCamera = {
  getZoom: () => number;
  getPitch: () => number;
  isMoving: () => boolean;
  easeTo: (options: {pitch: number; duration: number}) => unknown;
};
type TerrainPitchOptions = {
  camera: TerrainPitchCamera;
  enabled: () => boolean;
  focused: () => boolean;
  reducedMotion: () => boolean;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (id: number) => void;
};

/** Apply the scale profile after the SDK has left zoomend. The zoom-button
 * queue must be notified first: a queued next zoom owns the next frame and
 * cancels this correction. A manual pan/rotation has the same priority. */
export class MapTerrainPitch {
  private readonly options: TerrainPitchOptions;
  private frame: number | undefined;
  private requestedPitch: number | undefined;
  private revision = 0;
  private disposed = false;

  constructor(options: TerrainPitchOptions) {this.options = options;}

  settled(): void {
    if (this.disposed || this.frame !== undefined) return;
    const revision = this.revision;
    const run = () => {
      if (this.disposed || revision !== this.revision) return;
      this.frame = undefined;
      const {camera} = this.options;
      if (!this.options.enabled()) {this.requestedPitch = undefined; return;}
      if (camera.isMoving()) return;
      const zoom = camera.getZoom(), current = camera.getPitch();
      if (!Number.isFinite(zoom) || !Number.isFinite(current)) return;
      const pitch = terrainPitchForZoom(zoom, this.options.focused());
      // Terrain clearance can lower both rendered pitch and zoom. Retrying the
      // same requested pitch fights that safe camera and subtracts zoom again.
      // A manual angle also remains authoritative until the profile changes.
      if (pitch === this.requestedPitch) return;
      this.requestedPitch = pitch;
      if (Math.abs(current - pitch) <= 1.5) return;
      camera.easeTo({pitch, duration: this.options.reducedMotion() ? 0 : 180});
    };
    this.frame = this.options.requestFrame ? this.options.requestFrame(run) : requestAnimationFrame(run);
  }

  /** Record an explicit activation/selection camera's requested pitch before
   * the SDK applies its terrain clearance. Never infer it from clamped output. */
  remember(pitch: number): void {
    if (this.disposed) return;
    this.moving();
    this.requestedPitch = Number.isFinite(pitch) ? pitch : undefined;
  }

  reset(): void {this.moving(); this.requestedPitch = undefined;}

  moving(): void {
    this.revision++;
    if (this.frame !== undefined) {
      if (this.options.cancelFrame) this.options.cancelFrame(this.frame);
      else cancelAnimationFrame(this.frame);
      this.frame = undefined;
    }
  }

  dispose(): void {this.disposed = true; this.reset();}
}
