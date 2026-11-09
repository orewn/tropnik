import assert from 'node:assert/strict';
import {readFile, readdir, access, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {rewriteScript, rewriteJSON, rewriteHTML, pagesPath, ts} from './paths.mjs';

const out = resolve(process.argv[2]);
const report = JSON.parse(await readFile(join(out, 'build-info.json')));
const pages = JSON.parse(await readFile(join(out, 'page-manifest.json')));
const base = report.base;
const namespace = base.slice(1, -1);
const exists = async path => access(path).then(() => true, () => false);
assert.equal(report.apiConnected, false);
assert.equal(report.serverCodeIncluded, false);
assert.equal(report.fakeServerResponses, false);
assert.equal(report.hasApk, true, 'The public Pages build must include its advertised Android download');
assert.ok(report.bundledModules.includes('pages-preview/src/api.ts'));
assert.ok(report.bundledModules.includes('components/Explore.tsx'));
assert.ok(report.bundledModules.includes('components/Header.tsx'));
assert.ok(report.bundledModules.includes('components/Footer.tsx'));
assert.ok(report.bundledModules.includes('app/safety/registration/page.tsx'), 'The published safety page must have an executable page loader');
assert.ok(report.bundledModules.includes('components/SafetyRegistration.tsx'), 'The public safety form must be present in the browser bundle');
assert.ok(report.bundledModules.includes('app/planner/page.tsx'), 'The published hike planner must have an executable page loader');
assert.ok(report.bundledModules.includes('components/HikePlanner.tsx'), 'The hike planner must be present in the browser bundle');
assert.ok(report.bundledModules.includes('lib/trail-connections.ts'), 'The planner must use the real topology and route calculation');

// Catch the dangerous blanket replacement of slash separators and external URLs.
const sample = `const separator='/';const chunks=x.split('/');const absolute=x.startsWith('/');const data='/data/a.json';const outside='https://tiles.example/a';const historyTest=window.location.pathname==='/';history.replaceState(null,'','/');const logical='/'+pathname.slice(base.length);const route=\`/routes/\${id}\`;const el=<a href="/"/>;`;
const rewritten = rewriteScript(sample, 'check.tsx', {base});
assert.ok(rewritten.includes("x.split('/')"));
assert.ok(rewritten.includes("x.startsWith('/')"));
assert.ok(rewritten.includes(`const data='${base}data/a.json'`));
assert.ok(rewritten.includes(`pathname==='${base}'`));
assert.ok(rewritten.includes(`href="${base}"`));
assert.ok(rewritten.includes("const logical='/'+pathname.slice(base.length)"), 'Internal route normalization must not receive a second base prefix');
assert.ok(rewritten.includes('https://tiles.example/a'));
assert.equal(pagesPath(base + 'data/a.json', base), base + 'data/a.json');
assert.deepEqual(rewriteJSON({glyphs:'/offline-map/fonts/{fontstack}/{range}.pbf'}, base), {glyphs:base+'offline-map/fonts/{fontstack}/{range}.pbf'});
assert.equal(rewriteHTML('<a href="/offline-viewer.html">', base), `<a href="${base}offline-viewer.html">`);
assert.equal(rewriteScript("import {canvasStyle} from '/maps/canvas-style.js';", 'offline.js', {base}), `import {canvasStyle} from '${base}maps/canvas-style.js';`);
assert.equal(rewriteScript("const fonts='/offline-fonts.css';", 'sw.js', {base}), `const fonts='${base}offline-fonts.css';`);

// Execute the compiled router with its actual baked catalogue. HTTP 200 alone cannot prove routing.
const viteManifest = JSON.parse(await readFile(join(out, '.vite/manifest.json'), 'utf8'));
const router = Object.values(viteManifest).find(value => value.isEntry && value.src === 'source/pages-preview/src/routing.ts');
assert.ok(router, 'The production browser router entry must be present');
const {resolvePage} = await import(pathToFileURL(join(out, router.file)).href);
let routingChecks = 0;
for (const page of pages) {
  const url = page.path === '/' ? base : base + page.path.slice(1);
  for (const pathname of [url, url.endsWith('/') ? url + 'index.html' : url + '/', url.endsWith('/') ? url : url + '/index.html']) {
    assert.deepEqual(resolvePage(pathname), page, `Production routing mismatch for ${pathname}`);
    routingChecks++;
  }
}
assert.equal(resolvePage(base.slice(0, -1))?.kind, 'home');
for (const missing of ['/', '/outside/', base + 'not-a-real-page/', base + '%invalid']) assert.equal(resolvePage(missing), undefined, `Unknown path ${missing} must not become home`);
assert.equal(pages.filter(page => page.kind === 'route').length, report.referenceRoutes);
assert.equal(pages.filter(page => page.kind === 'region').length, report.regions);

// Exercise the real transformed production policy, including the new map preload boundary.
const policyEntry = Object.values(viteManifest).find(value => value.isEntry && value.src === 'source/lib/map-transport.ts');
assert.ok(policyEntry, 'Production map policy entry is required');
const {publicMapResourceKey} = await import(pathToFileURL(join(out, policyEntry.file)).href);
let mapPolicyChecks = 0;
for (const path of ['data/russia-display-area.geojson', 'data/russia-canonical-mask.geojson', 'maps/tropa-style.json', 'terrain/terrain-grid.json?v=current']) {
  assert.equal(publicMapResourceKey(base + path, report.origin), base + path); mapPolicyChecks++;
  assert.equal(publicMapResourceKey(report.origin + base + path, report.origin), base + path); mapPolicyChecks++;
}
for (const path of ['/data/russia-display-area.geojson', '/api/me', base + 'api/me', base + 'terrain/private%2fdata', '//example.org/terrain/x', 'https://untrusted.example/terrain/x']) {
  assert.equal(publicMapResourceKey(path, report.origin), null); mapPolicyChecks++;
}
const apiEntry = Object.values(viteManifest).find(value => value.isEntry && value.src === 'source/pages-preview/src/api.ts');
assert.ok(apiEntry, 'Production static API policy entry is required');
const staticApi = await import(pathToFileURL(join(out, apiEntry.file)).href);
const originalFetch = globalThis.fetch;
let attemptedNetwork = 0;
try {
  globalThis.fetch = async () => {attemptedNetwork++; throw new Error('Static API must not contact a server');};
  assert.equal(await staticApi.serviceStatus(), false);
  await assert.rejects(staticApi.api('/auth/login', {method:'POST'}), error => error.status === 503 && error.code === 'static_preview');
  await assert.rejects(staticApi.api('/me'), error => error.status === 503 && error.code === 'static_preview');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(staticApi.serviceStatus(controller.signal), {name:'AbortError'});
  assert.equal(attemptedNetwork, 0);
} finally {globalThis.fetch = originalFetch;}

for (const page of pages) {
  const name = page.path === '/' ? 'index.html' : page.path.slice(1) + '/index.html';
  const html = await readFile(join(out, name), 'utf8');
  assert.ok(!/<title>[^<]*(?:· тест|\bpreview\b)/i.test(html), `${name} must use a public-facing page title`);
  assert.ok(html.includes('noindex,nofollow'), `${name} must be noindex`);
  assert.ok(html.includes(`${base}assets/`), `${name} bundle path must have base`);
  for (const match of html.matchAll(/(?:href|src)=["'](\/[^"']*)["']/g)) assert.ok(match[1].startsWith(base), `${name}: root URL ${match[1]}`);
}
for (const path of ['data/world.geojson', 'data/regions.geojson', 'data/territories.geojson', 'data/russia-display-area.geojson', 'data/russia-outside-mask.geojson', 'data/russia-canonical-mask.geojson', 'data/russia-boundaries-provenance.json', 'maps/russia-viewport.js', 'maps/tropnik-sprite.png', 'maps/tropnik-sprite@2x.json', 'maps/maplibre-worker.js', 'terrain/terrain-grid.json', 'terrain/terrain-preview.json', 'offline-viewer.html', 'offline.js', 'offline-fonts.css', 'sw.js', '404.html', '.nojekyll']) assert.ok(await exists(join(out, path)), `Missing ${path}`);
for (const css of ['globals.css', 'tropnik-system.css', 'gotham.css', 'terrain.css', 'map-design.css', 'place-stories.css']) {
  assert.ok(report.layoutStyles.includes('./' + css), `Current layout style omitted: ${css}`);
  assert.ok(report.bundledModules.includes('app/' + css), `Current layout style not bundled: ${css}`);
}
assert.ok((await readdir(join(out, 'assets'))).some(name => /^terrain-preparation\.worker-[\w-]+\.js$/.test(name)), 'The real terrain preparation worker must be emitted');
const coverageBytes = await readFile(join(out, 'data/russia-boundaries-provenance.json'));
const coverage = JSON.parse(coverageBytes);
const coverageInput = report.inputs.find(input => input.path === 'web/public/data/russia-boundaries-provenance.json');
assert.equal(createHash('sha256').update(coverageBytes).digest('hex'), coverageInput?.sha256, 'Pinned coverage provenance must remain byte identical');
for (const id of coverage.excludedCatalogRouteIds) {
  assert.equal(resolvePage(base + 'routes/' + id), undefined, `Outside-coverage route ${id} must not get a public page`);
  assert.equal(await exists(join(out, 'routes', id, 'index.html')), false, `Outside-coverage route ${id} must not get a static file`);
}
for (const [name, asset] of Object.entries(coverage.assets)) {
  const data = await readFile(join(out, 'data', name));
  assert.equal(createHash('sha256').update(data).digest('hex'), asset.sha256, `Pinned RF geometry ${name}`);
}
if (report.hasApk) {
  const apk = await readFile(join(out, report.apk.path.slice(1)));
  const metadata = JSON.parse(await readFile(join(out, 'downloads/android-manifest.json')));
  assert.equal(apk.length, metadata.bytes);
  assert.equal(createHash('sha256').update(apk).digest('hex'), metadata.sha256);
  assert.equal(metadata.sha256, report.apk.sha256);
  assert.equal(report.apk.downloadHref, `${report.apk.path}?sha256=${metadata.sha256}`);
  assert.equal(metadata.russiaCoverageProvenanceSha256, coverageInput.sha256);
  assert.equal(report.apk.architecture, metadata.architecture);
}
const world = JSON.parse(await readFile(join(out, 'data/world.geojson')));
assert.ok(world.features.length > 100);
const terrain = JSON.parse(await readFile(join(out, 'terrain/terrain-grid.json')));
assert.equal(terrain.elevations.length, terrain.width * terrain.height);
const style = JSON.parse(await readFile(join(out, 'maps/pilot-style.json')));
assert.ok(style.glyphs.startsWith(base));
assert.ok(style.sources.openmaptiles.tiles.every(url => url.startsWith(base)));
const manifest = JSON.parse(await readFile(join(out, 'manifest.webmanifest')));
assert.equal(manifest.scope, base); assert.equal(manifest.start_url, base); assert.equal(manifest.id, base);
const sw = await readFile(join(out, 'sw.js'), 'utf8');
assert.ok(sw.includes(`${namespace}-tropnik-shell-${report.buildId}`));
assert.ok(sw.includes(`${namespace}-tropnik-map-`));
assert.ok(sw.includes(`${base}_offline/verified-map`));
assert.ok(sw.includes(`${base}assets/`));
const offline = await readFile(join(out, 'offline.js'), 'utf8');
assert.ok(offline.includes(`${namespace}-tropa-local-v1`));
assert.ok(offline.includes(`${base}maps/maplibre-gl.mjs`));
assert.ok(offline.includes(`${base}maps/canvas-style.js`));

// Public pack checksums remain valid because package bytes were never rewritten.
const pack = JSON.parse(await readFile(join(out, 'offline-map/manifest.json')));
let verified = 0;
for (const file of pack.files) {
  const data = await readFile(join(out, 'offline-map', file.path));
  assert.equal(data.length, file.bytes, file.path);
  assert.equal(createHash('sha256').update(data).digest('hex'), file.sha256, file.path);
  verified++;
}
const relief = JSON.parse(await readFile(join(out, 'maps/russia-relief/manifest.json')));
assert.equal(relief.complete, true);
assert.equal(relief.terrainElevationData, false);
assert.equal(relief.navigationReady, false);
assert.equal(relief.minzoom, 0);
assert.equal(relief.maxzoom, 4);
assert.equal(relief.files.length, 341);
assert.equal(relief.mask.sha256, coverage.assets['russia-canonical-area.geojson'].sha256);
assert.equal(relief.tileTemplate, base + 'maps/russia-relief/{z}/{x}/{y}.png');
const reliefPaths = new Set(relief.files.map(file => file.path));
for (let z = 0; z <= 4; z++) for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) assert.ok(reliefPaths.has(`${z}/${x}/${y}.png`), 'Complete local overview pyramid required');
for (const file of relief.files) {
  const bytes = await readFile(join(out, 'maps/russia-relief', file.path));
  assert.equal(bytes.length, file.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.readUInt32BE(16), 256);
  assert.equal(bytes.readUInt32BE(20), 256);
}
async function walk(path) {
  const result = [];
  for (const entry of await readdir(path, {withFileTypes:true})) {
    const name = join(path, entry.name);
    if (entry.isDirectory()) result.push(...await walk(name)); else result.push(name);
  }
  return result;
}
const outputFiles = await walk(out);
assert.ok(outputFiles.every(path => !/\.(?:tsx?|py|sql|sqlite|env)$/.test(path)), 'Only deployable public files may be published');
assert.ok(outputFiles.every(path => !/\/(?:backend|api)\//.test(path)), 'No backend directory in output');

// Inspect the deployed code's URL literals, not a second implementation of the app.
// Internal router keys are intentionally unprefixed; source provenance and the
// cryptographically pinned offline pack describe their own original resource root.
const rootAsset = /^\/(?:data|maps|terrain|offline-map|fonts|downloads|assets)(?:\/|$)|^\/offline(?:-fonts|-viewer)?\.(?:html|js|css)$/;
const deployedUrls = new Set();
let checkedScripts = 0;
// Rolldown can compact a literal URL array into `a,b`.split(`,`). Inspect
// the resulting values rather than mistaking the whole packed string for a URL.
function literalValues(node) {
  const member = node.parent, call = member?.parent;
  if (member && ts.isPropertyAccessExpression(member) && member.expression === node
    && member.name.text === 'split' && call && ts.isCallExpression(call)
    && call.expression === member && call.arguments.length === 1) {
    const separator = call.arguments[0];
    if ((ts.isStringLiteral(separator) || ts.isNoSubstitutionTemplateLiteral(separator)) && separator.text) {
      return node.text.split(separator.text);
    }
  }
  return [node.text];
}
for (const path of outputFiles) {
  const name = path.slice(out.length + 1);
  if (name.startsWith('offline-map/') || /(?:^|\/)(?:maplibre|leaflet|protomaps-leaflet)[^/]*\.[cm]?js$/.test(name)) continue;
  if (!/\.[cm]?js$/.test(name)) continue;
  const code = await readFile(path, 'utf8');
  const source = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)) {
      for (const value of literalValues(node)) {
        assert.ok(!rootAsset.test(value), `Unprefixed public asset in ${name}: ${value}`);
        if (value.startsWith(base)) deployedUrls.add(value);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source); checkedScripts++;
}
let publicAssetChecks = 0;
for (const value of deployedUrls) {
  const relativePath = value.slice(base.length).split(/[?#]/)[0];
  if (!/^(?:data|maps|terrain|offline-map|fonts|downloads|assets)\//.test(relativePath) || /[{}]/.test(relativePath)) continue;
  // A template head can end within a filename, such as icon-${size}.png.
  if (!relativePath.endsWith('/') && !/\.[a-z0-9]+$/i.test(relativePath) && !relativePath.endsWith('tropnik-sprite')) continue;
  const present = await exists(join(out, relativePath)) || relativePath.endsWith('tropnik-sprite') && await exists(join(out, relativePath + '.json')) && await exists(join(out, relativePath + '.png'));
  assert.ok(present, `Missing referenced public asset: ${value}`); publicAssetChecks++;
}
for (const path of outputFiles.filter(path => path.endsWith('.html'))) {
  assert.match(await readFile(path, 'utf8'), /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i, `HTML must be noindex: ${path}`);
}
const verification = {verified:true, pages:pages.length, referenceRoutes:report.referenceRoutes, productionRoutingChecks:routingChecks + 5, mapPolicyChecks, staticApiNetworkCalls:attemptedNetwork, checkedScripts, publicAssetChecks, outputFiles:outputFiles.length, offlineFilesVerified:verified, overviewReliefTilesVerified:relief.files.length, terrainGrid:[terrain.width, terrain.height], apkVerified:report.hasApk, coverageExcludedRoutes:coverage.excludedCatalogRouteIds, base};
await writeFile(join(out, 'verification.json'), JSON.stringify(verification, null, 2) + '\n');
console.log(JSON.stringify(verification, null, 2));
