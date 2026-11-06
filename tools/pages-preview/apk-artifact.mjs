import {createHash, randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat, mkdir, open, readFile, rename, rm} from 'node:fs/promises';
import {dirname} from 'node:path';

export const APK_FILE = 'tropnik-arm64-preview.apk';
const MAX_APK_BYTES = 100 * 1024 * 1024;
const RELEASE_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

export function validateApkManifest(value) {
  if (!value || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version) ||
      !Number.isSafeInteger(value.versionCode) || value.versionCode < 1 ||
      value.architecture !== 'arm64-v8a' ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_APK_BYTES ||
      !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error('Android manifest must pin a version, ARM64 architecture, bounded size and SHA256.');
  }
  return value;
}

export async function readApkManifest(path) {
  return validateApkManifest(JSON.parse(await readFile(path, 'utf8')));
}

export function publicApkUrl(metadata) {
  validateApkManifest(metadata);
  return `https://github.com/orewn/tropnik/releases/download/v${metadata.version}/${APK_FILE}`;
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

/** Use an existing verified binary, or publish a complete verified download atomically. */
export async function ensureApk(path, metadata, {fetchImpl = globalThis.fetch, download = true} = {}) {
  validateApkManifest(metadata);
  const existing = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) return {...await verifyApk(path, metadata), source: 'local'};
  if (!download) throw new Error('Required APK is absent. Run node tools/pages-preview/fetch-apk.mjs before building Pages.');

  const releaseUrl = publicApkUrl(metadata);
  let url = releaseUrl;
  let response;
  const signal = AbortSignal.timeout(120_000);
  for (let redirects = 0; redirects <= 4; redirects++) {
    response = await fetchImpl(requirePublicReleaseUrl(url), {redirect: 'manual', signal, headers: {Accept: 'application/octet-stream'}});
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

  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.${randomUUID()}.part`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o644);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > metadata.bytes) throw new Error('APK download exceeds its manifest size.');
      hash.update(chunk);
      await handle.writeFile(chunk);
    }
    if (bytes !== metadata.bytes || hash.digest('hex') !== metadata.sha256) throw new Error('Downloaded APK SHA256 or size does not match the manifest.');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    return {bytes, sha256: metadata.sha256, version: metadata.version, source: 'public-release', url: releaseUrl};
  } finally {
    await handle?.close();
    await rm(temporary, {force: true});
  }
}
