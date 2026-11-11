import test from 'node:test';
import assert from 'node:assert/strict';
import {captureCompletedTerrain,assertTerrainCaptureSet,terrainCaptureExpectedView,TERRAIN_CAPTURE_STAGES,TERRAIN_CAPTURE_TIMEOUT_MS} from '../browser-terrain-capture.mjs';
import {performanceBudgetIssues} from '../browser-smoothness.mjs';

function ready(stage='close',frames=2){
 return{at:1000,visible:true,ready:true,opacity:1,error:'',
  inspection:{frames,frame:{renderer:'webgl2',view:terrainCaptureExpectedView(stage),triangles:131072,pixelRatio:2,meshStride:2,sourceVertices:263169,cartography:{loadedTiles:1,requestedTiles:1,width:1024,height:1024}},
   cartography:{state:'ready',source:{loadedTiles:1,requestedTiles:1}}},
  canvas:{width:412,height:847,backingWidth:824,backingHeight:1694,renderer:'webgl2',pending:'false',presentation:'deferred-msaa',opacity:1}};
}

test('capture outcomes retain the original default, bounded zoom extremes and native turn',()=>{
 assert.deepEqual(terrainCaptureExpectedView('initial'),{yaw:-.48,pitch:.72,zoom:1,offset:[0,0]});
 assert.equal(terrainCaptureExpectedView('close').zoom,5);
 assert.equal(terrainCaptureExpectedView('wide').zoom,.65);
 assert.ok(Math.abs(terrainCaptureExpectedView('rotated').yaw-(-.23))<1e-12);
 assert.equal(terrainCaptureExpectedView('rotated').zoom,.65);
 assert.deepEqual(terrainCaptureExpectedView('reset'),terrainCaptureExpectedView('initial'));
 assert.throws(()=>terrainCaptureExpectedView('unknown'));
});

test('stale completed view, pending GPU and entrance opacity must all settle before the single screenshot',async()=>{
 const stale=ready('initial'),pending=ready(),fading=ready(),finished=ready();
 pending.canvas.pending='true';fading.canvas.opacity=.99;
 const states=[stale,pending,fading,finished];let clock=0,reads=0,captures=0;
 const counters={layoutShift:0,longestTaskMs:0},order=[];
 const result=await captureCompletedTerrain({
  stage:'close',lastNativeInputAtMs:900,now:()=>clock,
  readState:async()=>{order.push('read');const value=structuredClone(states[Math.min(reads++,states.length-1)]);value.at=1000+clock;return value;},
  sleep:async ms=>{order.push('wait');clock+=ms;counters.longestTaskMs=900;},
  capture:async()=>{order.push('capture');assert.equal(reads,4);captures++;clock+=12;return{data:'observed-png'};},
 });
 assert.equal(captures,1);assert.equal(reads,5);assert.deepEqual(order.slice(-3),['read','capture','read']);
 assert.equal(result.receipt.settleWaitMs,150);assert.equal(result.receipt.captureDurationMs,12);
 assert.equal(result.receipt.before.inspection.frame.view.zoom,5);assert.equal(result.receipt.before.canvas.opacity,1);
 assert.deepEqual(result.receipt.after,result.receipt.before);assert.equal(result.receipt.stable,true);
 assert.equal(result.receipt.observationAfterLastInputMs,250);
 assert.deepEqual(counters,{layoutShift:0,longestTaskMs:900});
 assert.deepEqual(performanceBudgetIssues(counters,{name:'android-portrait',mobile:true},'zoom-modes'),
  [{profile:'android-portrait',phase:'zoom-modes',metric:'longestTaskMs',value:900,limit:350}]);
});

test('a frame, view, pending flag or backing-size change during capture fails without recapturing',async()=>{
 for(const mutate of [
  scene=>scene.inspection.frames++,
  scene=>scene.inspection.frame.view.zoom=1,
  scene=>scene.canvas.pending='true',
  scene=>scene.canvas.backingWidth++,
  scene=>scene.canvas.opacity=.99,
 ]){
  let scene=ready(),captures=0;
  await assert.rejects(captureCompletedTerrain({
   stage:'close',lastNativeInputAtMs:900,readState:async()=>structuredClone(scene),sleep:async()=>assert.fail('Unexpected retry'),
   now:()=>0,capture:async()=>{captures++;mutate(scene);return{data:'preserved-failed-capture'};},
  }),error=>{
   assert.equal(error.terrainCapture.stable,false);
   assert.equal(error.terrainCaptureImage.data,'preserved-failed-capture');return true;
  });
  assert.equal(captures,1);
 }
});

test('missing pending status, wrong source surface and incomplete views cannot time out into a capture',async()=>{
 for(const mutate of [
  scene=>delete scene.canvas.pending,
  scene=>scene.canvas.pending='true',
  scene=>scene.inspection.frame.view.zoom=4.999,
  scene=>scene.inspection.cartography.state='loading',
  scene=>scene.inspection.frame.cartography.loadedTiles=0,
  scene=>scene.opacity=.5,
  scene=>scene.canvas.backingWidth=0,
 ]){
  const scene=ready();mutate(scene);let clock=0,captures=0;
  await assert.rejects(captureCompletedTerrain({
   stage:'close',lastNativeInputAtMs:900,
   readState:async()=>{clock+=5000;return{...structuredClone(scene),at:1000+clock};},now:()=>clock,
   sleep:async ms=>{clock+=ms;},capture:async()=>{captures++;return{data:'wrong'};},
  }),/readiness deadline/);
  assert.equal(captures,0);assert.ok(clock>=TERRAIN_CAPTURE_TIMEOUT_MS);
 }
});

test('renderer errors and backwards page clocks remain explicit failures',async()=>{
 const failed=ready();failed.error='Graphics context failed';let captures=0;
 await assert.rejects(captureCompletedTerrain({stage:'close',now:()=>0,readState:async()=>failed,sleep:async()=>{},capture:async()=>{captures++;}}),/Graphics context failed/);
 assert.equal(captures,0);
 const scene=ready();let reads=0;
 await assert.rejects(captureCompletedTerrain({stage:'close',now:()=>0,readState:async()=>({...structuredClone(scene),at:1000-reads++}),sleep:async()=>{},capture:async()=>({data:'png'})}),/clock moved backwards/);
});

async function boundFixture(){
 const scene={states:{},nativeInputs:Array.from({length:30},(_,index)=>({events:[{type:'click',time:100+index}]}))},screenshots=[];
 for(const [index,stage]of TERRAIN_CAPTURE_STAGES.entries()){
  const state=ready(stage,index+1),lastNativeInputAtMs=stage==='initial'?null:scene.nativeInputs[{close:13,wide:27,rotated:28,reset:29}[stage]].events[0].time;
  const result=await captureCompletedTerrain({stage,lastNativeInputAtMs,now:()=>0,readState:async()=>structuredClone(state),sleep:async()=>assert.fail('Already ready'),capture:async()=>({data:'png'})});
  const image={file:'android-portrait-scene3d-'+(stage==='initial'?'overview':stage)+'.png',mode:'scene3d',bytes:100,sha256:'a'.repeat(64)};
  result.receipt.image={file:image.file,bytes:image.bytes,sha256:image.sha256};
  scene.states[stage]=result.scene.inspection;screenshots.push({...image,terrainCapture:result.receipt});
 }
 return{scene,screenshots};
}

test('the publication binding accepts five stable images and rejects late metadata or altered image identity',async()=>{
 const fixture=await boundFixture();assert.equal(assertTerrainCaptureSet(fixture.scene,fixture.screenshots,'android-portrait'),fixture.scene);
 const mutations=[
  value=>delete value.screenshots[0].terrainCapture,
  value=>value.screenshots.pop(),
  value=>value.screenshots[1].terrainCapture.stage='initial',
  value=>value.screenshots[1].terrainCapture.stable=false,
  value=>value.screenshots[1].sha256='b'.repeat(64),
  value=>value.screenshots[1].terrainCapture.image.bytes++,
  value=>value.screenshots[1].terrainCapture.after.inspection.frames++,
  value=>{value.screenshots[1].terrainCapture.before.inspection.frame.view.zoom=1;value.screenshots[1].terrainCapture.after.inspection.frame.view.zoom=1;},
  value=>value.screenshots[1].terrainCapture.before.canvas.pending='true',
  value=>value.screenshots[1].terrainCapture.before.canvas.opacity=.99,
  value=>delete value.screenshots[1].terrainCapture.settleWaitMs,
  value=>value.screenshots[1].terrainCapture.settleWaitMs=TERRAIN_CAPTURE_TIMEOUT_MS+1,
  value=>value.screenshots[1].terrainCapture.lastNativeInputAtMs--,
  value=>value.scene.states.close.frames++,
  value=>value.screenshots[1].terrainCapture.expectedView.zoom=1,
 ];
 for(const mutate of mutations){
  const changed=structuredClone(fixture);mutate(changed);
  assert.throws(()=>assertTerrainCaptureSet(changed.scene,changed.screenshots,'android-portrait'));
 }
});
