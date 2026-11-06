import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellPaths, verifyMapShell } from '../scripts/verify-map-shell.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = path.join(root, 'public');
const source = await readFile(path.join(publicRoot, 'sw.js'), 'utf8');

async function copyInputs(t, omit = new Set()) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tropnik-map-shell-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalogPath = path.join(root, 'lib', 'territories.generated.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const files = new Set(['public/sw.js', 'lib/territories.generated.json',
    ...shellPaths(source).map(url => 'public/' + decodeURIComponent(url.slice(1))),
    ...catalog.metadata.routeGeometrySources.map(record => 'public/' + decodeURIComponent(record.url.slice(1))),
  ]);
  for (const relative of files) {
    if (omit.has(relative)) continue;
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, relative), target);
  }
  return { directory, catalog };
}

test('the actual offline shell includes every committed asset and matching territory route inventory', async () => {
  const receipt = await verifyMapShell(root);
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.shellAssets, shellPaths(source).length);
  assert.ok(receipt.territoryCount > 6);
  assert.ok(receipt.routeGeometrySources >= 277);
  assert.ok(receipt.verifiedPublicFiles > receipt.shellAssets);
  assert.equal(receipt.networkRequests, 0);
});

test('a checkout missing territory geometry fails before the framework build', async t => {
  const { directory } = await copyInputs(t, new Set(['public/data/territories.geojson']));
  await assert.rejects(verifyMapShell(directory), /Required map shell asset is missing: \/data\/territories\.geojson/);
});

test('an HTML asset cannot shadow the offline package management route', async t => {
  const { directory } = await copyInputs(t);
  await copyFile(path.join(directory, 'public/offline-viewer.html'), path.join(directory, 'public/offline.html'));
  await assert.rejects(verifyMapShell(directory), /public\/offline\.html shadows the \/offline management route/);
});

test('published territory metadata cannot silently drift from its map or route bytes', async t => {
  const { directory, catalog } = await copyInputs(t);
  const geometryPath = path.join(directory, 'public/data/territories.geojson');
  const geometry = await readFile(geometryPath);
  await t.test('territory geometry bytes changed without regeneration', async () => {
    await writeFile(geometryPath, Buffer.concat([geometry, Buffer.from('\n')]));
    await assert.rejects(verifyMapShell(directory), /Map asset integrity mismatch: \/data\/territories\.geojson/);
    await writeFile(geometryPath, geometry);
  });
  const metadataPath = path.join(directory, 'lib/territories.generated.json');
  const originalMetadata = await readFile(metadataPath);
  await t.test('territory count no longer agrees with the GeoJSON', async () => {
    const altered = JSON.parse(originalMetadata.toString('utf8'));
    altered.metadata.elementCount += 1;
    await writeFile(metadataPath, JSON.stringify(altered));
    await assert.rejects(verifyMapShell(directory), /Territory geometry and metadata counts differ/);
    await writeFile(metadataPath, originalMetadata);
  });
  const routeURL = catalog.metadata.routeGeometrySources[0].url;
  const routePath = path.join(directory, 'public', decodeURIComponent(routeURL.slice(1)));
  const route = await readFile(routePath);
  await t.test('a source route changed after territory membership was calculated', async () => {
    await writeFile(routePath, Buffer.concat([route, Buffer.from('\n')]));
    await assert.rejects(verifyMapShell(directory), /Map asset integrity mismatch:/);
    await writeFile(routePath, route);
  });
  assert.equal((await verifyMapShell(directory)).status, 'passed');
});

test('private API routes are rejected even if accidentally added to the shell list', async t => {
  const { directory } = await copyInputs(t);
  const changed = source.replace(/(\bconst\s+SHELL\s*=\s*\[)/, "$1'/api/backend/me',");
  assert.notEqual(changed, source);
  await writeFile(path.join(directory, 'public/sw.js'), changed);
  await assert.rejects(verifyMapShell(directory), /Private API\/auth resource cannot enter the map shell/);
});
