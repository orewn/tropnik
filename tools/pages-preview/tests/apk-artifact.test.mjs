import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {apkFileName, ensureApk, publicApkUrl, validateApkDelivery, validateApkManifest, verifyPublicApk} from '../apk-artifact.mjs';
import {payload, arm64Manifest as metadata, universalManifest} from './fixtures/apk.mjs';

async function fixture(t, manifest = metadata) {
  const directory = await mkdtemp(join(tmpdir(), 'tropnik-apk-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return {directory, path: join(directory, apkFileName(manifest))};
}

test('the pinned architecture selects only its known release asset', () => {
  assert.equal(apkFileName(metadata), 'tropnik-arm64-preview.apk');
  assert.equal(apkFileName(universalManifest), 'tropnik-preview.apk');
  assert.equal(publicApkUrl(metadata), 'https://github.com/orewn/tropnik/releases/download/v0.4.2-preview/tropnik-arm64-preview.apk');
  assert.equal(publicApkUrl(universalManifest), 'https://github.com/orewn/tropnik/releases/download/v0.4.2-preview/tropnik-preview.apk');
});

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
  for (const manifest of [metadata, universalManifest]) {
    const {path, directory} = await fixture(t, manifest);
    const calls = [];
    const result = await ensureApk(path, manifest, {fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.redirect, 'manual');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.headers.Authorization, undefined);
      if (calls.length === 1) return new Response(null, {status: 302, headers: {Location: 'https://release-assets.githubusercontent.com/tropnik.apk?signature=fixture'}});
      return new Response(payload, {headers: {'Content-Length': String(payload.length)}});
    }});
    assert.equal(calls[0], publicApkUrl(manifest));
    assert.equal(calls.length, 2);
    assert.equal(result.source, 'public-release');
    assert.deepEqual(await readFile(path), payload);
    assert.deepEqual(await readdir(directory), [apkFileName(manifest)]);
  }
});

test('the deployed release verifier consumes all anonymous chunks without requiring Content-Length', async () => {
  for (const manifest of [metadata, universalManifest]) {
    const calls = [];
    let delivered = 0;
    const result = await verifyPublicApk(manifest, {fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.redirect, 'manual');
      assert.equal(options.credentials, 'omit');
      assert.deepEqual(options.headers, {Accept: 'application/octet-stream'});
      assert.ok(options.signal instanceof AbortSignal);
      if (calls.length === 1) return new Response(null, {status: 302, headers: {Location: 'https://release-assets.githubusercontent.com/tropnik.apk?signature=fixture'}});
      return new Response(new ReadableStream({pull(controller) {
        if (delivered === payload.length) return controller.close();
        const end = Math.min(payload.length, delivered + 3);
        controller.enqueue(payload.subarray(delivered, end));
        delivered = end;
      }}));
    }});
    assert.equal(calls[0], publicApkUrl(manifest));
    assert.equal(calls.length, 2);
    assert.equal(delivered, payload.length);
    assert.deepEqual(result, {bytes: payload.length, sha256: manifest.sha256, version: manifest.version, source: 'public-release', url: publicApkUrl(manifest)});
  }
});

test('the deployed release verifier rejects false lengths, changed bytes, truncation and oversized bodies', async () => {
  for (const length of ['invalid', String(payload.length - 1), String(payload.length + 1)]) {
    await assert.rejects(verifyPublicApk(metadata, {fetchImpl: async () => new Response(payload, {headers: {'Content-Length': length}})}), /Content-Length/);
  }
  for (const body of [Buffer.alloc(payload.length, 66), payload.subarray(0, payload.length - 1), Buffer.concat([payload, Buffer.from('extra')])]) {
    await assert.rejects(verifyPublicApk(metadata, {fetchImpl: async () => new Response(body)}), /SHA256 or size|exceeds/);
  }
  await assert.rejects(verifyPublicApk(metadata, {fetchImpl: async () => new Response('Not found', {status: 404})}), /HTTP 404/);
});

test('the deployed release verifier never follows untrusted or excessive redirects', async () => {
  for (const location of ['https://private.example.invalid/file.apk', 'http://github.com/orewn/tropnik/file.apk',
    'https://user:password@github.com/orewn/tropnik/file.apk', 'https://github.com:8443/orewn/tropnik/file.apk']) {
    let calls = 0;
    await assert.rejects(verifyPublicApk(metadata, {fetchImpl: async () => {
      calls++;
      return new Response(null, {status: 302, headers: {Location: location}});
    }}), /outside the public GitHub release hosts/);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(verifyPublicApk(metadata, {fetchImpl: async () => {
    calls++;
    return new Response(null, {status: 302, headers: {Location: 'https://github.com/orewn/tropnik/again'}});
  }}), /excessive redirect/);
  assert.equal(calls, 5);
});

test('the external delivery receipt rejects a different source, URL, artifact or verification claim', () => {
  for (const manifest of [metadata, universalManifest]) {
    const delivery = {
      delivery: 'github-release', sourcePath: `/downloads/${apkFileName(manifest)}`,
      downloadHref: publicApkUrl(manifest), bytes: manifest.bytes, sha256: manifest.sha256,
      version: manifest.version, architecture: manifest.architecture,
      abis: manifest.abis || [manifest.architecture], signature: manifest.signature,
      signingCertificateSha256: manifest.signingCertificateSha256,
      sourceCommit: manifest.sourceCommit, workflowRunId: manifest.workflowRunId,
      testedArchitecture: manifest.testedArchitecture || null,
      deviceExecutionVerified: manifest.deviceExecutionVerified === true,
      physicalDeviceVerified: false,
    };
    assert.equal(validateApkDelivery(delivery, manifest), delivery);
    const wrongUrls = [delivery.downloadHref.replace('/orewn/', '/other/'), delivery.downloadHref.replace('/tropnik/', '/other/'),
      delivery.downloadHref.replace(`/v${manifest.version}/`, '/latest/'), delivery.downloadHref.replace('.apk', '-other.apk'),
      delivery.downloadHref.replace('github.com', 'github.com:443'), delivery.downloadHref.replace('https://', 'https://user@'),
      delivery.downloadHref + '?url=https://private.example.invalid/'];
    for (const patch of [...wrongUrls.map(downloadHref => ({downloadHref})), {delivery: 'local'}, {bytes: manifest.bytes + 1},
      {sha256: '0'.repeat(64)}, {sourceCommit: '0'.repeat(40)}, {workflowRunId: manifest.workflowRunId + 1},
      {signingCertificateSha256: '0'.repeat(64)}, {physicalDeviceVerified: true}, {abis: ['x86_64']}]) {
      assert.throws(() => validateApkDelivery({...delivery, ...patch}, manifest), /manifest-pinned public release/);
    }
  }
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
  for (const patch of [{version: '../latest'}, {versionCode: 0}, {architecture: 'x86_64'}, {architecture: ['universal']},
    {architecture: 'constructor'}, {minSdk: 27}, {bytes: 0}, {bytes: 101 * 1024 * 1024}, {sha256: 'not-a-digest'}]) {
    assert.throws(() => validateApkManifest({...metadata, ...patch}), /manifest must pin/);
  }
});

test('preview metadata cannot omit the signing certificate or source-run provenance', () => {
  for (const patch of [{signature: 'release'}, {signature: undefined}, {signingCertificateSha256: undefined},
    {signingCertificateSha256: 'not-a-certificate'}, {sourceCommit: 'main'}, {workflowRunId: 0}, {workflowRunId: '1'}]) {
    assert.throws(() => validateApkManifest({...metadata, ...patch}), /signing certificate, source commit and workflow run/);
  }
});

test('universal selection requires exactly the packaged ABI set', () => {
  assert.equal(validateApkManifest({...universalManifest, abis: ['x86_64', 'armeabi-v7a', 'arm64-v8a']}).architecture, 'universal');
  for (const abis of [undefined, 'universal', ['arm64-v8a'], ['arm64-v8a', 'x86_64', 'x86_64'],
    ['arm64-v8a', 'armeabi-v7a', 'x86'], ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86']]) {
    assert.throws(() => validateApkManifest({...universalManifest, abis}), /three ABIs/);
  }
  assert.throws(() => validateApkManifest({...metadata, abis: universalManifest.abis}), /cannot describe another ABI/);
});

test('universal selection requires the exact installed emulator payload without overstating device coverage', () => {
  for (const patch of [{testedArtifact: 'tropnik-arm64-preview.apk'}, {testedArchitecture: 'arm64-v8a'},
    {testedUniversalSha256: '0'.repeat(64)}, {deviceTestCount: 0}, {physicalDeviceVerified: true},
    {arm64DeviceExecutionVerified: true}, {arm64DeviceExecutionVerified: undefined},
    ...['deviceExecutionVerified', 'releasePayloadDeviceVerified', 'universalReleasePayloadDeviceVerified',
      'installedArtifactBytesVerified'].map(key => ({[key]: false}))]) {
    assert.throws(() => validateApkManifest({...universalManifest, ...patch}), /exact emulator-tested release payload/);
  }
});

test('a universal receipt for different bytes fails before any network request', async t => {
  const {path, directory} = await fixture(t, universalManifest);
  let requests = 0;
  await assert.rejects(ensureApk(path, {...universalManifest, testedUniversalSha256: '0'.repeat(64)}, {
    fetchImpl() {requests++; throw new Error('Unexpected network');},
  }), /exact emulator-tested release payload/);
  assert.equal(requests, 0);
  assert.deepEqual(await readdir(directory), []);
});
