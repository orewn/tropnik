import {readFile, readdir, lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = data => createHash('sha256').update(data).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const safe = name => typeof name === 'string' && /^[\w./-]+$/.test(name) && !name.startsWith('/') && name.split('/').every(part => part && part !== '.' && part !== '..');
const require = (condition, message) => {if (!condition) throw new Error(message);};

/** Read-only gate usable by both a web-only Sites checkout and the full repo.
 * The full generator --check additionally reconstructs all compiled outputs. */
export async function verifyCustomMap({webRoot = defaultRoot} = {}) {
  const directory = path.join(webRoot, 'public/custom-map');
  const manifestBytes = await readFile(path.join(directory, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  require(manifest.schemaVersion === 1 && manifest.runtime === 'tropnik-canvas' && manifest.apiVersion === 1, 'Unknown shared map bundle');
  require(manifest.compiler?.name === 'vite' && manifest.compiler.version === '8.1.6', 'Unreviewed shared map compiler');
  require(Array.isArray(manifest.sourceInputs) && manifest.sourceInputs.length <= 256 && hash(json(manifest.sourceInputs)) === manifest.sourceInputsSha256, 'Shared map source digest differs');
  const sources = new Set();
  for (const record of manifest.sourceInputs) {
    require(safe(record.path) && !sources.has(record.path) && !/(^|\/)(maplibre|mapbox|leaflet|protomaps|pmtiles)([-/]|$)/.test(record.path), 'Unlisted or vendor map runtime input');
    sources.add(record.path);
    if (record.path.startsWith('web/')) {
      const source = path.join(webRoot, record.path.slice(4)), bytes = await readFile(source);
      require(!(await lstat(source)).isSymbolicLink() && bytes.length === record.sizeBytes && hash(bytes) === record.sha256, `Shared map input changed: ${record.path}; regenerate the bundle in the full repository`);
    }
  }
  for (const name of ['custom-map-engine.ts', 'custom-map-camera.ts', 'custom-map-vector.ts', 'custom-map-painter.ts', 'custom-map-tiles.worker.ts']) require(sources.has('web/lib/' + name), `Shared map source missing: ${name}`);
  require(Array.isArray(manifest.files) && manifest.files.length >= 5 && manifest.files.length <= 64, 'Missing shared map outputs');
  const outputs = new Set(), records = [];
  for (const record of manifest.files) {
    require(safe(record.path) && !outputs.has(record.path) && Number.isSafeInteger(record.sizeBytes) && record.sizeBytes > 0 && record.sizeBytes <= 2 * 1024 * 1024 && /^[a-f0-9]{64}$/.test(record.sha256), 'Invalid map output record');
    const filename = path.join(directory, record.path), bytes = await readFile(filename);
    require(!(await lstat(filename)).isSymbolicLink() && bytes.length === record.sizeBytes && hash(bytes) === record.sha256, `Shared map output changed: ${record.path}`);
    if (record.path.endsWith('.js')) require(!/file:\/\/\//.test(bytes.toString()), 'Unresolved worker file origin in shared runtime');
    outputs.add(record.path);records.push({...record});
  }
  for (const name of ['map-runtime.js', 'map.css', 'android-bootstrap.js', 'index.html']) require(outputs.has(name), `Missing map entry: ${name}`);
  require([...outputs].some(name => name.startsWith('workers/custom-map-tiles.worker-') && name.endsWith('.js')), 'Own cartographic worker is missing');
  async function list(dir, prefix = '') {
    const result = [];
    for (const entry of await readdir(dir, {withFileTypes: true})) {
      require(!entry.isSymbolicLink(), 'Symlinked map output directory');
      if (entry.isDirectory()) result.push(...await list(path.join(dir, entry.name), prefix + entry.name + '/'));
      else result.push(prefix + entry.name);
    }
    return result;
  }
  require(JSON.stringify((await list(directory)).sort()) === JSON.stringify([...outputs, 'manifest.json'].sort()), 'Unlisted shared map outputs');
  const webFiles = records.filter(record => !['index.html', 'android-bootstrap.js', 'offline-manifest.json'].includes(record.path));
  return {runtime: manifest.runtime, sourceInputsSha256: manifest.sourceInputsSha256, manifestSha256: hash(manifestBytes),
    fileCount: outputs.size, workerCount: [...outputs].filter(name => name.startsWith('workers/') && name.endsWith('.js')).length,
    files: webFiles, manifest: {path: 'manifest.json', sizeBytes: manifestBytes.length, sha256: hash(manifestBytes)}};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await verifyCustomMap();
  console.log(JSON.stringify({runtime: report.runtime, sourceInputsSha256: report.sourceInputsSha256,
    manifestSha256: report.manifestSha256, fileCount: report.fileCount, workerCount: report.workerCount}, null, 2));
}
