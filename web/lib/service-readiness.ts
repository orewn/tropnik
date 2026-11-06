export type ServiceStatus = {
  configured: boolean;
  connected: boolean;
  version: '0.1.0';
  mode: 'preview' | 'connected' | 'unavailable';
  reason?: 'service_config' | 'upstream_unavailable';
};

type StatusResult = {status: 200 | 503; body: ServiceStatus};
type ProbeOptions = {fetcher?: typeof fetch; timeoutMs?: number};
const MAX_RESPONSE_BYTES = 4096;
const READY_TIMEOUT_MS = 3000;

function result(configured: boolean, connected: boolean, reason?: ServiceStatus['reason']): StatusResult {
  return {
    status: !configured || connected ? 200 : 503,
    body: {configured, connected, version: '0.1.0', mode: connected ? 'connected' : configured ? 'unavailable' : 'preview', ...(reason ? {reason} : {})},
  };
}

async function readyBody(response: Response, signal: AbortSignal): Promise<boolean> {
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || !response.body) return false;
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, {once: true});
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      if (signal.aborted) return false;
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { cancel(); return false; }
      chunks.push(value);
    }
    if (signal.aborted) return false;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
    const json: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!json || typeof json !== 'object' || Array.isArray(json) || 'error' in json) return false;
    const data = (json as {data?: unknown}).data;
    const meta = (json as {meta?: unknown}).meta;
    return !!data && typeof data === 'object' && !Array.isArray(data) && (data as {status?: unknown}).status === 'ready'
      && !!meta && typeof meta === 'object' && !Array.isArray(meta) && (meta as {mode?: unknown}).mode === 'production';
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

// No user-supplied URL, credentials or diagnostics are returned to the browser.
// A health/live response is deliberately insufficient: Go health/ready checks DB.
export async function probeServiceReadiness(config: string | undefined, options: ProbeOptions = {}): Promise<StatusResult> {
  const base = config?.trim();
  if (!base) return result(false, false);
  let url: URL;
  try {
    url = new URL(base);
    const local = ['localhost', '127.0.0.1', '[::1]', 'api'].includes(url.hostname);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.protocol === 'http:' && !local) return result(true, false, 'service_config');
    url.pathname = url.pathname.replace(/\/$/, '') + '/api/v1/health/ready';
  } catch { return result(true, false, 'service_config'); }

  const controller = new AbortController();
  const timeoutMs = Math.min(READY_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? READY_TIMEOUT_MS));
  const fetcher = options.fetcher ?? fetch;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(false); }, timeoutMs);
  });
  const probe = (async () => {
    try {
      const response = await fetcher(url, {method: 'GET', headers: {Accept: 'application/json'}, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal});
      return await readyBody(response, controller.signal);
    } catch { return false; }
  })();
  try { const connected = await Promise.race([probe, timeout]); return result(true, connected, connected ? undefined : 'upstream_unavailable'); }
  finally { clearTimeout(timer); controller.abort(); }
}

// A healthy Go service alone does not make a misconfigured browser BFF usable.
// The route passes the result of the same public-origin policy as the BFF.
export async function probeWebServiceReadiness(config: string | undefined, publicOriginValid: boolean, options: ProbeOptions = {}): Promise<StatusResult> {
  if (config?.trim() && !publicOriginValid) return result(true, false, 'service_config');
  return probeServiceReadiness(config, options);
}
