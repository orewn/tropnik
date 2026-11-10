import {createHash, randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat, mkdir, open, readFile, rename, rm} from 'node:fs/promises';
import {dirname} from 'node:path';
import {isDeepStrictEqual} from 'node:util';

export const APK_FILES = Object.freeze({
  'arm64-v8a': 'tropnik-arm64-preview.apk',
  universal: 'tropnik-preview.apk',
});
const UNIVERSAL_ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64'];
const MAX_APK_BYTES = 100 * 1024 * 1024;
const RELEASE_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

function hasExactAbis(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    new Set(actual).size === expected.length && actual.every(abi => expected.includes(abi));
}

export function validateApkManifest(value) {
  if (!value || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version) ||
      !Number.isSafeInteger(value.versionCode) || value.versionCode < 1 ||
      typeof value.architecture !== 'string' || !Object.hasOwn(APK_FILES, value.architecture) || value.minSdk !== 26 ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_APK_BYTES ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error('Android manifest must pin a version, supported architecture, Android API 26 minimum, bounded size and SHA256.');
  }
  if (value.signature !== 'development / debug' ||
      typeof value.signingCertificateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.signingCertificateSha256) ||
      typeof value.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(value.sourceCommit) ||
      !Number.isSafeInteger(value.workflowRunId) || value.workflowRunId < 1) {
    throw new Error('Android manifest must pin its preview signing certificate, source commit and workflow run.');
  }
  if (value.architecture === 'arm64-v8a' && value.abis !== undefined && !hasExactAbis(value.abis, ['arm64-v8a'])) {
    throw new Error('ARM64 Android manifest cannot describe another ABI.');
  }
  if (value.architecture === 'universal' &&
      (!hasExactAbis(value.abis, UNIVERSAL_ABIS) || value.testedArtifact !== APK_FILES.universal ||
       value.testedArchitecture !== 'x86_64' || value.testedUniversalSha256 !== value.sha256 ||
       value.deviceExecutionVerified !== true || value.releasePayloadDeviceVerified !== true ||
       value.universalReleasePayloadDeviceVerified !== true || value.installedArtifactBytesVerified !== true ||
       value.physicalDeviceVerified !== false || value.arm64DeviceExecutionVerified !== false ||
       !Number.isSafeInteger(value.deviceTestCount) || value.deviceTestCount < 1)) {
    throw new Error('Universal Android manifest must pin its three ABIs and the exact emulator-tested release payload.');
  }
  return value;
}

export function apkFileName(metadata) {
  return APK_FILES[validateApkManifest(metadata).architecture];
}

export async function readApkManifest(path) {
  return validateApkManifest(JSON.parse(await readFile(path, 'utf8')));
}

export function publicApkUrl(metadata) {
  const filename = apkFileName(metadata);
  return `https://github.com/orewn/tropnik/releases/download/v${metadata.version}/${filename}`;
}

/** Keep the emitted link and its proof bound to the selected manifest. */
export function validateApkDelivery(value, metadata) {
  validateApkManifest(metadata);
  const expected = {
    delivery: 'github-release', sourcePath: `/downloads/${apkFileName(metadata)}`,
    downloadHref: publicApkUrl(metadata), bytes: metadata.bytes, sha256: metadata.sha256,
    version: metadata.version, architecture: metadata.architecture,
    abis: metadata.abis || [metadata.architecture], signature: metadata.signature,
    signingCertificateSha256: metadata.signingCertificateSha256,
    sourceCommit: metadata.sourceCommit, workflowRunId: metadata.workflowRunId,
    testedArchitecture: metadata.testedArchitecture || null,
    deviceExecutionVerified: metadata.deviceExecutionVerified === true,
    physicalDeviceVerified: metadata.physicalDeviceVerified === true,
  };
  if (!isDeepStrictEqual(value, expected)) throw new Error('APK delivery must match the exact manifest-pinned public release and its verification fields.');
  return value;
}

export async function verifyApk(path, metadata) {
  validateApkManifest(metadata);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size !== metadata.bytes) throw new Error('APK must be a regular file of the exact manifest size.');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > metadata.bytes) throw new Error('APK exceeds its manifest size.');
    hash.update(chunk);
  }
  if (bytes !== metadata.bytes || hash.digest('hex') !== metadata.sha256) throw new Error('APK SHA256 or size does not match the Android manifest.');
  return {bytes, sha256: metadata.sha256, version: metadata.version};
}

function requirePublicReleaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !RELEASE_HOSTS.has(url.hostname)) {
    throw new Error('APK redirect is outside the public GitHub release hosts.');
  }
  return url.href;
}

async function publicApkResponse(metadata, fetchImpl) {
  validateApkManifest(metadata);
  const releaseUrl = publicApkUrl(metadata);
  let url = releaseUrl;
  let response;
  const signal = AbortSignal.timeout(120_000);
  for (let redirects = 0; redirects <= 4; redirects++) {
    response = await fetchImpl(requirePublicReleaseUrl(url), {redirect: 'manual', credentials: 'omit', signal, headers: {Accept: 'application/octet-stream'}});
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects === 4) throw new Error('APK download returned an invalid or excessive redirect chain.');
    url = new URL(location, url).href;
  }
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Error(`Public Android release asset is unavailable (HTTP ${response.status}): ${releaseUrl}`);
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) !== metadata.bytes)) {
    await response.body.cancel();
    throw new Error('APK download Content-Length does not match the manifest.');
  }
  return {response, releaseUrl};
}

async function consumeVerifiedApk(response, metadata, consumeChunk) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > metadata.bytes) throw new Error('APK download exceeds its manifest size.');
    hash.update(chunk);
    if (consumeChunk) await consumeChunk(chunk);
  }
  if (bytes !== metadata.bytes || hash.digest('hex') !== metadata.sha256) throw new Error('Downloaded APK SHA256 or size does not match the manifest.');
  return {bytes, sha256: metadata.sha256, version: metadata.version};
}

/** Verify the complete anonymous release response without retaining its binary. */
export async function verifyPublicApk(metadata, {fetchImpl = globalThis.fetch} = {}) {
  const {response, releaseUrl} = await publicApkResponse(metadata, fetchImpl);
  return {...await consumeVerifiedApk(response, metadata), source: 'public-release', url: releaseUrl};
}

/** Use an existing verified binary, or publish a complete verified download atomically. */
export async function ensureApk(path, metadata, {fetchImpl = globalThis.fetch, download = true} = {}) {
  validateApkManifest(metadata);
  const existing = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) return {...await verifyApk(path, metadata), source: 'local'};
  if (!download) throw new Error('Required APK is absent. Run node tools/pages-preview/fetch-apk.mjs before building Pages.');

  const {response, releaseUrl} = await publicApkResponse(metadata, fetchImpl);

  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.${randomUUID()}.part`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o644);
    const verified = await consumeVerifiedApk(response, metadata, chunk => handle.writeFile(chunk));
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    return {...verified, source: 'public-release', url: releaseUrl};
  } finally {
    await handle?.close();
    await rm(temporary, {force: true});
  }
}
