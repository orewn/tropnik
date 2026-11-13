import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';

const web = fileURLToPath(new URL('../../../web/', import.meta.url));
const require = createRequire(join(web, 'package.json'));

test('the actual patched OG edge package builds through Vite and renders in workerd without outbound fetches', {timeout: 60000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tropnik-og-worker-compatibility-'));
  let runtime;
  try {
    const vinext = await realpath(join(web, 'node_modules/vinext'));
    const vinextRequire = createRequire(join(vinext, 'package.json'));
    const ogRoot = dirname(vinextRequire.resolve('@vercel/og/package.json'));
    const edge = join(ogRoot, 'dist/index.edge.js');
    const edgeSource = await readFile(edge, 'utf8');
    assert.match(edgeSource, /satori@0\.33\.5\//);
    assert.doesNotMatch(edgeSource, /satori@0\.16\.0\//);

    const {createBuilder} = await import(pathToFileURL(require.resolve('vite')));
    const cloudflareRoot = await realpath(join(web, 'node_modules/@cloudflare/vite-plugin'));
    const cloudflareMetadata = JSON.parse(await readFile(join(cloudflareRoot, 'package.json'), 'utf8'));
    const {cloudflare} = await import(pathToFileURL(join(cloudflareRoot, cloudflareMetadata.exports['.'].import)));
    const {createOgInlineFetchAssetsPlugin, createOgAssetsPlugin} = await import(pathToFileURL(join(vinext, 'dist/plugins/og-assets.js')));
    const {Miniflare} = createRequire(join(await realpath(join(web, 'node_modules/wrangler')), 'package.json'))('miniflare');

    await writeFile(join(directory, 'package.json'), JSON.stringify({
      name: 'tropnik-og-worker-fixture', private: true, type: 'module',
      dependencies: {'@vercel/og': '1.0.3'},
    }));
    await mkdir(join(directory, 'fonts'));
    for (const subset of ['latin', 'cyrillic']) {
      await copyFile(require.resolve(`@fontsource/manrope/files/manrope-${subset}-400-normal.woff`), join(directory, 'fonts', `${subset}.bin`));
    }
    await writeFile(join(directory, 'worker.mjs'), `
import {ImageResponse} from '@vercel/og';
import latin from './fonts/latin.bin';
import cyrillic from './fonts/cyrillic.bin';
export default {
  async fetch() {
    const response = new ImageResponse({type: 'div', props: {
      style: {display: 'flex', width: '100%', height: '100%', fontFamily: 'Manrope Cyrillic, Manrope Latin',
        fontSize: 24, color: '#111', background: '#fff'},
      children: 'Тропник < & > Hiking',
    }}, {width: 320, height: 160,
      fonts: [{name: 'Manrope Latin', data: latin}, {name: 'Manrope Cyrillic', data: cyrillic}]
        .map(font => ({...font, weight: 400, style: 'normal'})),
      headers: {'X-Tropnik-Compatibility': 'checked'},
    });
    // Await the stream inside the request so an initialization failure cannot
    // appear to the test as a successful response with an empty body.
    return new Response(await response.arrayBuffer(), {status: response.status, headers: response.headers});
  },
};
`);

    const builder = await createBuilder({
      configFile: false, root: directory, logLevel: 'silent',
      cacheDir: join(directory, '.vite'),
      resolve: {alias: [{find: '@vercel/og', replacement: edge}]},
      plugins: [createOgInlineFetchAssetsPlugin(), createOgAssetsPlugin(), cloudflare({
        viteEnvironment: {name: 'rsc'}, inspectorPort: false, persistState: false,
        config: {name: 'tropnik-og-worker-fixture', main: join(directory, 'worker.mjs'),
          compatibility_date: '2026-05-15', compatibility_flags: ['nodejs_compat']},
      })],
      build: {outDir: join(directory, 'dist'), emptyOutDir: true},
    });
    await builder.buildApp();

    const outputFiles = await readdir(join(directory, 'dist'), {recursive: true});
    const configFiles = outputFiles.filter(name => name.endsWith('wrangler.json'));
    assert.equal(configFiles.length, 1, 'the isolated build emits one Worker configuration');
    const configPath = join(directory, 'dist', configFiles[0]);
    const configuration = JSON.parse(await readFile(configPath, 'utf8'));
    const workerPath = resolve(dirname(configPath), configuration.main);
    const wasmFiles = outputFiles.filter(name => name.endsWith('.wasm'));
    assert.ok(wasmFiles.some(name => /hb[.-]/.test(name) || name.endsWith('/hb.wasm')), 'the build emits the HarfBuzz WASM dependency');
    assert.ok(wasmFiles.some(name => /resvg/.test(name)), 'the build emits the PNG renderer WASM');
    assert.ok(wasmFiles.some(name => /yoga/.test(name)), 'the build emits the layout WASM');

    const outbound = [];
    runtime = new Miniflare({
      scriptPath: workerPath, modules: true, modulesRoot: dirname(workerPath),
      modulesRules: [{type: 'CompiledWasm', include: ['**/*.wasm'], fallthrough: true},
        {type: 'Data', include: ['**/*.bin'], fallthrough: true}],
      compatibilityDate: configuration.compatibility_date,
      compatibilityFlags: configuration.compatibility_flags,
      port: 0,
      outboundService(request) {
        outbound.push(new URL(request.url).origin);
        return new Response('The compatibility test blocks outbound fetches.', {status: 502});
      },
    });
    const response = await runtime.dispatchFetch('http://og-compatibility.invalid/image');
    const png = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, png.subarray(0, 1024).toString());
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('X-Tropnik-Compatibility'), 'checked');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [320, 160]);
    assert.ok(png.length > 500);
    assert.deepEqual(outbound, [], 'fonts and WASM are provided by the build, without remote fallback');
  } finally {
    try { await runtime?.dispose(); }
    finally { await rm(directory, {recursive: true, force: true}); }
  }
});
