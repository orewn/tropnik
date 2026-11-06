import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function shellPaths(source) {
  const literal = /\bconst\s+SHELL\s*=\s*(\[[\s\S]*?\])\s*;/.exec(source)?.[1];
  if (!literal) throw new Error('Service worker has no static SHELL list');
  const strings = [...literal.matchAll(/(['"])([^'"\\\r\n]*)\1/g)];
  if (!/^\[\s*(?:,\s*)*\]$/.test(literal.replace(/(['"])([^'"\\\r\n]*)\1/g, ''))) {
    throw new Error('SHELL must contain only literal public asset paths');
  }
  const paths = strings.map(item => item[2]);
  if (!paths.length || new Set(paths).size !== paths.length) throw new Error('SHELL paths are empty or duplicated');
  return paths;
}

function localPath(url) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || /[?#\\]/.test(url)) {
    throw new Error('Map asset URL is not a local absolute path: ' + String(url));
  }
  let decoded;
  try { decoded = decodeURIComponent(url); } catch { throw new Error('Map asset URL encoding is invalid'); }
  if (/[?#\\\0]/.test(decoded) || decoded.split('/').slice(1).some(part => !part || part === '.' || part === '..')) {
    throw new Error('Map asset path is not canonical: ' + url);
  }
  if (/^\/(?:api|auth)(?:\/|$)/.test(decoded)) throw new Error('Private API/auth resource cannot enter the map shell');
  return decoded.slice(1);
}

function recordMatches(record, actual, label) {
  if (!Number.isSafeInteger(record?.bytes) || record.bytes < 0 || !/^[a-f0-9]{64}$/.test(record?.sha256 ?? '')) {
    throw new Error('Invalid integrity metadata: ' + label);
  }
  if (record.bytes !== actual.bytes || record.sha256 !== actual.sha256) {
    throw new Error('Map asset integrity mismatch: ' + label);
  }
}

export async function verifyMapShell(webRoot = defaultRoot) {
  const root = path.resolve(webRoot);
  const publicRoot = await realpath(path.join(root, 'public'));
  const legacyViewer = await stat(path.join(publicRoot, 'offline.html')).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (legacyViewer) throw new Error('public/offline.html shadows the /offline management route through HTML asset routing; use offline-viewer.html');
  const source = await readFile(path.join(publicRoot, 'sw.js'), 'utf8');
  const paths = shellPaths(source);
  if (!paths.includes('/offline-viewer.html')) throw new Error('SHELL omits the standalone offline viewer');
  const version = /\bconst\s+VERSION\s*=\s*(['"])([^'"]+)\1/.exec(source)?.[2];
  if (!version) throw new Error('Service worker cache version is missing');
  const checked = new Map();
  const asset = async url => {
    if (!checked.has(url)) checked.set(url, (async () => {
      const relative = localPath(url);
      let location;
      try { location = await realpath(path.join(publicRoot, relative)); }
      catch { throw new Error('Required map shell asset is missing: ' + url); }
      const within = path.relative(publicRoot, location);
      if (within.startsWith('..' + path.sep) || path.isAbsolute(within) || within === '..') {
        throw new Error('Map shell asset escapes public/: ' + url);
      }
      if (!(await stat(location)).isFile()) throw new Error('Map shell asset is not a file: ' + url);
      const bytes = await readFile(location);
      if (!bytes.length) throw new Error('Map shell asset is empty: ' + url);
      let json;
      if (/\.(?:geojson|json)$/.test(relative)) {
        try { json = JSON.parse(bytes.toString('utf8')); }
        catch { throw new Error('Map asset JSON is invalid: ' + url); }
      }
      return { url, bytes: bytes.length, sha256: digest(bytes), json };
    })());
    return checked.get(url);
  };
  const shell = await Promise.all(paths.map(asset));
  if (!paths.includes('/data/territories.geojson')) throw new Error('SHELL omits the full territory geometry');
  const metadataPath = path.join(root, 'lib', 'territories.generated.json');
  let metadataBytes, catalog;
  try {
    metadataBytes = await readFile(metadataPath);
    catalog = JSON.parse(metadataBytes.toString('utf8'));
  } catch { throw new Error('Territory metadata is missing or invalid: lib/territories.generated.json'); }
  if (catalog.version !== 1 || !Array.isArray(catalog.territories) || !catalog.territories.length
    || catalog.geometry?.url !== '/data/territories.geojson') {
    throw new Error('Territory metadata schema is invalid');
  }
  const geometry = await asset(catalog.geometry.url);
  recordMatches(catalog.geometry, geometry, catalog.geometry.url);
  if (geometry.json?.type !== 'FeatureCollection' || !Array.isArray(geometry.json.features)) {
    throw new Error('Territory geometry is not a FeatureCollection');
  }
  const features = geometry.json.features;
  if (catalog.geometry.features !== features.length || catalog.metadata?.elementCount !== features.length
    || catalog.territories.length !== features.length) {
    throw new Error('Territory geometry and metadata counts differ');
  }
  const ids = new Set();
  for (const feature of features) {
    if (typeof feature.id !== 'string' || !feature.id.startsWith('territory-') || ids.has(feature.id)
      || feature.properties?.id !== feature.id || !['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)) {
      throw new Error('Territory geometry has an invalid or duplicate identity');
    }
    ids.add(feature.id);
  }
  const territoryIds = new Set();
  for (const territory of catalog.territories) {
    if (!ids.has(territory.id) || territoryIds.has(territory.id) || !Array.isArray(territory.geometryUrls)) {
      throw new Error('Territory metadata identity does not match the map');
    }
    territoryIds.add(territory.id);
  }
  const routeSources = catalog.metadata.routeGeometrySources;
  if (!Array.isArray(routeSources) || !routeSources.length
    || catalog.metadata.routeGeometrySourceCount !== routeSources.length
    || new Set(routeSources.map(item => item.url)).size !== routeSources.length) {
    throw new Error('Territory route source inventory is invalid');
  }
  const routeUrls = new Set(routeSources.map(item => item.url));
  for (const territory of catalog.territories) {
    if (territory.geometryUrls.some(url => !routeUrls.has(url))) {
      throw new Error('Territory references an unverified route geometry: ' + territory.id);
    }
  }
  await Promise.all(routeSources.map(async record => recordMatches(record, await asset(record.url), record.url)));
  return {
    schemaVersion: 1, status: 'passed', serviceWorkerVersion: version,
    shellAssets: shell.length, shellBytes: shell.reduce((sum, file) => sum + file.bytes, 0),
    territoryCount: features.length, territoryGeometrySha256: geometry.sha256,
    territoryMetadataSha256: digest(metadataBytes), routeGeometrySources: routeSources.length,
    verifiedPublicFiles: checked.size, networkRequests: 0,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: node verify-map-shell.mjs [web-root]');
    console.log(JSON.stringify(await verifyMapShell(process.argv[2] ?? defaultRoot)));
  } catch (error) {
    console.error('Map shell verification failed: ' + error.message);
    process.exitCode = 1;
  }
}
