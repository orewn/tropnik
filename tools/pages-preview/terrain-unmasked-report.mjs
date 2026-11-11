import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertBrowserEnvironment,assertMatchingBrowserEnvironments} from './browser-environment.mjs';
import {assertNativeSurfaceCoverage} from './browser-native-surface.mjs';
import {terrainUnmaskedSources} from './terrain-unmasked-sources.mjs';
import {terrainFullMaskFixture} from './tests/terrain-full-mask-fixture.mjs';

const repoRoot=resolve(import.meta.dirname,'../..'),sha=value=>createHash('sha256').update(value).digest('hex');
const phases=['terrain','cartography','route','rotated','resized','restored'];
const hash=value=>assert.match(value||'',/^[a-f0-9]{64}$/);
function samePixels(value,totalPixels){assert.equal(value?.differentPixels,0);assert.equal(value.maxChannelDelta,0);assert.equal(value.totalPixels,totalPixels);}
function observed(value,deferred,dpr,depthBits,samples){
 for(const key of ['fencesCreated','fencesDeleted','maxPending','waitCalls','readyFences','defaultSceneDraws','defaultPresentationDraws','pendingDefaultDraws','pendingDefaultClears','unreadyPresentationDraws','offscreenSceneDraws','resolves','badResolves','pendingResizes','onRenderWithoutPresentation','completedCallbacks','queuedAtCompletion','nullFences','liveFences','groundDraws','boundaryDraws'])assert.ok(Number.isInteger(value?.[key])&&value[key]>=0,'Missing actual graphics measurement: '+key);
 assert.equal(value.liveFences,0);assert.ok(value.groundDraws>=6&&value.boundaryDraws>=6);assert.ok(value.completedCallbacks>=6);
 if(!deferred){
  assert.equal(value.mode,'immutable-direct-reference');assert.ok(value.defaultSceneDraws>0);
  for(const key of ['fencesCreated','fencesDeleted','maxPending','waitCalls','defaultPresentationDraws'])assert.equal(value[key],0);
  assert.deepEqual(value.waitFlags,[]);assert.deepEqual(value.waitTimeouts,[]);assert.deepEqual(value.allocations,[]);return;
 }
 assert.equal(value.mode,'deferred-msaa');assert.equal(value.maxPending,1);assert.equal(value.fencesCreated,value.fencesDeleted);assert.ok(value.fencesCreated>=6);
 assert.ok(value.defaultPresentationDraws>=6&&value.defaultPresentationDraws<=value.readyFences&&value.readyFences<=value.fencesCreated&&value.waitCalls>=value.readyFences);
 assert.equal(value.completedCallbacks,value.defaultPresentationDraws);assert.ok(value.completedCallbacks-value.queuedAtCompletion>=6);
 assert.equal(value.resolves,value.fencesCreated);assert.ok(value.offscreenSceneDraws>0);assert.deepEqual(value.waitFlags,[0]);assert.deepEqual(value.waitTimeouts,[0]);
 for(const key of ['defaultSceneDraws','pendingDefaultDraws','pendingDefaultClears','unreadyPresentationDraws','badResolves','pendingResizes','onRenderWithoutPresentation','nullFences'])assert.equal(value[key],0,'Unsafe presentation: '+key);
 assert.equal(value.allocations?.length,6,'Initial, resized and restored color/depth targets must all be verified');
 const depthFormat={16:33189,24:33190,32:36012}[depthBits];assert.ok(depthFormat);
 for(let pair=0;pair<3;pair++){
  const width=(pair?384:512)*dpr,height=(pair?512:384)*dpr,common={requestedSamples:samples,width,height,samples};
  assert.deepEqual(value.allocations[pair*2],{...common,format:32849,precision:{redBits:8,greenBits:8,blueBits:8,alphaBits:0}});
  assert.deepEqual(value.allocations[pair*2+1],{...common,format:depthFormat,precision:{depthBits,stencilBits:0}});
 }
}

export function assertTerrainUnmaskedCase(item,{dpr,shaders,grid}){
 const name=`dpr${dpr}-unmasked-lifecycle`,pixels=512*384*dpr*dpr;
 assert.equal(item?.name,name);assert.equal(item.dpr,dpr);assert.equal(item.verified,true);assert.equal(item.phase,'complete');assert.equal(item.displayMask,null);assert.equal(item.maskKind,'unmasked');assert.equal(item.restore,true);assert.deepEqual(item.view,{rotate:0,zoom:1});assert.deepEqual(item.grid,grid);
 assert.deepEqual(item.errors,Array(2).fill('Графический контекст прерван. Восстанавливаем сцену…'));
 assert.equal(item.variants?.length,2);assert.equal(item.captures?.length,12);assert.equal(item.comparisons?.length,6);
 for(const variant of ['baseline','optimized']){
  const summaries=item.variants.filter(value=>value.variant===variant);assert.equal(summaries.length,1);const summary=summaries[0];
  assert.equal(summary.renderer,'webgl2');assert.equal(summary.displayMask,null);
  for(const [key,min]of [['terrainPixels',512],['routePixels',32],['groundPixels',8],['boundaryPixels',8]])assert.ok(Number.isInteger(summary.witnesses?.[key])&&summary.witnesses[key]>=min,'Missing actual unmasked witness: '+key);
  const first=item.captures.find(value=>value.variant===variant&&value.phase==='terrain');assert.ok(first);assert.ok([16,24,32].includes(first.depthBits));
  observed(summary.observation,variant==='optimized',dpr,first.depthBits,first.samples);
  assert.equal(summary.recovery?.lost,1);assert.equal(summary.recovery?.restored,1);assert.equal(summary.recovery?.trusted,true);samePixels(summary.recovery.comparison,pixels);
  const kinds={'terrain-fragment':'mixedFragmentSHA256','terrain-vertex':'vertexSHA256','ground-fragment':'groundFragmentSHA256','boundary-fragment':'boundaryFragmentSHA256',...(variant==='optimized'?{'presentation-fragment':'presentationFragmentSHA256'}:{})};
  assert.equal(summary.shaders?.length,Object.keys(kinds).length*2);
  for(const [kind,key]of Object.entries(kinds)){
   const compiled=summary.shaders.filter(value=>value.kind===kind);assert.equal(compiled.length,2,'Initial and restored shader missing');
   for(const value of compiled){assert.equal(value.sha256,shaders[key]);assert.equal(value.maskDiscard,kind==='terrain-fragment');}
  }
  for(const phase of phases){
   const matches=item.captures.filter(value=>value.variant===variant&&value.phase===phase);assert.equal(matches.length,1);const capture=matches[0],portrait=['resized','restored'].includes(phase),changed=!['terrain','cartography','route'].includes(phase);
   assert.equal(capture.renderer,'webgl2');assert.equal(capture.graphicsFallback,null);assert.equal(capture.displayMask,null);assert.equal(capture.quality,'full');assert.deepEqual(capture.cartography,phase==='terrain'?null:{loadedTiles:1,requestedTiles:1,width:1024,height:1024});
   assert.equal(capture.width,(portrait?384:512)*dpr);assert.equal(capture.height,(portrait?512:384)*dpr);assert.equal(capture.pixelRatio,dpr);
   assert.equal(capture.meshStride,1);assert.equal(capture.sourceVertices,289);assert.equal(capture.triangles,512);assert.equal(capture.heightScale,'1');
   assert.ok(Math.abs(capture.view?.yaw-(changed?.13:-.48))<1e-12);assert.equal(capture.view.pitch,.72);assert.equal(capture.view.zoom,changed?1.3:1);assert.deepEqual(capture.view.offset,[0,0]);
   for(const [key,value]of Object.entries({alpha:false,antialias:true,depth:true,stencil:false,preserveDrawingBuffer:false}))assert.equal(capture.contextAttributes?.[key],value,'Actual context changed: '+key);
   assert.ok(Number.isInteger(capture.samples)&&capture.samples>0);assert.equal(capture.stencilBits,0);assert.equal(capture.depthBits,first.depthBits);assert.equal(capture.samples,first.samples);
   assert.equal(capture.presentation,variant==='optimized'?'deferred-msaa':'immutable-direct-reference');assert.equal(capture.pending,variant==='optimized'?'false':null);
   hash(capture.pixelSHA256);hash(capture.sha256);assert.equal(capture.file,`${name}-${variant}-${phase}.png`);assert.ok(Number.isInteger(capture.bytes)&&capture.bytes>=33&&capture.bytes<=8*1024*1024);
  }
  const frame=phase=>item.captures.find(value=>value.variant===variant&&value.phase===phase);
  assert.notEqual(frame('terrain').pixelSHA256,frame('cartography').pixelSHA256);assert.notEqual(frame('cartography').pixelSHA256,frame('route').pixelSHA256);assert.notEqual(frame('route').pixelSHA256,frame('rotated').pixelSHA256);assert.notEqual(frame('rotated').pixelSHA256,frame('resized').pixelSHA256);assert.equal(frame('resized').pixelSHA256,frame('restored').pixelSHA256);
 }
 for(const phase of phases){
  const matches=item.comparisons.filter(value=>value.phase===phase);assert.equal(matches.length,1);const comparison=matches[0];samePixels(comparison,pixels);
  const old=item.captures.find(value=>value.variant==='baseline'&&value.phase===phase),current=item.captures.find(value=>value.variant==='optimized'&&value.phase===phase);
  assert.equal(comparison.baselinePixelSHA256,old.pixelSHA256);assert.equal(comparison.optimizedPixelSHA256,current.pixelSHA256);assert.equal(old.pixelSHA256,current.pixelSHA256);
  for(const key of ['quality','cartography','view','pixelRatio','meshStride','sourceVertices','triangles','heightScale','displayMask','contextAttributes','samples','stencilBits','depthBits'])assert.deepEqual(old[key],current[key],key+' changed');
 }
 return item;
}

export function assertTerrainUnmaskedReport(report,{sourceCommit,root=repoRoot,previewRoot=join(root,'web/pages-preview'),environment}={}){
 assert.ok(sourceCommit===null||/^[a-f0-9]{40}$/.test(sourceCommit||''),'An exact source commit is required');
 assert.equal(report?.schemaVersion,1);assert.equal(report.verified,true);assert.equal(report.releaseEligible,false);assert.equal(report.phase,'complete');assert.equal(report.evidence,'production-terrain-unmasked-pixel-parity');assert.equal(report.sourceCommit,sourceCommit);
 assert.ok(Buffer.byteLength(JSON.stringify(report))<=512*1024);
 const expected=terrainUnmaskedSources(root).bindings;for(const [key,value]of Object.entries(expected))assert.deepEqual(report[key],value,'Source binding differs: '+key);
 assertBrowserEnvironment(report.environment,sourceCommit);assertNativeSurfaceCoverage(report.environment.nativeSurface);if(environment)assertMatchingBrowserEnvironments(report.environment,environment,sourceCommit);
 const fixture=terrainFullMaskFixture(),grid={width:fixture.grid.width,height:fixture.grid.height,minElevation:Math.min(...fixture.grid.elevations),maxElevation:Math.max(...fixture.grid.elevations),heightSHA256:sha(fixture.grid.elevations),unchanged:true};
 assert.ok(grid.maxElevation-grid.minElevation>1000);assert.equal(report.cases?.length,2);
 for(const dpr of [1,2]){
  const matches=report.cases.filter(value=>value.dpr===dpr);assert.equal(matches.length,1);const item=assertTerrainUnmaskedCase(matches[0],{dpr,shaders:expected.shaders,grid});
  for(const capture of item.captures){
   const file=join(previewRoot,'design-qa/terrain-unmasked',capture.file);assert.equal(statSync(file).size,capture.bytes);const png=readFileSync(file);assert.equal(sha(png),capture.sha256);assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(png.subarray(12,16).toString(),'IHDR');assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[capture.width,capture.height]);
  }
 }
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assert.match(process.env.GITHUB_SHA||'',/^[a-f0-9]{40}$/);const report=JSON.parse(readFileSync(join(repoRoot,'web/pages-preview/dist/browser-terrain-unmasked-verification.json'),'utf8'));
 assertTerrainUnmaskedReport(report,{sourceCommit:process.env.GITHUB_SHA});console.log(JSON.stringify({verified:true,releaseEligible:false,sourceCommit:report.sourceCommit,rendererSHA256:report.rendererSHA256,cases:2,comparisons:12,pngs:24}));
}
