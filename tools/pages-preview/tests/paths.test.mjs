import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {pagesPath, rewriteScript, rewriteHTML, ts} from '../paths.mjs';
import {androidPageDownload, pinAndroidPageDownload} from '../apk-page.mjs';
import {apkFileName, validateApkManifest} from '../apk-artifact.mjs';
import {arm64Manifest, universalManifest} from './fixtures/apk.mjs';

const androidSource = await readFile(new URL('../../../web/app/android/page.tsx', import.meta.url), 'utf8');
const androidManifest = JSON.parse(await readFile(new URL('../../../web/public/downloads/android-manifest.json', import.meta.url), 'utf8'));

test('the rendered real Footer keeps its map and section links inside each Pages project base', async () => {
  const require = createRequire(new URL('../../../web/package.json', import.meta.url));
  const {createElement} = require('react');
  const {renderToStaticMarkup} = require('react-dom/server');
  const sources = Object.fromEntries(await Promise.all(['Footer', 'Brand'].map(async name =>
    [name, await readFile(new URL(`../../../web/components/${name}.tsx`, import.meta.url), 'utf8')])));
  for (const base of ['/tropnik/', '/another-project/']) {
    const modules = new Map();
    function load(name) {
      if (modules.has(name)) return modules.get(name);
      const transformed = rewriteScript(sources[name], `${name}.tsx`, {base});
      assert.equal(rewriteScript(transformed, `${name}.tsx`, {base}), transformed);
      const compiled = ts.transpileModule(transformed, {compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
      }}).outputText;
      const exports = {};
      new Function('require', 'exports', compiled)(specifier => {
        if (specifier === './Brand') return load('Brand');
        if (specifier === './TropnikIcons') return {DownloadSimple: () => null, ShieldCheck: () => null};
        if (specifier === './Footer.module.css') return {__esModule: true, default: {}};
        return require(specifier);
      }, exports);
      modules.set(name, exports);
      return exports;
    }
    const html = renderToStaticMarkup(createElement(load('Footer').Footer));
    const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
    assert.equal(links.find(link => link[2] === 'Карта маршрутов')?.[1], base);
    assert.ok(links.length > 1);
    for (const link of links) assert.ok(link[1] === base.slice(0,-1) || link[1].startsWith(base), `Footer link escapes ${base}: ${link[1]}`);
  }
});

test('search and account actions stay inside the published project for links and imperative navigation',()=>{
  const base='/tropnik/';
  for(const path of ['/search','/search?q=Байкал','/account/action#token=test','/planner','/planner?route=osm-relation-4509476']) assert.equal(pagesPath(path,base),base+path.slice(1));
  const source='const a=<a href="/search">Поиск</a>; window.location.assign("/search"); const b=`/search?q=${query}`; const planner=<a href={`/planner?route=${routeId}`}>Собрать поход</a>; const storageKey="tropnik-hike-plans-v1", storageEvent="tropnik-hike-plans-change";';
  const transformed=rewriteScript(source,'Header.tsx',{base});
  assert.ok(transformed.includes('href="/tropnik/search"'));
  assert.ok(transformed.includes('assign("/tropnik/search")'));
  assert.ok(transformed.includes('`/tropnik/search?q=${query}`'));
  assert.ok(transformed.includes('`/tropnik/planner?route=${routeId}`'));
  assert.ok(transformed.includes('"tropnik-tropnik-hike-plans-v1"'));
  assert.ok(transformed.includes('"tropnik-tropnik-hike-plans-change"'));
  assert.equal(rewriteHTML('<a href="/search">Поиск</a>',base),'<a href="/tropnik/search">Поиск</a>');
  assert.equal(pagesPath('https://example.org/search',base),'https://example.org/search');
});

test('the real Android download uses its manifest checksum and retains the Pages base exactly once', () => {
  for (const manifest of [androidManifest, arm64Manifest, universalManifest]) {
    validateApkManifest(manifest);
    const path = `/downloads/${apkFileName(manifest)}`;
    const original = androidPageDownload(androidSource, manifest);
    assert.deepEqual(original, {path, downloadHref: `${path}?sha256=${manifest.sha256}`});
    for (const base of ['/tropnik/', '/another-project/']) {
      const transformed = rewriteScript(androidSource, 'android/page.tsx', {base});
      assert.deepEqual(androidPageDownload(transformed, manifest, {base}), {
        path, downloadHref: `${base}${path.slice(1)}?sha256=${manifest.sha256}`,
      });
      assert.equal(rewriteScript(transformed, 'android/page.tsx', {base}), transformed);
    }
  }
});

test('the rendered Android page selects the advertised file and compatibility from the same manifest', () => {
  const require = createRequire(new URL('../../../web/package.json', import.meta.url));
  const {createElement} = require('react');
  const {renderToStaticMarkup} = require('react-dom/server');
  for (const manifest of [arm64Manifest, universalManifest]) for (const base of ['/tropnik/', '/another-project/']) {
    const transformed = rewriteScript(androidSource, 'android/page.tsx', {base});
    const compiled = ts.transpileModule(transformed, {compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    }}).outputText;
    const exports = {};
    new Function('require', 'exports', compiled)(specifier => {
      if (specifier === '@/public/downloads/android-manifest.json') return {__esModule: true, default: manifest};
      if (specifier === '@/components/Header') return {Header: () => null};
      if (specifier === '@/components/Footer') return {Footer: () => null};
      if (specifier === '@/components/TropnikIcons') return {Mountains: () => null, ArrowDown: () => null, MapTrifold: () => null, ShieldCheck: () => null};
      return require(specifier);
    }, exports);
    const html = renderToStaticMarkup(createElement(exports.default));
    const anchors = [...html.matchAll(/<a\b[^>]*\bdownload(?:="[^"]*")?[^>]*>/g)];
    assert.equal(anchors.length, 1);
    const href = anchors[0][0].match(/\bhref="([^"]+)"/)[1];
    assert.equal(href, androidPageDownload(transformed, manifest, {base}).downloadHref);
    assert.equal(html.includes('ARM 32 бит или x86_64'), manifest.architecture === 'universal');
    assert.match(html, /Android 8\.0 или новее/);
    assert.match(html, /Этот файл не подходит для обновления ранее установленного Тропника/);
  }
});

test('a static Android snapshot references only its selected verified APK', () => {
  for (const manifest of [arm64Manifest, universalManifest]) for (const base of ['/tropnik/', '/another-project/']) {
    const transformed = rewriteScript(androidSource, 'android/page.tsx', {base});
    const pinned = pinAndroidPageDownload(transformed, manifest, {base});
    assert.deepEqual(androidPageDownload(pinned, manifest, {base}), androidPageDownload(transformed, manifest, {base}));
    assert.equal(pinAndroidPageDownload(pinned, manifest, {base}), pinned);
    const inactiveFile = manifest.architecture === 'universal' ? 'tropnik-arm64-preview.apk' : 'tropnik-preview.apk';
    assert.ok(!pinned.includes(inactiveFile), 'The bundle must not reference an absent inactive APK');
    assert.ok(pinned.includes(`href="${base}downloads/${apkFileName(manifest)}?sha256=${manifest.sha256}"`));
  }
});

test('the Android page gate rejects a wrong payload, missing cache key, dynamic override or second download', () => {
  const badPages = [
    androidSource.replace('tropnik-arm64-preview.apk?', 'unverified.apk?'),
    androidSource.replace('tropnik-preview.apk?', 'unverified.apk?'),
    androidSource.replace("androidBuild.architecture === 'universal'", "androidBuild.architecture === 'arm64-v8a'"),
    androidSource.replace("androidBuild.architecture === 'universal'", "other.architecture === 'universal'"),
    androidSource.replace("androidBuild.architecture === 'universal'", "androidBuild.architecture == 'universal'"),
    androidSource.replace('?sha256=${androidBuild.sha256}', ''),
    androidSource.replace('androidBuild.sha256}', 'androidBuild.version}'),
    androidSource.replace('androidBuild.sha256}', 'other.sha256}'),
    androidSource.replace('sha256=${androidBuild.sha256}', `sha256=${'0'.repeat(64)}`),
    androidSource.replace(' download>', ' {...props} download>'),
    androidSource.replace(' download>', '>'),
    androidSource + '<a href="/downloads/other.apk" download>Other</a>',
  ];
  for (const page of badPages) {
    assert.notEqual(page, androidSource, 'The invalid page fixture must change the source');
    for (const manifest of [arm64Manifest, universalManifest]) {
      assert.throws(() => androidPageDownload(page, manifest), /Android download|Android page/);
      assert.throws(() => pinAndroidPageDownload(page, manifest), /Android download|Android page/);
    }
  }
});
