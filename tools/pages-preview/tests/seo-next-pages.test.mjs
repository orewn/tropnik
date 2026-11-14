import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync, existsSync} from 'node:fs';
import {dirname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {rewriteScript, rewriteJSON, ts} from '../paths.mjs';

const web = fileURLToPath(new URL('../../../web/', import.meta.url)).replace(/\/$/, '');
const require = createRequire(resolve(web, 'package.json'));
const {createElement} = require('react');
const {renderToStaticMarkup} = require('react-dom/server');

// Exercise the actual page functions and metadata. Only the interactive map,
// shared chrome and remote data boundary are isolated from this Node renderer.
function application({base = '/tropnik/', publicIndexing = true, staticExport = false, published = []} = {}) {
  const modules = new Map();
  const env = {NEXT_PUBLIC_SITE_URL: 'https://example.org' + base, TROPA_PUBLIC_INDEXING: String(publicIndexing), NEXT_PUBLIC_STATIC_EXPORT: String(staticExport)};
  function load(path) {
    assert.ok(path.startsWith(web + sep));
    if (modules.has(path)) return modules.get(path);
    if (path.endsWith('.json')) return rewriteJSON(JSON.parse(readFileSync(path, 'utf8')), base);
    const code = readFileSync(path, 'utf8');
    const transformed = path === resolve(web, 'lib/seo.ts') ? code : rewriteScript(code, path, {base});
    const compiled = ts.transpileModule(transformed, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true}}).outputText;
    const module = {exports: {}};
    const imports = specifier => {
      if (specifier === '@/lib/server') return {getPublishedTrails: async () => published, getPublishedTrail: async id => published.find(trail => trail.id === id)};
      if (specifier === '@/components/Header' || specifier === './Header') return {Header: () => null};
      if (specifier === '@/components/Footer' || specifier === './Footer') return {Footer: () => null};
      if (specifier === '@/components/Explore') return {Explore: () => createElement('section', {'data-map-boundary': 'preserved'}, createElement('h1', null, 'Карта маршрута'))};
      if (specifier === '@/components/TropnikIcons') return new Proxy({}, {get: () => () => null});
      if (specifier === 'next/navigation') return {notFound() {throw new Error('Page not found');}};
      if (specifier === 'next/link') return {__esModule: true, default: ({prefetch: _prefetch, children, ...props}) => createElement('a', props, children)};
      if (specifier.endsWith('.css')) return {__esModule: true, default: {}};
      if (specifier.startsWith('react')) return require(specifier);
      let target = specifier.startsWith('@/') ? resolve(web, specifier.slice(2)) : resolve(dirname(path), specifier);
      if (!/\.(?:json|tsx?)$/.test(target)) target += existsSync(target + '.ts') ? '.ts' : '.tsx';
      return load(target);
    };
    modules.set(path, module.exports);
    new Function('require', 'module', 'exports', 'process', compiled)(imports, module, module.exports, {env});
    modules.set(path, module.exports);
    return module.exports;
  }
  return {load: path => load(resolve(web, path)), base, origin: env.NEXT_PUBLIC_SITE_URL};
}

test('real Next route metadata indexes useful references and follows published overrides', async () => {
  const app = application(), {trails} = app.load('lib/content.ts'), {isRouteSeoEligible} = app.load('lib/seo.ts');
  const curated = trails.find(trail => isRouteSeoEligible(trail) && trail.regionId.startsWith('territory-'));
  const generic = trails.find(trail => !isRouteSeoEligible(trail));
  assert.ok(curated && generic);
  const page = app.load('app/routes/[id]/page.tsx');
  const meta = await page.generateMetadata({params: Promise.resolve({id: curated.id})});
  assert.equal(curated.publicationStatus, 'reference');
  assert.equal(meta.robots.index, true);
  assert.equal(meta.title.absolute.endsWith('Тропиныч'), true);
  assert.equal(meta.alternates.canonical, app.origin + 'routes/' + curated.id + '/');
  assert.equal((await page.generateMetadata({params: Promise.resolve({id: generic.id})})).robots.index, false);
  const changed = {...curated, id: generic.id, title: 'Обновлённый маршрут по опубликованным сведениям', publicationStatus: 'published'};
  const live = application({published: [changed]});
  const updated = await live.load('app/routes/[id]/page.tsx').generateMetadata({params: Promise.resolve({id: generic.id})});
  assert.equal(updated.title.absolute.startsWith(changed.title), true);
  assert.equal(updated.robots.index, true);
  const privateApp = application({publicIndexing: false});
  assert.equal((await privateApp.load('app/routes/[id]/page.tsx').generateMetadata({params: Promise.resolve({id: curated.id})})).robots.index, false);
});

test('real route and region articles preserve the map heading and valid breadcrumb URLs', async () => {
  for (const staticExport of [false, true]) {
    const app = application({staticExport}), {trails} = app.load('lib/content.ts'), {isRouteSeoEligible} = app.load('lib/seo.ts');
    const route = trails.find(trail => isRouteSeoEligible(trail) && trail.regionId.startsWith('territory-'));
    const html = renderToStaticMarkup(await app.load('app/routes/[id]/page.tsx').default({params: Promise.resolve({id: route.id})}));
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
    assert.match(html, /data-map-boundary="preserved"/);
    assert.ok(html.includes(route.title));
    assert.ok(html.includes('Источники маршрута'));
    assert.ok(!html.includes('/regions/territory-'));
    assert.equal(html.includes('application/ld+json'), !staticExport);
    const region = renderToStaticMarkup(await app.load('app/regions/[id]/page.tsx').default({params: Promise.resolve({id: 'krasnodar'})}));
    assert.equal((region.match(/<h1\b/g) || []).length, 1);
    assert.ok(region.includes('Пешие маршруты: Краснодарский край'));
    assert.ok(region.includes(app.origin + 'routes/'));
  }
});

test('catalogue and home keep crawlable navigation after the real Pages path rewrite', async () => {
  for (const base of ['/tropnik/', '/another-project/']) {
    const app = application({base}), {trails, regions} = app.load('lib/content.ts'), {isRouteSeoEligible} = app.load('lib/seo.ts');
    const html = renderToStaticMarkup(await app.load('app/routes/page.tsx').default());
    const links = [...html.matchAll(/href="([^"#]+\/routes\/([^/]+)\/)"/g)].map(match => match[2]);
    assert.deepEqual(new Set(links), new Set(trails.filter(isRouteSeoEligible).map(trail => trail.id)));
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
    const home = renderToStaticMarkup(createElement(app.load('components/HomeEditorial.tsx').HomeEditorial));
    const directions = [...home.matchAll(/href="([^"]+\/regions\/([^/]+)\/)"/g)];
    assert.equal(directions.length, regions.length);
    assert.ok(directions.every(match => match[1].startsWith(app.origin)));
    assert.ok(home.includes(app.origin + 'routes/'));
  }
});

test('Next sitemap and metadata agree for the same eligible reference catalogue', async () => {
  const app = application(), {trails, regions} = app.load('lib/content.ts');
  const seo = app.load('lib/seo.ts'), context = {siteUrl: app.origin, publicIndexing: true};
  const map = await app.load('app/sitemap.ts').default();
  const expected = [seo.homeSeo(context), seo.catalogueSeo(trails, regions, context), seo.infoSeo('about', 'О проекте', context), ...regions.map(region => seo.regionSeo(region, trails, context)), ...trails.map(trail => seo.routeSeo(trail, regions, context))];
  assert.deepEqual(new Set(map.map(item => item.url)), new Set(expected.filter(item => item.indexable).map(item => item.canonical)));
  assert.ok(map.every(item => !('lastModified' in item)));
  const privateApp = application({publicIndexing: false});
  assert.deepEqual(await privateApp.load('app/sitemap.ts').default(), []);
  assert.equal(app.load('app/about/page.tsx').metadata.robots.index, true);
});
