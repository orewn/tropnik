import test from 'node:test';
import assert from 'node:assert/strict';
import {assertTerrainUnmaskedCase} from '../terrain-unmasked-report.mjs';

const shaders={mixedFragmentSHA256:'a'.repeat(64),vertexSHA256:'b'.repeat(64),groundFragmentSHA256:'c'.repeat(64),boundaryFragmentSHA256:'d'.repeat(64),presentationFragmentSHA256:'e'.repeat(64)};
const grid={width:17,height:17,minElevation:300,maxElevation:2300,heightSHA256:'f'.repeat(64),unchanged:true};
function fixture(dpr=1){
 const phases=['terrain','cartography','route','rotated','resized','restored'],pixel={terrain:'1'.repeat(64),cartography:'2'.repeat(64),route:'3'.repeat(64),rotated:'4'.repeat(64),resized:'5'.repeat(64),restored:'5'.repeat(64)},name=`dpr${dpr}-unmasked-lifecycle`,totalPixels=512*384*dpr*dpr;
 const item={name,dpr,verified:true,phase:'complete',displayMask:null,maskKind:'unmasked',restore:true,view:{rotate:0,zoom:1},grid,errors:Array(2).fill('Графический контекст прерван. Восстанавливаем сцену…'),variants:[],captures:[],comparisons:[]};
 for(const variant of ['baseline','optimized']){
  const deferred=variant==='optimized',observation={mode:deferred?'deferred-msaa':'immutable-direct-reference',waitFlags:deferred?[0]:[],waitTimeouts:deferred?[0]:[],allocations:[]};
  for(const key of ['fencesCreated','fencesDeleted','maxPending','waitCalls','readyFences','defaultSceneDraws','defaultPresentationDraws','pendingDefaultDraws','pendingDefaultClears','unreadyPresentationDraws','offscreenSceneDraws','resolves','badResolves','pendingResizes','onRenderWithoutPresentation','completedCallbacks','queuedAtCompletion','nullFences','liveFences','groundDraws','boundaryDraws'])observation[key]=0;
  Object.assign(observation,{completedCallbacks:6,groundDraws:6,boundaryDraws:6,...(deferred?{fencesCreated:6,fencesDeleted:6,maxPending:1,waitCalls:6,readyFences:6,defaultPresentationDraws:6,offscreenSceneDraws:15,resolves:6}:{defaultSceneDraws:15})});
  if(deferred)for(let pair=0;pair<3;pair++){
   const width=(pair?384:512)*dpr,height=(pair?512:384)*dpr,common={requestedSamples:4,width,height,samples:4};
   observation.allocations.push({...common,format:32849,precision:{redBits:8,greenBits:8,blueBits:8,alphaBits:0}},{...common,format:33190,precision:{depthBits:24,stencilBits:0}});
  }
  const kinds={'terrain-fragment':'mixedFragmentSHA256','terrain-vertex':'vertexSHA256','ground-fragment':'groundFragmentSHA256','boundary-fragment':'boundaryFragmentSHA256',...(deferred?{'presentation-fragment':'presentationFragmentSHA256'}:{})};
  item.variants.push({variant,renderer:'webgl2',displayMask:null,witnesses:{terrainPixels:2000,routePixels:100,groundPixels:200,boundaryPixels:200},recovery:{lost:1,restored:1,trusted:true,comparison:{differentPixels:0,maxChannelDelta:0,totalPixels}},shaders:Array.from({length:2},()=>Object.entries(kinds).map(([kind,key])=>({kind,sha256:shaders[key],maskDiscard:kind==='terrain-fragment'}))).flat(),observation});
  for(const phase of phases){
   const portrait=['resized','restored'].includes(phase),changed=!['terrain','cartography','route'].includes(phase);
   item.captures.push({variant,phase,renderer:'webgl2',graphicsFallback:null,displayMask:null,quality:'full',cartography:phase==='terrain'?null:{loadedTiles:1,requestedTiles:1,width:1024,height:1024},width:(portrait?384:512)*dpr,height:(portrait?512:384)*dpr,pixelRatio:dpr,meshStride:1,sourceVertices:289,triangles:512,heightScale:'1',view:{yaw:changed?.13:-.48,pitch:.72,zoom:changed?1.3:1,offset:[0,0]},contextAttributes:{alpha:false,antialias:true,depth:true,stencil:false,preserveDrawingBuffer:false},samples:4,stencilBits:0,depthBits:24,presentation:deferred?'deferred-msaa':'immutable-direct-reference',pending:deferred?'false':null,pixelSHA256:pixel[phase],sha256:'a'.repeat(64),file:`${name}-${variant}-${phase}.png`,bytes:100});
  }
 }
 for(const phase of phases)item.comparisons.push({phase,differentPixels:0,maxChannelDelta:0,totalPixels,baselinePixelSHA256:pixel[phase],optimizedPixelSHA256:pixel[phase]});
 return item;
}
for(const dpr of [1,2])test('unmasked lifecycle receipt accepts all six actual stages at DPR '+dpr,()=>assertTerrainUnmaskedCase(fixture(dpr),{dpr,shaders,grid}));
for(const [name,corrupt]of [
 ['hidden source map on native material stage',v=>{v.captures[6].cartography={loadedTiles:1,requestedTiles:1,width:1024,height:1024};}],
 ['reduced motion quality',v=>{v.captures[6].quality='motion';}],
 ['Canvas fallback',v=>{v.captures[6].renderer='canvas2d';}],
 ['hidden graphics failure',v=>{v.captures[6].graphicsFallback={stage:'render',reason:'query failed'};}],
 ['replacement full mask',v=>{v.captures[6].displayMask={allowedPixels:4096};}],
 ['missing resize',v=>{v.captures[10].width=512;v.captures[10].height=384;}],
 ['reduced DPR',v=>{v.captures[6].pixelRatio=.5;}],
 ['reduced mesh',v=>{v.captures[6].meshStride=2;}],
 ['changed completed camera',v=>{v.captures[9].view.zoom=1;}],
 ['unfinished presentation',v=>{v.captures[6].pending='true';}],
 ['default scene draw',v=>{v.variants[1].observation.defaultSceneDraws=1;}],
 ['pending resize clear',v=>{v.variants[1].observation.pendingResizes=1;}],
 ['blocking poll',v=>{v.variants[1].observation.waitTimeouts=[1];}],
 ['two pending frames',v=>{v.variants[1].observation.maxPending=2;}],
 ['wrong actual samples',v=>{v.variants[1].observation.allocations[0].samples=2;}],
 ['missing actual precision query',v=>{delete v.variants[1].observation.allocations[1].precision.depthBits;}],
 ['stencil depth allocation',v=>{v.variants[1].observation.allocations[1].format=35056;v.variants[1].observation.allocations[1].precision.stencilBits=8;}],
 ['no ground draw',v=>{v.variants[1].observation.groundDraws=0;}],
 ['no rim pixels',v=>{v.variants[1].witnesses.boundaryPixels=0;}],
 ['changed ground shader',v=>{v.variants[1].shaders.find(s=>s.kind==='ground-fragment').sha256='f'.repeat(64);}],
 ['synthetic context restore',v=>{v.variants[1].recovery.trusted=false;}],
 ['changed pixels',v=>{v.comparisons[0].differentPixels=1;}],
 ['missing actual capture',v=>{v.captures.pop();}],
 ['changed source heights',v=>{v.grid={...v.grid,unchanged:false};}],
])test('unmasked lifecycle receipt rejects '+name,()=>{
 const value=fixture();corrupt(value);assert.throws(()=>assertTerrainUnmaskedCase(value,{dpr:1,shaders,grid}));
});
