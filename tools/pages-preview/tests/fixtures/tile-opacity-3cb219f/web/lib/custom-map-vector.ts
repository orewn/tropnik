/**
 * Independent, bounded Mapbox Vector Tile decoder. No map SDK or renderer runs here.
 * Format: https://github.com/mapbox/vector-tile-spec/tree/master/2.1
 * Wire encoding: https://protobuf.dev/programming-guides/encoding/
 *
 * Coordinates remain in source tile units, including its buffer outside the extent.
 * Ring order and every source layer/property are preserved. Polygon rings are returned
 * explicitly closed; their closing vertex does not move the MVT delta cursor.
 */
export type VectorPoint = {x: number; y: number};
export type VectorFeature = {
  id?: number;
  type: 1 | 2 | 3;
  properties: Record<string, string | number | boolean>;
  geometry: VectorPoint[][];
};
export type VectorLayer = {name: string; extent: number; features: VectorFeature[]};
export type VectorTile = {layers: Record<string, VectorLayer>};

/** Per-tile allocation/work limits; checked before allocating decoded collections. */
export const VECTOR_TILE_LIMITS = Object.freeze({
  bytes: 8 * 1024 * 1024,
  layers: 256,
  features: 100_000,
  dictionaryEntries: 200_000,
  stringBytes: 256 * 1024,
  tagPairsPerFeature: 2048,
  tagPairs: 500_000,
  geometryWords: 2_000_000,
  points: 500_000,
  groupDepth: 16,
});

type Scalar = string | number | boolean;
type Budget = {features: number; dictionaryEntries: number; tagPairs: number; geometryWords: number; points: number};
const ZERO = BigInt(0), ONE = BigInt(1), SIGN64 = ONE << BigInt(63), UINT64 = ONE << BigInt(64);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const utf8 = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
function invalid(reason: string): never {throw new Error(`Invalid vector tile: ${reason}`);}
const charge = (budget: Budget, key: keyof Budget, count = 1) => {
  if (count > VECTOR_TILE_LIMITS[key] - budget[key]) invalid(`${key} limit exceeded`);
  budget[key] += count;
};
const safeInteger = (value: bigint): number => {
  if (value > MAX_SAFE || value < -MAX_SAFE) invalid('integer exceeds JavaScript safe precision');
  return Number(value);
};

class Reader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly end: number;
  pos: number;

  constructor(bytes: Uint8Array, start = 0, end = bytes.byteLength) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = start;
    this.end = end;
  }

  uint32(): number {
    let value = 0, scale = 1;
    for (let i = 0; i < 5; i++, scale *= 128) {
      if (this.pos >= this.end) invalid('truncated varint');
      const byte = this.bytes[this.pos++];
      if (i === 4 && byte > 15) invalid('uint32 varint overflow');
      value += (byte & 127) * scale;
      if (byte < 128) return value;
    }
    return invalid('uint32 varint overflow');
  }

  uint64(): bigint {
    let value = ZERO;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) invalid('truncated varint');
      const byte = this.bytes[this.pos++];
      if (i === 9 && byte > 1) invalid('uint64 varint overflow');
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (byte < 128) return value;
    }
    return invalid('uint64 varint overflow');
  }

  tag(): {field: number; wire: number} {
    const tag = this.uint32(), field = tag >>> 3, wire = tag & 7;
    if (!field || wire > 5) invalid('invalid protobuf field tag');
    return {field, wire};
  }

  expect(actual: number, expected: number) {
    if (actual !== expected) invalid('incorrect protobuf wire type');
  }

  take(size: number): number {
    if (size > this.end - this.pos) invalid('truncated protobuf field');
    const start = this.pos;
    this.pos += size;
    return start;
  }

  message(): Reader {
    const size = this.uint32(), start = this.take(size);
    return new Reader(this.bytes, start, start + size);
  }

  string(): string {
    const size = this.uint32();
    if (size > VECTOR_TILE_LIMITS.stringBytes) invalid('string byte limit exceeded');
    const start = this.take(size);
    try {return utf8.decode(this.bytes.subarray(start, start + size));}
    catch {return invalid('invalid UTF-8 string');}
  }

  skip(field: number, wire: number, depth = 0): void {
    if (wire === 0) {this.uint64(); return;}
    if (wire === 1) {this.take(8); return;}
    if (wire === 2) {this.take(this.uint32()); return;}
    if (wire === 5) {this.take(4); return;}
    if (wire === 3) {
      if (depth >= VECTOR_TILE_LIMITS.groupDepth) invalid('protobuf group depth limit exceeded');
      while (this.pos < this.end) {
        const next = this.tag();
        if (next.wire === 4) {
          if (next.field !== field) invalid('mismatched protobuf group');
          return;
        }
        this.skip(next.field, next.wire, depth + 1);
      }
      invalid('truncated protobuf group');
    }
    invalid('unexpected protobuf end group');
  }
}

function readValue(reader: Reader): Scalar {
  let value: Scalar | undefined;
  while (reader.pos < reader.end) {
    const {field, wire} = reader.tag();
    if (field < 1 || field > 7) {reader.skip(field, wire); continue;}
    if (value !== undefined) invalid('value must contain exactly one scalar');
    if (field === 1) {reader.expect(wire, 2); value = reader.string();}
    else if (field === 2) {reader.expect(wire, 5); value = reader.view.getFloat32(reader.take(4), true);}
    else if (field === 3) {reader.expect(wire, 1); value = reader.view.getFloat64(reader.take(8), true);}
    else {
      reader.expect(wire, 0);
      const encoded = reader.uint64();
      if (field === 4) value = safeInteger(encoded >= SIGN64 ? encoded - UINT64 : encoded);
      else if (field === 5) value = safeInteger(encoded);
      else if (field === 6) value = safeInteger((encoded >> ONE) ^ -(encoded & ONE));
      else value = encoded !== ZERO;
    }
  }
  if (value === undefined) invalid('value is missing its scalar');
  return value;
}

function readRepeated(reader: Reader, wire: number, result: number[], limit: number, budget?: Budget) {
  if (wire !== 0 && wire !== 2) invalid('incorrect repeated integer wire type');
  const packed = wire === 2 ? reader.message() : reader;
  const append = () => {
    if (result.length >= limit) invalid('repeated integer count limit exceeded');
    if (budget) charge(budget, 'geometryWords');
    result.push(packed.uint32());
  };
  if (wire === 0) append();
  else while (packed.pos < packed.end) append();
}

function readGeometry(words: number[], type: 1 | 2 | 3, budget: Budget): VectorPoint[][] {
  const parts: VectorPoint[][] = [];
  let at = 0, x = 0, y = 0;
  const command = (id: number, minimum: number, maximum = 0x1fffffff) => {
    if (at >= words.length) return invalid('truncated geometry command');
    const word = words[at++], count = word >>> 3;
    if ((word & 7) !== id || count < minimum || count > maximum) invalid('invalid geometry command or count');
    if (id !== 7 && count > Math.floor((words.length - at) / 2)) invalid('truncated geometry parameters');
    return count;
  };
  const point = (line: boolean): VectorPoint => {
    const dx = words[at++], dy = words[at++];
    // -2^31 is excluded by MVT 2.1; unsigned shifts also handle large valid deltas.
    if (dx === 0xffffffff || dy === 0xffffffff) invalid('geometry delta outside supported range');
    if (line && dx === 0 && dy === 0) invalid('zero-length LineTo segment');
    x += (dx >>> 1) ^ -(dx & 1);
    y += (dy >>> 1) ^ -(dy & 1);
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) invalid('geometry coordinate exceeds safe precision');
    return {x, y};
  };
  if (type === 1) {
    const count = command(1, 1);
    charge(budget, 'points', count);
    for (let i = 0; i < count; i++) parts.push([point(false)]);
    if (at !== words.length) invalid('extra command after point geometry');
    return parts;
  }
  while (at < words.length) {
    command(1, 1, 1);
    charge(budget, 'points');
    const ring = [point(false)];
    const count = command(2, type === 3 ? 2 : 1);
    charge(budget, 'points', count);
    for (let i = 0; i < count; i++) ring.push(point(true));
    if (type === 3) {
      command(7, 1, 1);
      const first = ring[0], last = ring[ring.length - 1];
      if (first.x === last.x && first.y === last.y) invalid('polygon repeats its closing vertex before ClosePath');
      charge(budget, 'points');
      ring.push({x: first.x, y: first.y});
    }
    parts.push(ring);
  }
  if (!parts.length) invalid('empty geometry');
  return parts;
}

function readFeature(reader: Reader, keys: string[], values: Scalar[], budget: Budget): VectorFeature {
  let id: number | undefined, type: number | undefined;
  const tags: number[] = [], geometry: number[] = [];
  while (reader.pos < reader.end) {
    const field = reader.tag();
    if (field.field === 1) {reader.expect(field.wire, 0); id = safeInteger(reader.uint64());}
    else if (field.field === 2) readRepeated(reader, field.wire, tags, VECTOR_TILE_LIMITS.tagPairsPerFeature * 2);
    else if (field.field === 3) {reader.expect(field.wire, 0); type = reader.uint32();}
    else if (field.field === 4) readRepeated(reader, field.wire, geometry, VECTOR_TILE_LIMITS.geometryWords, budget);
    else reader.skip(field.field, field.wire);
  }
  // Unsupported types/versions fail explicitly instead of silently dropping source data.
  if (type !== 1 && type !== 2 && type !== 3) invalid('missing or unsupported geometry type');
  if (tags.length % 2) invalid('odd feature tag count');
  charge(budget, 'tagPairs', tags.length / 2);
  const properties: VectorFeature['properties'] = Object.create(null);
  for (let i = 0; i < tags.length; i += 2) {
    const key = tags[i], value = tags[i + 1];
    if (key >= keys.length || value >= values.length) invalid('feature tag dictionary index out of range');
    const name = keys[key];
    if (Object.hasOwn(properties, name)) invalid('duplicate feature property');
    properties[name] = values[value];
  }
  return {...(id === undefined ? {} : {id}), type, properties, geometry: readGeometry(geometry, type, budget)};
}

function readLayer(reader: Reader, budget: Budget): VectorLayer {
  let name: string | undefined, version: number | undefined, extent = 4096;
  const keys: string[] = [], values: Scalar[] = [], features: Reader[] = [];
  while (reader.pos < reader.end) {
    const {field, wire} = reader.tag();
    if (field === 1) {reader.expect(wire, 2); name = reader.string();}
    else if (field === 2) {reader.expect(wire, 2); charge(budget, 'features'); features.push(reader.message());}
    else if (field === 3) {reader.expect(wire, 2); charge(budget, 'dictionaryEntries'); keys.push(reader.string());}
    else if (field === 4) {reader.expect(wire, 2); charge(budget, 'dictionaryEntries'); values.push(readValue(reader.message()));}
    else if (field === 5) {reader.expect(wire, 0); extent = reader.uint32();}
    else if (field === 15) {reader.expect(wire, 0); version = reader.uint32();}
    else reader.skip(field, wire);
  }
  if (name === undefined) invalid('layer name is missing');
  if (version !== 1 && version !== 2) invalid('missing or unsupported layer version');
  if (!extent) invalid('layer extent must be positive');
  // The protobuf schema supplies a 4096 extent default; tables may follow features.
  return {name, extent, features: features.map(feature => readFeature(feature, keys, values, budget))};
}

/**
 * Decode an uncompressed protobuf MVT payload. Throws on malformed/oversized input.
 * Integers outside ±Number.MAX_SAFE_INTEGER are rejected, never rounded. Unknown
 * protobuf fields are skipped; unknown geometry/version is reported as an error.
 * This checks the command grammar and ring closure, not polygon intersection topology.
 */
export function decodeVectorTile(input: ArrayBuffer | Uint8Array): VectorTile {
  if (!(input instanceof Uint8Array) && !(input instanceof ArrayBuffer)) invalid('input must be an ArrayBuffer or Uint8Array');
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > VECTOR_TILE_LIMITS.bytes) invalid('tile byte limit exceeded');
  const reader = new Reader(bytes);
  const layers: VectorTile['layers'] = Object.create(null);
  const budget: Budget = {features: 0, dictionaryEntries: 0, tagPairs: 0, geometryWords: 0, points: 0};
  let layerCount = 0;
  while (reader.pos < reader.end) {
    const {field, wire} = reader.tag();
    if (field !== 3) {reader.skip(field, wire); continue;}
    reader.expect(wire, 2);
    if (++layerCount > VECTOR_TILE_LIMITS.layers) invalid('layer count limit exceeded');
    const layer = readLayer(reader.message(), budget);
    if (Object.hasOwn(layers, layer.name)) invalid('duplicate layer name');
    layers[layer.name] = layer;
  }
  return {layers};
}
