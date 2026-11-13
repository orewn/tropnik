#!/usr/bin/env node
/** Deterministic shared map runtime. --check builds outside the checkout and
 * compares every output; CI must never repair the commit it is attesting. */
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, writeFile, mkdir, readdir, rm, lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const web = path.join(root, 'web');
const native = path.join(root, 'android/app/src/main/assets');
const destinations = [path.join(web, 'public/custom-map'), path.join(native, 'custom-map')];
const hash = data => createHash('sha256').update(data).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const relative = value => path.relative(root, value).split(path.sep).join('/');
const forbiddenRuntime = /(?:^|\/)(?:@maplibre|@mapbox|maplibre-gl|mapbox-gl|leaflet|protomaps-leaflet|pmtiles)(?:\/|$)/;
const requiredSources = ['web/lib/custom-map-engine.ts', 'web/lib/custom-map-camera.ts', 'web/lib/custom-map-painter.ts', 'web/lib/custom-map-tiles.ts', 'web/lib/custom-map-tiles.worker.ts', 'web/lib/custom-map-vector.ts', 'web/public/maps/map-coverage-lod.js'];

async function files(directory, prefix = '') {
  const result = [];
  for (const entry of (await readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symlinked runtime output: ${name}`);
    if (entry.isDirectory()) result.push(...await files(path.join(directory, entry.name), name + '/'));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`Unknown runtime output: ${name}`);
  }
  return result;
}
export function safeResourcePath(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_./-]+$/.test(value) && !value.startsWith('/') && !value.split('/').some(p => !p || p === '.' || p === '..');
}
async function record(filename, recordPath = relative(filename)) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Non-regular runtime input: ${recordPath}`);
  const bytes = await readFile(filename);
  return {path: recordPath, sizeBytes: bytes.length, sha256: hash(bytes)};
}
async function aliases(catalogue) {
  const result = [];
  async function alias(url, assetPath) {
    if (!url.startsWith('/') || !safeResourcePath(assetPath)) throw new Error('Unsafe map alias');
    result.push({url, assetPath, ...await record(path.join(native, assetPath), assetPath)});
  }
  await alias('/data/map-coverage/manifest.json', 'maps/coverage/manifest.json');
  for (const filename of await files(path.join(native, 'maps/coverage'))) {
    if (filename === 'manifest.json') continue;
    if (!filename.endsWith('.coverage')) throw new Error('Unlisted shared coverage asset: ' + filename);
    await alias('/data/map-coverage/' + filename, 'maps/coverage/' + filename);
  }
  for (const [urlPrefix, assetPrefix, suffix] of [
    ['/offline-map/localtiles/', 'maps/pilot/localtiles/', '.pbf'],
    ['/offline-map/terrain/tiles/', 'maps/terrain-pilot/tiles/', '.png'],
    ['/maps/russia-relief/', 'maps/russia-relief/', '.png'],
  ]) for (const filename of await files(path.join(native, assetPrefix))) {
    if (filename.endsWith(suffix)) await alias(urlPrefix + filename, assetPrefix + filename);
  }
  await alias(catalogue.trailOverlay.url, catalogue.trailOverlay.path);
  const sources = new Map();
  for (const source of catalogue.files) {
    if (!/^web\/public\/data\/(routes|imported)\/[a-z0-9-]+\.geojson$/.test(source.sourcePath)) throw new Error('Invalid native source alias');
    const url = source.sourcePath.slice('web/public'.length), prior = sources.get(url);
    if (prior && (prior.sha256 !== source.sha256 || prior.bytes !== source.bytes)) throw new Error('Conflicting native route source');
    if (!prior) {sources.set(url, source);await alias(url, source.path);}
  }
  return result.sort((a, b) => a.url.localeCompare(b.url, 'en'));
}

async function nativeCatalogue() {
  const catalogue = JSON.parse(await readFile(path.join(native, 'catalog-manifest.json'), 'utf8'));
  const metadata = JSON.parse(await readFile(path.join(web, 'lib/trail-overlay.generated.json'), 'utf8'));
  const overlay = catalogue.trailOverlay;
  if (catalogue.schemaVersion !== 1 || !overlay || overlay.path !== 'maps/catalogue/trail-overlay.json' ||
    overlay.url !== metadata.url || overlay.sha256 !== metadata.sha256 || overlay.bytes !== metadata.bytes ||
    overlay.sourcePath !== 'web/public' + metadata.url) throw new Error('Native trail overview is stale; run prepare-catalog.mjs first');
  const bytes = await readFile(path.join(native, overlay.path));
  if (bytes.length !== overlay.bytes || hash(bytes) !== overlay.sha256 || !(await readFile(path.join(root, overlay.sourcePath))).equals(bytes)) throw new Error('Native trail overview differs from its source');
  const sources = new Map(), ids = new Set();
  for (const source of catalogue.files) {
    if (!/^web\/public\/data\/(routes|imported)\/[a-z0-9-]+\.geojson$/.test(source.sourcePath) ||
      !/^maps\/routes\/[a-z0-9-]+\.geojson$/.test(source.path) || !/^[a-z0-9-]{1,128}$/.test(source.routeId)) throw new Error('Invalid native catalogue source path or identity');
    const key = source.sourcePath.slice('web/public/data/'.length), url = '/data/' + key;
    if (metadata.sourceHashes[key] !== source.sha256 || ids.has(source.routeId) || !catalogue.referenceRouteIds.includes(source.routeId)) throw new Error('Native trail identity or source integrity differs');
    const bytes = await readFile(path.join(native, source.path));
    if (bytes.length !== source.bytes || hash(bytes) !== source.sha256 || bytes.length > 8 * 1024 * 1024) throw new Error('Native trail geometry differs from the catalogue manifest or resource budget');
    ids.add(source.routeId);
    const prior = sources.get(url);
    if (prior) prior.ids.push(source.routeId);
    else sources.set(url, {url, sha256: source.sha256, sizeBytes: source.bytes, ids: [source.routeId]});
  }
  if (sources.size !== metadata.uniqueGeometries || sources.size !== Object.keys(metadata.sourceHashes).length ||
    ids.size !== metadata.geometryRoutes || catalogue.referenceRouteIds.length !== metadata.catalogueRoutes) throw new Error('Native trail catalogue is incomplete');
  return {catalogue, descriptor: {schemaVersion: 1, overlay: {url: overlay.url, sha256: overlay.sha256, sizeBytes: overlay.bytes},
    sources: [...sources.values()].sort((a, b) => a.url.localeCompare(b.url, 'en')), referenceRouteIds: catalogue.referenceRouteIds}};
}
export async function prepareCustomMap({check = false, output} = {}) {
  const packageJson = JSON.parse(await readFile(path.join(web, 'package.json'), 'utf8'));
  if (packageJson.devDependencies.vite !== '8.1.6') throw new Error('Shared map compiler pin changed; review deterministic output before updating it');
  const {build, version} = await import(pathToFileURL(path.join(web, 'node_modules/vite/dist/node/index.js')).href);
  if (version !== packageJson.devDependencies.vite) throw new Error('Installed Vite differs from the committed pin');
  const stage = await mkdtemp(path.join(tmpdir(), 'tropnik-custom-map-'));
  const sourceFiles = new Set();
  const audit = () => ({name: 'tropnik-map-runtime-provenance',
    moduleParsed(info) {
      const id = info.id.split('?')[0];
      if (forbiddenRuntime.test(id)) throw new Error(`Map SDK in shared runtime: ${relative(id)}`);
      if (path.isAbsolute(id) && !id.includes('/node_modules/') && id.startsWith(root + path.sep)) sourceFiles.add(id);
    },
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) if (item.type === 'chunk') for (const id of Object.keys(item.modules)) {
        const filename = id.split('?')[0];
        if (forbiddenRuntime.test(filename)) throw new Error(`Map SDK in shared runtime: ${relative(filename)}`);
        if (path.isAbsolute(filename) && !filename.includes('/node_modules/') && filename.startsWith(root + path.sep)) sourceFiles.add(filename);
      }
    }});
  try {
    await build({root: web, configFile: false, publicDir: false, base: './', logLevel: 'warn',
      resolve: {alias: {'@': web}}, plugins: [audit()],
      worker: {format: 'es', plugins: () => [audit()], rollupOptions: {output: {entryFileNames: 'workers/[name]-[hash].js', chunkFileNames: 'workers/[name]-[hash].js'}}},
      build: {outDir: stage, emptyOutDir: true, target: 'es2022', sourcemap: false, minify: 'oxc', cssCodeSplit: false,
        lib: {entry: {'map-runtime': path.join(root, 'tools/android-build/custom-map-entry.ts'), 'android-bootstrap': path.join(root, 'tools/android-build/custom-map-android.ts')}, formats: ['es'], fileName: (_format, name) => name + '.js', cssFileName: 'map'},
        rollupOptions: {output: {chunkFileNames: 'chunks/[name]-[hash].js', assetFileNames: info => (info.names || [info.name]).some(name => name?.endsWith('.css')) ? 'map.css' : 'assets/[name]-[hash][extname]'}}}});
    for (const source of ['tools/android-build/prepare-custom-map.mjs', 'tools/android-build/custom-map.html',
      'tools/android-build/custom-map-host.css', 'tools/android-build/tsconfig.json', 'web/tsconfig.json', 'web/package.json', 'web/pnpm-lock.yaml', 'web/pnpm-workspace.yaml',
      ...['latin', 'cyrillic'].flatMap(subset => [400, 600].map(weight => `tools/android-build/fonts/manrope-${subset}-${weight}-normal.woff2`)), 'tools/android-build/fonts/OFL.txt']) sourceFiles.add(path.join(root, source));
    for (const filename of requiredSources) if (!sourceFiles.has(path.join(root, filename))) throw new Error(`Missing shared runtime source provenance: ${filename}`);
    const {catalogue, descriptor} = await nativeCatalogue();
    sourceFiles.add(path.join(native, 'catalog-manifest.json'));
    sourceFiles.add(path.join(web, 'lib/trail-overlay.generated.json'));
    sourceFiles.add(path.join(root, catalogue.trailOverlay.sourcePath));
    const resourceAliases = await aliases(catalogue);
    await writeFile(path.join(stage, 'catalogue.json'), json(descriptor));
    const offline = resourceAliases.filter(r => r.url.startsWith('/offline-map/')).map(r => ({path: r.url.slice('/offline-map/'.length), size: r.sizeBytes, sha256: r.sha256}));
    await writeFile(path.join(stage, 'offline-manifest.json'), json({schemaVersion: 1, complete: true, fullRussiaDetailedOffline: false, files: offline}));
    await writeFile(path.join(stage, 'index.html'), await readFile(path.join(root, 'tools/android-build/custom-map.html')));
    await writeFile(path.join(stage, 'Manrope-OFL.txt'), await readFile(path.join(root, 'tools/android-build/fonts/OFL.txt')));
    const runtimeFiles = await Promise.all((await files(stage)).map(filename => record(path.join(stage, filename), filename)));
    for (const required of ['map-runtime.js', 'android-bootstrap.js', 'map.css', 'index.html']) if (!runtimeFiles.some(r => r.path === required)) throw new Error(`Missing shared runtime entry: ${required}`);
    if (!runtimeFiles.some(r => r.path.startsWith('workers/') && r.path.endsWith('.js'))) throw new Error('Own cartographic worker was not emitted');
    const sourceInputs = await Promise.all([...sourceFiles].sort().map(filename => record(filename)));
    const manifest = {schemaVersion: 1, runtime: 'tropnik-canvas', apiVersion: 1, compiler: {name: 'vite', version},
      entry: 'map-runtime.js', stylesheet: 'map.css', androidEntry: 'index.html',
      origin: 'https://map.tropnik.invalid', bridge: 'exact-origin-web-message-port-v1',
      sourceInputs, sourceInputsSha256: hash(json(sourceInputs)), files: runtimeFiles, resourceAliases,
      virtualResources: [{url: '/offline-map/manifest.json', assetPath: 'custom-map/offline-manifest.json'}],
      networkHosts: ['tiles.openfreemap.org', 'tiles.mapterhorn.com', 'tiles.maps.eox.at'],
      fullRussiaDetailedOffline: false, sceneIsSeparate: true};
    await writeFile(path.join(stage, 'manifest.json'), json(manifest));
    const expected = await files(stage), outputs = output ? [path.resolve(output)] : destinations;
    for (const destination of outputs) {
      if (check) {
        let existing;try {existing = await files(destination);} catch {throw new Error(`Missing generated map runtime: ${relative(destination)}`);}
        if (JSON.stringify(expected) !== JSON.stringify(existing)) throw new Error(`Generated map file set differs: ${relative(destination)}; run prepare-custom-map.mjs locally and commit all outputs`);
        for (const filename of expected) if (!(await readFile(path.join(destination, filename))).equals(await readFile(path.join(stage, filename)))) throw new Error(`Stale generated map runtime: ${relative(path.join(destination, filename))}`);
      } else {
        await mkdir(destination, {recursive: true});
        // Only remove known files in this generated output directory. Source
        // files, native data packages and the separate landscape are untouched.
        for (const filename of await files(destination)) if (!expected.includes(filename)) await rm(path.join(destination, filename));
        for (const filename of expected) {await mkdir(path.dirname(path.join(destination, filename)), {recursive: true});await writeFile(path.join(destination, filename), await readFile(path.join(stage, filename)));}
      }
    }
    return {checkOnly: check, runtime: manifest.runtime, sourceInputsSha256: manifest.sourceInputsSha256, sourceFiles: sourceInputs.length, outputFiles: expected.length, resourceAliases: resourceAliases.length, manifestSha256: hash(json(manifest)), destinations: outputs.map(relative)};
  } finally {await rm(stage, {recursive: true, force: true});}
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);let output;
  if (args.includes('--output')) output = args[args.indexOf('--output') + 1];
  if (args.some((value, i) => !['--check', '--output'].includes(value) && args[i - 1] !== '--output') || (args.includes('--output') && !output)) throw new Error('Usage: prepare-custom-map.mjs [--check] [--output directory]');
  console.log(JSON.stringify(await prepareCustomMap({check: args.includes('--check'), output}), null, 2));
}
