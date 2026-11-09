import test from 'node:test';
import assert from 'node:assert/strict';
import {assertMapUIBounds,dispatchZoomBurst,settleMapCamera,mapCameraIsMoving} from '../browser-zoom-audit.mjs';

test('rapid zoom uses four serial native presses and releases without camera callbacks',async()=>{
 for(const mobile of [true,false]){
  const calls=[];let dispatching=false;
  const cdp={async call(method,params){
   assert.equal(dispatching,false,'Input commands must finish in order');dispatching=true;
   await Promise.resolve();calls.push({method,...params});dispatching=false;
  }};
  const result=await dispatchZoomBurst(cdp,{x:287,y:189},{mobile},4);
  assert.equal(result.count,4);assert.equal(result.input,mobile?'touch':'mouse');
  assert.ok(Number.isFinite(result.durationMs)&&result.durationMs>=0);
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
 }
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

test('settling observes a queued camera only after compositor progress and consecutive idle samples',async()=>{
 let frames=0,reads=0;const observed=[];
 const state=zoom=>({visible:true,moving:false,engine:'leaflet',camera:{longitude:40,latitude:43,zoom,tileSize:256},rect:{left:0,top:68,width:412,height:847},route:'kavkaz-8a'});
 const result=await settleMapCamera({engine:'leaflet',
  frame:async()=>{frames+=2;},
  read:async()=>{reads++;assert.equal(frames,reads*2,'Every sample must follow compositor frames');const sample=frames<4?state(4.020198667):state(3.270198667);if(frames===4||frames===6)sample.moving=true;observed.push(sample);return sample;},
  wait:async(_label,read,accept,timeout)=>{assert.equal(timeout,15000);for(let index=0;index<12;index++){const sample=await read();if(accept(sample))return sample;}throw new Error('Did not settle');},
 });
 assert.equal(result.camera.zoom,3.270198667,'The stale pre-RAF camera must not become a false lower bound');
 assert.ok(observed.some(item=>item.moving),'An in-progress transition must reset idle stability');
 assert.equal(observed.slice(-4).every(item=>!item.moving&&item.camera.zoom===result.camera.zoom),true);
});

test('a Leaflet child-pane transition remains moving after the old camera dataset clears',()=>{
 let datasetMoving=false,paneAnimating=true;
 const element={
  hasAttribute:name=>name==='data-map-camera'&&datasetMoving,
  classList:{contains:()=>false},
  querySelector:selector=>selector==='.leaflet-map-pane.leaflet-zoom-anim'&&paneAnimating?{className:'leaflet-map-pane leaflet-zoom-anim'}:null,
 };
 assert.equal(mapCameraIsMoving(element),true,'The animation class belongs to the child pane');
 paneAnimating=false;assert.equal(mapCameraIsMoving(element),false);
 datasetMoving=true;assert.equal(mapCameraIsMoving(element),true,'Other camera motion still uses the public dataset');
});
