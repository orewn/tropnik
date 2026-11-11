import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertTerrainPresentationReport} from '../terrain-presentation-report.mjs';
import {terrainPresentationSources} from '../terrain-presentation-sources.mjs';
import {terrainFullMaskFixture} from './terrain-full-mask-fixture.mjs';
import {browserEnvironmentFixture} from './browser-environment-fixture.mjs';

const sourceCommit='a'.repeat(40),sha=value=>createHash('sha256').update(value).digest('hex');
function observation(deferred,frames,restore,dpr){
 return{mode:deferred?'deferred-msaa':'immutable-direct-reference',fencesCreated:deferred?frames:0,fencesDeleted:deferred?frames:0,maxPending:deferred?1:0,waitCalls:deferred?frames*2:0,waitFlags:deferred?[0]:[],waitTimeouts:deferred?[0]:[],readyFences:deferred?frames:0,defaultSceneDraws:deferred?0:frames*3,defaultPresentationDraws:deferred?frames:0,pendingDefaultDraws:0,pendingDefaultClears:0,unreadyPresentationDraws:0,offscreenSceneDraws:deferred?frames*3:1,resolves:deferred?frames:0,badResolves:0,pendingResizes:0,onRenderWithoutPresentation:0,completedCallbacks:frames,queuedAtCompletion:0,nullFences:0,liveFences:0,
  allocations:deferred?Array.from({length:restore?2:1},()=>[{samples:4,format:32849,width:512*dpr,height:384*dpr,depthBits:0,stencilBits:0},{samples:4,format:35056,width:512*dpr,height:384*dpr,depthBits:24,stencilBits:8}]).flat():[]};
}
function unitFixture(t){
 const previewRoot=mkdtempSync(join(tmpdir(),'tropnik-presentation-report-'));t.after(()=>rmSync(previewRoot,{recursive:true,force:true}));mkdirSync(join(previewRoot,'design-qa/terrain-presentation'),{recursive:true});
 const inputs=terrainFullMaskFixture(),{grid}=inputs,bindings=terrainPresentationSources().bindings;
 const witness={terrainPixels:4000,routePixels:100,outsideWitnesses:2000,routeLeaks:0};
 // Explicitly synthetic validator observations. PNG headers test retained
 // file identity only; no browser execution or pixel success is claimed here.
 const report={schemaVersion:1,verified:true,phase:'complete',evidence:'production-terrain-presentation-pixel-parity',sourceCommit,...bindings,environment:browserEnvironmentFixture(sourceCommit),cases:[]};
 for(const dpr of [1,2])for(const maskKind of ['full','mixed'])for(const restore of [false,true]){
  const name=`dpr${dpr}-${maskKind}-${restore?'rotated-zoomed':'initial'}`,phases=['terrain','route',...(restore?['restored']:[])],allowedPixels=inputs.mask(maskKind==='full'?'full':'known').source.allowedPixels,totalPixels=512*384*dpr*dpr;
  const item={name,dpr,maskKind,restore,verified:true,phase:'complete',view:{rotate:restore?.61:0,zoom:restore?1.3:1},grid:{width:17,height:17,minElevation:Math.min(...grid.elevations),maxElevation:Math.max(...grid.elevations),heightSHA256:sha(grid.elevations),unchanged:true},variants:[],captures:[],comparisons:[],errors:restore?Array(2).fill('Графический контекст прерван. Восстанавливаем сцену…'):[]};
  for(const variant of ['baseline','optimized']){
   const discard=maskKind==='mixed',shaders=Array.from({length:restore?2:1},()=>[
    {kind:'terrain-vertex',sha256:bindings.shaders.vertexSHA256,maskDiscard:false},
    {kind:'terrain-fragment',sha256:discard?bindings.shaders.mixedFragmentSHA256:bindings.shaders.fullFragmentSHA256,maskDiscard:discard},
    ...(variant==='optimized'?[{kind:'presentation-fragment',sha256:bindings.shaders.presentationFragmentSHA256,maskDiscard:false}]:[]),
   ]).flat();
   item.variants.push({variant,renderer:'webgl2',allowedPixels,callerMaskMutationChecked:true,witnesses:{...witness},shaders,observation:observation(variant==='optimized',phases.length,restore,dpr),recovery:restore?{lost:1,restored:1,trusted:true,comparison:{differentPixels:0,maxChannelDelta:0,totalPixels},witnesses:{...witness}}:null});
   for(const phase of phases){
    const file=`${name}-${variant}-${phase}.png`,png=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(13,8);png.write('IHDR',12);png.writeUInt32BE(512*dpr,16);png.writeUInt32BE(384*dpr,20);writeFileSync(join(previewRoot,'design-qa/terrain-presentation',file),png);
    item.captures.push({variant,phase,file,width:512*dpr,height:384*dpr,renderer:'webgl2',view:{yaw:restore?.13:-.48,pitch:.72,zoom:restore?1.3:1,offset:[0,0]},pixelRatio:dpr,meshStride:1,sourceVertices:289,triangles:512,heightScale:'1',displayMask:{width:64,height:64,allowedPixels,coverageVersion:'a'.repeat(16)},contextAttributes:{alpha:false,antialias:true,depth:true,stencil:true,preserveDrawingBuffer:false},samples:4,stencilBits:8,depthBits:24,presentation:variant==='optimized'?'deferred-msaa':'immutable-direct-reference',pending:variant==='optimized'?'false':null,pixelSHA256:sha(phase==='terrain'?'synthetic terrain':'synthetic route'),sha256:sha(png),bytes:png.length});
   }
  }
  item.comparisons=phases.map(phase=>({phase,differentPixels:0,maxChannelDelta:0,totalPixels,baselinePixelSHA256:sha(phase==='terrain'?'synthetic terrain':'synthetic route'),optimizedPixelSHA256:sha(phase==='terrain'?'synthetic terrain':'synthetic route')}));report.cases.push(item);
 }
 return{report,options:{sourceCommit,previewRoot}};
}

test('presentation receipt binds immutable f36, both DPRs, complete deferred frames and exact retained pixels',t=>{
 const {report,options}=unitFixture(t);assert.equal(assertTerrainPresentationReport(report,options),report);
 assert.equal(assertTerrainPresentationReport(report,{...options,environment:structuredClone(report.environment)}),report);
});
for(const [name,change]of [
 ['another renderer',r=>r.rendererSHA256='f'.repeat(64)],
 ['direct fallback replacing async presentation',r=>r.cases[0].captures[2].presentation='direct'],
 ['two concurrent pending frames',r=>r.cases[0].variants[1].observation.maxPending=2],
 ['GPU wait with a nonzero timeout',r=>r.cases[0].variants[1].observation.waitTimeouts=[100]],
 ['a pending GPU frame surviving destroy',r=>r.cases[0].variants[1].observation.liveFences=1],
 ['a default scene draw before completed presentation',r=>r.cases[0].variants[1].observation.defaultSceneDraws=1],
 ['an unready presentation draw',r=>r.cases[0].variants[1].observation.unreadyPresentationDraws=1],
 ['a default clear while GPU work is pending',r=>r.cases[0].variants[1].observation.pendingDefaultClears=1],
 ['visible backing resize while GPU work is pending',r=>r.cases[0].variants[1].observation.pendingResizes=1],
 ['onRender without an actual default draw',r=>r.cases[0].variants[1].observation.onRenderWithoutPresentation=1],
 ['an offscreen surface with reduced sample count',r=>r.cases[0].variants[1].observation.allocations[0].samples=2],
 ['an offscreen surface with reduced depth precision',r=>r.cases[0].variants[1].observation.allocations[1].depthBits=16],
 ['pending pixels presented as a settled capture',r=>r.cases[0].captures[2].pending='true'],

 ['a mutable current-module reference',r=>r.reference.sha256=r.rendererSHA256],
 ['stale fixture source',r=>r.fixtureSHA256='f'.repeat(64)],
 ['different commit',r=>r.sourceCommit='b'.repeat(40)],
 ['full GPU compositor',r=>r.environment.gpu.featureStatus.gpu_compositing='enabled'],
 ['missing DPR2 coverage',r=>r.cases=r.cases.filter(item=>item.dpr===1)],
 ['Canvas fallback',r=>r.cases[0].variants[1].renderer='canvas2d'],
 ['a changed terrain shader',r=>r.cases[0].variants[1].shaders[1].sha256=r.shaders.mixedFragmentSHA256],
 ['discard removed for the mixed mask',r=>r.cases[2].variants[1].shaders[1].maskDiscard=false],
 ['changed source height',r=>r.cases[0].grid.heightSHA256='f'.repeat(64)],
 ['coarser source mesh',r=>r.cases[0].captures[0].meshStride=2],
 ['lost stencil',r=>r.cases[0].captures[0].contextAttributes.stencil=false],
 ['no multisampling',r=>r.cases[0].captures[0].samples=0],
 ['missing rotated view',r=>r.cases[1].captures[0].view.yaw=-.48],
 ['synthetic recovery event',r=>r.cases[1].variants[1].recovery.trusted=false],
 ['unobserved restored presentation shader',r=>r.cases[1].variants[1].shaders.pop()],
 ['missing restored frame',r=>r.cases[1].captures.pop()],
 ['one changed pixel',r=>r.cases[0].comparisons[0].differentPixels=1],
 ['inconsistent raw pixel hash',r=>r.cases[0].comparisons[0].optimizedPixelSHA256='f'.repeat(64)],
 ['route leaking outside terrain',r=>r.cases[0].variants[0].witnesses.routeLeaks=1],
 ['no visible route witnesses',r=>r.cases[0].variants[0].witnesses.routePixels=0],
 ['altered PNG digest',r=>r.cases[0].captures[0].sha256='f'.repeat(64)],
 ['unrelated PNG path',r=>r.cases[0].captures[0].file='../unrelated.png'],
])test('presentation receipt rejects '+name,t=>{
 const {report,options}=unitFixture(t);change(report);assert.throws(()=>assertTerrainPresentationReport(report,options));
});
test('presentation receipt cannot bind to another actual Chrome revision',t=>{
 const {report,options}=unitFixture(t),environment=structuredClone(report.environment);environment.browser.revision='@'+'c'.repeat(40);
 assert.throws(()=>assertTerrainPresentationReport(report,{...options,environment}),/another browser environment/);
});
