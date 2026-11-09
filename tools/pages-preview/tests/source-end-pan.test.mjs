import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchSourceEndPan,sourceEndPanPlans,sourceEndsAreFramed} from '../browser-source-end-pan.mjs';
import {CLOSE_TRAIL_FIXTURE} from '../browser-report.mjs';
import {projectMapPoint} from '../map-projection.mjs';

const rect=(left,top,width,height)=>({left,top,width,height,right:left+width,bottom:top+height});
const marker=(left,top)=>({badge:{visible:true,rect:rect(left,top,32,32)},caption:{visible:true,rect:rect(left-16,top+36,64,24)}});
const translate=(frame,plan)=>({...frame,markers:frame.markers.map(item=>Object.fromEntries(Object.entries(item).map(([key,part])=>[key,{...part,rect:rect(part.rect.left+plan.dx,part.rect.top+plan.dy,part.rect.width,part.rect.height)}])))});

test('observed mobile zoom17 footprints can be framed by a bounded pan without moving the source annotations individually',()=>{
 // Original rectangles from candidate92a3604a android-portrait-source-ends-z17.
 const frame={available:rect(0,68,412,691),markers:[marker(-92,-101),marker(-12,317)],overlays:[
  {rect:rect(12,80,280,56)},{rect:rect(12,140,143,44)},{rect:rect(350,140,50,191)},
  {rect:rect(350,343,50,50)},{rect:rect(352,703,44,44)},
 ]};
 assert.equal(sourceEndsAreFramed(frame),false);
 const plans=sourceEndPanPlans(frame);assert.ok(plans.length>0&&plans.length<=25);
 for(const plan of plans){
  assert.equal(sourceEndsAreFramed(translate(frame,plan)),true);
  assert.ok(Math.abs(translate(frame,plan).markers[1].badge.rect.top-translate(frame,plan).markers[0].badge.rect.top-418)<1e-9);
  for(const start of plan.starts)for(const point of [start,{x:start.x+plan.dx,y:start.y+plan.dy}]){
   assert.ok(point.x>=12&&point.x<=400&&point.y>=80&&point.y<=747);
  }
 }
 assert.deepEqual(sourceEndPanPlans(translate(frame,plans[0])),[],'An already framed map must not receive an extra drag');
});

test('desktop framing uses the free horizontal space when full labels nearly fill the map height',()=>{
 const frame={available:rect(399,72,1041,928),markers:[marker(550,-100),marker(710,736)],overlays:[
  {rect:rect(411,84,380,56)},{rect:rect(1326,84,98,52)},{rect:rect(1374,144,50,191)},
 ]};
 const plans=sourceEndPanPlans(frame);assert.ok(plans.length>0);
 for(const plan of plans)assert.equal(sourceEndsAreFramed(translate(frame,plan)),true);
 const short={...frame,available:rect(399,72,1041,700)};
 assert.throws(()=>sourceEndPanPlans(short),/cannot fit at this fixed zoom/,'The audit must not silently lower zoom or move individual source markers');
 const hidden=structuredClone(frame);hidden.markers[0].caption.visible=false;
 assert.throws(()=>sourceEndPanPlans(hidden),/four rendered full annotations/);
});

test('the measured C7 desktop toolbar gap admits both full source annotations at zoom17',()=>{
 // Exact UI bounds from C7 desktop-webgl.json. The canonical source geometry
 // is projected at zoom17; no browser or map API is substituted by this test.
 const available=rect(384,72,1041,928),camera={longitude:40.69132455927737,latitude:45.54159484685463,zoom:17,tileSize:512};
 const frame={available,markers:CLOSE_TRAIL_FIXTURE.endpoints.map(coordinate=>{
  const point=projectMapPoint(coordinate,camera,available);return marker(point.x-16,point.y-16);
 }),overlays:[
  {kind:'map-context',rect:rect(408,96,482.0625,56)},
  {kind:'map-style-switch',rect:rect(1105.90625,96,295.09375,54)},
  {kind:'map-controls',rect:rect(1349,160,52,235)},
  {kind:'layer-button',rect:rect(1307.5625,872,93.4375,44)},
  {kind:'map-legend',rect:rect(409,957,490.765625,16)},
  {kind:'map-attribution-toggle',rect:rect(1357,940,44,44)},
  {kind:'fact-closed',rect:rect(408,866,142.921875,44)},
 ]};
 const plans=sourceEndPanPlans(frame);assert.ok(plans.length>0&&plans.length<=25);
 for(const plan of plans){
  const final=translate(frame,plan);assert.equal(sourceEndsAreFramed(final),true);
  const first=final.markers[0].caption.rect;
  assert.ok(first.left>=890.0625&&first.right<=1105.90625,'A caption fits the actual gap between context and style controls');
 }
});

test('source-end pan emits only one bounded native gesture and holds before releasing',async()=>{
 for(const mobile of [true,false]){
  const calls=[],pauses=[];
  const receipt=await dispatchSourceEndPan({async call(method,params){calls.push({method,...params});}},{x:80,y:240},{dx:242,dy:345},{mobile},async ms=>pauses.push(ms));
  assert.equal(calls.length,mobile?14:15);assert.equal(receipt.commands.length,calls.length);
  assert.deepEqual(pauses,[...Array(12).fill(25),200]);
  assert.ok(receipt.commands.every(command=>command.status==='fulfilled'));
  if(mobile){
   assert.deepEqual(calls.map(call=>call.type),['touchStart',...Array(12).fill('touchMove'),'touchEnd']);
   assert.ok(calls.every(call=>call.method==='Input.dispatchTouchEvent'));assert.deepEqual(calls.at(-1).touchPoints,[]);
   assert.equal(calls.at(-2).touchPoints[0].x,322);assert.equal(calls.at(-2).touchPoints[0].y,585);
  }else{
   assert.deepEqual(calls.map(call=>call.type),['mouseMoved','mousePressed',...Array(12).fill('mouseMoved'),'mouseReleased']);
   assert.ok(calls.every(call=>call.method==='Input.dispatchMouseEvent'));assert.equal(calls.at(-1).buttons,0);
   assert.equal(calls.at(-1).x,322);assert.equal(calls.at(-1).y,585);
  }
 }
});

test('a failed native move is reported and the pointer is still released without another pan',async()=>{
 const calls=[];
 const error=await dispatchSourceEndPan({async call(method,params){calls.push({method,...params});if(calls.length===4)throw new Error('Fixture move failed');}},{x:50,y:250},{dx:210,dy:200},{mobile:true},async()=>{}).catch(value=>value);
 assert.match(error.message,/Fixture move failed/);assert.equal(calls.length,5);assert.equal(calls.at(-1).type,'touchEnd');
 assert.equal(error.panDiagnostics.commands[3].status,'rejected');assert.equal(error.panDiagnostics.commands.at(-1).status,'fulfilled');
});
