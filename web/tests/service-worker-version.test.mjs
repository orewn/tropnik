import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {stampServiceWorker} from '../scripts/stamp-service-worker.mjs';

test('public map changes invalidate the Sites shell without deleting offline packs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tropnik-worker-'));
  try {
    await mkdir(join(root, 'public/maps'), {recursive: true});
    await writeFile(join(root, 'package.json'), JSON.stringify({version: '0.4.18'}));
    await writeFile(join(root, 'public/sw.js'), "const VERSION='tropnik-shell-v20';\nconst saved='tropnik-map-';\n");
    await writeFile(join(root, 'public/maps/map-city-labels.js'), 'export const style=1;');
    const first = await stampServiceWorker(root);
    assert.equal(await stampServiceWorker(root), first, 'repeated builds must be deterministic');
    await writeFile(join(root, 'public/maps/map-city-labels.js'), 'export const style=2;');
    const next = await stampServiceWorker(root);
    assert.notEqual(next, first, 'changed stable-URL map assets must receive a new shell cache');
    await mkdir(join(root, 'public/data'), {recursive: true});
    const coverage = join(root, 'public/data/russia-display-area.geojson');
    await writeFile(coverage, JSON.stringify({type: 'Point', coordinates: [27, 60]}));
    const withCoverage = await stampServiceWorker(root);
    await writeFile(coverage, JSON.stringify({type: 'Point', coordinates: [27.001, 60]}));
    const repairedCoverage = await stampServiceWorker(root);
    assert.notEqual(repairedCoverage, withCoverage, 'a data-only coastline repair must replace cached geometry');
    await writeFile(join(root, 'public/data/geometry-manifest.json'), JSON.stringify({revision: 1}));
    const withManifest = await stampServiceWorker(root);
    await writeFile(join(root, 'public/data/geometry-manifest.json'), JSON.stringify({revision: 2}));
    assert.notEqual(await stampServiceWorker(root), withManifest, 'a new geometry manifest must invalidate the shell');
    assert.equal(await stampServiceWorker(root), await stampServiceWorker(root));
    assert.match(await readFile(join(root, 'public/sw.js'), 'utf8'), /tropnik-map-/);
  } finally {await rm(root, {recursive: true, force: true});}
});
