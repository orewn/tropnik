import assert from 'node:assert/strict';

export const TERRAIN_CAPTURE_STAGES=Object.freeze(['initial','close','wide','rotated','reset']);
export const TERRAIN_CAPTURE_TIMEOUT_MS=15000;
const POLL_MS=50;

/** These are the existing default view, 14 native 1.2x zoom steps and .25 turn.
 * They describe outcomes, not desired state read back from the renderer. */
export function terrainCaptureExpectedView(stage){
 assert.ok(TERRAIN_CAPTURE_STAGES.includes(stage),'Unknown terrain capture stage');
 const yaw=stage==='rotated'?((-.48+.25+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI:-.48;
 return{yaw,pitch:.72,zoom:stage==='close'?5:stage==='wide'||stage==='rotated'? .65 :1,offset:[0,0]};
}
function sameView(actual,expected){
 return !!actual&&Number.isFinite(actual.yaw)&&Math.abs(actual.yaw-expected.yaw)<=1e-12&&
  actual.pitch===expected.pitch&&actual.zoom===expected.zoom&&
  Array.isArray(actual.offset)&&actual.offset.length===2&&actual.offset.every((value,index)=>value===expected.offset[index]);
}
function positive(value){return Number.isFinite(value)&&value>0;}
function snapshot(scene){
 return{visible:scene?.visible,ready:scene?.ready,error:scene?.error||'',sceneOpacity:scene?.opacity,
  inspection:structuredClone(scene?.inspection??null),canvas:structuredClone(scene?.canvas??null)};
}
function complete(value,expected){
 const inspection=value?.inspection,canvas=value?.canvas,frame=inspection?.frame;
 return value?.visible===true&&value.ready===true&&!value.error&&value.sceneOpacity===1&&
  Number.isInteger(inspection?.frames)&&inspection.frames>0&&sameView(frame?.view,expected)&&
  canvas?.pending==='false'&&canvas.opacity===1&&
  ['deferred-msaa','direct','canvas2d'].includes(canvas.presentation)&&
  ['webgl2','canvas2d'].includes(frame?.renderer)&&canvas.renderer===frame.renderer&&
  positive(canvas.width)&&positive(canvas.height)&&
  Number.isInteger(canvas.backingWidth)&&canvas.backingWidth>0&&
  Number.isInteger(canvas.backingHeight)&&canvas.backingHeight>0&&
  inspection.cartography?.state==='ready'&&
  Number.isInteger(inspection.cartography?.source?.loadedTiles)&&inspection.cartography.source.loadedTiles>0&&
  frame.cartography?.loadedTiles===inspection.cartography.source.loadedTiles;
}
function finiteNonnegative(value,label){
 assert.ok(Number.isFinite(value)&&value>=0,label);
}

/** The only wait is a bounded read-only outcome check. Input dispatch and the
 * document's continuously accumulated performance counters are untouched.
 * There is exactly one screenshot attempt; a changing frame fails explicitly. */
export async function captureCompletedTerrain({stage,readState,capture,sleep,now=()=>performance.now(),lastNativeInputAtMs=null}){
 const expectedView=terrainCaptureExpectedView(stage),started=now();
 const receipt={schemaVersion:1,method:'completed-frame-before-and-after-screenshot',stage,expectedView,
  readinessTimeoutMs:TERRAIN_CAPTURE_TIMEOUT_MS,pollIntervalMs:POLL_MS,lastNativeInputAtMs,
  observations:0,stable:false};
 let scene,image;
 try{
  for(;;){
   scene=await readState();receipt.observations++;
   finiteNonnegative(scene?.at,'Terrain observation has no page timestamp');
   if(receipt.firstObservedAtMs===undefined)receipt.firstObservedAtMs=scene.at;
   receipt.lastObservedAtMs=scene.at;receipt.lastObserved=snapshot(scene);
   if(scene.error)throw new Error('Terrain capture failed: '+scene.error);
   const elapsed=now()-started;
   finiteNonnegative(elapsed,'Terrain capture clock moved backwards');
   if(elapsed>TERRAIN_CAPTURE_TIMEOUT_MS)throw new Error('Terrain capture did not settle before the readiness deadline');
   if(complete(receipt.lastObserved,expectedView))break;
   if(elapsed===TERRAIN_CAPTURE_TIMEOUT_MS)throw new Error('Terrain capture did not settle before the readiness deadline');
   await sleep(Math.min(POLL_MS,TERRAIN_CAPTURE_TIMEOUT_MS-elapsed));
  }
  const readyAt=now();receipt.settleWaitMs=readyAt-started;
  receipt.before=receipt.lastObserved;receipt.beforeObservedAtMs=scene.at;
  receipt.observationAfterLastInputMs=lastNativeInputAtMs===null?null:scene.at-lastNativeInputAtMs;
  if(lastNativeInputAtMs!==null)finiteNonnegative(receipt.observationAfterLastInputMs,'Terrain capture predates the native input');
  // No file write, report save or other awaited operation may intervene here.
  image=await capture();
  const after=await readState();
  finiteNonnegative(after?.at,'Terrain post-capture observation has no page timestamp');
  receipt.after=snapshot(after);receipt.afterObservedAtMs=after.at;receipt.lastObservedAtMs=after.at;receipt.captureDurationMs=now()-readyAt;
  assert.ok(complete(receipt.after,expectedView),'Terrain frame was no longer complete immediately after screenshot capture');
  assert.deepEqual(receipt.after,receipt.before,'Terrain completed frame changed during screenshot capture');
  assert.ok(receipt.afterObservedAtMs>=receipt.beforeObservedAtMs,'Terrain page clock moved backwards');
  finiteNonnegative(receipt.captureDurationMs,'Terrain capture duration is invalid');
  receipt.stable=true;delete receipt.lastObserved;
  return{image,scene,receipt};
 }catch(error){
  receipt.failure=error.message;receipt.elapsedMs=now()-started;
  error.terrainCapture=receipt;if(image)error.terrainCaptureImage=image;
  throw error;
 }
}

/** A later zoom=5 inspection cannot certify a screenshot of an earlier frame. */
export function assertTerrainCaptureSet(scene,screenshots,profile){
 const images=screenshots.filter(value=>value.mode==='scene3d');
 assert.equal(images.length,TERRAIN_CAPTURE_STAGES.length,profile+': five bound terrain screenshots are required');
 assert.deepEqual(images.map(value=>value.terrainCapture?.stage).sort(),[...TERRAIN_CAPTURE_STAGES].sort(),
  profile+': terrain screenshot stages are missing or duplicated');
 for(const stage of TERRAIN_CAPTURE_STAGES){
  const image=images.find(value=>value.terrainCapture.stage===stage),binding=image.terrainCapture;
  assert.equal(image.file,profile+'-scene3d-'+(stage==='initial'?'overview':stage)+'.png');
  assert.match(image.sha256,/^[0-9a-f]{64}$/);assert.ok(Number.isInteger(image.bytes)&&image.bytes>0);
  assert.equal(binding.schemaVersion,1);assert.equal(binding.method,'completed-frame-before-and-after-screenshot');
  assert.equal(binding.stable,true,profile+'/'+stage+': terrain capture was not stable');
  assert.deepEqual(binding.expectedView,terrainCaptureExpectedView(stage));
  assert.equal(binding.readinessTimeoutMs,TERRAIN_CAPTURE_TIMEOUT_MS);assert.equal(binding.pollIntervalMs,POLL_MS);
  assert.ok(Number.isInteger(binding.observations)&&binding.observations>0);
  finiteNonnegative(binding.settleWaitMs,'Missing terrain settle wait');
  assert.ok(binding.settleWaitMs<=TERRAIN_CAPTURE_TIMEOUT_MS,'Terrain settle deadline was exceeded');
  finiteNonnegative(binding.captureDurationMs,'Missing terrain capture duration');
  for(const key of ['firstObservedAtMs','beforeObservedAtMs','afterObservedAtMs'])finiteNonnegative(binding[key],'Missing terrain capture page time');
  assert.ok(binding.firstObservedAtMs<=binding.beforeObservedAtMs&&binding.beforeObservedAtMs<=binding.afterObservedAtMs);
  assert.ok(complete(binding.before,binding.expectedView),profile+'/'+stage+': screenshot began with an incomplete or stale terrain frame');
  assert.ok(complete(binding.after,binding.expectedView),profile+'/'+stage+': screenshot ended with an incomplete or stale terrain frame');
  assert.deepEqual(binding.after,binding.before,profile+'/'+stage+': completed frame identity changed during screenshot');
  assert.deepEqual(scene.states[stage],binding.before.inspection,profile+'/'+stage+': reported terrain state is not the captured frame');
  assert.deepEqual(binding.image,{file:image.file,bytes:image.bytes,sha256:image.sha256},profile+'/'+stage+': screenshot digest is not bound to the captured frame');
  if(stage==='initial'){
   assert.equal(binding.lastNativeInputAtMs,null);assert.equal(binding.observationAfterLastInputMs,null);
  }else{
   const index={close:13,wide:27,rotated:28,reset:29}[stage];
   const input=scene.nativeInputs?.[index],click=input?.events?.findLast(event=>event.type==='click');
   finiteNonnegative(click?.time,'Terrain capture has no matching native click');
   assert.equal(binding.lastNativeInputAtMs,click.time);
   assert.equal(binding.observationAfterLastInputMs,binding.beforeObservedAtMs-click.time);
   finiteNonnegative(binding.observationAfterLastInputMs,'Terrain capture predates the matching native input');
  }
 }
 return scene;
}
