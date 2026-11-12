import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {inflateSync} from 'node:zlib';
import {createTerrainRegionReader} from '../lib/terrain-region-sources.ts';
import {createLandscapeSurfaceLoader} from '../lib/custom-map-surface.ts';
import * as renderer from '../public/terrain/terrain-renderer.js';

// Vite emits this URL in a browser build. Only the asset-URL syntax is replaced;
// the real loader, numeric preparation and regional checksum reader are used.
const viteAssets = registerHooks({resolve(specifier, context, next) {
  if (specifier.endsWith('?worker&url')) return {url: 'data:text/javascript,export default "/assets/terrain-preparation.test.js"', shortCircuit: true};
  return next(specifier, context);
}});
const {createCustomLandscapeLoader} = await import('../lib/custom-map-landscape.ts');
viteAssets.deregister();

const hash = bytes => createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
const publicRoot = new URL('../public/', import.meta.url);

// Bounded decoder for the actual non-interlaced RGBA8 fixture. This avoids a
// browser/optional image dependency, and its result is checked against a pixel
// digest independently obtained with Pillow, not against its own calculation.
function decodePackagedRGBA(bytes) {
  const data = Buffer.from(bytes);
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let offset = 8, width, height; const idat = [];
  while (offset + 12 <= data.length) {
    const size = data.readUInt32BE(offset), kind = data.toString('ascii', offset + 4, offset + 8);
    assert.ok(offset + size + 12 <= data.length);
    const chunk = data.subarray(offset + 8, offset + 8 + size);
    if (kind === 'IHDR') {
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4);
      assert.ok(width >= 2 && height >= 2 && width <= 2048 && height <= 2048);
      assert.deepEqual([...chunk.subarray(8)], [8, 6, 0, 0, 0], 'RGBA8, standard compression, no interlacing');
    } else if (kind === 'IDAT') idat.push(chunk);
    offset += size + 12;
    if (kind === 'IEND') break;
  }
  const stride = width * 4, expected = (stride + 1) * height;
  const raw = inflateSync(Buffer.concat(idat), {maxOutputLength: expected});
  assert.equal(raw.length, expected);
  const pixels = new Uint8ClampedArray(stride * height);
  const paeth = (left, top, corner) => {
    const p = left + top - corner, a = Math.abs(p - left), b = Math.abs(p - top), c = Math.abs(p - corner);
    return a <= b && a <= c ? left : b <= c ? top : corner;
  };
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)]; assert.ok(filter <= 4);
    for (let col = 0; col < stride; col++) {
      const at = row * stride + col;
      const left = col >= 4 ? pixels[at - 4] : 0, top = row ? pixels[at - stride] : 0;
      const corner = row && col >= 4 ? pixels[at - stride - 4] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? top : filter === 3 ? Math.floor((left + top) / 2) : paeth(left, top, corner);
      pixels[at] = (raw[row * (stride + 1) + 1 + col] + predictor) & 255;
    }
  }
  return {width, height, pixels};
}

const regionalCases = [
  {id: 'south-sakhalin-v1', requested: [142.70, 46.90, 142.93, 47.02],
    pixelSha: '0cd576ea6adae4f5a7aaa8c1a2725e0beeac7b33b1b25810025049f32fe9848f',
    northWest: [181, 187, 142, 255]},
  // The actual desktop opening frustum of «Восьмёрка» extends ~300 m west
  // of the first extract. This separate measured window covers it completely.
  {id: 'south-sakhalin-central-v1', requested: [142.67637419183654, 46.906421037100415, 142.9029870611837, 47.03734588359725],
    pixelSha: 'e4daae3e43201c913f530fb26bc92e73f6fa4a01baaf43154a85fa852af95b15',
    northWest: [121, 151, 108, 255]},
];
for (const regionCase of regionalCases) test(`${regionCase.id}: delivered DEM and material travel through the real regional loaders without remote imagery or height resampling`, async () => {
  const reads = [];
  const loadBytes = async url => {
    assert.match(url, /^\/terrain-regions\/[a-z0-9/_-]+\.(json|png)$/,
      `A fully covered regional request must not ask for any remote/pilot source: ${url}`);
    reads.push(url);
    const bytes = await readFile(new URL(url.slice(1), publicRoot));
    return new Uint8Array(bytes).buffer;
  };
  const loadJSON = async url => JSON.parse(new TextDecoder().decode(await loadBytes(url)));
  const manifest = await loadJSON('/terrain-regions/manifest.json');
  const entry = manifest.regions.find(region => region.id === regionCase.id);
  assert.ok(entry, 'The screenshot region must be an actually delivered asset');
  const reader = createTerrainRegionReader({loadBytes, loadJSON});
  const requested = regionCase.requested;
  const region = await reader.find(requested);
  assert.equal(region.id, entry.id);
  const originalGridBytes = await loadBytes(entry.gridUrl);
  const originalGrid = JSON.parse(new TextDecoder().decode(originalGridBytes));
  assert.equal(hash(originalGridBytes), entry.gridSha256);

  // Preparation uses the real cooperative path in Node (no browser Worker).
  // Lower requested render resolution must not discard this native extract.
  const loader = createCustomLandscapeLoader({loadBytes, loadJSON, online: () => false});
  try {
    const result = await loader.load(requested, {preferRegional: true, gridSize: 257});
    assert.equal(result.provenance.kind, 'local-grid');
    assert.equal(result.provenance.provider, 'Copernicus GLO-30');
    assert.equal(result.grid.source.regionId, entry.id);
    assert.deepEqual(result.provenance.sourceUrls, [entry.gridUrl]);
    assert.equal(result.provenance.sourceNominalResolutionM, 30);
    assert.equal(result.provenance.fallbackReason, null);
    assert.equal(result.provenance.missingDataFilled, false);
    assert.deepEqual(result.provenance.requestedBounds, requested);
    assert.deepEqual(result.grid.bounds, entry.bounds);
    assert.deepEqual([result.grid.width, result.grid.height], [660, 632]);
    assert.deepEqual(result.grid.elevations, originalGrid.elevations,
      'Loaded extract must retain every surveyed/resampled source value without a second runtime resampling');
    assert.equal(result.grid.source.verticalDatum, 'EGM2008 orthometric metres');
    assert.equal(result.grid.processing.sourceNativePixelCentresPreserved, false);
    assert.equal(result.prepared[1], result.grid);
    assert.equal(result.prepared[2].grid, result.grid);
    assert.equal(result.prepared[2].heights.length, 660 * 632);
    assert.ok(result.provenance.outputSpacingApproxM.eastWest >= 29.9 && result.provenance.outputSpacingApproxM.eastWest <= 30.1);

    let decoded;
    const surfaceLoader = createLandscapeSurfaceLoader({loadBytes, loadJSON, regional: reader,
      online: () => false,
      paint: async () => assert.fail('Regional material must not decode provider imagery'),
      decodeMaterial: async (bytes, width, height) => {
        assert.equal(hash(bytes), entry.materialSha256, 'Surface uses the exact verified PNG from this manifest');
        decoded = decodePackagedRGBA(bytes);
        assert.deepEqual([decoded.width, decoded.height], [width, height]);
        assert.equal(hash(decoded.pixels), regionCase.pixelSha);
        return decoded;
      },
    });
    const surface = await surfaceLoader(result.grid);
    assert.equal(surface.source.kind, 'landcover');
    assert.equal(surface.source.name, 'ESA WorldCover 2021');
    assert.equal(surface.source.attribution, entry.material.attribution);
    assert.equal(surface.source.acquisitionPeriod, '2021');
    assert.equal(surface.source.nativeResolutionM, 10);
    assert.equal(surface.source.complete, true);
    assert.equal(surface.source.loadedTiles, 1);
    assert.deepEqual([surface.width, surface.height], [1977, 1894]);
    assert.equal(surface.pixels, decoded.pixels, 'Matching measured material is retained without resizing or another palette');
    assert.deepEqual(surface.source.bounds, result.grid.bounds);
    assert.equal(surface.source.sampleLayout, 'grid-nodes');
    assert.equal(surface.source.rowOrder, 'north-to-south');
    renderer.validateTerrainCartography(surface, result.grid);
    assert.deepEqual([...surface.pixels.subarray(0, 4)], regionCase.northWest);
    assert.deepEqual([...surface.pixels.subarray((surface.height - 1) * surface.width * 4,
      (surface.height - 1) * surface.width * 4 + 4)], [190, 190, 148, 255]);
    assert.ok(reads.every(url => url.startsWith('/terrain-regions/')));

    // A regional extract cannot silently claim a nationwide or partially
    // overlapping view; the runtime must use its separately identified source.
    assert.equal(await reader.find([130, 40, 160, 60]), undefined);
    assert.equal(await reader.find([142.65, 46.90, 142.90, 47.02]), undefined);
  } finally {loader.dispose();}
});
