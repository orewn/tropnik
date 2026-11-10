export type SoftwareMapRenderer = 'swiftshader' | 'llvmpipe' | 'softpipe';

/** Match actual software rasterizers, never browser or device names. Unknown
 * and privacy-masked renderers keep the ordinary camera profile. */
export function softwareMapRenderer(value: unknown): SoftwareMapRenderer | undefined {
  if (typeof value !== 'string') return;
  if (/\bSwiftShader\b/i.test(value)) return 'swiftshader';
  if (/\bllvmpipe\b/i.test(value)) return 'llvmpipe';
  if (/\bsoftpipe\b/i.test(value)) return 'softpipe';
}

/** Read the map's existing context without allocating a probe or changing any
 * framebuffer state. Re-read after restoration in case the renderer changed. */
export function readSoftwareMapRenderer(canvas: HTMLCanvasElement): SoftwareMapRenderer | undefined {
  try {
    const gl = canvas.getContext('webgl2');
    if (!gl || gl.isContextLost()) return;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return softwareMapRenderer(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  } catch {return;}
}
