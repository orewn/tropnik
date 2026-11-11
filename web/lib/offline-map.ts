export type OfflineManifest = {
  id: string;
  title: string;
  complete: boolean;
  bbox: number[];
  tileCount: number;
  maxzoom: number;
  packageBytesIncludingManifest: number;
  source: { sourceSnapshotDateInIdentifier: string };
  files: { path: string; bytes: number; sha256: string }[];
};
export type MapReceipt = {
  id: string;
  cacheName: string;
  savedAt: string;
  bytes: number;
  files: number;
  verified: true;
  landscape?: boolean;
};

const receiptPath = '/_offline/verified-map';
const mutationLock = 'tropnik-download-map';
const changeEvent = 'tropnik-offline-map-change';

async function mutateMap<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!navigator.locks?.request) {
    throw new Error('Браузер не поддерживает безопасное изменение пакета между вкладками. Обновите браузер и повторите. Сохранённую карту можно открыть.');
  }
  return navigator.locks.request(mutationLock, { mode: 'exclusive', signal }, async () => {
    signal?.throwIfAborted();
    return operation();
  });
}

function notifyMapChange() {
  window.dispatchEvent(new Event(changeEvent));
  // Only a public cache-change signal crosses tabs; no account data is sent.
  try {
    const channel = new BroadcastChannel(changeEvent);
    channel.postMessage('changed');
    channel.close();
  } catch { /* Focus refresh also works when BroadcastChannel is unavailable. */ }
}

export function watchMapChanges(listener: () => void): () => void {
  window.addEventListener(changeEvent, listener);
  window.addEventListener('focus', listener);
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(changeEvent);
    channel.onmessage = listener;
  } catch { /* Reading an installed package does not depend on this channel. */ }
  return () => {
    window.removeEventListener(changeEvent, listener);
    window.removeEventListener('focus', listener);
    channel?.close();
  };
}

export async function getMapReceipt(): Promise<MapReceipt | null> {
  if (!('caches' in window)) return null;
  const names = (await caches.keys()).filter(name => name.startsWith('tropnik-map-')).sort().reverse();
  for (const name of names) {
    const cache = await caches.open(name);
    const item = await cache.match(receiptPath);
    if (!item) continue;
    try {
      const receipt = await item.json() as MapReceipt;
      if (receipt.verified === true && receipt.cacheName === name && (await caches.keys()).includes(name)) return receipt;
    } catch { /* An unreadable marker must not claim that the package is ready. */ }
  }
  return null;
}

export async function removeMap(): Promise<void> {
  if (!('caches' in window)) return;
  await mutateMap(async () => {
    const names = (await caches.keys()).filter(name => name.startsWith('tropnik-map-') || name.startsWith('tropnik-staging-'));
    // Settle all removals before releasing the shared mutation lock.
    const removed = await Promise.allSettled(names.map(name => caches.delete(name)));
    notifyMapChange();
    const failed = removed.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  });
}

export async function downloadMap(onProgress: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<MapReceipt> {
  if (!window.isSecureContext || !('caches' in window) || !crypto.subtle) {
    throw new Error('Для сохранения подробной карты нужен защищённый HTTPS-адрес и поддержка хранилища браузером.');
  }
  return mutateMap(async () => {
    const response = await fetch('/offline-map/manifest.json', { cache: 'no-store', signal });
    if (!response.ok) throw new Error('Паспорт карты недоступен. Скачивание не начато.');
    const manifest = await response.clone().json() as OfflineManifest;
    if (!manifest.complete || typeof manifest.id !== 'string' || !/^[\w.-]{1,160}$/.test(manifest.id)
      || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 1000
      || manifest.files.some(file => !file.path || file.path.startsWith('/') || file.path.split('/').includes('..')
        || !/^\w[\w /.-]+$/.test(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0)
      || new Set(manifest.files.map(file => file.path)).size !== manifest.files.length) {
      throw new Error('Паспорт карты не прошёл проверку.');
    }
    const required = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
    if (!Number.isSafeInteger(required)) throw new Error('Размер пакета карты не прошёл проверку.');
    const quota = await navigator.storage?.estimate();
    if (typeof quota?.quota === 'number' && typeof quota.usage === 'number' && quota.quota - quota.usage < required * 1.5) {
      throw new Error('Недостаточно свободного места для карты. Освободите место и повторите.');
    }
    // A replacement never writes into the last verified copy, even if the
    // clock repeats a timestamp or two tabs request the same manifest.
    const cacheName = 'tropnik-map-' + Date.now() + '-' + crypto.randomUUID() + '-' + manifest.id;
    const cache = await caches.open(cacheName);
    const transfer = new AbortController();
    const abort = () => transfer.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    let published = false;
    let index = 0;
    let loaded = 0;
    try {
      signal?.throwIfAborted();
      const workers = Array.from({ length: 4 }, async () => {
        while (index < manifest.files.length) {
          transfer.signal.throwIfAborted();
          const file = manifest.files[index++];
          const url = '/offline-map/' + file.path.split('/').map(encodeURIComponent).join('/');
          const result = await fetch(url, { cache: 'no-store', signal: transfer.signal });
          if (!result.ok) throw new Error('Не все части карты удалось скачать. Пакет не помечен готовым.');
          const bytes = await result.arrayBuffer();
          if (bytes.byteLength !== file.bytes) throw new Error('Размер файла карты отличается от паспорта.');
          const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(value => value.toString(16).padStart(2, '0')).join('');
          if (digest !== file.sha256) throw new Error('Проверка целостности карты не пройдена.');
          transfer.signal.throwIfAborted();
          await cache.put(url, new Response(bytes, { headers: { 'Content-Type': result.headers.get('Content-Type') || 'application/octet-stream' } }));
          onProgress(++loaded, manifest.files.length);
        }
      });
      try {
        await Promise.all(workers);
      } catch (error) {
        transfer.abort();
        await Promise.allSettled(workers);
        throw error;
      }
      // Keep the exact manifest whose hashes were checked, including across a deployment.
      await cache.put('/offline-map/manifest.json', response);
      transfer.signal.throwIfAborted();
      const receipt: MapReceipt = {
        id: manifest.id, cacheName, savedAt: new Date().toISOString(), bytes: required,
        files: loaded, verified: true, landscape: manifest.files.some(file => file.path === 'terrain/landscape.html'),
      };
      await cache.put(receiptPath, new Response(JSON.stringify(receipt), { headers: { 'Content-Type': 'application/json' } }));
      published = true;
      notifyMapChange();
      // Once published, a failed cleanup cannot roll back the new working copy.
      const old = (await caches.keys().catch(() => [])).filter(name => name.startsWith('tropnik-map-') && name !== cacheName);
      await Promise.allSettled(old.map(name => caches.delete(name)));
      navigator.storage?.persist?.().catch(() => {});
      return receipt;
    } catch (error) {
      if (!published) await caches.delete(cacheName).catch(() => false);
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }, signal);
}
