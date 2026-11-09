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
    await writeFile(join(root, 'public/maps/canvas-style.js'), 'export const style=1;');
    const first = await stampServiceWorker(root);
    assert.equal(await stampServiceWorker(root), first, 'repeated builds must be deterministic');
    await writeFile(join(root, 'public/maps/canvas-style.js'), 'export const style=2;');
    const next = await stampServiceWorker(root);
    assert.notEqual(next, first, 'changed stable-URL map assets must receive a new shell cache');
    assert.match(await readFile(join(root, 'public/sw.js'), 'utf8'), /tropnik-map-/);
  } finally {await rm(root, {recursive: true, force: true});}
});
