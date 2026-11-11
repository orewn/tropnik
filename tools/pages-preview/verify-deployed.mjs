import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {validateApkDelivery, validateApkManifest, verifyPublicApk} from './apk-artifact.mjs';
import {assertBrowserReport} from './browser-report.mjs';

const [address, expectedBuild, expectedCommit] = process.argv.slice(2);
assert.match(expectedBuild || '', /^[a-f0-9]{16}$/, 'Pass the build ID produced by the build job');
assert.match(expectedCommit || '', /^[a-f0-9]{40}$/, 'Pass the exact checked-out source commit');
const site = new URL(address);
assert.equal(site.origin, 'https://orewn.github.io');
assert.equal(site.pathname.replace(/\/$/, ''), '/tropnik');
assert.equal(site.search + site.hash + site.username + site.password, '');
site.pathname = '/tropnik/';
let checks = 0;

async function request(path, limit = 4 * 1024 * 1024, binary = false) {
  const url = new URL(path, site);
  assert.equal(url.origin, site.origin);
  assert.ok(url.pathname.startsWith(site.pathname), 'Every probe must stay under the published base path');
  url.searchParams.set('tropnik-build', expectedBuild);
  const response = await fetch(url, {redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000)});
  assert.equal(response.status, 200, `${url.pathname} did not return a public HTTP 200`);
  assert.ok(response.body, `${url.pathname} returned no body`);
  const chunks = [];
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    assert.ok(bytes <= limit, `${url.pathname} exceeds its response budget`);
    hash.update(chunk);
    if (!binary) chunks.push(chunk);
  }
  assert.ok(bytes > 0, `${url.pathname} returned an empty body`);
  checks++;
  return {bytes, sha256: hash.digest('hex'), text: binary ? null : Buffer.concat(chunks).toString('utf8')};
}

// Pages can briefly serve the preceding CDN revision after a completed deploy.
// Retry only the freshness probe; never label a different build as this release.
let build;
for (let attempt = 0; attempt < 6; attempt++) {
  try {
    build = JSON.parse((await request('build-info.json')).text);
    assert.equal(build.buildId, expectedBuild, 'The public CDN still serves another build');
    assert.equal(build.sourceCommit, expectedCommit, 'The published source commit does not match this workflow');
    break;
  } catch (error) {
    if (attempt === 5) throw error;
    await delay(5000);
  }
}
assert.equal(build.base, '/tropnik/');
assert.equal(build.origin, site.origin);
assert.equal(build.hasApk, true);
assert.equal(build.apiConnected, false);
const verification = JSON.parse((await request('verification.json')).text);
assert.equal(verification.verified, true);
assert.equal(verification.apkVerified, true);
assert.equal(verification.base, build.base);
assert.equal(verification.pages, build.pages);
const pages = JSON.parse((await request('page-manifest.json')).text);
assert.equal(pages.length, build.pages);
const browser = JSON.parse((await request('browser-verification.json')).text);
assertBrowserReport(browser,expectedCommit,build.catalogue);

const home = (await request('')).text;
assert.match(home, /Тропник/);
assert.match(home, /noindex,nofollow/);
const assets = new Set([...home.matchAll(/(?:src|href)=["'](\/tropnik\/assets\/[^"']+)["']/g)].map(match => match[1]));
assert.ok(assets.size >= 2, 'The homepage must reference its built script and style assets');
for (const path of assets) await request(path);
for (const kind of ['region', 'route', 'android', 'offline', 'sources']) {
  const page = pages.find(item => item.kind === kind);
  assert.ok(page, `No page of kind ${kind}`);
  assert.match((await request(page.path.slice(1) + '/')).text, /noindex,nofollow/);
}
await request('offline-viewer.html');
for (const asset of ['offline-safety.html','offline-safety.js','offline-safety.css']) await request(asset);
await request('sw.js');
await request('data/territories.geojson');
const android = validateApkManifest(JSON.parse((await request('downloads/android-manifest.json')).text));
validateApkDelivery(build.apk, android);
// The site probes remain strictly same-origin. The separately bounded anonymous
// release request follows only the existing GitHub asset redirect allowlist.
const apk = await verifyPublicApk(android);
assert.equal(apk.bytes, android.bytes);
assert.equal(apk.sha256, android.sha256, 'The public APK is not the pinned Android build');
console.log(JSON.stringify({verified: true, url: site.href, buildId: build.buildId, sourceCommit: build.sourceCommit, publicHttpChecks: checks, apkDelivery: build.apk.delivery, apkUrl: apk.url, apkBytes: apk.bytes, apkSha256: apk.sha256, browserRenderingTested: true, browserProfiles: browser.profiles.length}, null, 2));
