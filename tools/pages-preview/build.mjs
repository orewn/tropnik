import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname, join, resolve, relative, extname, isAbsolute} from 'node:path';
import {mkdir, readFile, writeFile, readdir, rm, access} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {normalizeBase, rewriteScript, rewriteJSON, rewriteHTML, rewriteCSS, ts} from './paths.mjs';
import {APK_FILE, ensureApk, readApkManifest, verifyApk} from './apk-artifact.mjs';
import {androidPageDownload} from './apk-page.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const web = join(project, 'web');
const require = createRequire(join(web, 'package.json'));
const {build: viteBuild} = await import(require.resolve('vite'));
const {default: react} = await import(require.resolve('@vitejs/plugin-react'));
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const base = normalizeBase(option('--base', '/tropnik/'));
const origin = option('--origin', 'http://localhost:4173');
const parsedOrigin = new URL(origin);
if (!['https:', 'http:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== origin || parsedOrigin.username || parsedOrigin.password) throw new Error('--origin must contain only the scheme and host.');
const out = resolve(option('--out', join(web, 'pages-preview/dist')));
const stage = join(web, 'pages-preview/.stage');
if (out === web || out === project || out === stage || !out.includes('pages-preview')) throw new Error('Output must be an isolated pages-preview directory.');
const source = join(stage, 'source');
const publicDir = join(stage, 'public');
const inputs = [];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = async path => access(path).then(() => true, () => false);
const textExtensions = new Set(['.json', '.webmanifest', '.html', '.css', '.js', '.mjs']);
const vendorScripts = /\/maps\/(?:maplibre|leaflet|protomaps-leaflet)/;

const connectionsCheck = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/build-trail-connections.mjs', '--check'], {cwd: web, stdio: 'inherit'});
if (connectionsCheck.error) throw connectionsCheck.error;
if (connectionsCheck.status !== 0) throw new Error('The trail connection index must match the current catalogue and geometry before publishing.');

// A successful release must include the download advertised on the Android page.
// Fetching is a separate explicit preparation step; the build never uses the network.
const androidMetadata = await readApkManifest(join(web, 'public/downloads/android-manifest.json'));
await ensureApk(join(web, 'public/downloads', APK_FILE), androidMetadata, {download: false});
const sourceCommit = process.env.GITHUB_SHA || null;
if (sourceCommit !== null && !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('GITHUB_SHA must be a full source commit.');

async function files(root) {
  const result = [];
  for (const entry of (await readdir(root, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

async function snapshot(from, to) {
  const bytes = await readFile(from);
  await mkdir(dirname(to), {recursive: true});
  await writeFile(to, bytes);
  inputs.push({path: relative(project, from), bytes: bytes.length, sha256: sha(bytes)});
}

const infoPages = {
  about: 'О проекте', safety: 'Подготовка к походу', 'safety/registration': 'Регистрация похода в МЧС', sources: 'Источники и лицензии',
  privacy: 'Конфиденциальность', terms: 'Условия', offline: 'Карты с собой',
  trips: 'Походы и группы', community: 'Сообщество', guides: 'Гидам и инструкторам', planner: 'Конструктор похода',
  account: 'Личный кабинет', 'account/action': 'Действие с аккаунтом', search: 'Поиск', moderation: 'Модерация', android: 'Тропник для Android',
};
// Inherit the current site's cascade. This preview does not maintain a second visual system.
const layoutPath = join(web, 'app/layout.tsx');
const layoutBytes = await readFile(layoutPath);
const layoutSource = ts.createSourceFile(layoutPath, layoutBytes.toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const layoutStyles = layoutSource.statements.filter(node => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.endsWith('.css')).map(node => node.moduleSpecifier.text);
if (!layoutStyles.length) throw new Error('The site layout has no CSS imports to inherit.');
inputs.push({path: relative(project, layoutPath), bytes: layoutBytes.length, sha256: sha(layoutBytes)});
await rm(stage, {recursive: true, force: true});
await mkdir(stage, {recursive: true});
for (const folder of ['components', 'lib']) {
  for (const path of await files(join(web, folder))) {
    if (folder === 'lib' && ['api.ts', 'server.ts'].includes(path.slice(path.lastIndexOf('/') + 1))) continue;
    if (!/\.(?:[cm]?[jt]sx?|json|css)$/.test(path)) continue;
    await snapshot(path, join(source, relative(web, path)));
  }
}
for (const path of ['page.tsx', 'not-found.tsx', 'regions/[id]/page.tsx', 'routes/[id]/page.tsx', ...layoutStyles.filter(path => path.startsWith('./')).map(path => path.slice(2)), ...Object.keys(infoPages).map(name => `${name}/page.tsx`)]) {
  await snapshot(join(web, 'app', path), join(source, 'app', path));
}
for (const path of await files(join(web, 'pages-preview/src'))) await snapshot(path, join(source, 'pages-preview/src', relative(join(web, 'pages-preview/src'), path)));
for (const path of await files(join(web, 'public'))) {
  const name = relative(join(web, 'public'), path);
  if (/(?:\.map|\.d\.ts|\.original\.txt)$/.test(name)) continue;
  await snapshot(path, join(source, 'public', name));
}
for (const name of ['web/package.json', 'web/pnpm-lock.yaml', ...(await files(join(project, 'tools/pages-preview'))).map(path => relative(project, path))]) {
  const path = join(project, name);
  if (await exists(path)) {const bytes = await readFile(path); inputs.push({path: name, bytes: bytes.length, sha256: sha(bytes)});}
}
inputs.sort((a, b) => a.path.localeCompare(b.path));
const buildId = sha(JSON.stringify({base, origin, inputs})).slice(0, 16);

// Read the actual catalogue, including the pinned geographic exclusions. Resolve JSON
// imports from the snapshot; fail on an unexpected runtime dependency instead of guessing.
let catalogueCode = await readFile(join(source, 'lib/content.ts'), 'utf8');
const catalogueSource = ts.createSourceFile('content.ts', catalogueCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const jsonEdits = [];
for (const node of catalogueSource.statements) {
  if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) continue;
  const specifier = node.moduleSpecifier.text;
  if (!specifier.endsWith('.json') || !node.importClause?.name || node.importClause.namedBindings) throw new Error(`Unsupported catalogue runtime import: ${specifier}`);
  const path = specifier.startsWith('@/') ? resolve(source, specifier.slice(2)) : resolve(source, 'lib', specifier);
  if (!path.startsWith(source + '/') || !isAbsolute(path)) throw new Error('Catalogue import escaped the source snapshot.');
  const data = JSON.parse(await readFile(path, 'utf8'));
  jsonEdits.push([node.getStart(catalogueSource), node.end, `const ${node.importClause.name.text} = ${JSON.stringify(data)};`]);
}
for (const [start, end, replacement] of jsonEdits.sort((a, b) => b[0] - a[0])) catalogueCode = catalogueCode.slice(0, start) + replacement + catalogueCode.slice(end);
const compiled = ts.transpileModule(catalogueCode, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}}).outputText;
const {regions, trails} = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const pages = [
  {path: '/', title: 'Карта маршрутов России', kind: 'home'},
  ...Object.entries(infoPages).map(([kind, title]) => ({path: '/' + kind, title, kind})),
  {path: '/preview', title: 'Возможности Тропника', kind: 'preview'},
  ...regions.map(region => ({path: '/regions/' + encodeURIComponent(region.id), title: region.name, kind: 'region', id: region.id})),
  ...trails.map(trail => ({path: '/routes/' + encodeURIComponent(trail.id), title: trail.title, kind: 'route', id: trail.id})),
];
if (new Set(pages.map(page => page.path)).size !== pages.length) throw new Error('Duplicate catalogue page path.');
const apkManifestPath = join(source, 'public/downloads/android-manifest.json');
const metadata = await readApkManifest(apkManifestPath);
const androidPage = await readFile(join(source, 'app/android/page.tsx'), 'utf8');
const androidDownload = androidPageDownload(androidPage, metadata);
const verifiedApk = await verifyApk(join(source, 'public', androidDownload.path.slice(1)), metadata);
const apk = {...androidDownload, ...verifiedApk, architecture: metadata.architecture, signature: metadata.signature, deviceExecutionVerified: metadata.deviceExecutionVerified === true};
const config = {id: buildId, base, origin, hasApk: true, pages};

// The archived offline pack is copied byte-for-byte. Only its separate application style gets a base path.
for (const path of await files(join(source, 'public'))) {
  const name = relative(join(source, 'public'), path);
  const target = join(publicDir, name);
  let bytes = await readFile(path);
  // The Android manifest pins this original provenance file. Its declared root URLs
  // describe the source dataset; GeoJSON bytes and source hashes stay unchanged.
  const immutable = name.startsWith('offline-map/') || name === 'data/russia-boundaries-provenance.json';
  if (!immutable && textExtensions.has(extname(name))) {
    let value = bytes.toString('utf8');
    if (/\.(?:json|webmanifest)$/.test(name)) value = JSON.stringify(rewriteJSON(JSON.parse(value), base), null, 2) + '\n';
    else if (name.endsWith('.html')) value = rewriteHTML(value, base);
    else if (name.endsWith('.css')) value = rewriteCSS(value, base);
    else if (!vendorScripts.test('/' + name)) value = rewriteScript(value, name, {base});
    if (name === 'sw.js') value = value.replace(/const VERSION\s*=\s*['"][^'"]+['"]/, `const VERSION='${base.slice(1, -1)}-tropnik-shell-${buildId}'`);
    bytes = Buffer.from(value);
  }
  await mkdir(dirname(target), {recursive: true});
  await writeFile(target, bytes);
}
const manifestPath = join(publicDir, 'manifest.webmanifest');
const pwa = JSON.parse(await readFile(manifestPath, 'utf8'));
pwa.name = 'Тропник'; pwa.short_name = 'Тропник';
await writeFile(manifestPath, JSON.stringify(pwa, null, 2) + '\n');
await writeFile(join(publicDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
await writeFile(join(publicDir, '.nojekyll'), '');
await writeFile(join(stage, 'entry.tsx'), "import './source/pages-preview/src/main.tsx';\n");
await writeFile(join(stage, 'index.html'), `<!doctype html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#244d3c"><meta name="robots" content="noindex,nofollow"><meta name="description" content="Карта маршрутов по России. Выбирайте направление и сохраняйте тропы для своего путешествия."><title>Тропник</title><link rel="icon" href="${base}favicon.svg"><link rel="manifest" href="${base}manifest.webmanifest"></head><body><div id="root"><main class="pages-preview-boot"><h1>Тропник</h1><p>Открываем карту маршрутов…</p></main></div><noscript>Чтобы открыть карту, разрешите выполнение сценариев в настройках браузера. <a href="${base}offline-viewer.html">Автономная карта</a> доступна после включения сценариев.</noscript><script type="module" src="/entry.tsx"></script></body></html>`);

const boundary = {
  [join(source, 'lib/api')]: join(source, 'pages-preview/src/api.ts'),
  [join(source, 'lib/server')]: join(source, 'pages-preview/src/server-data.ts'),
};
let bundledModules = [], dependencyModules = [];
const integration = {
  name: 'tropnik-pages-boundary', enforce: 'pre',
  resolveId(id, importer) {
    if (id === 'virtual:pages-build') return '\0virtual:pages-build';
    if (id === 'virtual:pages-layout-styles') return '\0virtual:pages-layout-styles';
    if (id === 'next/navigation') return join(source, 'pages-preview/src/navigation.ts');
    let target = id.startsWith('@/') ? join(source, id.slice(2)) : id.startsWith('.') && importer ? resolve(dirname(importer), id) : id;
    target = target.replace(/\.(?:ts|tsx|js|mjs)$/, '');
    if (boundary[target]) return boundary[target];
    if (/next\/(?:server|headers|cache)|\/app\/api\/|\/backend\//.test(target)) throw new Error(`Server code is forbidden in the Pages graph: ${target}`);
    return null;
  },
  load(id) {
    if (id === '\0virtual:pages-build') return `export default ${JSON.stringify(config)};`;
    if (id === '\0virtual:pages-layout-styles') return layoutStyles.map(path => `import ${JSON.stringify(path.startsWith('./') ? join(source, 'app', path.slice(2)) : path)};`).join('\n');
  },
  transform(code, id) {
    const path = id.split('?')[0];
    if (!path.startsWith(source + '/') || vendorScripts.test(path)) return null;
    // These adapters already use build.base. Their internal route keys are not public URLs.
    if (path.startsWith(join(source, 'pages-preview/src') + '/')) return null;
    if (/\.[cm]?[jt]sx?$/.test(path)) return {code: rewriteScript(code, path, {base}), map: null};
    if (path.endsWith('.json')) return {code: JSON.stringify(rewriteJSON(JSON.parse(code), base)), map: null};
    return null;
  },
  generateBundle() {
    const modules = [...this.getModuleIds()];
    bundledModules = modules.filter(id => id.startsWith(source)).map(id => relative(source, id)).sort();
    dependencyModules = modules.filter(id => id.startsWith('/') && id.includes('/node_modules/'));
    const forbidden = bundledModules.filter(id => /^(?:lib\/(?:api|server)\.ts|app\/api\/)|(?:^|\/)backend\//.test(id));
    if (forbidden.length) throw new Error(`Production API/server modules leaked into Pages graph: ${forbidden.join(', ')}`);
  },
};
await viteBuild({
  configFile: false, root: stage, base, publicDir,
  plugins: [integration, react()],
  resolve: {alias: {'@': source}},
  define: {'process.env.NEXT_PUBLIC_SITE_URL': JSON.stringify(origin + base.slice(0, -1)), 'process.env.TROPA_PUBLIC_INDEXING': JSON.stringify('false')},
  build: {
    outDir: out, emptyOutDir: true, sourcemap: false, manifest: true, chunkSizeWarningLimit: 1200,
    // Keep the actual browser router as an importable production entry, not a second test implementation.
    rolldownOptions: {input: {index: join(stage, 'index.html'), routing: join(source, 'pages-preview/src/routing.ts'), 'map-policy': join(source, 'lib/map-transport.ts'), 'api-policy': join(source, 'pages-preview/src/api.ts')}, preserveEntrySignatures: 'strict'},
  },
});

const html = await readFile(join(out, 'index.html'), 'utf8');
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
for (const page of pages) {
  const target = page.path === '/' ? join(out, 'index.html') : join(out, page.path.slice(1), 'index.html');
  await mkdir(dirname(target), {recursive: true});
  await writeFile(target, html.replace(/<title>[^<]*<\/title>/, `<title>${escape(page.title)} · Тропник</title>`));
}
await writeFile(join(out, '404.html'), html.replace(/<title>[^<]*<\/title>/, '<title>Страница не найдена · Тропник</title>'));
const packageRoots = new Set(dependencyModules.map(id => {
  const marker = '/node_modules/', index = id.lastIndexOf(marker), parts = id.slice(index + marker.length).split('/');
  return id.slice(0, index + marker.length) + parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join('/');
}));
const thirdParty = [];
for (const root of [...packageRoots].sort()) {
  if (!await exists(join(root, 'package.json'))) continue;
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const licenses = [];
  for (const entry of await readdir(root, {withFileTypes: true})) {
    if (!entry.isFile() || !/^(?:licen[cs]e|ofl|copyright)(?:[.-]|$)/i.test(entry.name)) continue;
    const name = `licenses/${metadata.name.replace(/[@/]/g, '_')}-${metadata.version}/${entry.name}`;
    await mkdir(dirname(join(out, name)), {recursive:true});
    await writeFile(join(out, name), await readFile(join(root, entry.name)));
    licenses.push(name);
  }
  thirdParty.push({name: metadata.name, version: metadata.version, license: metadata.license || 'See package notice', notices: licenses});
}
await writeFile(join(out, 'THIRD_PARTY_NOTICES.txt'), 'Tropnik static preview: browser dependencies\n\n' + thirdParty.map(item => `${item.name} ${item.version}\nLicense: ${JSON.stringify(item.license)}\n${item.notices.join('\n') || 'License notice is retained in the distributed bundle.'}\n`).join('\n'));
const report = {
  schemaVersion: 1, buildId, sourceCommit, base, origin, renderer: 'Existing public terrain module from the input snapshot',
  apiConnected: false, serverCodeIncluded: false, fakeServerResponses: false, pages: pages.length,
  regions: regions.length, referenceRoutes: trails.length, hasApk: config.hasApk, apk, layoutStyles,
  storageNamespace: base.slice(1, -1), immutableOfflinePack: true, inputs, bundledModules, thirdParty,
};
await writeFile(join(out, 'build-info.json'), JSON.stringify(report, null, 2) + '\n');
await writeFile(join(out, 'page-manifest.json'), JSON.stringify(pages, null, 2) + '\n');
const verification = spawnSync(process.execPath, [join(project, 'tools/pages-preview/verify.mjs'), out], {stdio: 'inherit'});
if (verification.status !== 0) throw new Error('Static output verification failed.');
const httpVerification = spawnSync(process.execPath, [join(project, 'tools/pages-preview/verify-http.mjs'), out], {stdio: 'inherit'});
if (httpVerification.status !== 0) throw new Error('Static HTTP verification failed.');
const zip = resolve(dirname(out), `${base.slice(1, -1)}.zip`);
const archive = spawnSync('python3', [join(project, 'tools/pages-preview/archive.py'), out, zip], {stdio: 'inherit'});
if (archive.status !== 0) throw new Error('Static archive creation failed.');
await rm(stage, {recursive: true, force: true});
console.log(JSON.stringify({buildId, output: out, archive: zip, base, pages: pages.length, referenceRoutes: trails.length}, null, 2));
