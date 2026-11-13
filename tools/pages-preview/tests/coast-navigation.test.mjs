import test from 'node:test';
import assert from 'node:assert/strict';
import {COAST_FIXTURES,coastPanPlan,createCoastNavigation} from '../browser-coast-audit.mjs';
import {projectMapPoint} from '../map-projection.mjs';
import {pan,zoomAt} from '../../../web/lib/custom-map-camera.ts';

// Actual Gogland camera and unobscured insets from Pages 43422618701. The
// camera helpers are production code; only delivery of a requested gesture is
// controlled here. Native hit-testing, event delivery and mask acceptance
// remain the browser audit's responsibility.
const source=COAST_FIXTURES.find(fixture=>fixture.id==='gogland').coordinate;
const initial={center:[26.95967506087257,60.06331589470519],zoom:5.621307459879889,bearingDegrees:0};
const rect={left:0,top:68,width:412,height:847,right:412,bottom:915};
const padding={left:24,right:80,top:88,bottom:180};
const anchor={x:(rect.width+padding.left-padding.right)/2,y:(rect.height+padding.top-padding.bottom)/2};
const cameraState=camera=>({longitude:camera.center[0],latitude:camera.center[1],zoom:camera.zoom,tileSize:256,centerX:206,centerY:423.5});
const offset=camera=>{const point=projectMapPoint(source,cameraState(camera),rect);return{x:point.x-206,y:point.y-491.5};};

function fixture({panScale=()=>1,zoomScale=1}={}){
 let camera=structuredClone(initial);const drags=[],zooms=[];
 const read=async()=>({camera:cameraState(camera),rect:{...rect}});
 const zoom=async label=>{
  const direction=label==='Увеличить масштаб'?1:-1;
  assert.ok(['Увеличить масштаб','Уменьшить масштаб'].includes(label));
  camera=zoomAt(camera,rect,camera.zoom+direction*zoomScale,anchor,{minZoom:1,maxZoom:18});zooms.push(label);
 };
 const navigation=createCoastNavigation({read,zoom,mobile:true,context:'observed Gogland',drag:async(delta,context)=>{
  assert.deepEqual(context.coordinate,source,'Navigation must retain the pinned source coordinate');
  assert.ok(Math.abs(delta.dx)<=rect.width*.35+1e-9&&Math.abs(delta.dy)<=rect.height*.3+1e-9);
  const scale=panScale(context),delivered={x:delta.dx*scale,y:delta.dy*scale};
  camera=pan(camera,delivered);drags.push({...context,delta,delivered});
 }});
 return{...navigation,zoom,drags,zooms,get camera(){return structuredClone(camera);}};
}

test('Gogland reaches the same source center and zoom within twelve total correction attempts across six anchored zooms',async()=>{
 const env=fixture(),result=await env.reachZoom(11,source);
 assert.equal(env.zooms.length,6);assert.equal(result.map.camera.zoom,11.621307459879889);
 assert.ok(result.centerErrorPx<.001);assert.deepEqual(source,[26.9596752,60.0633158]);
 assert.ok(Math.abs(result.map.camera.longitude-source[0])<1e-8&&Math.abs(result.map.camera.latitude-source[1])<1e-8);
 assert.equal(env.drags.length,6,'Short native corrections prevent exponential source displacement');
 assert.deepEqual(env.drags.map(drag=>drag.attempt),[0,1,2,3,4,5],'The zoom case shares one correction budget');
 assert.ok(env.drags.every(drag=>drag.leg===0));
});

test('the old six-zoom batch requires thirteen bounded corrections and must still fail the twelve-attempt budget',async()=>{
 const env=fixture();for(let step=0;step<6;step++)await env.zoom('Увеличить масштаб');
 assert.ok(Math.abs(env.camera.center[0]-26.17226858544643)<1e-10&&Math.abs(env.camera.center[1]-60.702588094188826)<1e-10,'Production zoom math reproduces the recorded post-zoom camera');
 const displaced=offset(env.camera);assert.ok(Math.abs(displaced.x-1764)<.001&&Math.abs(displaced.y-2898)<.001);
 await assert.rejects(env.panTo(source),/native panning did not center/);
 assert.equal(env.drags.length,12);assert.deepEqual(env.drags.map(drag=>drag.attempt),Array.from({length:12},(_,index)=>index));
 const remaining=offset(env.camera);assert.ok(Math.abs(Math.hypot(remaining.x,remaining.y)-64.62256070416483)<.001);
 assert.ok(Math.hypot(remaining.x,remaining.y)>6,'The original six-pixel oracle must reject the saved failure');
 const [thirteenth]=coastPanPlan(-remaining.x,-remaining.y,rect,true),corrected=pan(env.camera,{x:thirteenth.dx,y:thirteenth.dy});
 const final=offset(corrected);assert.ok(Math.hypot(final.x,final.y)<.001,'A thirteenth mathematical correction explains the unreachable old sequence, but is not admitted by the controller');
});

test('intermediate centering does not reset the shared twelve-attempt budget and accepts its last successful correction',async()=>{
 for(const slowAttempts of [1,2]){
  const attemptsAtZoom=new Map();
  const env=fixture({panScale:({attempt,before})=>{
   const attempts=attemptsAtZoom.get(before.camera.zoom)||new Set();attempts.add(attempt);attemptsAtZoom.set(before.camera.zoom,attempts);
   return attempts.size<=slowAttempts ? .2 : 1;
  }});
  if(slowAttempts===1){
   const result=await env.reachZoom(11,source);assert.ok(result.centerErrorPx<.001);assert.equal(result.map.camera.zoom,11.621307459879889);assert.equal(env.zooms.length,6);
  }else await assert.rejects(env.reachZoom(11,source),/native panning did not center/);
  assert.deepEqual([...new Set(env.drags.map(drag=>drag.attempt))],Array.from({length:12},(_,index)=>index));
  assert.ok(env.drags.every(drag=>Math.hypot(drag.delivered.x,drag.delivered.y)>3),'Even slow delivery moves the actual camera beyond the unchanged native movement threshold');
  if(slowAttempts===2)assert.ok(env.zooms.length<6,'A new zoom step cannot acquire another twelve corrections');
 }
});

test('wrong pan direction and nonfunctional zoom remain failures under the original navigation limits',async()=>{
 const wrongPan=fixture({panScale:()=>-1});await assert.rejects(wrongPan.reachZoom(11,source),/native panning did not center/);
 assert.equal(new Set(wrongPan.drags.map(drag=>drag.attempt)).size,12);assert.ok(Math.hypot(...Object.values(offset(wrongPan.camera)))>6);
 const wrongZoom=fixture({zoomScale:0});await assert.rejects(wrongZoom.reachZoom(11,source),/native coastline zoom did not reach 11/);
 assert.equal(wrongZoom.zooms.length,28);assert.equal(wrongZoom.drags.length,0);assert.equal(wrongZoom.camera.zoom,initial.zoom);
});
