import test from 'node:test';
import assert from 'node:assert/strict';
import {assertMapUIBounds,dispatchZoomBurst,settleMapCamera,mapCameraIsMoving,shouldTraceTerrainZoom} from '../browser-zoom-audit.mjs';
import {assertNativeBurstEventOrder} from '../browser-report.mjs';

function nativeBurstEvents(input,delivery='deferred',rounded=false){
 const pairs=Array.from({length:4},(_,tap)=>['pointerdown','pointerup','click'].map((type,index)=>({
  type,timestamp:rounded?100:100+tap*10+(index?2:0),pointerType:input,pointerId:input==='touch'?tap+2:1,trusted:true,
 })));
 const ordered=delivery==='interleaved'?pairs.flat():delivery==='mixed'?
  [...pairs[0].slice(0,2),...pairs[1].slice(0,2),pairs[0][2],...pairs[2].slice(0,2),pairs[1][2],...pairs[3].slice(0,2),pairs[2][2],pairs[3][2]]:
  [...pairs.flatMap(pair=>pair.slice(0,2)),...pairs.map(pair=>pair[2])];
 return ordered.map((event,index)=>({...event,time:rounded?150:150+index}));
}

test('native burst correlation accepts deferred, mixed and interleaved Chromium click delivery',()=>{
 for(const input of ['touch','mouse'])for(const delivery of ['deferred','mixed','interleaved'])for(const rounded of [false,true]){
  const events=nativeBurstEvents(input,delivery,rounded);
  assert.equal(assertNativeBurstEventOrder(events,input),true);
 }
 const reused=nativeBurstEvents('touch');for(const event of reused)event.pointerId=2;
 assert.equal(assertNativeBurstEventOrder(reused,'touch'),true,'Pointer IDs may be reused between completed pointer sequences');
});

test('native burst correlation rejects orphan, reordered or mismatched pairs and clicks',()=>{
 const changes=[
  events=>events.pop(),
  events=>events.push({...events.at(-1)}),
  events=>{events[1].type='pointerdown';events[2].type='pointerup';},
  events=>{[events[1],events[8]]=[events[8],events[1]];},
  events=>{[events[8],events[9]]=[events[9],events[8]];},
  events=>{events[1].pointerId=99;},
  events=>{events[8].pointerId=99;},
  events=>{delete events[8].pointerId;},
  events=>{events[8].pointerType='mouse';},
  events=>{events[8].timestamp=999;},
  events=>{events[0].timestamp=events[1].timestamp+1;},
  events=>{events[2].timestamp=99;},
  events=>{events[8].trusted=false;},
 ];
 for(const change of changes){
  const events=nativeBurstEvents('touch');change(events);
  // Keep delivery clocks monotonic so ordering failures cannot hide behind a
  // backwards-clock rejection when the event identities are rearranged.
  events.forEach((event,index)=>{event.time=150+index;});
  assert.throws(()=>assertNativeBurstEventOrder(events,'touch'));
 }
 const backwards=nativeBurstEvents('touch');backwards[1].time=backwards[0].time-1;
 assert.throws(()=>assertNativeBurstEventOrder(backwards,'touch'),/delivery time moved backwards/);
 const mouse=nativeBurstEvents('mouse');[mouse[8].timestamp,mouse[9].timestamp]=[mouse[9].timestamp,mouse[8].timestamp];
 assert.throws(()=>assertNativeBurstEventOrder(mouse,'mouse'),/source pointer-up timestamp/,'Reused mouse IDs do not excuse a click from another press');
});

test('rapid zoom sends native presses in wire order without waiting for slow acknowledgements',async()=>{
 for(const mobile of [true,false]){
  const calls=[],acknowledgements=[];
  const cdp={call(method,params){calls.push({method,...params});return new Promise(resolve=>acknowledgements.push(resolve));}};
  const pending=dispatchZoomBurst(cdp,{x:287,y:189},{mobile},4);
  assert.equal(calls.length,mobile?8:9,'Every event must be sent while the first ACK is still unresolved');
  if(mobile){
   assert.equal(calls.length,8);
   assert.deepEqual(calls.map(call=>call.type),Array.from({length:4},()=>['touchStart','touchEnd']).flat());
   for(const [index,call] of calls.entries()){
    assert.equal(call.method,'Input.dispatchTouchEvent');
    if(index%2===0){assert.equal(call.touchPoints.length,1);assert.equal(call.touchPoints[0].x,287);assert.equal(call.touchPoints[0].y,189);}
    else assert.deepEqual(call.touchPoints,[]);
   }
  }else{
   assert.equal(calls.length,9);assert.equal(calls[0].type,'mouseMoved');
   assert.deepEqual(calls.slice(1).map(call=>call.type),Array.from({length:4},()=>['mousePressed','mouseReleased']).flat());
   for(const call of calls){assert.equal(call.method,'Input.dispatchMouseEvent');assert.equal(call.x,287);assert.equal(call.y,189);assert.equal(call.pointerType,'mouse');}
   for(const call of calls.slice(1)){assert.equal(call.button,'left');assert.equal(call.clickCount,1);}
  }
  for(const acknowledge of acknowledgements.toReversed())acknowledge();
  const result=await pending;
  assert.equal(result.count,4);assert.equal(result.input,mobile?'touch':'mouse');assert.equal(result.dispatchMode,'ordered-native');
  assert.ok(Number.isFinite(result.durationMs)&&result.durationMs>=0);
  assert.equal(result.commands.length,calls.length);
  assert.deepEqual(result.commands.map(command=>command.type),calls.map(call=>call.type));
  assert.ok(result.commands.every(command=>command.status==='fulfilled'&&command.ackOffsetMs>=command.sentOffsetMs));
  assert.ok(Math.max(...result.commands.map(command=>command.sentOffsetMs))<=Math.min(...result.commands.map(command=>command.ackOffsetMs)),'Slow ACKs must not throttle the producer');
 }
});

test('rapid zoom drains all acknowledgements and surfaces every native input error',async()=>{
 const acknowledgements=[],calls=[];
 const cdp={call(method,params){calls.push({method,...params});return new Promise((resolve,reject)=>acknowledgements.push({resolve,reject}));}};
 let terminal=false;
 const observed=dispatchZoomBurst(cdp,{x:287,y:189},{mobile:true},4).then(()=>{terminal=true;return null;},error=>{terminal=true;return error;});
 assert.equal(calls.length,8);
 const first=new Error('touch end failed'),second=new Error('touch start failed');
 acknowledgements[4].reject(second);acknowledgements[1].reject(first);
 for(let index=0;index<7;index++)if(index!==1&&index!==4)acknowledgements[index].resolve();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(terminal,false,'One failed ACK must not return while other native input is still outstanding');
 acknowledgements[7].resolve();
 const error=await observed;
 assert.ok(error instanceof AggregateError);assert.deepEqual(error.errors,[first,second]);
 assert.match(error.message,/touch end failed/);
 assert.equal(error.inputDiagnostics.commands.length,8);
 assert.equal(error.inputDiagnostics.commands[1].status,'rejected');assert.equal(error.inputDiagnostics.commands[4].status,'rejected');
 assert.equal(error.inputDiagnostics.commands[7].status,'fulfilled');
});

test('invalid zoom bursts fail before emitting partial or empty acceptance input',async()=>{
 const cdp={async call(){assert.fail('Invalid burst must not emit native input');}};
 for(const count of [0,-1,5,NaN,Infinity,1.5])await assert.rejects(dispatchZoomBurst(cdp,{x:10,y:10},{mobile:true},count));
 await assert.rejects(dispatchZoomBurst(cdp,{x:NaN,y:10},{mobile:false},4));
});

test('map overlay checks reject the observed notice/story collision and obscured controls',()=>{
 const rect=(left,top,width,height)=>({left,top,width,height,right:left+width,bottom:top+height});
 const layout={width:1363,scrollWidth:1363,scrollY:0,available:rect(384,78,979,800),
  ui:[{kind:'map-message',rect:rect(408,799,505,52)},{kind:'fact-closed',rect:rect(408,802,143,44)}],targets:[]};
 assert.throws(()=>assertMapUIBounds(layout,'CUA desktop z11.98'),/map-message overlaps fact-closed/);
 layout.ui[0].rect=rect(408,170,505,52);
 layout.ui.push({kind:'map-attribution-toggle',rect:rect(1295,802,44,44)},{kind:'map-attribution-content',rect:rect(925,708,306,80)});
 assert.doesNotThrow(()=>assertMapUIBounds(layout,'Separated desktop overlays'));
 layout.targets=[{label:'Истории мест',rect:rect(408,802,143,44),minimumSize:44,unobscured:false}];
 assert.throws(()=>assertMapUIBounds(layout,'Covered launcher'),/Истории мест is covered/);
 layout.targets[0].unobscured=true;layout.targets[0].rect=rect(408,802,143,30);
 assert.throws(()=>assertMapUIBounds(layout,'Small launcher'),/smaller than 44px/);
 layout.targets=[];layout.ui[2].rect=rect(1330,802,44,44);
 assert.throws(()=>assertMapUIBounds(layout,'Clipped attribution'),/map-attribution-toggle leaves the usable map/);
});

test('the C9 terrain preload notice must occupy a separate row above the story launcher',()=>{
 const rect=(left,top,width,height)=>({left,top,width,height,right:left+width,bottom:top+height});
 const layout={width:1440,scrollWidth:1425,scrollY:0,available:rect(384,72,1041,928),ui:[
  {kind:'map-preload-status',rect:rect(408,878,269,34)},
  {kind:'fact-closed',rect:rect(408,866,143,44)},
  {kind:'map-legend',rect:rect(409,939,524,34)},
 ],targets:[]};
 assert.throws(()=>assertMapUIBounds(layout,'C9 terrain z14.91'),/map-preload-status overlaps fact-closed/);
 layout.ui[0].rect=rect(408,820,269,34);
 assert.equal(layout.ui[1].rect.top-layout.ui[0].rect.bottom,12);
 assert.doesNotThrow(()=>assertMapUIBounds(layout,'Separate loading row'));
});

test('first-visit desktop credits leave the full labelled Layers button unobscured',()=>{
 const rect=(left,top,width,height)=>({left,top,width,height,right:left+width,bottom:top+height});
 const layout={width:1440,scrollWidth:1425,scrollY:0,available:rect(384,72,1041,928),ui:[
  {kind:'map-attribution-content',rect:rect(966.4375,852,370,80)},
  {kind:'layer-button',rect:rect(1307,872,93,44)},
  {kind:'map-attribution-toggle',rect:rect(1357,940,44,44)},
 ],targets:[]};
 assert.throws(()=>assertMapUIBounds(layout,'First-visit desktop credits'),/map-attribution-content overlaps layer-button/);
 layout.ui[0].rect=rect(922.4375,852,370,80);
 assert.ok(layout.ui[1].rect.left-layout.ui[0].rect.right>=12);
 assert.doesNotThrow(()=>assertMapUIBounds(layout,'Credits beside the complete rail'));
});

test('settling observes a queued camera only after compositor progress and consecutive idle samples',async()=>{
 let frames=0,reads=0;const observed=[];
 const state=zoom=>({visible:true,moving:false,engine:'tropnik-canvas',camera:{longitude:40,latitude:43,zoom,tileSize:256},rect:{left:0,top:68,width:412,height:847},route:'kavkaz-8a',rendering:{painted:true,coverageReady:true,drawnRoute:'kavkaz-8a',tilesState:'ready'}});
 const result=await settleMapCamera({engine:'tropnik-canvas',
  frame:async()=>{frames+=2;},
  read:async()=>{reads++;assert.equal(frames,reads*2,'Every sample must follow compositor frames');const sample=frames<4?state(4.020198667):state(3.270198667);if(frames===4||frames===6)sample.moving=true;observed.push(sample);return sample;},
  wait:async(_label,read,accept,timeout)=>{assert.equal(timeout,15000);for(let index=0;index<12;index++){const sample=await read();if(accept(sample))return sample;}throw new Error('Did not settle');},
 });
 assert.equal(result.camera.zoom,3.270198667,'The stale pre-RAF camera must not become a false lower bound');
 assert.equal(reads,7,'Exactly four idle observations are still required after the two moving samples');
 assert.ok(observed.some(item=>item.moving),'An in-progress transition must reset idle stability');
 assert.equal(observed.slice(-4).every(item=>!item.moving&&item.camera.zoom===result.camera.zoom),true);
});

test('own camera motion and queued native transitions stay moving until both public markers clear',()=>{
 const element={dataset:{mapMoving:'true'},hasAttribute:()=>false};
 assert.equal(mapCameraIsMoving(element),true);
 element.dataset.mapMoving='false';assert.equal(mapCameraIsMoving(element),false);
 element.hasAttribute=()=>true;assert.equal(mapCameraIsMoving(element),true);
});

test('settle failure retains only the last16 timed samples without rounding camera drift',async()=>{
 let now=0,frames=0,reads=0;
 const failure=new Error('The tropnik-canvas map did not settle'),state={visible:true,moving:false,engine:'tropnik-canvas',camera:{longitude:40,latitude:43,zoom:5.9054061044955795,tileSize:256,centerX:520.5,centerY:464},rect:{left:384,top:72,width:1041,height:928},route:'kavkaz-8a',rendering:{painted:true,coverageReady:true,drawnRoute:'kavkaz-8a',tilesState:'ready'}};
 const observed=await settleMapCamera({engine:'tropnik-canvas',clock:()=>now,
  frame:async()=>{frames++;now+=frames===16?6026:10;},
  read:async()=>{reads++;now+=3;state.camera.centerX=reads%2?520.5000000000027:520.5;return state;},
  wait:async(label,read,accept,timeout)=>{assert.equal(label,'The tropnik-canvas map did not settle');assert.equal(timeout,15000);for(let index=0;index<24;index++)assert.equal(accept(await read()),false,'Subpixel drift must not bypass exact equality');throw failure;},
 }).then(()=>null,error=>error);
 assert.equal(observed,failure);const diagnostic=observed.settleDiagnostics;
 assert.equal(diagnostic.timeoutMs,15000);assert.equal(diagnostic.requiredIdleObservations,4);assert.equal(diagnostic.comparison,'exact-camera-rect-route');
 assert.equal(diagnostic.totalSamples,24);assert.equal(diagnostic.sampleLimit,16);assert.equal(diagnostic.discardedSamples,8);assert.equal(diagnostic.samples.length,16);
 assert.deepEqual(diagnostic.samples.map(sample=>sample.index),Array.from({length:16},(_,index)=>index+9));
 assert.equal(diagnostic.samples[0].state.camera.centerX,520.5000000000027,'The ring must retain a snapshot even when the reader reuses an object');
 assert.equal(diagnostic.samples.find(sample=>sample.index===16).frameMs,6026);
 assert.ok(diagnostic.samples.every(sample=>sample.readMs===3&&sample.phase==='observed'&&sample.idleObservations===1&&!sample.signatureUnchanged));
 assert.ok(diagnostic.samples.every(sample=>sample.changedFields.includes('camera.centerX')&&Number.isFinite(sample.startedAtEpochMs)&&sample.endOffsetMs>=sample.startOffsetMs));
 assert.equal(diagnostic.elapsedMs,now);assert.doesNotThrow(()=>JSON.stringify(diagnostic));assert.equal(frames,reads);
});

test('failed compositor frames and state reads keep their phase timing and original errors',async()=>{
 for(const phase of ['frame','read']){
  let now=0;const failure=new Error(`${phase} unavailable`);
  const observed=await settleMapCamera({engine:'tropnik-canvas',clock:()=>now,
   frame:async()=>{now+=10;if(phase==='frame')throw failure;},
   read:async()=>{now+=20;throw failure;},
   wait:async(_label,read)=>read(),
  }).then(()=>null,error=>error);
  assert.equal(observed,failure);const sample=observed.settleDiagnostics.samples[0];
  assert.equal(observed.settleDiagnostics.totalSamples,1);assert.equal(sample.phase,phase);assert.equal(sample.frameMs,10);assert.equal(sample.readMs,phase==='read'?20:null);
  assert.equal(sample.durationMs,phase==='read'?30:10);assert.equal(sample.error,`${phase} unavailable`);
 }
});

test('opt-in terrain tracing covers only the first existing desktop upward4–5 step',()=>{
 const profile={name:'desktop-webgl',engine:'tropnik-canvas',mobile:false};
 for(const zoom of [4,4.9054061044955795,4.999]){
  assert.equal(shouldTraceTerrainZoom(profile,'scene3d',1,zoom,false),false);
  assert.equal(shouldTraceTerrainZoom(profile,'scene3d',1,zoom,false,false),false);
  assert.equal(shouldTraceTerrainZoom(profile,'scene3d',1,zoom,false,true),true);
 }
 for(const zoom of [2,3.999,5,5.905,18,NaN])assert.equal(shouldTraceTerrainZoom(profile,'scene3d',1,zoom,false,true),false);
 assert.equal(shouldTraceTerrainZoom(profile,'scene3d',1,4.905,true,true),false);
 for(const mode of ['detail','satellite',undefined])assert.equal(shouldTraceTerrainZoom(profile,mode,1,4.905,false,true),false);
 assert.equal(shouldTraceTerrainZoom(profile,'scene3d',-1,4.905,false,true),false);
 for(const changed of [{mobile:true},{engine:'unsupported'},{name:'android-portrait'}])assert.equal(shouldTraceTerrainZoom({...profile,...changed},'scene3d',1,4.905,false,true),false);
});
