/** Only public map assets may cross the preview/render cache boundary. */
export function publicMapResourceKey(url: string, origin = 'https://map-preview.local'): string | null {
  try {
    if (url.startsWith('//')) return null;
    const base = new URL(origin), parsed = new URL(url, base);
    if (parsed.username || parsed.password || parsed.hash || /%2f|%5c|%00/i.test(parsed.pathname)) return null;
    if (parsed.origin === base.origin && ['/data/', '/maps/', '/terrain/'].some(prefix => parsed.pathname.startsWith(prefix))) return parsed.pathname + parsed.search;
    if (parsed.protocol === 'https:' && !parsed.port && ['tiles.openfreemap.org', 'tiles.mapterhorn.com'].includes(parsed.hostname)) return parsed.href;
    return null;
  } catch {return null;}
}

type PublicPool = {
  has: (url: string) => boolean;
  get: (url: string, priority?: number) => Promise<ArrayBuffer>;
  json: <T>(url: string, priority?: number) => Promise<T>;
};
const scheme = 'tropnik-map://';
function aborted() {return new DOMException('Map request cancelled', 'AbortError');}

/** A cancelled consumer must not abort another card or map sharing the fetch. */
export function consumeShared<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(aborted());
    if (signal.aborted) {void promise.catch(() => {}); reject(aborted()); return;}
    signal.addEventListener('abort', cancel, {once: true});
    promise.then(value => {
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) reject(aborted()); else resolve(value);
    }, error => {signal.removeEventListener('abort', cancel); reject(error);});
  });
}

export function createMapTransport(pool: PublicPool, origin: () => string) {
  return {
    transformRequest(url: string) {
      const key = publicMapResourceKey(url, origin());
      // Leave new live requests to MapLibre's own scheduling and cancellation.
      return {url: key && pool.has(key) ? scheme + encodeURIComponent(key) : url};
    },
    async load(params: {url: string; type?: string}, controller: AbortController) {
      if (!params.url.startsWith(scheme)) throw new Error('Unknown map protocol');
      const key = publicMapResourceKey(decodeURIComponent(params.url.slice(scheme.length)), origin());
      if (!key) throw new Error('Unknown public map resource');
      if (controller.signal.aborted) throw aborted();
      if (params.type === 'json') {
        const data = await consumeShared(pool.json<unknown>(key, 0), controller.signal);
        if (data === null || typeof data !== 'object') throw new Error('Invalid public map JSON');
        return {data: structuredClone(data)};
      }
      const bytes = await consumeShared(pool.get(key, 0), controller.signal);
      // MapLibre transfers vector buffers to workers. Keep our cached buffer intact.
      return {data: params.type === 'string' ? new TextDecoder().decode(bytes) : bytes.slice(0)};
    },
  };
}
