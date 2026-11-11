import test from 'node:test';
import assert from 'node:assert/strict';
import {coastPanPlan,assertCoastPanInput} from '../browser-coast-audit.mjs';
import {projectMapPoint,unprojectMapPoint} from '../map-projection.mjs';
import {coastFixture} from './coast-fixture.mjs';

test('the observed Primorsk touch residual is corrected by two deliberate drags at the same zoom',()=>{
 const rect={left:0,top:68,width:412,height:847};
 let camera={longitude:28.589456866727573,latitude:60.35932599053769,zoom:9.371307459879883,tileSize:256};
 const coordinate=[28.6069513,60.3623846],center={x:206,y:491.5},point=projectMapPoint(coordinate,camera,rect);
 const dx=center.x-point.x,dy=center.y-point.y;
 assert.ok(Math.abs(Math.hypot(dx,dy)-8.738865834905365)<1e-7,'use the exact failed CI camera and source vertex');
 const plan=coastPanPlan(dx,dy,rect,true);
 assert.equal(plan.length,2);
 for(const [leg,planned] of plan.entries()){
  let delta=planned;
  if(leg===0)delta={dx:planned.dx*1.25,dy:planned.dy*1.25};
  else{
   // The return must use the observed camera even if the first native drag
   // moved 25% farther than requested; adding the original vector would fail.
   const actual=projectMapPoint(coordinate,camera,rect);
   [delta]=coastPanPlan(center.x-actual.x,center.y-actual.y,rect,false);
  }
  assert.ok(Math.hypot(delta.dx,delta.dy)>=48-1e-9,'each gesture crosses native touch slop with room to spare');
  assert.ok(Math.abs(delta.dx)<=rect.width*.35&&Math.abs(delta.dy)<=rect.height*.3);
  const next=unprojectMapPoint({x:center.x-delta.dx,y:center.y-delta.dy},camera,rect);
  camera={...camera,longitude:next[0],latitude:next[1]};
 }
 const final=projectMapPoint(coordinate,camera,rect);
 assert.ok(Math.hypot(final.x-center.x,final.y-center.y)<.001,'the paired translations retain the exact centering target');
 assert.equal(camera.zoom,9.371307459879883);
});

test('large coastal corrections remain bounded and mouse corrections need no touch approach',()=>{
 const rect={width:412,height:847};
 const far=coastPanPlan(900,-700,rect,true);assert.equal(far.length,1);
 assert.ok(Math.abs(far[0].dx)<=rect.width*.35&&Math.abs(far[0].dy)<=rect.height*.3);
 assert.deepEqual(coastPanPlan(-8.239141978112627,2.9127848435781516,rect,false),[{dx:-8.239141978112627,dy:2.9127848435781516}]);
});

test('coastline proof rejects native taps and stationary cameras even when commands were acknowledged',()=>{
 for(const [profile,input] of [['android-portrait','touch'],['desktop-webgl','mouse']]){
  const pan=coastFixture(profile,'tropnik-canvas').pans[0];
  assert.equal(assertCoastPanInput(pan,input,'fixture'),true);
  const tap=structuredClone(pan);tap.events.push({type:'click',trusted:true,pointerType:input});
  assert.throws(()=>assertCoastPanInput(tap,input,'fixture'),/tap cannot count/);
  const stationary=structuredClone(pan);stationary.after=structuredClone(stationary.before);
  assert.throws(()=>assertCoastPanInput(stationary,input,'fixture'),/did not move the actual camera/);
  const noCamera=structuredClone(pan);delete noCamera.after;
  assert.throws(()=>assertCoastPanInput(noCamera,input,'fixture'),/camera evidence is missing/);
 }
});
