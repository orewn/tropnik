import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {packs, savedPackIds, saveReference, deletePack} from '../lib/local.ts';
import {MAP_RESOURCE_LIMITS} from '../lib/map-config.ts';
import {rewriteScript,ts} from '../../tools/pages-preview/paths.mjs';

const trail = {id: 'test-route', title: 'Пробная тропа', regionId: 'karelia', checkedAt: '2026-11-09'};
const geometry = {type: 'LineString', coordinates: [[30, 61], [30.01, 61.01]]};
const checkedUrl='/data/routes/kolyma-black-creek.geojson';
const checkedBytes=await readFile(new URL('../public'+checkedUrl,import.meta.url));
const checkedGeometry=JSON.parse(checkedBytes);
const sourceMetadata=JSON.parse(await readFile(new URL('../lib/trail-overlay.generated.json',import.meta.url),'utf8'));
const versionedCheckedUrl=checkedUrl+'?v='+sourceMetadata.sourceHashes['routes/kolyma-black-creek.geojson'].slice(0,16);

function storage(t, options = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  let opened = 0, closed = 0, ready, transaction;
  const started = new Promise(resolve => {ready = resolve;});
  const database = {
    close() {closed++;},
    transaction(name, mode) {
      assert.equal(name, 'packs');
      if (options.transactionError) throw options.transactionError;
      const request = {result: undefined, error: null};
      const tx = {
        mode, request, error: null, operation: null, value: undefined,
        objectStore(storeName) {
          assert.equal(storeName, 'packs');
          const operation = kind => value => {tx.operation = kind; tx.value = value; if (options.requestError) throw options.requestError; return request;};
          return {getAll: operation('getAll'), getAllKeys: operation('getAllKeys'), put: operation('put'), delete: operation('delete')};
        },
        abort(error = new DOMException('Transaction aborted', 'AbortError')) {tx.error = error; queueMicrotask(() => tx.onabort?.({target: tx}));},
        succeed(value) {request.result = value; request.onsuccess?.({target: request});},
        complete() {tx.oncomplete?.({target: tx});},
        fail(error) {request.error = error; request.onerror?.({target: request}); tx.error = error; tx.onerror?.({target: tx});},
      };
      transaction = tx; ready(tx); return tx;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', {configurable: true, value: {open(name, version) {
    assert.equal(name, options.databaseName??'tropa-local-v1'); assert.equal(version, 1); opened++;
    const request = {result: database}; queueMicrotask(() => request.onsuccess()); return request;
  }}});
  t.after(() => {if (previous) Object.defineProperty(globalThis, 'indexedDB', previous); else delete globalThis.indexedDB;});
  return {started, counts: () => ({opened, closed}), transaction: () => transaction};
}

for (const operation of [
  {name: 'read', run: () => packs(), result: [], kind: 'getAll'},
  {name: 'read IDs', run: () => savedPackIds(), result: [], kind: 'getAllKeys'},
  {name: 'save', run: () => saveReference({...trail, geometry}), result: trail.id, kind: 'put'},
  {name: 'delete', run: () => deletePack(trail.id), result: undefined, kind: 'delete'},
]) test(`${operation.name} waits for transaction commit and rejects a later abort instead of hanging or reporting success`, async t => {
  const env = storage(t), pending = operation.run();
  let settled = false; void pending.then(() => {settled = true;}, () => {settled = true;});
  const tx = await env.started;
  assert.equal(tx.operation, operation.kind);
  tx.succeed(operation.result); await Promise.resolve();
  assert.equal(settled, false, 'request success does not mean transaction commit');
  assert.equal(env.counts().closed, 0);
  tx.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(env.counts().closed, 1);
});

test('successful commits close the database and keep the existing saved-card format with inline geometry', async t => {
  const env = storage(t);
  t.mock.method(globalThis, 'fetch', () => {throw new Error('Inline geometry must not download a second source');});
  const pending = saveReference({...trail, geometry, geometryUrl: '/unused.geojson'}), tx = await env.started;
  assert.equal(tx.mode, 'readwrite');
  assert.deepEqual(tx.value.geometry, geometry);
  assert.equal(tx.value.kind, 'reference');
  assert.equal(tx.value.sourceCheckedAt, trail.checkedAt);
  assert.ok(tx.value.bytes > 0);
  tx.succeed(trail.id); tx.complete();
  const saved = await pending;
  assert.equal(saved, tx.value); assert.equal(env.counts().closed, 1);
});

test('downloaded API geometry is unwrapped without any casting or format migration', async t => {
  const env = storage(t);
  t.mock.method(globalThis, 'fetch', async (url,options) => {
    assert.equal(url,'/api/backend/routes/test-route');assert.equal(options.cache,'no-store');assert.equal(options.credentials,'same-origin');
    return new Response(JSON.stringify({data:{id:trail.id,revisionId:'revision-1',geometryDetail:'full',geometry}}));
  });
  const pending = saveReference({...trail,publicationStatus:'published',revisionId:'revision-1', geometryUrl: '/api/backend/routes/test-route'}), tx = await env.started;
  assert.deepEqual(tx.value.geometry, geometry);
  tx.succeed(trail.id); tx.complete();
  await pending; assert.equal(env.counts().closed, 1);
});

test('saved membership reads only keys and does not open or clone any stored geometry offline', async t => {
  const env=storage(t);
  t.mock.method(globalThis,'fetch',()=>{throw new Error('An offline key read must not fetch');});
  const pending=savedPackIds(),tx=await env.started;
  assert.equal(tx.operation,'getAllKeys');assert.equal(tx.mode,'readonly');
  tx.succeed(['a','b',17]);tx.complete();
  assert.deepEqual(await pending,['a','b']);assert.deepEqual(env.counts(),{opened:1,closed:1});
});

test('saving a published overview obtains every full vertex and rejects stale identity before storage',async t=>{
  const overview={...trail,publicationStatus:'published',revisionId:'revision-1',geometryUrl:'/api/backend/routes/test-route',geometry:{type:'LineString',coordinates:[geometry.coordinates[0],geometry.coordinates[1]]}};
  const full={type:'LineString',coordinates:[[30,61],[30.003,61.002],[30.006,61.008],[30.01,61.01]]};
  for(const mismatch of [{id:'wrong-route'},{revisionId:'wrong-revision'},{geometryDetail:'overview'}]){
    await t.test(Object.keys(mismatch)[0],async t=>{
      const env=storage(t);t.mock.method(globalThis,'fetch',async()=>Response.json({data:{id:trail.id,revisionId:'revision-1',geometryDetail:'full',geometry:full,...mismatch}}));
      await assert.rejects(saveReference(overview),/Пакет не изменён/);assert.deepEqual(env.counts(),{opened:0,closed:0});
    });
  }
  await t.test('full',async t=>{
    const env=storage(t);t.mock.method(globalThis,'fetch',async()=>Response.json({data:{id:trail.id,revisionId:'revision-1',geometryDetail:'full',geometry:full}}));
    const pending=saveReference(overview),tx=await env.started;
    assert.deepEqual(tx.value.geometry,full);assert.equal(tx.value.trail.revisionId,'revision-1');
    tx.succeed(trail.id);tx.complete();assert.deepEqual((await pending).geometry.coordinates,full.coordinates);
  });
});

test('transaction creation, request creation and request failure always reject and close once', async t => {
  for (const kind of ['transactionError', 'requestError', 'eventError']) await t.test(kind, async t => {
    const error = new DOMException('Storage rejected the operation', 'QuotaExceededError');
    const env = storage(t, {[kind]: error});
    const pending = saveReference({...trail, geometry});
    if (kind === 'eventError') {const tx = await env.started; tx.fail(error); tx.abort(error);}
    await assert.rejects(pending, error);
    await Promise.resolve();
    assert.equal(env.counts().closed, 1);
  });
});

test('a failed geometry download never opens or changes the existing IndexedDB pack', async t => {
  const env = storage(t);
  let requests=0;t.mock.method(globalThis, 'fetch', async () => {requests++;return new Response('Unavailable',{status:503});});
  await assert.rejects(saveReference({...trail, geometryUrl:checkedUrl}), /Пакет не изменён/);
  assert.equal(requests,1,'HTTP failures must not silently repeat the save');
  assert.deepEqual(env.counts(), {opened: 0, closed: 0});
});

test('saving a static source verifies the exact versioned bytes before opening IndexedDB',async t=>{
  const env=storage(t),requests=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{requests.push({url,cache:options.cache});return new Response(checkedBytes);});
  // A stale inline object cannot bypass a catalogue source's byte identity.
  const pending=saveReference({...trail,geometry,geometryUrl:checkedUrl}),tx=await env.started;
  assert.deepEqual(requests,[{url:versionedCheckedUrl,cache:'default'}]);
  assert.deepEqual(tx.value.geometry,checkedGeometry);
  tx.succeed(trail.id);tx.complete();assert.deepEqual((await pending).geometry,checkedGeometry);
});

test('an invalid cached source gets one fresh read and cannot replace a saved card when both reads disagree',async t=>{
  for(const recovers of [false,true])await t.test(String(recovers),async t=>{
    const env=storage(t),requests=[];
    t.mock.method(globalThis,'fetch',async(url,options)=>{
      requests.push({url,cache:options.cache});
      return new Response(recovers&&requests.length===2?checkedBytes:JSON.stringify(geometry));
    });
    const pending=saveReference({...trail,geometryUrl:checkedUrl});
    if(recovers){const tx=await env.started;assert.deepEqual(tx.value.geometry,checkedGeometry);tx.succeed(trail.id);tx.complete();await pending;}
    else{await assert.rejects(pending,/Пакет не изменён/);assert.deepEqual(env.counts(),{opened:0,closed:0});}
    assert.deepEqual(requests,[{url:versionedCheckedUrl,cache:'default'},{url:versionedCheckedUrl,cache:'reload'}]);
  });
});

test('unknown source identities and invalid inline or API geometry never mutate a saved pack',async t=>{
  for(const sample of [
    {geometry:{unexpected:'not GeoJSON'}},
    {geometry:{type:'LineString',coordinates:[['wrong',43],[40,44]]}},
    {geometryUrl:'/data/routes/not-in-the-catalogue.geojson'},
    {geometryUrl:'https://untrusted.invalid/route.geojson'},
    {publicationStatus:'published',revisionId:'revision-1',geometryUrl:'/api/backend/routes/test-route'},
  ])await t.test(JSON.stringify(sample),async t=>{
    const env=storage(t);let requests=0;
    t.mock.method(globalThis,'fetch',async()=>{requests++;return new Response(JSON.stringify({unexpected:'not GeoJSON'}));});
    await assert.rejects(saveReference({...trail,...sample}),/Пакет не изменён/);
    assert.deepEqual(env.counts(),{opened:0,closed:0});
    assert.equal(requests,sample.publicationStatus==='published'?1:0);
  });
});

test('oversized announced and streamed route responses are cancelled before JSON or storage',async t=>{
  for(const announced of [true,false])await t.test(String(announced),async t=>{
    const env=storage(t);let cancelled=false;
    const body=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(announced?1:MAP_RESOURCE_LIMITS.maxResourceBytes+1));},cancel(){cancelled=true;}});
    t.mock.method(globalThis,'fetch',async()=>new Response(body,{headers:announced?{'Content-Length':String(MAP_RESOURCE_LIMITS.maxResourceBytes+1)}:{}}));
    await assert.rejects(saveReference({...trail,publicationStatus:'published',revisionId:'revision-1',geometryUrl:'/api/backend/routes/test-route'}),error=>/Пакет не изменён/.test(error.message)&&error.cause?.code==='response_too_large');
    assert.equal(cancelled,true);assert.deepEqual(env.counts(),{opened:0,closed:0});
  });
});

test('a card without a confirmed line remains savable with no invented geometry or network request',async t=>{
  const env=storage(t);t.mock.method(globalThis,'fetch',()=>assert.fail('No geometry source is declared'));
  const pending=saveReference(trail),tx=await env.started;
  assert.equal(tx.value.geometry,null);tx.succeed(trail.id);tx.complete();assert.equal((await pending).geometry,null);
});

test('Pages saves verify project-prefixed source URLs with catalogue-relative hashes and the existing isolated store',async t=>{
  const base='/tropnik/',moduleURL=(source,filename)=>'data:text/javascript,'+encodeURIComponent(ts.transpileModule(source,{fileName:filename,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
  const geometryURL=new URL('../lib/route-geometry.ts',import.meta.url).href;
  const integrity=rewriteScript(await readFile(new URL('../lib/route-source-integrity.ts',import.meta.url),'utf8'),'route-source-integrity.ts',{base}).replace("'./route-geometry.ts'",JSON.stringify(geometryURL));
  let source=rewriteScript(await readFile(new URL('../lib/local.ts',import.meta.url),'utf8'),'local.ts',{base});
  for(const [relative,url] of [
    ['./route-geometry.ts',geometryURL],['./route-source-integrity.ts',moduleURL(integrity,'route-source-integrity.ts')],
    ['./map-config.ts',new URL('../lib/map-config.ts',import.meta.url).href],['./trail-overlay.generated.json',new URL('../lib/trail-overlay.generated.json',import.meta.url).href],
    ['./published-route.ts',new URL('../lib/published-route.ts',import.meta.url).href],
    ['./api-transport.ts',new URL('../lib/api-transport.ts',import.meta.url).href],
  ])source=source.replace(JSON.stringify(relative),JSON.stringify(url)).replace("'"+relative+"'",JSON.stringify(url));
  const runtime=await import(moduleURL(source,'local.ts')),env=storage(t,{databaseName:'tropnik-tropa-local-v1'}),requests=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{requests.push({url,cache:options.cache});return new Response(checkedBytes);});
  const pending=runtime.saveReference({...trail,geometryUrl:base+checkedUrl.slice(1)}),tx=await env.started;
  assert.deepEqual(requests,[{url:base+versionedCheckedUrl.slice(1),cache:'default'}]);
  assert.deepEqual(tx.value.geometry,checkedGeometry);tx.succeed(trail.id);tx.complete();await pending;
});

test('a real stalled HTTP response aborts before headers and during the body without storing an incomplete route',async t=>{
  for(const sendsHeaders of [false,true])await t.test(String(sendsHeaders),async t=>{
    const env=storage(t);let seen=false,closed=false;
    const server=createServer((_request,response)=>{seen=true;response.on('close',()=>{closed=true;});if(sendsHeaders){response.writeHead(200,{'Content-Type':'application/json'});response.write('{');}});
    server.listen(0,'127.0.0.1');await once(server,'listening');
    t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
    const origin=`http://127.0.0.1:${server.address().port}`,realFetch=globalThis.fetch,realTimeout=globalThis.setTimeout;
    t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>realTimeout(callback,delay===MAP_RESOURCE_LIMITS.timeoutMs?250:delay,...args));
    t.mock.method(globalThis,'fetch',(url,options)=>realFetch(new URL(url,origin),options));
    await assert.rejects(saveReference({...trail,geometryUrl:checkedUrl}),error=>/Пакет не изменён/.test(error.message)&&error.cause?.name==='AbortError');
    assert.equal(seen,true);assert.deepEqual(env.counts(),{opened:0,closed:0});
    // The aborted transport must also release its live socket, not just reject
    // a wrapper promise while the server keeps sending bytes.
    for(let attempt=0;attempt<20&&!closed;attempt++)await new Promise(resolve=>realTimeout(resolve,5));
    assert.equal(closed,true);
  });
});
