type Point = {x: number; y: number};
type Rect = {left: number; top: number; right: number; bottom: number};
export type OutsideLabelEvidence = {probes: number[][]; examined: number; limited: boolean};

/** Exact outside-mask classification, prepared once before the fixture receipt.
 * Yield bounded batches so a diagnostic request never monopolises the renderer. */
export async function prepareOutsideLabelEvidence(rect: Rect, boundaryX: number,
  unproject: (point: Point) => readonly number[], covered: (coordinate: readonly number[]) => boolean,
  current: () => boolean, yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0))): Promise<OutsideLabelEvidence> {
  if (![...Object.values(rect), boundaryX].every(Number.isFinite) || rect.right <= rect.left || rect.bottom <= rect.top || rect.right - rect.left > 8192 || rect.bottom - rect.top > 8192) throw new Error('Invalid label evidence rectangle');
  const probes: number[][] = [];let examined = 0;
  if (!current()) throw new DOMException('Stale label evidence', 'AbortError');
  for (let y = Math.ceil(rect.top); y < rect.bottom; y++) for (let x = Math.ceil(Math.max(rect.left, boundaryX + 2)); x < rect.right; x++) {
    if (probes.length === 2048) return {probes, examined, limited: true};
    const point = {x: x + .5, y: y + .5};examined++;
    if (!covered(unproject(point))) probes.push([point.x, point.y]);
    if (examined % 64 === 0) {await yieldTask();if (!current()) throw new DOMException('Stale label evidence', 'AbortError');}
  }
  if (!current()) throw new DOMException('Stale label evidence', 'AbortError');
  return {probes, examined, limited: false};
}

/** Matches the native UTF-16 message cap. Never silently drop oversized proof. */
export function encodeDiagnosticMessage(message: {version: number; generation: number; type: string; payload: Record<string, unknown>}, limit = 256 * 1024) {
  const transport = {chars: 0, utf8Bytes: 0};
  message.payload.transport = transport;
  let encoded = '';
  for (let pass = 0; pass < 6; pass++) {
    encoded = JSON.stringify(message);
    const chars = encoded.length, bytes = new TextEncoder().encode(encoded).byteLength;
    if (chars === transport.chars && bytes === transport.utf8Bytes) return {encoded: chars <= limit ? encoded : undefined, ...transport};
    transport.chars = chars;transport.utf8Bytes = bytes;
  }
  throw new Error('Diagnostic size receipt did not converge');
}
