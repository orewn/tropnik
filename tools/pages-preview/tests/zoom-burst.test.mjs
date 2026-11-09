import test from 'node:test';
import assert from 'node:assert/strict';
import {assertMapUIBounds,dispatchZoomBurst} from '../browser-zoom-audit.mjs';

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
