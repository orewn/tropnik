import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pagesPath, rewriteScript, rewriteHTML} from '../paths.mjs';
import {androidPageDownload} from '../apk-page.mjs';

const androidSource = await readFile(new URL('../../../web/app/android/page.tsx', import.meta.url), 'utf8');
const androidManifest = JSON.parse(await readFile(new URL('../../../web/public/downloads/android-manifest.json', import.meta.url), 'utf8'));

test('search and account actions stay inside the published project for links and imperative navigation',()=>{
  const base='/tropnik/';
  for(const path of ['/search','/search?q=Байкал','/account/action#token=test']) assert.equal(pagesPath(path,base),base+path.slice(1));
  const source='const a=<a href="/search">Поиск</a>; window.location.assign("/search"); const b=`/search?q=${query}`;';
  const transformed=rewriteScript(source,'Header.tsx',{base});
  assert.ok(transformed.includes('href="/tropnik/search"'));
  assert.ok(transformed.includes('assign("/tropnik/search")'));
  assert.ok(transformed.includes('`/tropnik/search?q=${query}`'));
  assert.equal(rewriteHTML('<a href="/search">Поиск</a>',base),'<a href="/tropnik/search">Поиск</a>');
  assert.equal(pagesPath('https://example.org/search',base),'https://example.org/search');
});

test('the real Android download uses its manifest checksum and retains the Pages base exactly once', () => {
  const path = '/downloads/tropnik-arm64-preview.apk';
  const original = androidPageDownload(androidSource, androidManifest);
  assert.deepEqual(original, {path, downloadHref: `${path}?sha256=${androidManifest.sha256}`});
  const base = '/tropnik/';
  const transformed = rewriteScript(androidSource, 'android/page.tsx', {base});
  assert.deepEqual(androidPageDownload(transformed, androidManifest, {base}), {
    path, downloadHref: `${base}${path.slice(1)}?sha256=${androidManifest.sha256}`,
  });
  assert.equal(rewriteScript(transformed, 'android/page.tsx', {base}), transformed);
});

test('the Android page gate rejects a wrong payload, missing cache key, dynamic override or second download', () => {
  const badPages = [
    androidSource.replace('tropnik-arm64-preview.apk?', 'unverified.apk?'),
    androidSource.replace('?sha256=${androidBuild.sha256}', ''),
    androidSource.replace('androidBuild.sha256}', 'androidBuild.version}'),
    androidSource.replace('androidBuild.sha256}', 'other.sha256}'),
    androidSource.replace('sha256=${androidBuild.sha256}', `sha256=${'0'.repeat(64)}`),
    androidSource.replace(' download>', ' {...props} download>'),
    androidSource.replace(' download>', '>'),
    androidSource + '<a href="/downloads/other.apk" download>Other</a>',
  ];
  for (const page of badPages) assert.throws(() => androidPageDownload(page, androidManifest), /Android download|Android page/);
});
