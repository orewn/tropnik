import {MAP_CONFIG} from './map-config.ts';

export type SoftwareMapRenderer = 'swiftshader' | 'llvmpipe' | 'softpipe';

/** These are software rasterizers, not browser/device model names. Unknown or
 * privacy-masked renderers retain the ordinary configured resolution. */
export function softwareMapRenderer(value: unknown): SoftwareMapRenderer | undefined {
  if (typeof value !== 'string') return;
  if (/\bSwiftShader\b/i.test(value)) return 'swiftshader';
  if (/\bllvmpipe\b/i.test(value)) return 'llvmpipe';
  if (/\bsoftpipe\b/i.test(value)) return 'softpipe';
}

type DensityMap = Pick<import('maplibre-gl').Map, 'getCanvas' | 'getPixelRatio' | 'setPixelRatio' | 'getTerrain' | 'on' | 'off'>;

/** Read the map's existing context; do not allocate a probe context or change
 * framebuffer state. This also rechecks a context restored on a different GPU. */
export function readSoftwareMapRenderer(canvas: HTMLCanvasElement): SoftwareMapRenderer | undefined {
  try {
    const gl = canvas.getContext('webgl2');
    if (!gl || gl.isContextLost()) return;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return softwareMapRenderer(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  } catch {return;}
}

/** Terrain's output/depth buffers are expensive on CPU rasterizers. Reduce
 * their backing resolution only while terrain is active; CSS camera geometry
 * and DOM controls stay at their normal size. Tile RTT/DEM resolution is not
 * changed by this policy, and map labels/lines can appear softer in terrain. */
export class MapRenderDensity {
  private readonly map: DensityMap;
  private readonly baseline: number;
  private disposed = false;
  private readonly terrainChanged = () => this.setTerrain(!!this.map.getTerrain());

  constructor(map: DensityMap) {
    this.map = map; this.baseline = map.getPixelRatio();
    // Every explicit setTerrain and the SDK's asynchronous style/context
    // restoration emits this public event, including cluster expansion.
    map.on('terrain', this.terrainChanged);
  }

  setTerrain(active: boolean): void {
    if (this.disposed) return;
    const software = active && readSoftwareMapRenderer(this.map.getCanvas());
    const ratio = software ? Math.min(this.baseline, MAP_CONFIG.softwareTerrainPixelRatio) : this.baseline;
    if (this.map.getPixelRatio() !== ratio) this.map.setPixelRatio(ratio);
  }

  dispose(): void {this.disposed = true; this.map.off('terrain', this.terrainChanged);}
}
