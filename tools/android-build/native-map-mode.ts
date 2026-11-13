type Mode = 'detail' | 'satellite';
type MapModeTarget = {setMode: (mode: Mode) => void; setPitch: (pitch: number) => void; setLayers: (layers: {relief: boolean}) => void; retry: () => void};

/** Connectivity changes resource admission, never the user's camera. Retain
 * the selected mode so a recovered connection can resume satellite imagery. */
export class NativeMapModeController {
  requested: Mode = 'detail';
  online = false;
  constructor(private readonly map: MapModeTarget) {}
  select(value: unknown) {
    if (value !== 'detail' && value !== 'satellite') throw new Error('Invalid map mode');
    this.requested = value;
    this.map.setPitch(0);
    if (value === 'detail') this.map.setLayers({relief: true});
    this.apply();
  }
  network(enabled: boolean) {
    const changed = enabled !== this.online;this.online = enabled;
    this.apply();
    // The engine retains its last complete ground while retrying. Going through
    // overview here used to discard that frame and force the relief mode.
    if (changed) this.map.retry();
  }
  private apply() {this.map.setMode(this.requested === 'satellite' && this.online ? 'satellite' : 'detail');}
}
