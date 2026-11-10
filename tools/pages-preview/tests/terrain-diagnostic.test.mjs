import test from 'node:test';
import assert from 'node:assert/strict';
import {browserAuditRunPolicy,terrainDiagnosticTraceCategories,queryTerrainTraceCategories,terrainResource,observeTerrainResources,inspectTerrainWebGL,shouldTraceTerrainDiagnostic,runTerrainCloseDiagnostic} from '../browser-zoom-audit.mjs';
import {DESKTOP_TRACE_CATEGORIES} from '../browser-trace.mjs';
import {assertBrowserReport} from '../browser-report.mjs';

test('terrain diagnostics select only desktop and can never select the release receipt',()=>{
 assert.deepEqual(browserAuditRunPolicy(undefined),{diagnostic:null,reportFile:'browser-verification.json',profiles:null});
 assert.deepEqual(browserAuditRunPolicy(''),browserAuditRunPolicy(undefined));
 const policy=browserAuditRunPolicy('terrain-close');
 assert.deepEqual(policy.profiles,['desktop-webgl']);assert.equal(policy.diagnostic,'terrain-close');assert.equal(policy.reportFile,'browser-terrain-diagnostic.json');
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
 const doc={defaultView:{devicePixelRatio:1},querySelector(selector){assert.equal(selector,'.maplibregl-canvas');return{width:1440,height:1000,getBoundingClientRect:()=>({width:1440,height:1000}),getContext(...args){contexts.push(args);return gl;}};}};
 const result=inspectTerrainWebGL(doc);assert.deepEqual(contexts,[['webgl2']]);assert.equal(result.available,true);assert.equal(result.attributes.antialias,false);assert.equal(result.samples,0);assert.equal(result.unmaskedRenderer,'ANGLE SwiftShader');assert.equal(result.defaultFramebufferBound,true);assert.equal(result.sampleScope,'currently-bound-framebuffer');assert.equal(reads.length,8);
 assert.deepEqual(result.canvas,{width:1440,height:1000,cssWidth:1440,cssHeight:1000,devicePixelRatio:1});
 assert.equal(inspectTerrainWebGL({querySelector:()=>null}).available,false);
});

function nativeDiagnosticFixture(failure,failAt=15){
 let current=12.4,toggles=0,bottoms=0,saves=0;const movements=[],captures=[],gpuSnapshots=[],profile={name:'desktop-webgl',engine:'maplibre',mobile:false},report={geometryPassed:false,verified:true};
 const actions={report,phase:async()=>{},gpu:async()=>{const sample={webgl:{available:true,attributes:{antialias:false}},terrainEnabled:toggles>0,zoom:current};gpuSnapshots.push(sample);return sample;},geometry:async()=>({zoom:current,routeId:'kavkaz-8a'}),capture:async(_mode,state,label)=>{captures.push({zoom:state.zoom,label});},reachZoom:async value=>{assert.equal(value,11);current=Math.max(current,value);},reachBottom:async()=>{assert.ok(report.terrainEnabledGPU?.terrainEnabled,'Capture the enabled terrain GPU before lowering the camera');bottoms++;current=2.9054061044955795;return current;},toggleTerrain:async()=>{toggles++;},zoom:async(direction,{mode})=>{
  assert.equal(direction,1);assert.equal(mode,'terrain-diagnostic');const before=current,traced=shouldTraceTerrainDiagnostic(profile,mode,direction,before,false);movements.push({before,traced});
  if(failure&&before>=failAt)throw failure;current=Math.min(18,current+1);return{before,after:current,changed:true};
 },save:async()=>{saves++;}};
 return{actions,report,movements,captures,gpuSnapshots,counts:()=>({toggles,bottoms,saves})};
}

test('the diagnostic uses the lower clamp and existing native increments to reproduce15.905→16.905',async()=>{
 const env=nativeDiagnosticFixture(),report=await runTerrainCloseDiagnostic(env.actions);
 assert.equal(report,env.report);assert.equal(report.status,'completed');assert.equal(report.verified,false);assert.equal(report.releaseEligible,false);assert.equal(report.diagnosticOnly,true);assert.equal(report.geometryPassed,false);
 assert.deepEqual(env.captures.map(item=>item.label),['route-ready','terrain-ready','before-target','upper-bound']);
 assert.equal(env.movements.length,16);assert.equal(env.movements.filter(item=>item.traced).length,1);assert.ok(Math.abs(report.targetBeforeZoom-15.9054061044955795)<1e-9);
 assert.equal(env.counts().toggles,1);assert.equal(env.counts().bottoms,1);assert.equal(report.diagnosticSteps.at(-1).zoom,18);
 assert.equal(report.terrainEnabledGPU,env.gpuSnapshots[1]);assert.equal(report.terrainEnabledGPU.terrainEnabled,true);assert.equal(report.terrainEnabledGPU.zoom,12.4);
 assert.throws(()=>assertBrowserReport({...report,sourceCommit:'a'.repeat(40)},'a'.repeat(40)),'A completed diagnostic is never publication evidence');
});

test('a high-zoom settle failure is not retried or converted into diagnostic/release success',async()=>{
 const failure=new Error('The maplibre map did not settle');failure.settleDiagnostics={samples:[{frameMs:15000}]};const env=nativeDiagnosticFixture(failure);
 const observed=await runTerrainCloseDiagnostic(env.actions).then(()=>null,error=>error);assert.equal(observed,failure);
 assert.equal(env.movements.filter(item=>item.traced).length,1);assert.equal(env.movements.at(-1).traced,true);assert.equal(env.captures.some(item=>item.label==='upper-bound'),false);assert.notEqual(env.report.status,'completed');assert.equal(env.report.verified,false);assert.equal(env.report.releaseEligible,false);
 const profile={name:'desktop-webgl',engine:'maplibre',mobile:false};for(const zoom of [4.905,14.905,16,17.905])assert.equal(shouldTraceTerrainDiagnostic(profile,'terrain-diagnostic',1,zoom,false),false);
 assert.equal(shouldTraceTerrainDiagnostic(profile,'terrain-diagnostic',1,15.905,true),false);assert.equal(shouldTraceTerrainDiagnostic(profile,'terrain',1,15.905,false),false);
});

test('terrain backing evidence survives a failure before the high-zoom trace and screenshot',async()=>{
 const failure=new Error('The maplibre map did not settle'),env=nativeDiagnosticFixture(failure,14);
 const observed=await runTerrainCloseDiagnostic(env.actions).then(()=>null,error=>error);
 assert.equal(observed,failure);assert.equal(env.report.terrainEnabledGPU.terrainEnabled,true);assert.equal(env.gpuSnapshots.length,2);
 assert.equal(env.report.highZoomGPU,undefined);assert.equal(env.movements.filter(movement=>movement.traced).length,0);
 assert.equal(env.movements.at(-1).before,14.90540610449558);assert.equal(env.report.verified,false);assert.equal(env.report.releaseEligible,false);
});
