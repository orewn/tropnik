import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {APK_FILE, ensureApk, publicApkUrl, validateApkManifest} from '../apk-artifact.mjs';

const payload = Buffer.from('A bounded binary fixture, never an actual installable APK.');
const metadata = {
  version: '0.4.2-preview', versionCode: 6, architecture: 'arm64-v8a',
  bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex'),
};
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tropnik-apk-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return {directory, path: join(directory, APK_FILE)};
}

test('an existing verified APK is reused without a network call', async t => {
  const {path} = await fixture(t);
  await writeFile(path, payload);
  const result = await ensureApk(path, metadata, {fetchImpl() {throw new Error('Unexpected network');}});
  assert.equal(result.source, 'local');
  assert.equal(result.sha256, metadata.sha256);
});

test('a changed local APK fails closed and is not silently replaced', async t => {
  const {path} = await fixture(t);
  const changed = Buffer.alloc(payload.length, 65);
  await writeFile(path, changed);
  await assert.rejects(ensureApk(path, metadata, {fetchImpl() {throw new Error('Unexpected network');}}), /SHA256/);
  assert.deepEqual(await readFile(path), changed);
});

test('an absent APK cannot pass the offline build preparation gate', async t => {
  const {path, directory} = await fixture(t);
  await assert.rejects(ensureApk(path, metadata, {download: false}), /Required APK is absent/);
  assert.deepEqual(await readdir(directory), []);
});

test('a public release redirect downloads exact pinned bytes before publication', async t => {
  const {path, directory} = await fixture(t);
  const calls = [];
  const result = await ensureApk(path, metadata, {fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, undefined);
    if (calls.length === 1) return new Response(null, {status: 302, headers: {Location: 'https://release-assets.githubusercontent.com/tropnik.apk?signature=fixture'}});
    return new Response(payload, {headers: {'Content-Length': String(payload.length)}});
  }});
  assert.equal(calls[0], publicApkUrl(metadata));
  assert.equal(calls.length, 2);
  assert.equal(result.source, 'public-release');
  assert.deepEqual(await readFile(path), payload);
  assert.deepEqual(await readdir(directory), [APK_FILE]);
});

test('missing public release asset fails before producing an APK', async t => {
  const {path, directory} = await fixture(t);
  await assert.rejects(ensureApk(path, metadata, {fetchImpl: async () => new Response('Not found', {status: 404})}), /HTTP 404/);
  assert.deepEqual(await readdir(directory), []);
});

test('untrusted redirect cannot receive a download request', async t => {
  const {path, directory} = await fixture(t);
  let requests = 0;
  await assert.rejects(ensureApk(path, metadata, {fetchImpl: async () => {
    requests++;
    return new Response(null, {status: 302, headers: {Location: 'https://private.example.invalid/file.apk'}});
  }}), /outside the public GitHub release hosts/);
  assert.equal(requests, 1);
  assert.deepEqual(await readdir(directory), []);
});

test('wrong digest, truncation and oversized streamed bodies leave no published or partial file', async t => {
  const cases = [Buffer.alloc(payload.length, 66), payload.subarray(0, payload.length - 1), Buffer.concat([payload, Buffer.from('extra')])];
  for (const body of cases) {
    const {path, directory} = await fixture(t);
    await assert.rejects(ensureApk(path, metadata, {fetchImpl: async () => new Response(body)}), /SHA256|size/);
    assert.deepEqual(await readdir(directory), []);
  }
});

test('manifest cannot redirect versions into a different release path or remove resource bounds', () => {
  for (const patch of [{version: '../latest'}, {versionCode: 0}, {architecture: 'x86_64'}, {bytes: 0}, {bytes: 101 * 1024 * 1024}, {sha256: 'not-a-digest'}]) {
    assert.throws(() => validateApkManifest({...metadata, ...patch}), /manifest must pin/);
  }
});
