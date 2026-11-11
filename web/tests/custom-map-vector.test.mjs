import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {decodeVectorTile, VECTOR_TILE_LIMITS} from '../lib/custom-map-vector.ts';

// Tiny fixture encoder, independent of the decoder. It can deliberately emit invalid
// protobuf/MVT, which normal map SDK encoders hide or repair before the parser sees it.
const concat = (...parts) => Buffer.concat(parts.flat().map(part => Buffer.from(typeof part === 'number' ? [part] : part)));
const varint = value => {
  value = BigInt(value); const bytes = [];
  do {const low = Number(value & 127n); value >>= 7n; bytes.push(low | (value ? 128 : 0));} while (value);
  return Buffer.from(bytes);
};
const tag = (field, wire) => varint(field * 8 + wire);
const uint = (field, value) => concat(tag(field, 0), varint(value));
const bytes = (field, value) => concat(tag(field, 2), varint(value.length), value);
const str = (field, value) => bytes(field, Buffer.from(value));
const packed = (field, values) => bytes(field, concat(values.map(varint)));
const zigzag = value => value < 0 ? -2 * value - 1 : 2 * value;
const floating = (field, value) => {
  const data = Buffer.alloc(field === 2 ? 4 : 8);
  if (field === 2) data.writeFloatLE(value); else data.writeDoubleLE(value);
  return concat(tag(field, field === 2 ? 5 : 1), data);
};
const valueString = value => str(1, value);
const feature = ({id, type = 1, geometry = [9, 50, 34], tags = [], extra = []} = {}) => concat(
  id === undefined ? [] : uint(1, id), packed(2, tags), uint(3, type), packed(4, geometry), extra,
);
const layer = ({name = 'example', version = 2, extent = 4096, features = [], keys = [], values = [], extra = []} = {}) => concat(
  name === undefined ? [] : str(1, name), features.map(f => bytes(2, f)),
  keys.map(key => str(3, key)), values.map(value => bytes(4, value)),
  extent === undefined ? [] : uint(5, extent), version === undefined ? [] : uint(15, version), extra,
);
const tile = (...layers) => concat(layers.map(layer => bytes(3, layer)));
const parseFeature = (options, layerOptions) => decodeVectorTile(tile(layer({features: [feature(options)], ...layerOptions}))).layers.example.features[0];
const reject = (data, pattern = /Invalid vector tile:/) => assert.throws(() => decodeVectorTile(data), pattern);

test('specification point, multipoint and multiline examples keep delta cursors and tile buffer', () => {
  assert.deepEqual(parseFeature({}).geometry, [[{x: 25, y: 17}]]);
  assert.deepEqual(parseFeature({geometry: [17, 10, 14, 3, 9]}).geometry, [[{x: 5, y: 7}], [{x: 3, y: 2}]]);
  assert.deepEqual(parseFeature({type: 2, geometry: [9, 4, 4, 18, 0, 16, 16, 0, 9, 17, 17, 10, 4, 8]}).geometry,
    [[{x: 2, y: 2}, {x: 2, y: 10}, {x: 10, y: 10}], [{x: 1, y: 1}, {x: 3, y: 5}]]);
  assert.deepEqual(parseFeature({geometry: [17, zigzag(-30), zigzag(6000), zigzag(5000), zigzag(-6100)]}).geometry,
    [[{x: -30, y: 6000}], [{x: 4970, y: -100}]], 'do not clip the source buffer to the layer extent');
  assert.deepEqual(parseFeature({geometry: [9, 4294967294, 4294967293]}).geometry,
    [[{x: 2147483647, y: -2147483647}]], 'large valid uint32 deltas must not use a signed shift');
});

test('polygon exterior, second exterior and hole retain order and close without resetting the cursor', () => {
  const geometry = [9,0,0,26,20,0,0,20,19,0,15,9,22,2,26,18,0,0,18,17,0,15,9,4,13,26,0,8,8,0,0,7,15];
  const decoded = parseFeature({type: 3, geometry}).geometry;
  assert.deepEqual(decoded, [
    [{x: 0, y: 0}, {x: 10, y: 0}, {x: 10, y: 10}, {x: 0, y: 10}, {x: 0, y: 0}],
    [{x: 11, y: 11}, {x: 20, y: 11}, {x: 20, y: 20}, {x: 11, y: 20}, {x: 11, y: 11}],
    [{x: 13, y: 13}, {x: 13, y: 17}, {x: 17, y: 17}, {x: 17, y: 13}, {x: 13, y: 13}],
  ]);
  assert.notEqual(decoded[0][0], decoded[0].at(-1), 'the closing coordinate is an independent value');
});

test('all seven protobuf scalar types, safe 64-bit IDs, UTF-8 names and thematic attributes survive', () => {
  const keys = ['name:ru', 'opacity', 'ele', 'negative', 'osm_id', 'offset', 'intermittent', 'visible', 'name:latin'];
  const values = [valueString('Бзерпинский карниз'), floating(2, 0.25), floating(3, 2310.125),
    uint(4, (1n << 64n) - 37n), uint(5, Number.MAX_SAFE_INTEGER), uint(6, 73), uint(7, 0), uint(7, 1), valueString('\uFEFFBzerpinsky')];
  const decoded = parseFeature({id: Number.MAX_SAFE_INTEGER, tags: keys.flatMap((_, i) => [i, i])}, {keys, values});
  assert.equal(decoded.id, Number.MAX_SAFE_INTEGER);
  assert.deepEqual({...decoded.properties}, {
    'name:ru': 'Бзерпинский карниз', opacity: 0.25, ele: 2310.125, negative: -37,
    osm_id: Number.MAX_SAFE_INTEGER, offset: -37, intermittent: false, visible: true, 'name:latin': '\uFEFFBzerpinsky',
  });
  const contour = decodeVectorTile(tile(layer({name: 'contour', keys: ['ele'], values: [uint(5, 2300)],
    features: [feature({type: 2, tags: [0, 0], geometry: [9, 0, 0, 10, 10, 12]})]})));
  assert.equal(contour.layers.contour.features[0].properties.ele, 2300);
});

test('packed chunks, unpacked repeated fields and table ordering follow protobuf semantics', () => {
  const f = concat(uint(3, 1), packed(4, [17, 10]), uint(4, 14), packed(4, [3, 9]),
    uint(2, 0), packed(2, [0]), uint(1, 7), uint(1, 9));
  // Explicit schema default: the optional extent is omitted, and tables follow features.
  const l = concat(bytes(2, f), bytes(4, valueString('лес')), str(3, 'class'), str(1, 'landcover'), uint(15, 2));
  const decoded = decodeVectorTile(tile(l)).layers.landcover;
  assert.equal(decoded.extent, 4096);
  assert.equal(decoded.features[0].id, 9, 'last singular field wins, as required by protobuf');
  assert.equal(decoded.features[0].properties.class, 'лес');
  assert.deepEqual(decoded.features[0].geometry, [[{x: 5, y: 7}], [{x: 3, y: 2}]]);
});

test('unknown fields of every wire type are skipped, including bounded protobuf2 groups', () => {
  const extras = concat(uint(90, (1n << 64n) - 1n), concat(tag(91, 1), Buffer.alloc(8)),
    bytes(92, Buffer.from([0xff, 0xff])), concat(tag(93, 5), Buffer.alloc(4)),
    tag(94, 3), uint(1, 19), tag(95, 3), str(1, 'inside'), tag(95, 4), tag(94, 4));
  const ordinary = tile(layer({features: [feature()]}));
  const withUnknown = concat(extras, tile(layer({extra: extras, features: [feature({extra: extras})]})), extras);
  assert.deepEqual(decodeVectorTile(withUnknown), decodeVectorTile(ordinary));
});

test('unusual layer/property names are preserved without prototype mutation and empty layers remain', () => {
  const decoded = decodeVectorTile(tile(layer({name: '__proto__', keys: ['__proto__', 'constructor', 'toString'],
    values: [valueString('safe')], features: [feature({tags: [0, 0, 1, 0, 2, 0]})]}), layer({name: 'empty'})));
  assert.equal(Object.getPrototypeOf(decoded.layers), null);
  const properties = decoded.layers.__proto__.features[0].properties;
  assert.equal(Object.getPrototypeOf(properties), null);
  assert.deepEqual(Object.keys(properties), ['__proto__', 'constructor', 'toString']);
  assert.equal(properties.__proto__, 'safe');
  assert.deepEqual(decoded.layers.empty.features, []);
  assert.equal({}.safe, undefined);
});

test('ArrayBuffer and Uint8Array subviews respect their exact byte boundaries', () => {
  const data = tile(layer({features: [feature()]}));
  const allocation = concat(Buffer.from([0xff, 0xff]), data, Buffer.from([0xff, 0xff]));
  const view = allocation.subarray(2, 2 + data.length);
  const copied = Uint8Array.from(data).buffer;
  assert.deepEqual(decodeVectorTile(view), decodeVectorTile(copied));
  assert.deepEqual(Object.keys(decodeVectorTile(new ArrayBuffer(0)).layers), []);
  for (const wrongType of [null, undefined, 100_000_000, [], 'protobuf', new DataView(copied)]) {
    reject(wrongType, /input must be/);
  }
});

test('wire truncation, varint overflow, invalid tags, invalid UTF-8 and fixed-width truncation fail', () => {
  const invalidInputs = [
    Buffer.from([0]), Buffer.from([0x1e]), Buffer.from([0x80]), Buffer.from([0x1a, 0x80]),
    Buffer.from([0x1a, 0xff, 0xff, 0xff, 0xff, 0x10]), Buffer.from([0x1a, 7, 0x0a]),
    concat(tag(90, 0), Buffer.alloc(10, 0x80)), concat(tag(90, 0), Buffer.alloc(9, 0xff), [2]),
    tile(concat(bytes(1, [0xc3, 0x28]), uint(15, 2))),
    tile(layer({values: [concat(tag(2, 5), [0, 0, 0])]})),
    tile(layer({values: [concat(tag(3, 1), Buffer.alloc(7))]})),
    concat(tag(5, 3), tag(6, 4)), concat(tag(5, 3), uint(1, 0)), tag(5, 4),
    uint(3, 1), tile(concat(uint(1, 7), uint(15, 2))),
  ];
  for (const input of invalidInputs) reject(input);
});

test('missing or incompatible schema fields, duplicate layers and ambiguous values fail explicitly', () => {
  const invalidInputs = [
    tile(concat(str(1, 'no-version'), uint(5, 4096))),
    tile(concat(uint(15, 2), uint(5, 4096))),
    tile(layer({extent: 0})), tile(layer({version: 3})), tile(layer(), layer()),
    tile(layer({features: [concat(packed(4, [9, 0, 0]))]})),
    tile(layer({features: [feature({type: 0})]})), tile(layer({features: [feature({type: 7})]})),
    tile(layer({values: [Buffer.alloc(0)]})), tile(layer({values: [concat(uint(7, 0), valueString('second'))]})),
    tile(layer({values: [concat(valueString('first'), valueString('second'))]})),
  ];
  for (const input of invalidInputs) reject(input);
});

test('attribute tags must be paired, in range and unique rather than silently overwriting data', () => {
  const options = {keys: ['class', 'class'], values: [valueString('wood')]};
  for (const tags of [[0], [2, 0], [0, 1], [0, 0, 0, 0], [0, 0, 1, 0]]) {
    reject(tile(layer({...options, features: [feature({tags})]})), /tag|property/);
  }
});

test('64-bit integers outside exact JavaScript precision are rejected, not rounded', () => {
  const tooLarge = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  reject(tile(layer({features: [feature({id: tooLarge})]})), /safe precision/);
  for (const value of [uint(4, tooLarge), uint(4, (1n << 64n) - tooLarge), uint(5, tooLarge), uint(6, tooLarge * 2n)]) {
    reject(tile(layer({values: [value]})), /safe precision/);
  }
  assert.equal(parseFeature({tags: [0, 0]}, {keys: ['minimum'], values: [uint(4, (1n << 64n) - BigInt(Number.MAX_SAFE_INTEGER))]}).properties.minimum,
    -Number.MAX_SAFE_INTEGER);
});

test('geometry grammar rejects partial lines, invalid commands/counts and unclosed polygons', () => {
  const cases = [
    [1, []], [1, [1]], [1, [9, 0]], [1, [9, 0, 0, 9, 1, 1]], [1, [10, 0, 0]],
    [1, [0xfffffff9, 0, 0]], [1, [9, 0xffffffff, 0]],
    [2, []], [2, [9, 0, 0]], [2, [17, 0, 0, 2, 2, 10, 2, 2]],
    [2, [9, 0, 0, 10, 0, 0]], [2, [9, 0, 0, 10, 2]], [2, [9, 0, 0, 10, 2, 2, 15]],
    [3, [9, 0, 0, 18, 2, 0, 0, 2]], [3, [9, 0, 0, 10, 2, 2, 15]],
    [3, [9, 0, 0, 18, 2, 0, 0, 2, 23]], [3, [9, 0, 0, 18, 2, 0, 1, 0, 15]],
  ];
  for (const [type, geometry] of cases) reject(tile(layer({features: [feature({type, geometry})]})));
});

test('allocation/work limits reject large inputs, nested groups, layers, attributes and point floods', () => {
  reject(new Uint8Array(VECTOR_TILE_LIMITS.bytes + 1), /byte limit/);
  reject(tile(layer({name: 'x'.repeat(VECTOR_TILE_LIMITS.stringBytes + 1)})), /string byte limit/);
  reject(tile(...Array.from({length: VECTOR_TILE_LIMITS.layers + 1}, (_, n) => layer({name: `l${n}`}))), /layer count limit/);
  reject(concat(Array.from({length: VECTOR_TILE_LIMITS.groupDepth + 1}, () => tag(99, 3)),
    Array.from({length: VECTOR_TILE_LIMITS.groupDepth + 1}, () => tag(99, 4))), /group depth limit/);
  reject(tile(layer({features: [feature({tags: Array((VECTOR_TILE_LIMITS.tagPairsPerFeature + 1) * 2).fill(0)})]})), /count limit/);
  // A compact valid multipoint encoding can otherwise expand into hundreds of thousands
  // of arrays/objects. Admission occurs before those point arrays are allocated.
  const count = VECTOR_TILE_LIMITS.points + 1;
  const f = concat(uint(3, 1), bytes(4, concat(varint(count * 8 + 1), Buffer.alloc(count * 2))));
  reject(tile(layer({features: [f]})), /points limit/);
  const emptyFeatures = Array.from({length: VECTOR_TILE_LIMITS.features + 1}, () => bytes(2, Buffer.alloc(0)));
  reject(tile(concat(str(1, 'many'), uint(15, 2), emptyFeatures)), /features limit/);
  const dictionary = Array.from({length: VECTOR_TILE_LIMITS.dictionaryEntries + 1}, () => str(3, ''));
  reject(tile(concat(str(1, 'many'), uint(15, 2), dictionary)), /dictionaryEntries limit/);
});

test('every truncation of a complete declared layer fails before exposing a partial tile', () => {
  const encoded = tile(layer({name: 'water', keys: ['name:ru'], values: [valueString('Озеро')],
    features: [feature({type: 3, tags: [0, 0], geometry: [9, 0, 0, 18, 100, 0, 0, 100, 15]})]}));
  for (let end = 1; end < encoded.length; end++) reject(encoded.subarray(0, end));
  assert.equal(decodeVectorTile(encoded).layers.water.features[0].properties['name:ru'], 'Озеро');
});

test('all 193 pinned offline tiles retain every layer, feature, property and coordinate', () => {
  const root = fileURLToPath(new URL('../public/offline-map/localtiles/', import.meta.url)), files = [];
  function walk(path) {
    for (const entry of readdirSync(path, {withFileTypes: true})) {
      const next = join(path, entry.name);
      if (entry.isDirectory()) walk(next); else if (entry.name.endsWith('.pbf')) files.push(next);
    }
  }
  walk(root); files.sort();
  let features = 0, properties = 0, coordinates = 0;
  const hash = createHash('sha256'), layerNames = new Set();
  for (const path of files) {
    const decoded = decodeVectorTile(readFileSync(path)), normalized = {};
    for (const name of Object.keys(decoded.layers).sort()) {
      const layer = decoded.layers[name]; layerNames.add(name); features += layer.features.length;
      normalized[name] = {name, extent: layer.extent, features: layer.features.map(feature => {
        properties += Object.keys(feature.properties).length;
        for (const part of feature.geometry) coordinates += part.length;
        return {...(feature.id === undefined ? {} : {id: feature.id}), type: feature.type,
          properties: Object.fromEntries(Object.entries(feature.properties).sort(([a], [b]) => a.localeCompare(b, 'en'))),
          geometry: feature.geometry};
      })};
    }
    hash.update(relative(root, path) + '\n' + JSON.stringify(normalized) + '\n');
  }
  assert.deepEqual({tiles: files.length, features, properties, coordinates},
    {tiles: 193, features: 14665, properties: 74281, coordinates: 575929});
  assert.deepEqual([...layerNames].sort(), ['aeroway', 'boundary', 'building', 'housenumber', 'landcover', 'landuse',
    'mountain_peak', 'park', 'place', 'poi', 'transportation', 'transportation_name', 'water', 'water_name', 'waterway']);
  // Independently checked once against @mapbox/vector-tile 2.0.5 on the complete
  // pinned corpus. The regression test has no SDK dependency, even as SDKs are removed.
  assert.equal(hash.digest('hex'), '2669b34bbadafb21d092b107c2a3f8d669439babb96d940a571ca46dfb0e00a3');
});
