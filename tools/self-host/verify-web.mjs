// Run after TROPA_STANDALONE=true pnpm --dir web build:next.
// Local use: node tools/self-host/verify-web.mjs --http-only
// The complete browser gate runs only in GitHub Actions; it never mocks an API.
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {access, cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchBrowser, browserErrorDetails} from '../pages-preview/browser-startup.mjs';
import {browserEnvironmentArgs, collectBrowserEnvironment} from '../pages-preview/browser-environment.mjs';
import {inspectCustomMapDOM, assertCustomMapInspection} from '../pages-preview/browser-custom-map.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = join(ROOT, 'web');
const SITE = 'https://xn--h1akbedl4b5a.xn--p1ai';
const args = process.argv.slice(2), httpOnly = args.includes('--http-only');
const outputIndex = args.indexOf('--artifacts');
assert.ok(args.every((arg, index) => arg === '--http-only' || arg === '--artifacts' || index === outputIndex + 1 && outputIndex >= 0), 'Unknown verification argument');
assert.ok(outputIndex < 0 || args[outputIndex + 1] && !args[outputIndex + 1].startsWith('--'), '--artifacts needs a directory');
const OUTPUT = outputIndex < 0 ? join(WEB, '.next/self-host-verification') : resolve(args[outputIndex + 1]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = {schemaVersion: 1, scope: 'Next standalone web without API or database', sourceCommit: process.env.GITHUB_SHA || null,
  siteOrigin: SITE, startedAt: new Date().toISOString(), verified: false, httpVerified: false, browserVerified: false,
  http: {}, browser: {pageErrors: [], consoleErrors: [], localAssetErrors: [], expectedDisconnectedAPI: [], workers: [], frames: {}}};

async function port() {
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const value = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return value;
}

async function get(origin, path, status = 200) {
  const response = await fetch(new URL(path, origin), {signal: AbortSignal.timeout(10000), cache: 'no-store'});
  assert.equal(new URL(response.url).origin, origin, `Unexpected redirect: ${path}`);
  assert.equal(response.status, status, `${path}: HTTP ${response.status}`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; assert.ok(size <= 8 * 1024 * 1024, `${path}: oversized response`); chunks.push(chunk); }
  return {text: Buffer.concat(chunks).toString('utf8'), bytes: size, type: response.headers.get('content-type') || '', status, url: response.url};
}

const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(match => [match[1].toLowerCase(), match[2] ?? match[3]]));
const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map(match => attributes(match[0]));
function publicURL(value) {
  assert.ok(typeof value === 'string' && /^[\x21-\x7e]+$/.test(value), 'Public URLs must use the ASCII domain');
  const url = new URL(value);
  assert.equal(url.origin, SITE); assert.equal(url.username + url.password + url.search + url.hash, '');
  assert.ok(!url.pathname.startsWith('/tropnik/'), 'Pages base path leaked into the self-host build');
  return value;
}

async function verifyHTTP(origin) {
  let home;
  report.http.pages = [];
  for (const path of ['/', '/routes/', '/about/']) {
    const page = await get(origin, path); assert.match(page.type, /^text\/html/);
    const meta = tags(page.text, 'meta'), canonical = tags(page.text, 'link').filter(tag => tag.rel === 'canonical');
    assert.equal(canonical.length, 1, `${path}: one canonical is required`);
    assert.equal(publicURL(canonical[0].href), SITE + path);
    const robots = meta.find(tag => tag.name === 'robots')?.content;
    assert.ok(robots?.split(/,\s*/).includes('index') && !robots.includes('noindex'), `${path}: public indexing is disabled`);
    assert.equal(publicURL(meta.find(tag => tag.property === 'og:url')?.content), SITE + path);
    assert.ok(meta.find(tag => tag.name === 'description')?.content?.length > 30, `${path}: description is missing`);
    const title = page.text.match(/<title>([^<]+)<\/title>/)?.[1]; assert.match(title || '', /Тропиныч/iu);
    report.http.pages.push({path, title, canonical: canonical[0].href, robots, bytes: page.bytes});
    if (path === '/') home = page.text;
  }
  const robots = await get(origin, '/robots.txt');
  assert.match(robots.text, /^Allow: \/\r?$/m); assert.match(robots.text, /^Disallow: \/api\/\r?$/m);
  assert.ok(robots.text.split(/\r?\n/).includes(`Sitemap: ${SITE}/sitemap.xml`));
  assert.ok(!robots.text.includes('/tropnik/')); report.http.robots = robots.text;
  const sitemap = await get(origin, '/sitemap.xml'); assert.match(sitemap.type, /xml/);
  const locations = [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => publicURL(match[1]));
  assert.ok(locations.length > 3); assert.equal(new Set(locations).size, locations.length);
  for (const path of ['/', '/routes/', '/about/']) assert.ok(locations.includes(SITE + path), `Sitemap lacks ${path}`);
  report.http.sitemap = {locations: locations.length, origin: SITE, bytes: sitemap.bytes};
  const status = await get(origin, '/api/status'); assert.match(status.type, /^application\/json/);
  const body = JSON.parse(status.text);
  assert.equal(body.configured, false); assert.equal(body.connected, false); assert.equal(body.mode, 'preview');
  report.http.apiStatus = body;
  for (const [name, path] of [['accountStatus', '/api/backend/me'], ['routesStatus', '/api/backend/routes/?limit=100']]) {
    const unavailable = await get(origin, path, 503); assert.match(unavailable.type, /^application\/json/);
    assert.equal(JSON.parse(unavailable.text).error?.code, 'service_not_configured');
    report.http[name] = {method: 'GET', path, status: 503, code: 'service_not_configured'};
  }
  const assets = [tags(home, 'script').find(tag => tag.src?.startsWith('/_next/static/'))?.src,
    tags(home, 'link').find(tag => tag.rel === 'stylesheet' && tag.href?.startsWith('/_next/static/'))?.href, '/favicon.svg'];
  report.http.assets = [];
  for (const path of assets) { assert.ok(path, 'Root Next static asset is missing'); const asset = await get(origin, path); assert.ok(asset.bytes > 0); report.http.assets.push({path, bytes: asset.bytes, type: asset.type}); }
  report.httpVerified = true;
}

class CDP {
  constructor(url) { this.url = url; this.next = 1; this.pending = new Map(); this.observers = new Map(); }
  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 10000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once: true});
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, {once: true});
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) { const job = this.pending.get(message.id); if (!job) return; this.pending.delete(message.id); clearTimeout(job.timer); message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result); return; }
      for (const callback of this.observers.get(message.method) || []) callback(message.params, message.sessionId);
    });
  }
  call(method, params = {}, sessionId) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 10000);
      this.pending.set(id, {resolve, reject, timer}); this.socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
    });
  }
  observe(method, callback) { const list = this.observers.get(method) || []; list.push(callback); this.observers.set(method, list); }
  close() { for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(new Error('CDP closed')); } this.pending.clear(); this.socket?.close(); }
}
async function evaluate(cdp, expression, sessionId) {
  const reply = await cdp.call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}, sessionId);
  assert.ok(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails)); return reply.result.value;
}
async function waitFor(label, read, accept, timeout = 30000) {
  const deadline = performance.now() + timeout; let last;
  while (performance.now() < deadline) { last = await read(); if (accept(last)) return last; await pause(100); }
  throw Object.assign(new Error(`${label} did not complete in ${timeout} ms`), {lastValue: last});
}
async function click(cdp, selector) {
  const point = await evaluate(cdp, `(() => {const node=document.querySelector(${JSON.stringify(selector)}),r=node?.getBoundingClientRect();return r&&r.width>0&&r.height>0?{x:r.left+r.width/2,y:r.top+r.height/2}:null;})()`);
  assert.ok(point, `Visible control missing: ${selector}`);
  await cdp.call('Input.dispatchMouseEvent', {type: 'mouseMoved', ...point});
  await cdp.call('Input.dispatchMouseEvent', {type: 'mousePressed', ...point, button: 'left', clickCount: 1});
  await cdp.call('Input.dispatchMouseEvent', {type: 'mouseReleased', ...point, button: 'left', clickCount: 1});
}
const settled = map => map?.state.ready && !map.state.loading && !map.state.error && map.coverage?.ready &&
  map.catalogueOverlay.currentViewportReady && !map.catalogueOverlay.pending && !map.catalogueOverlay.error;

function disconnectedRead(request, response, origin) {
  if (request?.method !== 'GET' || response.status !== 503 || request.url !== response.url) return false;
  const url = new URL(response.url), path = url.pathname.replace(/\/$/, '');
  if (url.origin !== origin) return false;
  // Next's trailing-slash redirect preserves these two exact read operations.
  return path === '/api/backend/me' && url.search === '' || path === '/api/backend/routes' && url.search === '?limit=100';
}

async function verifyBrowser(origin) {
  // CI browser gate; --http-only supports local verification.
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run --http-only locally; Chromium is restricted to GitHub Actions');
  const binary = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find(name => spawnSync('which', [name], {stdio: 'ignore'}).status === 0);
  assert.ok(binary, 'Chromium is unavailable');
  const debugPort = await port(), profile = await mkdtemp(join(tmpdir(), 'tropinych-self-host-'));
  const browser = launchBrowser(binary, browserEnvironmentArgs({debugPort, userDataDir: profile}));
  const result = report.browser, workers = new Map(), tasks = new Set(), requests = new Map(), apiBodies = new Map(); let cdp;
  const record = (list, value) => { if (list.length < 256) list.push(value); else result.failureOverflow = true; };
  try {
    const version = await browser.waitUntilReady(`http://127.0.0.1:${debugPort}/json/version`);
    result.environment = await collectBrowserEnvironment(version.webSocketDebuggerUrl, {sourceCommit: report.sourceCommit});
    const target = await browser.requestJSON(`http://127.0.0.1:${debugPort}/json/new?about:blank`, {method: 'PUT'});
    cdp = new CDP(target.webSocketDebuggerUrl); await cdp.open();
    cdp.observe('Runtime.exceptionThrown', (event, sessionId) => record(result.pageErrors, {sessionId, details: event.exceptionDetails}));
    cdp.observe('Runtime.consoleAPICalled', (event, sessionId) => { if (event.type === 'error') record(result.consoleErrors, {sessionId, text: event.args.map(arg => arg.value ?? arg.description).join(' ').slice(0, 4096)}); });
    cdp.observe('Network.requestWillBeSent', (event, sessionId) => requests.set(`${sessionId || ''}:${event.requestId}`, {url: event.request.url, method: event.request.method}));
    cdp.observe('Network.responseReceived', ({response, requestId}, sessionId) => {
      if (!response.url.startsWith(origin + '/') || response.status < 400) return;
      const key = `${sessionId || ''}:${requestId}`, request = requests.get(key);
      const item = {url: response.url, method: request?.method, status: response.status};
      if (disconnectedRead(request, response, origin)) apiBodies.set(key, item);
      else record(result.localAssetErrors, item);
    });
    cdp.observe('Network.loadingFinished', ({requestId}, sessionId) => {
      const key = `${sessionId || ''}:${requestId}`, item = apiBodies.get(key); if (!item) return;
      // Read the actual browser response only after its body finished arriving.
      const task = (async () => {
        const reply = await cdp.call('Network.getResponseBody', {requestId}, sessionId);
        const body = Buffer.from(reply.body, reply.base64Encoded ? 'base64' : 'utf8');
        assert.ok(body.length <= 4096, 'Oversized disconnected API response');
        const code = JSON.parse(body.toString('utf8')).error?.code;
        assert.equal(code, 'service_not_configured');
        record(result.expectedDisconnectedAPI, {...item, code, bodyVerified: true});
      })().catch(error => record(result.localAssetErrors, {...item, error: error.message})).finally(() => apiBodies.delete(key));
      tasks.add(task); void task.finally(() => tasks.delete(task));
    });
    cdp.observe('Network.loadingFailed', (event, sessionId) => {
      const key = `${sessionId || ''}:${event.requestId}`, url = requests.get(key)?.url || '';
      const missingAPIBody = apiBodies.delete(key);
      if (url.startsWith(origin + '/') && (!event.canceled || missingAPIBody)) record(result.localAssetErrors, {url, error: event.errorText});
    });
    cdp.observe('Target.attachedToTarget', ({targetInfo, sessionId}) => {
      if (targetInfo.type !== 'worker') return;
      const worker = {sessionId, targetId: targetInfo.targetId, script: targetInfo.url}; workers.set(sessionId, worker); result.workers.push(worker);
      const task = (async () => {
        await cdp.call('Runtime.enable', {}, sessionId);
        Object.assign(worker, await evaluate(cdp, '({name:self.name,url:location.href})', sessionId));
        await cdp.call('Network.enable', {}, sessionId);
      })().catch(error => { worker.observationError = error.message; });
      tasks.add(task); void task.finally(() => tasks.delete(task));
    });
    cdp.observe('Target.detachedFromTarget', ({sessionId}) => { const worker = workers.get(sessionId); if (worker) worker.detached = true; });
    await cdp.call('Page.enable'); await cdp.call('Runtime.enable'); await cdp.call('Network.enable');
    await cdp.call('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: false, flatten: true});
    await cdp.call('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false, screenWidth: 1440, screenHeight: 1000});
    await cdp.call('Page.navigate', {url: origin + '/'});
    const metadata = JSON.parse(await readFile(join(WEB, 'lib/trail-overlay.generated.json'), 'utf8'));
    const readMap = () => evaluate(cdp, `(${inspectCustomMapDOM.toString()})()`);
    const complete = map => settled(map) && map.catalogueOverlay.sources === metadata.uniqueGeometries && map.catalogueOverlay.preparedParts > 0;
    result.frames.country = await waitFor('Hydrated country map and complete trail overlay', readMap, complete);
    assertCustomMapInspection(result.frames.country, 'Standalone country map', {mode: 'overview', routeId: ''});
    assert.ok(result.frames.country.tiles.overview.length > 0, 'Cartography worker produced no map bitmaps');
    await click(cdp, '.layer-button');
    const checkbox = '.layer-menu label:first-of-type input[type="checkbox"]';
    await waitFor('Hydrated layers control', () => evaluate(cdp, `!!document.querySelector(${JSON.stringify(checkbox)})`), Boolean);
    await click(cdp, checkbox);
    result.frames.pathsOff = await waitFor('Paths hidden by native input', readMap, map => settled(map) && map.catalogueOverlay.sources === 0 && map.catalogueOverlay.preparedParts === 0);
    await click(cdp, checkbox);
    result.frames.pathsOn = await waitFor('Paths repainted by native input', readMap, complete);
    assertCustomMapInspection(result.frames.pathsOn, 'Restored standalone map', {mode: 'overview'});
    assert.ok(result.frames.pathsOn.drawRevision > result.frames.country.drawRevision);
    await click(cdp, '.layer-button');
    await Promise.all(tasks);
    for (const name of ['tropnik-cartography', 'tropnik-trail-overlay']) {
      const worker = result.workers.find(item => item.name === name && !item.detached);
      assert.ok(worker, `${name} never became a real running worker`);
      assert.equal(worker.observationError, undefined);
      Object.assign(worker, await evaluate(cdp, '({name:self.name,url:location.href,messageHandlerReady:typeof self.onmessage==="function"})', worker.sessionId));
      assert.equal(worker.messageHandlerReady, true);
      assert.ok(worker.url.startsWith(origin + '/_next/static/'), `${name} is not served from the Next root`);
      const asset = await get(origin, worker.url); assert.match(asset.type, /javascript/); assert.ok(asset.bytes > 0);
      worker.http = {status: asset.status, bytes: asset.bytes, type: asset.type};
    }
    await waitFor('Disconnected API response bodies', () => apiBodies.size, count => count === 0, 10000);
    assert.deepEqual(result.pageErrors, []); assert.deepEqual(result.consoleErrors, []); assert.deepEqual(result.localAssetErrors, []);
    assert.ok(!result.failureOverflow, 'Too many browser failures');
    assert.deepEqual(result.frames.pathsOn.resources.errors, []);
    const shot = await cdp.call('Page.captureScreenshot', {format: 'png'});
    await writeFile(join(OUTPUT, 'map.png'), Buffer.from(shot.data, 'base64'));
    report.browserVerified = true;
  } catch (error) {
    if (cdp) { try { const shot = await cdp.call('Page.captureScreenshot', {format: 'png'}); await writeFile(join(OUTPUT, 'failure.png'), Buffer.from(shot.data, 'base64')); } catch {} }
    throw error;
  } finally {
    cdp?.close(); await browser.close(); result.startup = browser.diagnostics();
    await rm(profile, {recursive: true, force: true});
    assert.ok(['stopped', 'not-started'].includes(result.startup.cleanup.status), 'Chromium cleanup did not finish');
  }
}

await mkdir(OUTPUT, {recursive: true});
let server, serverLog, failure;
try {
  let entry;
  for (const candidate of ['server.js', 'web/server.js']) {
    const file = join(WEB, '.next/standalone', candidate); try { await access(file); entry = file; break; } catch {}
  }
  assert.ok(entry, 'Build the real Next standalone artifact before verification');
  report.buildId = (await readFile(join(WEB, '.next/BUILD_ID'), 'utf8')).trim(); assert.ok(report.buildId);
  const directory = dirname(entry);
  await cp(join(WEB, '.next/static'), join(directory, '.next/static'), {recursive: true});
  await cp(join(WEB, 'public'), join(directory, 'public'), {recursive: true});
  const listenerPort = await port(), origin = `http://127.0.0.1:${listenerPort}`;
  const env = {...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', HOSTNAME: '127.0.0.1', PORT: String(listenerPort),
    NEXT_PUBLIC_SITE_URL: SITE, PUBLIC_ORIGIN: SITE, TROPA_PUBLIC_INDEXING: 'true'};
  delete env.TROPA_API_URL; delete env.TROPA_PROXY_TOKEN;
  serverLog = createWriteStream(join(OUTPUT, 'server.log'));
  server = spawn(process.execPath, [entry], {cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe']});
  let startError; server.on('error', error => { startError = error; });
  server.stdout.pipe(serverLog, {end: false}); server.stderr.pipe(serverLog, {end: false});
  await waitFor('Standalone server', async () => {
    if (startError) throw startError;
    assert.equal(server.exitCode, null, 'Standalone server exited during startup');
    try { const response = await fetch(origin + '/api/status/', {signal: AbortSignal.timeout(1000)}); await response.body?.cancel(); return response.ok; } catch { return false; }
  }, Boolean);
  await verifyHTTP(origin);
  if (!httpOnly) await verifyBrowser(origin);
  report.verified = report.httpVerified && report.browserVerified;
  report.status = httpOnly ? 'http-only-completed' : 'completed';
} catch (error) {
  failure = error; report.status = 'failed'; report.error = browserErrorDetails(error);
  if (error.lastValue !== undefined) report.lastValue = error.lastValue;
} finally {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    for (let attempts = 0; attempts < 20 && server.exitCode === null && server.signalCode === null; attempts++) await pause(100);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGKILL');
      for (let attempts = 0; attempts < 10 && server.exitCode === null && server.signalCode === null; attempts++) await pause(100);
    }
  }
  report.serverCleanup = {pid: server?.pid ?? null, stopped: !server?.pid || server.exitCode !== null || server.signalCode !== null,
    exitCode: server?.exitCode ?? null, signalCode: server?.signalCode ?? null};
  if (!report.serverCleanup.stopped) {
    failure ??= new Error('Standalone server cleanup did not finish'); report.status = 'failed'; report.verified = false; report.error = browserErrorDetails(failure);
  }
  if (serverLog) await new Promise(resolve => serverLog.end(resolve));
  report.completedAt = new Date().toISOString();
  await writeFile(join(OUTPUT, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({status: report.status, verified: report.verified, httpVerified: report.httpVerified,
  browserVerified: report.browserVerified, buildId: report.buildId, receipt: join(OUTPUT, 'verification.json')}));
if (failure) { console.error(failure.stack || String(failure)); process.exitCode = 1; }
