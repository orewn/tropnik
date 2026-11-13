/** Decoded JSON budgets shared by the browser, SSR and same-origin BFF.
 * Requests and ordinary responses use 1 MiB; exact resource policies below
 * allow larger successful responses without broadening error budgets. */
export const API_TRANSPORT_LIMITS = Object.freeze({
  requestBytes: 1024 * 1024,
  responseBytes: 1024 * 1024,
  chatBytes: 4 * 1024 * 1024,
  collectionBytes: 8 * 1024 * 1024,
  emergencyCardBytes: 2 * 1024 * 1024,
  safetyPassportBytes: 16 * 1024 * 1024,
  routeDetailBytes: 8 * 1024 * 1024,
  statusBytes: 4096,
  browserTimeoutMs: 15_000,
  proxyTimeoutMs: 12_000,
  statusTimeoutMs: 10_000,
  serverTimeoutMs: 6000,
  chatRefreshMs: 10_000,
});

const richCollections = new Set(['recruitment-requests', 'me/reports', 'me/moderation-actions', 'me/appeals', 'me/notifications', 'moderation/reports', 'moderation/appeals']);

/** Larger success budgets apply only to the explicitly bounded resources.
 * Errors and unlisted paths or methods always keep the default cap. */
export function apiResponseBytes(path: string, method = 'GET', successful = true): number {
  const pathname = path.split('?', 1)[0].replace(/^\//, '');
  if (!successful) return API_TRANSPORT_LIMITS.responseBytes;
  const operation = method.toUpperCase();
  if (operation === 'GET') {
    if (/^routes\/[A-Za-z0-9_-]{1,128}$/.test(pathname)) return API_TRANSPORT_LIMITS.routeDetailBytes;
    // The latest 100 messages allow 4000 Unicode characters each. Go's JSON
    // HTML escaping can encode one character as six bytes (for example '<').
    if (/^(?:departures|recruitment-requests)\/[A-Za-z0-9_-]{1,128}\/messages$/.test(pathname)) return API_TRANSPORT_LIMITS.chatBytes;
    // These SQL-bounded latest-100 collections contain moderated target text,
    // reasons or reviews. All maxima include Go's six-byte JSON escaping.
    if (richCollections.has(pathname) || /^(?:departures|guides)\/[A-Za-z0-9_-]{1,128}\/reviews$/.test(pathname)) return API_TRANSPORT_LIMITS.collectionBytes;
    if (/^departures\/[A-Za-z0-9_-]{1,128}\/emergency-card$/.test(pathname)) return API_TRANSPORT_LIMITS.emergencyCardBytes;
    if (/^departures\/[A-Za-z0-9_-]{1,128}\/safety-passport$/.test(pathname)) return API_TRANSPORT_LIMITS.safetyPassportBytes;
  }
  // These five mutations return the complete passport, not a small ack.
  // Valid route metadata can occupy most of the existing 8 MiB route budget;
  // the passport adds private details and may exceed that original envelope.
  if (operation === 'POST' && /^departures\/[A-Za-z0-9_-]{1,128}\/(?:safety-passport\/prepare|mchs\/(?:submission|confirmation|start-contact|return-report))$/.test(pathname)) return API_TRANSPORT_LIMITS.safetyPassportBytes;
  return API_TRANSPORT_LIMITS.responseBytes;
}

export class BodyLimitError extends Error {
  constructor() { super('JSON body exceeds its byte budget'); this.name = 'BodyLimitError'; }
}

/** One deadline covers the request, headers and body. Disposing also releases
 * an unread response, while caller cancellation retains its original reason. */
export function requestDeadline(timeoutMs: number, parent?: AbortSignal | null) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError('Invalid API deadline');
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort(); else parent?.addEventListener('abort', abort, {once: true});
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort(new DOMException('API request timed out', 'TimeoutError'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() { clearTimeout(timer); parent?.removeEventListener('abort', abort); controller.abort(); },
  };
}

type BodySource = Pick<Request, 'body' | 'headers'>;
/** A traversal shares one decoded-byte allowance across all its responses. */
export type ResponseByteBudget = {remainingBytes: number};

/** Count streamed, decoded bytes even without Content-Length. Cancellation
 * releases a pending read as well as the reader lock; a slow cancel hook cannot
 * keep the request alive after its deadline. */
export async function readBoundedBody(source: BodySource, maxBytes: number, signal: AbortSignal, budget?: ResponseByteBudget): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || budget && (!Number.isSafeInteger(budget.remainingBytes) || budget.remainingBytes < 0)) throw new RangeError('Invalid JSON byte budget');
  signal.throwIfAborted();
  if (!source.body) return new Uint8Array(0);
  const reader = source.body.getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', cancel, {once: true});
  try {
    const declared = source.headers.get('content-length');
    // Fetch exposes decoded bytes but retains the wire Content-Length. Gzip
    // framing can be larger than a small valid body, so only identity lengths
    // may reject early; the stream is always counted below.
    const encoding = source.headers.get('content-encoding')?.trim().toLowerCase();
    if ((!encoding || encoding === 'identity') && declared && /^\d+$/.test(declared) && Number(declared) > Math.min(maxBytes, budget?.remainingBytes ?? maxBytes)) throw new BodyLimitError();
    const bodyLimit = Math.min(maxBytes, budget?.remainingBytes ?? maxBytes);
    let bytes = new Uint8Array(0);
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const {done, value} = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (value.byteLength > maxBytes - size || budget && value.byteLength > budget.remainingBytes) throw new BodyLimitError();
      if (budget) budget.remainingBytes -= value.byteLength;
      const required = size + value.byteLength;
      if (required > bytes.length) {
        const capacity = Math.min(bodyLimit, Math.max(required, bytes.length * 2, 4096));
        const grown = new Uint8Array(capacity);
        grown.set(bytes.subarray(0, size)); bytes = grown;
      }
      bytes.set(value, size); size = required;
    }
    // Static source hashes and callers returning .buffer need exact bytes,
    // never spare zero-filled capacity. No chunk objects survive the read.
    return size === bytes.length ? bytes : bytes.slice(0, size);
  } finally {
    signal.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function readBoundedJSON(source: BodySource, maxBytes: number, signal: AbortSignal, budget?: ResponseByteBudget): Promise<unknown> {
  const bytes = await readBoundedBody(source, maxBytes, signal, budget);
  signal.throwIfAborted();
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
}
