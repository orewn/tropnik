import test from 'node:test';
import assert from 'node:assert/strict';
import {browserAuditRunPolicy,terrainDiagnosticTraceCategories,queryTerrainTraceCategories,terrainResource,observeTerrainResources,inspectTerrainWebGL} from '../browser-zoom-audit.mjs';
import {DESKTOP_TRACE_CATEGORIES} from '../browser-trace.mjs';
import {assertBrowserReport} from '../browser-report.mjs';

test('terrain diagnostics select only desktop and can never select the release receipt',()=>{
 assert.deepEqual(browserAuditRunPolicy(undefined),{diagnostic:null,reportFile:'browser-verification.json',profiles:null});
 assert.deepEqual(browserAuditRunPolicy(''),browserAuditRunPolicy(undefined));
 const policy=browserAuditRunPolicy('terrain-close');
 assert.deepEqual(policy.profiles,['desktop-webgl']);assert.equal(policy.diagnostic,'terrain-close');assert.equal(policy.reportFile,'browser-terrain-diagnostic.json');
 assert.deepEqual(browserAuditRunPolicy('map-interactions'),{diagnostic:'map-interactions',reportFile:'browser-map-interactions-diagnostic.json',profiles:['desktop-webgl']});
 for(const invalid of ['true','terrain','terrain-high-zoom','release',' terrain-close '])assert.throws(()=>browserAuditRunPolicy(invalid),/Unknown TROPNIK_BROWSER_DIAGNOSTIC/);
});

test('GPU diagnostic categories are a small supported extension of unchanged default evidence',()=>{
 const result=terrainDiagnosticTraceCategories(['cc','viz','disabled-by-default-gpu.service','disabled-by-default-gpu.debug','disabled-by-default-cc.debug']);
 assert.deepEqual(result.supported,['cc','viz','disabled-by-default-gpu.service']);
 assert.deepEqual(result.selected,[...DESKTOP_TRACE_CATEGORIES,...result.supported]);
 assert.equal(result.availability,'enumerated');assert.deepEqual(result.unverified,[]);
 assert.equal(result.selected.includes('disabled-by-default-gpu.debug'),false);assert.equal(result.selected.includes('disabled-by-default-cc.debug'),false);
 const empty=terrainDiagnosticTraceCategories();assert.equal(empty.availability,'unknown-empty-enumeration');assert.equal(empty.availableCount,0);assert.deepEqual(empty.supported,[]);
 assert.deepEqual(empty.unverified,empty.requested);assert.deepEqual(empty.selected,[...DESKTOP_TRACE_CATEGORIES,...empty.requested]);assert.equal(empty.selected.length,DESKTOP_TRACE_CATEGORIES.length+4);
});

test('category extraction uses the unwrapped CDP payload and distinguishes empty enumeration from errors',async()=>{
 const call=async value=>queryTerrainTraceCategories({async call(method,params,timeout){assert.equal(method,'Tracing.getCategories');assert.deepEqual(params,{});assert.equal(timeout,3000);return value;}});
 const normal=await call({categories:['gpu','cc']});assert.equal(normal.availableCount,2);assert.deepEqual(normal.supported,['cc']);assert.deepEqual(normal.selected,[...DESKTOP_TRACE_CATEGORIES,'cc']);
 const empty=await call({categories:[]});assert.equal(empty.availableCount,0);assert.equal(empty.availability,'unknown-empty-enumeration');assert.equal(empty.error,undefined);assert.equal(empty.selected.includes('viz'),true);
 for(const malformed of [{result:{categories:['cc']}},{},null,{categories:'cc'}, {categories:[17]}]){
  const result=await call(malformed);assert.equal(result.availableCount,null);assert.equal(result.availability,'unknown-query-failed');assert.match(result.error,/invalid categories payload/);assert.deepEqual(result.supported,[]);assert.equal(result.selected.includes('disabled-by-default-gpu.device'),true);
 }
 const failure=await queryTerrainTraceCategories({async call(){throw new Error('Protocol timed out');}});assert.match(failure.error,/Protocol timed out/);assert.equal(failure.availability,'unknown-query-failed');
});

test('the bounded DEM recorder retains URLs, tile levels, HTTP failures and pre-response failures',()=>{
 assert.deepEqual(terrainResource('https://tiles.mapterhorn.com/16/40123/23971.webp').tile,{z:16,x:40123,y:23971});
 assert.equal(terrainResource('https://tiles.mapterhorn.com/tilejson.json').kind,'dem-metadata');
 assert.equal(terrainResource('https://example.test/16/1/2.webp'),null);assert.equal(terrainResource('bad URL'),null);
 const listeners=new Map(),cdp={observe(name,callback){listeners.set(name,callback);return()=>listeners.delete(name);}},emit=(name,event)=>listeners.get(name)?.(event);
 const recorder=observeTerrainResources(cdp,()=> 'terrain-diagnostic-upward');
 const request=(id,url)=>emit('Network.requestWillBeSent',{requestId:id,request:{url},timestamp:100,wallTime:200});
 request('metadata','https://tiles.mapterhorn.com/tilejson.json');
 emit('Network.responseReceived',{requestId:'metadata',response:{url:'https://tiles.mapterhorn.com/tilejson.json',status:200,mimeType:'application/json'},timestamp:101});
 emit('Network.loadingFinished',{requestId:'metadata',encodedDataLength:1234,timestamp:102});
 request('missing','https://tiles.mapterhorn.com/16/1/2.webp');
 emit('Network.responseReceived',{requestId:'missing',response:{url:'https://tiles.mapterhorn.com/16/1/2.webp',status:404,mimeType:'text/html'},timestamp:101});
 request('blocked','https://tiles.mapterhorn.com/17/1/2.webp');emit('Network.loadingFailed',{requestId:'blocked',errorText:'net::ERR_FAILED',blockedReason:'other',timestamp:102});
 const saved=recorder.snapshot();assert.deepEqual(saved.tileLevels,[16,17]);assert.equal(saved.requests[0].finished,true);assert.equal(saved.requests[0].bytes,1234);assert.equal(saved.requests[1].status,404);assert.equal(saved.requests[2].error,'net::ERR_FAILED');
 assert.equal(saved.requests[2].phase,'terrain-diagnostic-upward');assert.equal(saved.requests[2].status,undefined);
 request('ignored','https://example.test/16/1/2.webp');assert.equal(recorder.snapshot().observedRequests,3);
 for(let i=0;i<260;i++)request(`tile-${i}`,`https://tiles.mapterhorn.com/18/${i}/2.webp`);
 const bounded=recorder.snapshot();assert.equal(bounded.sampleLimit,256);assert.equal(bounded.requests.length,256);assert.equal(bounded.observedRequests,263);assert.equal(bounded.discardedRequests,7);assert.deepEqual(bounded.tileLevels,[18]);
 assert.equal(saved.requests.length,3,'Saved evidence cannot be changed by later network events');recorder.dispose();assert.equal(listeners.size,0);
});

test('WebGL evidence uses public getters on the existing canvas without changing framebuffer state',()=>{
 const reads=[],contexts=[],keys=['RENDERER','VENDOR','VERSION','SAMPLES','SAMPLE_BUFFERS','FRAMEBUFFER_BINDING'];
 const gl={drawingBufferWidth:1440,drawingBufferHeight:1000,getExtension:name=>{assert.equal(name,'WEBGL_debug_renderer_info');return{UNMASKED_RENDERER_WEBGL:7,UNMASKED_VENDOR_WEBGL:8};},isContextLost:()=>false,getContextAttributes:()=>({antialias:false}),getParameter(key){reads.push(key);return new Map([[1,'WebKit WebGL'],[2,'WebKit'],[3,'WebGL 2.0'],[4,0],[5,0],[6,null],[7,'ANGLE SwiftShader'],[8,'Google']]).get(key);},bindFramebuffer(){assert.fail('Diagnostic reads must not bind a framebuffer');}};
 keys.forEach((key,index)=>{gl[key]=index+1;});
 const doc={querySelector(selector){assert.equal(selector,'.terrain-scene.is-visible .terrain-canvas');return{getContext(...args){contexts.push(args);return gl;}};}};
 const result=inspectTerrainWebGL(doc);assert.deepEqual(contexts,[['webgl2']]);assert.equal(result.available,true);assert.equal(result.attributes.antialias,false);assert.equal(result.samples,0);assert.equal(result.unmaskedRenderer,'ANGLE SwiftShader');assert.equal(result.defaultFramebufferBound,true);assert.equal(result.sampleScope,'currently-bound-framebuffer');assert.equal(reads.length,8);
 assert.equal(inspectTerrainWebGL({querySelector:()=>null}).available,false);
});

test('completed own-terrain diagnostics cannot certify a release',()=>{
 const diagnostic={verified:false,releaseEligible:false,diagnosticOnly:true,status:'completed',diagnosticScope:'current-visible-map-terrain',sourceCommit:'a'.repeat(40)};
 assert.throws(()=>assertBrowserReport(diagnostic,diagnostic.sourceCommit));
});
