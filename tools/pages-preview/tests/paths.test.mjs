import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {pagesPath, rewriteScript, rewriteHTML, ts} from '../paths.mjs';
import {androidPageDownload} from '../apk-page.mjs';

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
