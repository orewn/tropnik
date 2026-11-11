import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertBrowserEnvironment,assertMatchingBrowserEnvironments} from './browser-environment.mjs';
import {assertNativeSurfaceCoverage} from './browser-native-surface.mjs';
import {terrainPresentationSources} from './terrain-presentation-sources.mjs';
import {terrainFullMaskFixture} from './tests/terrain-full-mask-fixture.mjs';

const repoRoot=resolve(import.meta.dirname,'../..'),sha=value=>createHash('sha256').update(value).digest('hex');
const hash=value=>assert.match(value||'',/^[a-f0-9]{64}$/);
function witnesses(value){
 for(const key of ['terrainPixels','routePixels','outsideWitnesses','routeLeaks'])assert.ok(Number.isInteger(value?.[key])&&value[key]>=0,'Missing real pixel witness: '+key);
 assert.ok(value.terrainPixels>=512&&value.routePixels>=32&&value.outsideWitnesses>=128,'Blank pixels cannot prove route/terrain clipping');assert.equal(value.routeLeaks,0);
}
function equality(value,totalPixels){
 assert.equal(value?.differentPixels,0);assert.equal(value.maxChannelDelta,0);assert.equal(value.totalPixels,totalPixels);
}
function completion(value,deferred,minimumFrames,restore,width,height,depthBits,samples){
 assert.ok(value,'Missing actual presentation observations');
 for(const key of ['fencesCreated','fencesDeleted','maxPending','waitCalls','readyFences','defaultSceneDraws','defaultPresentationDraws','pendingDefaultDraws','pendingDefaultClears','unreadyPresentationDraws','offscreenSceneDraws','resolves','badResolves','pendingResizes','onRenderWithoutPresentation','completedCallbacks','queuedAtCompletion','nullFences','liveFences'])assert.ok(Number.isInteger(value[key])&&value[key]>=0,'Missing real presentation measurement: '+key);
 assert.equal(value.liveFences,0,'A pending GPU frame survived renderer destruction');
 if(!deferred){
  assert.equal(value.mode,'immutable-direct-reference');assert.ok(value.defaultSceneDraws>0);assert.equal(value.defaultPresentationDraws,0);assert.equal(value.fencesCreated,0);assert.equal(value.fencesDeleted,0);assert.equal(value.maxPending,0);assert.equal(value.waitCalls,0);assert.deepEqual(value.waitFlags,[]);assert.deepEqual(value.waitTimeouts,[]);assert.deepEqual(value.allocations,[]);return;
 }
 assert.equal(value.mode,'deferred-msaa');assert.equal(value.maxPending,1);assert.equal(value.fencesCreated,value.fencesDeleted);assert.ok(value.fencesCreated>=minimumFrames);assert.ok(value.defaultPresentationDraws>=minimumFrames);assert.ok(value.defaultPresentationDraws<=value.readyFences&&value.readyFences<=value.fencesCreated&&value.waitCalls>=value.readyFences);assert.ok(value.offscreenSceneDraws>0);assert.equal(value.resolves,value.fencesCreated);assert.deepEqual(value.waitFlags,[0]);assert.deepEqual(value.waitTimeouts,[0]);
 assert.equal(value.completedCallbacks,value.defaultPresentationDraws);assert.ok(value.completedCallbacks-value.queuedAtCompletion>=minimumFrames);
 for(const key of ['defaultSceneDraws','pendingDefaultDraws','pendingDefaultClears','unreadyPresentationDraws','badResolves','pendingResizes','onRenderWithoutPresentation','nullFences'])assert.equal(value[key],0,'Unsafe deferred presentation: '+key);
 assert.equal(value.allocations?.length,restore?4:2);
 for(let index=0;index<value.allocations.length;index+=2){
  assert.deepEqual(value.allocations[index],{samples,format:32849,width,height,depthBits:0,stencilBits:0},'The offscreen RGB8 color surface changed precision, size or MSAA');
  assert.deepEqual(value.allocations[index+1],{samples,format:depthBits===24?35056:36013,width,height,depthBits,stencilBits:8},'The offscreen depth/stencil surface changed precision, size or MSAA');
 }
}

// Require an immutable pre-FBO reference plus the exact current module, real
// deferred completion observations, unchanged shaders, full resolution and
// retained pixel files. This is separate from the shader-specialization gate.
export function assertTerrainPresentationReport(report,{sourceCommit,root=repoRoot,previewRoot=join(root,'web/pages-preview'),environment}={}){
 assert.ok(sourceCommit===null||/^[a-f0-9]{40}$/.test(sourceCommit||''),'An exact source commit is required');
 assert.equal(report?.schemaVersion,1);assert.equal(report.verified,true);assert.equal(report.phase,'complete');assert.equal(report.evidence,'production-terrain-presentation-pixel-parity');assert.equal(report.sourceCommit,sourceCommit);
 assert.ok(Buffer.byteLength(JSON.stringify(report))<=512*1024,'Oversized presentation pixel receipt');
 const expected=terrainPresentationSources(root).bindings;
 for(const [key,value]of Object.entries(expected))assert.deepEqual(report[key],value,'Full-mask source binding differs: '+key);
 assertBrowserEnvironment(report.environment,sourceCommit);assertNativeSurfaceCoverage(report.environment.nativeSurface);
 if(environment)assertMatchingBrowserEnvironments(report.environment,environment,sourceCommit);
 const fixture=terrainFullMaskFixture(),expectedGrid={width:fixture.grid.width,height:fixture.grid.height,minElevation:Math.min(...fixture.grid.elevations),maxElevation:Math.max(...fixture.grid.elevations),heightSHA256:sha(fixture.grid.elevations),unchanged:true};
 assert.ok(expectedGrid.maxElevation-expectedGrid.minElevation>1000);assert.equal(report.cases?.length,8);
 let pairs=0,pictures=0;
 for(const dpr of [1,2])for(const maskKind of ['full','mixed'])for(const restore of [false,true]){
  const name=`dpr${dpr}-${maskKind}-${restore?'rotated-zoomed':'initial'}`,matches=report.cases.filter(item=>item.name===name);assert.equal(matches.length,1,'Missing unique presentation case: '+name);const item=matches[0];
  assert.equal(item.verified,true);assert.equal(item.phase,'complete');assert.equal(item.maskKind,maskKind);assert.equal(item.dpr,dpr);assert.equal(item.restore,restore);assert.deepEqual(item.view,{rotate:restore?.61:0,zoom:restore?1.3:1});assert.deepEqual(item.grid,expectedGrid);
  const phases=['terrain','route',...(restore?['restored']:[])],totalPixels=512*384*dpr*dpr,allowedPixels=fixture.mask(maskKind==='full'?'full':'known').source.allowedPixels;
  assert.deepEqual(item.errors,restore?Array(2).fill('Графический контекст прерван. Восстанавливаем сцену…'):[],'Unexpected renderer error');
  assert.equal(item.variants?.length,2);assert.equal(item.captures?.length,phases.length*2);assert.equal(item.comparisons?.length,phases.length);
  for(const variant of ['baseline','optimized']){
   const variants=item.variants.filter(value=>value.variant===variant);assert.equal(variants.length,1);const summary=variants[0];assert.equal(summary.renderer,'webgl2','Canvas fallback cannot replace a WebGL shader proof');assert.equal(summary.allowedPixels,allowedPixels);assert.equal(summary.callerMaskMutationChecked,true);witnesses(summary.witnesses);
   const firstFrame=item.captures.find(value=>value.variant===variant);assert.ok(firstFrame);assert.ok([24,32].includes(firstFrame.depthBits));
   completion(summary.observation,variant==='optimized',phases.length,restore,512*dpr,384*dpr,firstFrame.depthBits,firstFrame.samples);
   const count=restore?2:1;assert.equal(summary.shaders?.length,count*(variant==='baseline'?2:3));
   for(const kind of ['terrain-fragment','terrain-vertex',...(variant==='optimized'?['presentation-fragment']:[])]){
    const shaders=summary.shaders.filter(shader=>shader.kind===kind);assert.equal(shaders.length,count,'Missing compiled or restored program');
    const usesDiscard=kind==='terrain-fragment'&&maskKind==='mixed';
    const expectedHash=kind==='presentation-fragment'?expected.shaders.presentationFragmentSHA256:kind==='terrain-vertex'?expected.shaders.vertexSHA256:usesDiscard?expected.shaders.mixedFragmentSHA256:expected.shaders.fullFragmentSHA256;
    for(const shader of shaders){assert.equal(shader.sha256,expectedHash,'The actual GPU shader differs');assert.equal(shader.maskDiscard,usesDiscard);}
   }
   if(restore){assert.equal(summary.recovery?.lost,1);assert.equal(summary.recovery?.restored,1);assert.equal(summary.recovery?.trusted,true);equality(summary.recovery.comparison,totalPixels);witnesses(summary.recovery.witnesses);}else assert.equal(summary.recovery,null);
   for(const phase of phases){
    const captures=item.captures.filter(value=>value.variant===variant&&value.phase===phase);assert.equal(captures.length,1);const capture=captures[0];
    assert.equal(capture.renderer,'webgl2');assert.equal(capture.width,512*dpr);assert.equal(capture.height,384*dpr);assert.equal(capture.pixelRatio,dpr);assert.equal(capture.meshStride,1);assert.equal(capture.sourceVertices,289);assert.equal(capture.triangles,512);assert.equal(capture.heightScale,'1');
    assert.ok(Math.abs(capture.view?.yaw-(restore?.13:-.48))<1e-12);assert.equal(capture.view.pitch,.72);assert.equal(capture.view.zoom,restore?1.3:1);assert.deepEqual(capture.view.offset,[0,0]);
    assert.deepEqual(capture.displayMask,{width:64,height:64,allowedPixels,coverageVersion:'a'.repeat(16)});
    for(const [key,value]of Object.entries({alpha:false,antialias:true,depth:true,stencil:true,preserveDrawingBuffer:false}))assert.equal(capture.contextAttributes?.[key],value,'The actual WebGL context changed: '+key);
    assert.ok(Number.isInteger(capture.samples)&&capture.samples>0,'Real multisampling is required');assert.ok(Number.isInteger(capture.stencilBits)&&capture.stencilBits>0);
    assert.equal(capture.presentation,variant==='optimized'?'deferred-msaa':'immutable-direct-reference');assert.equal(capture.pending,variant==='optimized'?'false':null);assert.equal(capture.depthBits,firstFrame.depthBits);
    hash(capture.pixelSHA256);hash(capture.sha256);assert.equal(capture.file,`${name}-${variant}-${phase}.png`);assert.ok(Number.isInteger(capture.bytes)&&capture.bytes>=33&&capture.bytes<=8*1024*1024);
    const file=join(previewRoot,'design-qa/terrain-presentation',capture.file);assert.equal(statSync(file).size,capture.bytes);const png=readFileSync(file);assert.equal(sha(png),capture.sha256);assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(png.subarray(12,16).toString(),'IHDR');assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[capture.width,capture.height]);pictures++;
   }
   const terrain=item.captures.find(value=>value.variant===variant&&value.phase==='terrain'),route=item.captures.find(value=>value.variant===variant&&value.phase==='route');assert.notEqual(terrain.pixelSHA256,route.pixelSHA256,'Adding the actual route must change the pixels');
   if(restore){const before=item.captures.find(value=>value.variant===variant&&value.phase==='route'),after=item.captures.find(value=>value.variant===variant&&value.phase==='restored');assert.equal(before.pixelSHA256,after.pixelSHA256);}
  }
  for(const phase of phases){
   const values=item.comparisons.filter(value=>value.phase===phase);assert.equal(values.length,1);const comparison=values[0];equality(comparison,totalPixels);
   const old=item.captures.find(value=>value.variant==='baseline'&&value.phase===phase),current=item.captures.find(value=>value.variant==='optimized'&&value.phase===phase);
   assert.equal(comparison.baselinePixelSHA256,old.pixelSHA256);assert.equal(comparison.optimizedPixelSHA256,current.pixelSHA256);assert.equal(old.pixelSHA256,current.pixelSHA256,'Raw pixels differ');
   for(const key of ['view','pixelRatio','meshStride','sourceVertices','triangles','heightScale','displayMask','contextAttributes','samples','stencilBits','depthBits'])assert.deepEqual(old[key],current[key],key+' changed with shader selection');pairs++;
  }
 }
 assert.equal(pairs,20);assert.equal(pictures,40);return report;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assert.match(process.env.GITHUB_SHA||'',/^[a-f0-9]{40}$/);
 const report=JSON.parse(readFileSync(join(repoRoot,'web/pages-preview/dist/browser-terrain-presentation-verification.json'),'utf8'));
 assertTerrainPresentationReport(report,{sourceCommit:process.env.GITHUB_SHA});
 console.log(JSON.stringify({verified:true,sourceCommit:report.sourceCommit,cases:8,comparisons:20,pngs:40}));
}
