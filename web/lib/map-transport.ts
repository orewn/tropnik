/** Only public map assets may cross the preview/render cache boundary. */
export function publicMapResourceKey(url: string, origin = 'https://map-preview.local'): string | null {
  try {
    if (url.startsWith('//')) return null;
    const base = new URL(origin), parsed = new URL(url, base);
    if (parsed.username || parsed.password || parsed.hash || /%2f|%5c|%00/i.test(parsed.pathname)) return null;
    if (parsed.origin === base.origin && ['/data/', '/maps/', '/terrain/', '/offline-map/'].some(prefix => parsed.pathname.startsWith(prefix))) return parsed.pathname + parsed.search;
    if (parsed.protocol === 'https:' && !parsed.port && ['tiles.openfreemap.org', 'tiles.mapterhorn.com'].includes(parsed.hostname)) return parsed.href;
    if (parsed.protocol === 'https:' && !parsed.port && parsed.hostname === 'tiles.maps.eox.at' && !parsed.search && /^\/wmts\/1\.0\.0\/(s2cloudless_3857|bluemarble_3857)\/default\/g\/\d+\/\d+\/\d+\.jpg$/.test(parsed.pathname)) return parsed.href;
    return null;
  } catch {return null;}
}

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
