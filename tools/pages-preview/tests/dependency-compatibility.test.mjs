import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp, readFile, readdir, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath, pathToFileURL} from 'node:url';
import test, {mock} from 'node:test';

const web = fileURLToPath(new URL('../../../web/', import.meta.url));
const require = createRequire(join(web, 'package.json'));

test('the patched real Vinext image renderer streams a PNG with project fonts under Node ESM', {timeout: 20000}, async () => {
  const shim = join(await realpath(join(web, 'node_modules/vinext')), 'dist/shims/og.js');
  const og = createRequire(shim).resolve('@vercel/og');
  const bundle = await readFile(og, 'utf8');
  // A declaration-only Satori override would leave the vulnerable bundled code.
  assert.match(bundle, /satori@0\.33\.5\//);
  assert.doesNotMatch(bundle, /satori@0\.16\.0\//);
  const {ImageResponse} = await import(pathToFileURL(shim));
  const {createElement} = require('react');
  const fonts = await Promise.all(['cyrillic', 'latin'].map(async subset => ({
    name: subset === 'cyrillic' ? 'ManropeCyrillic' : 'ManropeLatin', weight: 400, style: 'normal',
    data: await readFile(require.resolve(`@fontsource/manrope/files/manrope-${subset}-400-normal.woff`)),
  })));
  const outbound = [];
  const localFetch = globalThis.fetch.bind(globalThis);
  const fetch = mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    // Yoga uses a bundled data URI; decoding it does not access the network.
    if (url.protocol === 'data:') return localFetch(input, init);
    outbound.push(url.origin);
    throw new Error('The compatibility renderer must use only packaged fonts and WASM');
  });
  try {
    const response = new ImageResponse(createElement('div', {style: {
      display: 'flex', width: '100%', height: '100%', fontFamily: 'ManropeCyrillic, ManropeLatin',
      fontSize: 24, color: '#111', background: '#fff',
    }}, 'Тропник < & > Hiking'), {width: 320, height: 160, fonts,
      headers: {'X-Tropnik-Compatibility': 'checked'}});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('X-Tropnik-Compatibility'), 'checked');
    const png = Buffer.from(await response.arrayBuffer());
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [320, 160]);
    assert.ok(png.length > 500);
    assert.deepEqual(outbound, [], 'Rendering must not silently fetch a fallback font');
  } finally { fetch.mock.restore(); }
});

test('Wrangler resolves the patched compiler and builds typed input with its real API', {timeout: 15000}, async () => {
  const wrangler = await realpath(join(web, 'node_modules/wrangler'));
  const compiler = createRequire(join(wrangler, 'package.json'))('esbuild');
  assert.equal(compiler.version, '0.28.1');
  const output = await compiler.build({stdin: {contents: 'export const answer: number = 42;', loader: 'ts'},
    bundle: true, minify: true, write: false, format: 'esm', platform: 'browser', target: 'es2022'});
  assert.equal(output.outputFiles.length, 1);
  const built = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].contents).toString('base64'));
  assert.equal(built.answer, 42);
});

test('the declared Drizzle module still generates its opt-in schema using the patched loader', {timeout: 20000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tropnik-drizzle-compatibility-'));
  try {
    const drizzle = await realpath(join(web, 'node_modules/drizzle-kit'));
    const metadata = JSON.parse(await readFile(join(drizzle, 'package.json'), 'utf8'));
    const result = await promisify(execFile)(process.execPath, [join(drizzle, metadata.bin['drizzle-kit']),
      'generate', '--dialect', 'sqlite', '--schema', './examples/d1/db/schema.ts', '--out', directory],
    {cwd: web, timeout: 15000, maxBuffer: 1024 * 1024});
    assert.match(result.stdout, /1 tables/);
    const sql = (await readdir(directory)).filter(name => name.endsWith('.sql'));
    assert.equal(sql.length, 1);
    assert.match(await readFile(join(directory, sql[0]), 'utf8'), /CREATE TABLE [`"]?notes[`"]?/);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
