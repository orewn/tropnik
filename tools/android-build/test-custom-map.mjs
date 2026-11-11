import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, cp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {safeResourcePath} from './prepare-custom-map.mjs';
import {verifyCustomMap} from '../../web/scripts/verify-custom-map.mjs';

const root = path.resolve(import.meta.dirname, '../..');

test('the native bootstrap compiles against the actual shared engine interface', async () => {
  await promisify(execFile)(process.execPath, [path.join(root, 'web/node_modules/typescript/bin/tsc'), '-p', path.join(root, 'tools/android-build/tsconfig.json'), '--noEmit'], {timeout: 30_000});
});

test('shared runtime binds its own renderer, worker and current source bytes', async () => {
  const report = await verifyCustomMap({webRoot: path.join(root, 'web')});
  assert.equal(report.runtime, 'tropnik-canvas');
  assert.ok(report.workerCount >= 1);
  const native = path.join(root, 'android/app/src/main/assets/custom-map');
  const web = path.join(root, 'web/public/custom-map');
  const manifest = JSON.parse(await readFile(path.join(native, 'manifest.json')));
  for (const record of [...manifest.files, {path: 'manifest.json'}]) assert.deepEqual(await readFile(path.join(native, record.path)), await readFile(path.join(web, record.path)), record.path);
});

test('runtime output tampering is rejected before an offline shell is written', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'tropnik-map-integrity-'));
  try {
    await cp(path.join(root, 'web/public/custom-map'), path.join(temporary, 'public/custom-map'), {recursive: true});
    const manifestPath = path.join(temporary, 'public/custom-map/manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath));
    // Supply the source inputs from the real checkout, then corrupt one worker.
    for (const record of manifest.sourceInputs.filter(r => r.path.startsWith('web/'))) {
      const filename = record.path.slice(4);
      await cp(path.join(root, 'web', filename), path.join(temporary, filename), {recursive: true, force: true});
    }
    const worker = manifest.files.find(r => r.path.startsWith('workers/custom-map-tiles.worker-')).path;
    await writeFile(path.join(temporary, 'public/custom-map', worker), 'throw new Error("corrupted worker")');
    await assert.rejects(verifyCustomMap({webRoot: temporary}), /Shared map output changed/);
  } finally {await rm(temporary, {recursive: true, force: true});}
});

test('generated map resource names cannot traverse or become external URLs', () => {
  assert.equal(safeResourcePath('workers/custom-map-tiles.worker-aBC123.js'), true);
  for (const value of ['../private', '/absolute', 'a/../private', 'a//b', 'a/./b', 'https://example.invalid/file', 'a%2fb', 'a\\b', 'a?token=1']) assert.equal(safeResourcePath(value), false, value);
});
