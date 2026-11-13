import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {assertBrowserEnvironment,assertMatchingBrowserEnvironments} from './browser-environment.mjs';
import {assertNativeSurfaceCoverage} from './browser-native-surface.mjs';

export const TILE_OPACITY_BASELINE=Object.freeze({sourceCommit:'3cb219fdd8380fcf2580bfe37aa7d1f47523ba08',workerSHA256:'25047eadb538c0e08b2e5521349419504961bee8bbb207fde6633f414f2d7217'});
export const TILE_OPACITY_CANDIDATE_SHA256='1817903d49d61ff46bdc7c7bd4b84f724a9af3093d1439e5bf19a1c84ec789e1';
export const TILE_OPACITY_WORKER_DEPENDENCIES=Object.freeze({
 'web/lib/custom-map-vector.ts':'87e145aa0d4c8a6b5007c0e1b53faba1b57a6c0d41b7782d7091575c1f5ebe48',
 'web/lib/custom-map-relief.ts':'14ee495df7b02fe2f689c51e585e4e0fd64ec165a9beb1a85522716861e5f71a',
 'web/public/maps/map-city-labels.js':'62d4b661ef3edf6ffe22b079dde39da0c1602f5f33f28f265bf44c388e3cfd53',
 'web/lib/custom-map-symbols.ts':'062eb4cdaf29d6f4946713a790c3d90feca49d0bf9cfcd2d7477465d3a289601',
 'web/lib/custom-map-labels.ts':'b0e38679b23272f18119501b2503211801d5e1719cc2804713496f041f4342fd',
 'web/lib/custom-map-painter.ts':'7665c1fb54ba8d62dbd75342e72eac046f3fc1ca6e2427a5c9a0d4812971e0f1',
});
export const TILE_OPACITY_ASSETS=Object.freeze([
 {id:'z7',path:'web/public/offline-map/localtiles/7/78/46.pbf',sha256:'377653b949af33792b377c16f3f77e7dd92711a082fa625ac437d4ee71f32091'},
 {id:'z12',path:'web/public/offline-map/localtiles/12/2506/1494.pbf',sha256:'ef12aeb5e7091f725d8ccdfc7ecf158d48a1a2eb6570d3a7f29d0f32e7556a2b'},
 {id:'z14',path:'web/public/offline-map/localtiles/14/10025/5977.pbf',sha256:'e6ddbb9d45623808994039f3ddc4290b6d789b73f1018ae0a06cd572312ea25d'},
 {id:'relief',path:'web/public/offline-map/terrain/tiles/12/2506/1494.png',sha256:'0f22d003fd23f306ce0815cee54fe45cc9c76ea72ff0cb55dac4b2005ebe79a6'},
]);
export const TILE_OPACITY_CASES=Object.freeze([
 {name:'vector-z7',asset:'z7',kind:'vector',z:7,x:78,y:46,transparent:false},
 {name:'vector-z12',asset:'z12',kind:'vector',z:12,x:2506,y:1494,transparent:false},
 {name:'vector-z14',asset:'z14',kind:'vector',z:14,x:10025,y:5977,transparent:false},
 {name:'empty-mvt',asset:null,kind:'vector',z:12,x:2506,y:1494,transparent:false},
 {name:'overzoom18-child5-7',asset:'z14',kind:'vector',z:18,x:160405,y:95639,sourceZ:14,transparent:false},
 {name:'transparent-z14',asset:'z14',kind:'vector',z:14,x:10025,y:5977,transparent:true},
 {name:'transparent-empty',asset:null,kind:'vector',z:12,x:2506,y:1494,transparent:true},
 {name:'relief-z12',asset:'relief',kind:'relief',z:12,x:2506,y:1494,transparent:false,mime:'image/png'},
]);
export const TILE_OPACITY_MATRIX=Object.freeze({dpr:[1,1.5,2],softwareRaster:[false,true],scenarios:TILE_OPACITY_CASES.map(item=>item.name)});
export const TILE_OPACITY_FIXTURE='tools/pages-preview/tests/browser-map-tile-opacity.browser.mjs';
export const TILE_OPACITY_HELPER='tools/pages-preview/browser-map-tile-opacity-receipt.mjs';
export const TILE_OPACITY_PHASES=Object.freeze(['baseline-tile','candidate-tile','baseline-world','candidate-world','baseline-affine','candidate-affine']);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sha=value=>assert.match(value??'',/^[a-f0-9]{64}$/);
const record=value=>{assert.ok(value&&typeof value.path==='string'&&!value.path.includes('..')&&!value.path.startsWith('/'));assert.ok(Number.isSafeInteger(value.bytes)&&value.bytes>0);sha(value.sha256);};
export const tileOpacityCaseKey=item=>`${item.name}/dpr${item.dpr}/${item.softwareRaster?'software':'default'}`;
export const tileOpacityPNGName=(item,phase)=>tileOpacityCaseKey(item).replaceAll('/','-')+'-'+phase+'.png';

/** Dependency-free assertion shared by CI and public proof verification. It
 * never launches a browser or trusts a summary instead of the 144 raw rows. */
export function assertTileOpacityReceipt(report,{sourceCommit,buildId,environment}={}){
 assert.equal(report?.schemaVersion,1);assert.equal(report.evidence,'production-native-worker-tile-opacity-pixel-parity');
 assert.equal(report.verified,true);assert.equal(report.phase,'complete');assert.equal(report.sourceCommit,sourceCommit);
 assert.equal(report.buildId,buildId);assert.match(buildId??'',/^[a-f0-9]{16}$/);
 assert.deepEqual(report.baseline,TILE_OPACITY_BASELINE);assert.equal(report.workerSHA256,TILE_OPACITY_CANDIDATE_SHA256);
 assert.deepEqual(report.workerDependencies,TILE_OPACITY_WORKER_DEPENDENCIES);assert.deepEqual(report.matrix,TILE_OPACITY_MATRIX);
 assert.equal(report.fixture.path,TILE_OPACITY_FIXTURE);record(report.fixture);record(report.helper);assert.equal(report.helper.path,TILE_OPACITY_HELPER);
 assert.ok(Array.isArray(report.sources)&&report.sources.length>=12&&report.sources.length<=96);
 const sources=new Map(report.sources.map(value=>{record(value);return[value.path,value];}));assert.equal(sources.size,report.sources.length);
 assert.deepEqual(sources.get(TILE_OPACITY_FIXTURE),report.fixture);assert.deepEqual(sources.get(TILE_OPACITY_HELPER),report.helper);
 assert.equal(sources.get('web/lib/custom-map-tiles.worker.ts')?.sha256,report.workerSHA256);
 assert.ok(sources.has('web/lib/custom-map-engine.ts')&&sources.has('web/lib/custom-map-camera.ts'));
 for(const [path,value]of Object.entries(TILE_OPACITY_WORKER_DEPENDENCIES))assert.equal(sources.get(path)?.sha256,value);
 assert.deepEqual(report.assets.map(({id,path,sha256})=>({id,path,sha256})),TILE_OPACITY_ASSETS);
 for(const asset of report.assets){record(asset);assert.deepEqual(sources.get(asset.path),{path:asset.path,bytes:asset.bytes,sha256:asset.sha256});}
 record(report.runtime.web);record(report.runtime.native);sha(report.runtime.sourceInputsSha256);
 assert.equal(report.runtime.web.path,'web/public/custom-map/manifest.json');assert.equal(report.runtime.native.path,'android/app/src/main/assets/custom-map/manifest.json');
 assert.equal(report.runtime.web.sha256,report.runtime.native.sha256);assert.equal(report.runtime.web.bytes,report.runtime.native.bytes);
 assert.deepEqual(sources.get(report.runtime.web.path),report.runtime.web);
 assertBrowserEnvironment(report.environment,sourceCommit);assertNativeSurfaceCoverage(report.environment.nativeSurface);
 if(environment)assertMatchingBrowserEnvironments(report.environment,environment,sourceCommit);
 assert.equal(report.browserStartup?.status,'ready');assert.equal(report.browserStartup.cleanup?.status,'stopped');assert.deepEqual(report.browserStartup.cleanup.errors,[]);
 const expected=TILE_OPACITY_MATRIX.dpr.flatMap(dpr=>TILE_OPACITY_MATRIX.softwareRaster.flatMap(softwareRaster=>TILE_OPACITY_CASES.map(item=>tileOpacityCaseKey({...item,dpr,softwareRaster}))));
 assert.deepEqual(report.cases.map(tileOpacityCaseKey),expected);assert.equal(report.cases.length,48);
 let comparisons=0,pngs=0;
 for(const item of report.cases){
  const definition=TILE_OPACITY_CASES.find(value=>value.name===item.name);assert.equal(item.verified,true,item.error);assert.equal(item.nativeDpr,item.dpr);
  assert.deepEqual(item.definition,definition);assert.equal(item.metadata.equal,true);assert.deepEqual(item.metadata.baseline,item.metadata.candidate);
  assert.ok(Array.isArray(item.metadata.baseline.labels));assert.ok(Number.isSafeInteger(item.metadata.baseline.contours)&&item.metadata.baseline.contours>=0);
  assert.equal(item.input.sha256,definition.asset?report.assets.find(value=>value.id===definition.asset).sha256:hash(new Uint8Array()));
  assert.equal(item.input.bytes,definition.asset?report.assets.find(value=>value.id===definition.asset).bytes:0);
  for(const side of ['baseline','candidate']){
   const worker=item.workers[side];assert.equal(worker.receivedBitmap,true);assert.deepEqual(worker.receivedDimensions,[512,512]);
   assert.equal(worker.inputTransfer.beforeBytes,item.input.bytes);assert.equal(worker.inputTransfer.afterBytes,0);
   assert.equal(worker.transfer.nativeBitmap,true);assert.equal(worker.transfer.count,1);assert.equal(worker.transfer.includesBitmap,true);
   assert.deepEqual(worker.transfer.beforeDimensions,[512,512]);assert.deepEqual(worker.transfer.afterDimensions,[0,0]);
   assert.ok(Array.isArray(worker.contexts)&&worker.contexts.length>=1&&worker.contexts.length<=4);
   const context=worker.contexts[0],alpha=side==='baseline'||definition.kind!=='vector'||definition.transparent;
   assert.deepEqual([context.width,context.height],[512,512]);assert.equal(context.type,'2d');assert.equal(context.native,true);
   assert.equal(context.requested.alpha,alpha);assert.equal(context.actual.alpha,alpha);
   assert.equal(context.requested.willReadFrequently,item.softwareRaster);assert.equal(context.actual.willReadFrequently,item.softwareRaster);
  }
  const normalize=contexts=>contexts.map((context,index)=>index?context:{...context,requested:{...context.requested,alpha:true},actual:{...context.actual,alpha:true}});
  assert.deepEqual(normalize(item.workers.baseline.contexts),normalize(item.workers.candidate.contexts));
  assert.equal(item.tile.width,512);assert.equal(item.tile.height,512);
  for(const [key,bearing,pitch]of [['world',0,0],['affine',17.3,25]]){
   const frame=item[key];assert.equal(frame.width,Math.round(512*item.dpr));assert.equal(frame.height,Math.round(384*item.dpr));
   assert.equal(frame.camera.zoom,definition.z-.37);assert.equal(frame.camera.bearingDegrees,bearing);assert.equal(frame.pitch,pitch);assert.equal(frame.productionWorldTransform,true);assert.equal(frame.productionDrawTiles,true);
   assert.equal(frame.drawCalls.baseline,1);assert.equal(frame.drawCalls.candidate,1);assert.equal(frame.alpha,definition.kind==='relief'?.82:1);
   assert.ok(frame.transform.every(Number.isFinite)&&frame.transform.length===6);
  }
  assert.deepEqual(item.world.camera.center,item.affine.camera.center);
  for(const frame of [item.tile,item.world,item.affine]){
   assert.deepEqual(frame.comparison,{differentPixels:0,maxChannelDelta:0,totalPixels:frame.width*frame.height});
   sha(frame.baselinePixelSHA256);assert.equal(frame.baselinePixelSHA256,frame.candidatePixelSHA256);comparisons++;
  }
  assert.deepEqual(item.tile.baselineAlpha,item.tile.candidateAlpha);
  assert.equal(Object.values(item.tile.baselineAlpha).reduce((sum,value)=>sum+value,0),512*512);
  if(definition.kind==='vector'&&!definition.transparent)assert.deepEqual(item.tile.baselineAlpha,{opaquePixels:512*512,transparentPixels:0,translucentPixels:0});
  else assert.ok(item.tile.baselineAlpha.transparentPixels+item.tile.baselineAlpha.translucentPixels>0,'Transparent control must actually contain alpha');
  if(definition.name==='transparent-empty')assert.deepEqual(item.tile.baselineAlpha,{opaquePixels:0,transparentPixels:512*512,translucentPixels:0});
  else for(const frame of [item.world,item.affine])assert.ok(frame.visiblePixels>0,'The real output must affect both compositions');
  assert.deepEqual(item.cleanup,{workersCreated:2,workersTerminated:2,bitmapsReceived:2,bitmapsClosed:2,closedDimensions:[[0,0],[0,0]],pendingJobs:0});
  assert.deepEqual(item.captures.map(value=>value.phase),TILE_OPACITY_PHASES);
  for(const capture of item.captures){
   assert.equal(capture.file,tileOpacityPNGName(item,capture.phase));assert.ok(Number.isSafeInteger(capture.bytes)&&capture.bytes>=33&&capture.bytes<=8*1024*1024);sha(capture.sha256);
   const kind=capture.phase.split('-').at(-1),side=capture.phase.startsWith('baseline')?'baseline':'candidate';
   assert.deepEqual([capture.width,capture.height],[item[kind].width,item[kind].height]);assert.equal(capture.rgbaSHA256,item[kind][side+'PixelSHA256']);pngs++;
  }
 }
 assert.equal(comparisons,144);assert.equal(pngs,288);assert.deepEqual(report.totals,{cases:48,comparisons:144,pngs:288,workers:96});
 return report;
}

/** Source files and PNG bytes remain independently inspectable artifacts. */
export function assertTileOpacityFiles(report,{root='.',build}={}){
 assert.ok(build&&build.sourceCommit===report.sourceCommit&&build.buildId===report.buildId);
 for(const source of report.sources){const bytes=readFileSync(join(root,source.path));assert.equal(bytes.length,source.bytes);assert.equal(hash(bytes),source.sha256);assert.deepEqual(build.inputs.find(input=>input.path===source.path),source);}
 const native=readFileSync(join(root,report.runtime.native.path));assert.equal(native.length,report.runtime.native.bytes);assert.equal(hash(native),report.runtime.native.sha256);
 const manifest=JSON.parse(readFileSync(join(root,report.runtime.web.path),'utf8'));assert.equal(manifest.sourceInputsSha256,report.runtime.sourceInputsSha256);
 assert.equal(manifest.sourceInputs.find(input=>input.path==='web/lib/custom-map-tiles.worker.ts')?.sha256,report.workerSHA256);
 for(const item of report.cases)for(const capture of item.captures){
  const bytes=readFileSync(join(root,'web/pages-preview/design-qa/map-tile-opacity',capture.file));assert.equal(bytes.length,capture.bytes);assert.equal(hash(bytes),capture.sha256);
  assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.deepEqual([bytes.readUInt32BE(16),bytes.readUInt32BE(20)],[capture.width,capture.height]);
 }
 return report;
}
