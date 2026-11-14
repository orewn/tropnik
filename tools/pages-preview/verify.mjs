import assert from 'node:assert/strict';
import {assertPageSeo, assertSitemap} from './seo-verification.mjs';
import {readFile, readdir, access, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {rewriteScript, rewriteJSON, rewriteHTML, rewriteCSS, pagesPath, ts} from './paths.mjs';
import {apkFileName, validateApkDelivery, validateApkManifest, verifyApk} from './apk-artifact.mjs';
import {assertCatalogueExpectations} from './catalogue-expectations.mjs';
import {verifyCustomMap} from '../../web/scripts/verify-custom-map.mjs';
import {customMapWebRecords,customMapShellRecords,readCustomMapShellResources,legacyMapRuntime} from './custom-map-assets.mjs';
import {withNodeModulePreloads} from './node-module-preloads.mjs';

const out = resolve(process.argv[2]);
const report = JSON.parse(await readFile(join(out, 'build-info.json')));
const pages = JSON.parse(await readFile(join(out, 'page-manifest.json')));
const base = report.base;
const namespace = base.slice(1, -1);
const web = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const customMap = await verifyCustomMap({webRoot:web});
const customMapFiles = customMapWebRecords(customMap);
const {deployedFiles:deployedCustomMapFiles,...customMapProvenance} = report.customMap || {};
assert.deepEqual(customMapProvenance,customMap,'The deployed map must describe the current verified shared renderer');
assert.ok(Array.isArray(deployedCustomMapFiles)&&deployedCustomMapFiles.length===customMapFiles.length);
for(const [index,file]of customMapFiles.entries()){
 const name=file.path,original=await readFile(join(web,'public/custom-map',name));
 let expected=original;
 if(name!=='manifest.json'){
  if(/\.[cm]?js$/.test(name))expected=Buffer.from(rewriteScript(original.toString('utf8'),name,{base}));
  else if(name.endsWith('.css'))expected=Buffer.from(rewriteCSS(original.toString('utf8'),base));
  else if(name.endsWith('.json'))expected=Buffer.from(JSON.stringify(rewriteJSON(JSON.parse(original),base),null,2)+'\n');
 }
 const bytes=await readFile(join(out,'custom-map',name));
 assert.deepEqual(bytes,expected,`Shared map output differs from the verified source and Pages transform: ${name}`);
 assert.deepEqual(deployedCustomMapFiles[index],{path:name,sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
 const input=report.inputs.find(input=>input.path==='web/public/custom-map/'+name);
 assert.equal(input?.sha256,file.sha256);assert.equal(input?.bytes,file.sizeBytes);
}
const exists = async path => access(path).then(() => true, () => false);
assert.equal(report.apiConnected, false);
assert.equal(report.serverCodeIncluded, false);
assert.equal(report.fakeServerResponses, false);
assert.equal(report.hasApk, true, 'The public Pages build must retain its verified Android download');
assert.ok(report.bundledModules.includes('pages-preview/src/api.ts'));
assert.ok(report.bundledModules.includes('components/Explore.tsx'));
assert.ok(report.bundledModules.includes('components/CustomAtlas.tsx'));
assert.ok(report.bundledModules.includes('lib/custom-map-engine.ts'));
assert.ok(report.bundledModules.includes('lib/custom-map-vector.ts'));
assert.ok(report.thirdParty.every(item=>!['maplibre-gl','mapbox-gl','leaflet','protomaps-leaflet','pmtiles'].includes(item.name)),'The map must not bundle a third-party rendering engine');
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
assert.equal(rewriteScript("import {CustomMapEngine} from '/custom-map/map-runtime.js';", 'offline.js', {base}), `import {CustomMapEngine} from '${base}custom-map/map-runtime.js';`);
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
    const {path, title, kind, id} = page;
    assert.deepEqual(resolvePage(pathname), {path, title, kind, ...(id ? {id} : {})}, `Production routing mismatch for ${pathname}`);
    routingChecks++;
  }
}
assert.equal(resolvePage(base.slice(0, -1))?.kind, 'home');
for (const missing of ['/', '/outside/', base + 'not-a-real-page/', base + '%invalid']) assert.equal(resolvePage(missing), undefined, `Unknown path ${missing} must not become home`);
assert.equal(pages.filter(page => page.kind === 'route').length, report.referenceRoutes);
assert.equal(pages.filter(page => page.kind === 'region').length, report.regions);
const catalogue = assertCatalogueExpectations(report.catalogue);
assert.equal(catalogue.total, report.referenceRoutes, 'Source catalogue count must match the emitted route inventory');
assert.equal(catalogue.directions.length, report.regions);
assert.deepEqual(new Set(catalogue.directions.map(region => region.id)),
  new Set(pages.filter(page => page.kind === 'region').map(page => page.id)),
  'Browser count expectations must describe exactly the emitted directions');

// Exercise the real transformed production policy, including the new map preload boundary.
const policyEntry = Object.values(viteManifest).find(value => value.isEntry && value.src === 'source/lib/map-transport.ts');
assert.ok(policyEntry, 'Production map policy entry is required');
const {publicMapResourceKey} = await import(pathToFileURL(join(out, policyEntry.file)).href);
let mapPolicyChecks = 0;
for (const path of ['data/russia-display-area.geojson', 'data/russia-canonical-mask.geojson', 'maps/russia-relief/manifest.json', 'terrain/terrain-grid.json?v=current', 'terrain-regions/manifest.json', 'terrain-regions/south-sakhalin-v1/terrain-grid.json', 'terrain-regions/south-sakhalin-v1/surface.png']) {
  assert.equal(publicMapResourceKey(base + path, report.origin), base + path); mapPolicyChecks++;
  assert.equal(publicMapResourceKey(report.origin + base + path, report.origin), base + path); mapPolicyChecks++;
}
for (const path of ['/data/russia-display-area.geojson', '/terrain-regions/manifest.json', '/api/me', base + 'api/me', base + 'terrain/private%2fdata', base + 'terrain-regions/private%2fdata', base + 'terrain-regions/../api/me', base + 'terrain-regions-private/secret.json', '//example.org/terrain/x', 'https://untrusted.example/terrain/x', 'https://untrusted.example/terrain-regions/manifest.json']) {
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
  assertPageSeo(html, page, report);
  assert.ok(html.includes(`${base}assets/`), `${name} bundle path must have base`);
  for (const match of html.matchAll(/(?:href|src)=["'](\/[^"']*)["']/g)) assert.ok(match[1].startsWith(base), `${name}: root URL ${match[1]}`);
}
for (const path of ['data/world.geojson', 'data/regions.geojson', 'data/territories.geojson', 'data/russia-display-area.geojson', 'data/russia-outside-mask.geojson', 'data/russia-canonical-mask.geojson', 'data/russia-boundaries-provenance.json', 'maps/russia-viewport.js', 'custom-map/map-runtime.js', 'custom-map/manifest.json', 'terrain/terrain-grid.json', 'terrain/terrain-preview.json', 'offline-viewer.html', 'offline-safety.html', 'offline-safety.js', 'offline-safety.css', 'offline.js', 'offline-fonts.css', 'sw.js', '404.html', '.nojekyll']) assert.ok(await exists(join(out, path)), `Missing ${path}`);
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
  const metadata = validateApkManifest(JSON.parse(await readFile(join(out, 'downloads/android-manifest.json'))));
  validateApkDelivery(report.apk, metadata);
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const verified = await verifyApk(join(project, 'web/public/downloads', apkFileName(metadata)), metadata);
  assert.equal(verified.sha256, report.apk.sha256);
  assert.equal(verified.bytes, report.apk.bytes);
  const input = report.inputs.find(input => input.path === `web/public${report.apk.sourcePath}`);
  assert.equal(input?.sha256, verified.sha256, 'The release APK remains a verified build input');
  assert.equal(input?.bytes, verified.bytes);
  assert.equal(metadata.russiaCoverageProvenanceSha256, coverageInput.sha256);
}
const world = JSON.parse(await readFile(join(out, 'data/world.geojson')));
assert.ok(world.features.length > 100);
const terrain = JSON.parse(await readFile(join(out, 'terrain/terrain-grid.json')));
assert.equal(terrain.elevations.length, terrain.width * terrain.height);
// Regional manifests contain hashes of original source bytes, including JSON.
// Neither formatting nor logical resource URLs may change during publication.
const regionalRoot=join(web,'public/terrain-regions'),regionalFiles=await walk(regionalRoot);
assert.ok(regionalFiles.length>0,'The measured regional terrain package is missing');
for(const originalPath of regionalFiles){
 const name=originalPath.slice(regionalRoot.length+1),original=await readFile(originalPath),deployed=await readFile(join(out,'terrain-regions',name));
 assert.deepEqual(deployed,original,`Regional source bytes changed during Pages publication: ${name}`);
 const input=report.inputs.find(input=>input.path==='web/public/terrain-regions/'+name);
 assert.equal(input?.bytes,original.length,`Regional build input size differs: ${name}`);
 assert.equal(input?.sha256,createHash('sha256').update(original).digest('hex'),`Regional build input checksum differs: ${name}`);
}
const regionalEntry=Object.values(viteManifest).find(value=>value.isEntry&&value.src==='source/lib/terrain-region-sources.ts');
assert.ok(regionalEntry,'The actual production regional reader must be importable for verification');
const {createTerrainRegionReader,parseTerrainRegions}=await import(pathToFileURL(join(out,regionalEntry.file)).href);
const regionalManifest=JSON.parse(await readFile(join(out,'terrain-regions/manifest.json'),'utf8')),regions=parseTerrainRegions(regionalManifest),regionalFetches=[];
assert.ok(regions.length>0,'The public regional manifest must contain measured terrain');
const readRegionalURL=async url=>{
 assert.ok(url.startsWith(base+'terrain-regions/'),`Regional runtime fetch escaped the Pages base: ${url}`);
 assert.equal(publicMapResourceKey(url,report.origin),url,'Regional runtime fetch must cross the real public map policy');regionalFetches.push(url);
 return readFile(join(out,url.slice(base.length)));
};
const regionalReader=createTerrainRegionReader({loadJSON:async url=>JSON.parse(await readRegionalURL(url)),loadBytes:async url=>{const bytes=await readRegionalURL(url);return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);}});
await withNodeModulePreloads(base,async()=>{
 for(const region of regions){
  assert.ok(await regionalReader.find(region.bounds),`Production reader cannot discover ${region.id}`);
  const grid=await regionalReader.grid(region),material=await regionalReader.material(region);
  assert.deepEqual(grid.bounds,region.bounds);assert.equal(material.byteLength,region.materialBytes);
 }
});
assert.deepEqual(regionalFetches,[base+'terrain-regions/manifest.json',...regions.flatMap(region=>[base+region.gridUrl.slice(1),base+region.materialUrl.slice(1)])],'The real deployed reader must resolve immutable logical URLs exactly once');
const manifest = JSON.parse(await readFile(join(out, 'manifest.webmanifest')));
assert.equal(manifest.scope, base); assert.equal(manifest.start_url, base); assert.equal(manifest.id, base);
const sw = await readFile(join(out, 'sw.js'), 'utf8');
assert.ok(sw.includes(`${namespace}-tropnik-shell-${report.buildId}`));
assert.ok(sw.includes(`${namespace}-tropnik-map-`));
assert.ok(sw.includes(`${base}_offline/verified-map`));
assert.ok(sw.includes(`${base}assets/`));
assert.deepEqual(readCustomMapShellResources(sw),customMapShellRecords(deployedCustomMapFiles,base),'The offline shell must pin the actual deployed custom-map bytes');
const offline = await readFile(join(out, 'offline.js'), 'utf8');
assert.ok(offline.includes(`${namespace}-tropa-local-v1`));
assert.ok(offline.includes(`${base}custom-map/map-runtime.js`));
assert.ok(!/maps\/(?:maplibre|leaflet|protomaps)/.test(offline));

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
assert.deepEqual(outputFiles.filter(path=>path.startsWith(join(out,'terrain-regions')+'/')).map(path=>path.slice(join(out,'terrain-regions').length+1)).sort(),regionalFiles.map(path=>path.slice(regionalRoot.length+1)).sort(),'Regional publication must preserve the exact source package inventory');
assert.deepEqual(outputFiles.filter(path=>path.startsWith(join(out,'custom-map')+'/')).map(path=>path.slice(join(out,'custom-map').length+1)).sort(),customMapFiles.map(file=>file.path).sort(),'The public map output must contain exactly the verified common runtime');
assert.ok(outputFiles.every(path=>!legacyMapRuntime.test(path.slice(out.length+1))),'A retired vendor map runtime remains in the deployable files');
assert.ok(outputFiles.every(path => !/\.apk$/i.test(path)), 'Pages must link the verified release without publishing any APK binary');
assert.ok(outputFiles.every(path => !/\.(?:tsx?|py|sql|sqlite|env)$/.test(path)), 'Only deployable public files may be published');
assert.ok(outputFiles.every(path => !/\/(?:backend|api)\//.test(path)), 'No backend directory in output');

// Inspect the deployed code's URL literals, not a second implementation of the app.
// Internal router keys are intentionally unprefixed; source provenance and the
// cryptographically pinned offline pack describe their own original resource root.
const rootAsset = /^\/(?:data|maps|custom-map|terrain|terrain-regions|offline-map|fonts|downloads|assets)(?:\/|$)|^\/offline(?:-fonts|-viewer)?\.(?:html|js|css)$/;
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
  if (name.startsWith('offline-map/')) continue;
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
  if (!/^(?:data|maps|custom-map|terrain|terrain-regions|offline-map|fonts|downloads|assets)\//.test(relativePath) || /[{}]/.test(relativePath)) continue;
  // A template head can end within a filename, such as icon-${size}.png.
  if (!relativePath.endsWith('/') && !/\.[a-z0-9]+$/i.test(relativePath)) continue;
  const present = await exists(join(out, relativePath));
  assert.ok(present, `Missing referenced public asset: ${value}`); publicAssetChecks++;
}
const seoFiles = new Set(pages.map(page => join(out, page.path === '/' ? 'index.html' : page.path.slice(1) + '/index.html')));
for (const path of outputFiles.filter(path => path.endsWith('.html') && !seoFiles.has(path))) {
  assert.match(await readFile(path, 'utf8'), /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i, `Utility HTML must remain noindex: ${path}`);
}
const sitemapPages = assertSitemap(await readFile(join(out, 'sitemap.xml'), 'utf8'), pages, report);
const verification = {verified:true, seo:{verified:true,sitemapPages,indexingEnabled:report.indexing.enabled}, pages:pages.length, referenceRoutes:report.referenceRoutes, productionRoutingChecks:routingChecks + 5, mapPolicyChecks, staticApiNetworkCalls:attemptedNetwork, checkedScripts, publicAssetChecks, outputFiles:outputFiles.length, offlineFilesVerified:verified, customMap:{runtime:customMap.runtime,sourceInputsSha256:customMap.sourceInputsSha256,manifestSha256:customMap.manifestSha256,deployedFilesVerified:deployedCustomMapFiles.length,workerCount:customMap.workerCount}, overviewReliefTilesVerified:relief.files.length, terrainGrid:[terrain.width, terrain.height], regionalTerrain:{regions:regions.length,filesVerified:regionalFiles.length,runtimeFetches:regionalFetches}, apkVerified:report.hasApk, coverageExcludedRoutes:coverage.excludedCatalogRouteIds, base};
await writeFile(join(out, 'verification.json'), JSON.stringify(verification, null, 2) + '\n');
console.log(JSON.stringify(verification, null, 2));
