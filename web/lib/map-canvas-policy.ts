export type MapCanvasPolicy = Readonly<{softwareRaster: boolean; reason: 'available' | 'software' | 'unavailable'}>;

const policies = new WeakMap<Document, MapCanvasPolicy>();
const softwareRenderer = /swiftshader|llvmpipe|softpipe|lavapipe|software|microsoft basic render|\bwarp\b/i;

/** Probe only when a real map is constructed, once per document. Software GL
 * can turn ordinary 2D paths into expensive emulated GPU work. Those devices
 * use the browser's CPU rasterizer at exactly the same pixel density instead.
 * A successful context with restricted renderer metadata keeps the normal
 * browser path; an unavailable debug extension is not evidence of software GL. */
export function mapCanvasPolicy(owner: Document = document): MapCanvasPolicy {
  const cached = policies.get(owner);if (cached) return cached;
  let context: WebGL2RenderingContext | null = null;
  let reason: MapCanvasPolicy['reason'] = 'unavailable';
  try {
    const probe = owner.createElement('canvas');probe.width = 1;probe.height = 1;
    context = probe.getContext('webgl2', {alpha: false, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: true, powerPreference: 'default'});
    if (context) {
      reason = 'available';
      try {
        const debug = context.getExtension('WEBGL_debug_renderer_info');
        if (debug && softwareRenderer.test(String(context.getParameter(debug.UNMASKED_RENDERER_WEBGL)))) reason = 'software';
      } catch { /* Privacy restrictions do not make an available GPU software. */ }
    }
  } catch { /* Missing or denied GPU access uses the independent 2D fallback. */ }
  finally {
    // The probe never owns visible content or survives as a spare GPU context.
    try {context?.getExtension('WEBGL_lose_context')?.loseContext();} catch { /* Unsupported explicit disposal is left to the browser. */ }
  }
  const policy = Object.freeze({softwareRaster: reason !== 'available', reason});
  policies.set(owner, policy);return policy;
}
