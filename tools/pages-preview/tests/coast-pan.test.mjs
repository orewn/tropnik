import test from 'node:test';
import assert from 'node:assert/strict';
import {coastPanPlan,assertCoastPanInput,inspectCoastPanSelection} from '../browser-coast-audit.mjs';
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

function releaseClick(pan){
 const up=pan.events.find(event=>event.type==='pointerup');
 return{type:'click',time:up.time+1,trusted:true,pointerType:'mouse',pointerId:up.pointerId,x:Math.floor(pan.end.x),y:Math.floor(pan.end.y),target:'CANVAS[tropnik-map-canvas]',button:null};
}

test('coastline proof keeps native touch pans free of taps and requires actual camera displacement',()=>{
 for(const [profile,input] of [['android-portrait','touch'],['desktop-webgl','mouse']]){
  const pan=coastFixture(profile,'tropnik-canvas').pans[0];
  assert.equal(assertCoastPanInput(pan,input,'fixture'),true);
  if(input==='touch'){
   const tap=structuredClone(pan);tap.events.push({...releaseClick(tap),pointerType:input});
   assert.throws(()=>assertCoastPanInput(tap,input,'fixture'),/tap cannot count/);
  }
  const stationary=structuredClone(pan);stationary.after=structuredClone(stationary.before);
  assert.throws(()=>assertCoastPanInput(stationary,input,'fixture'),/did not move the actual camera/);
  const noCamera=structuredClone(pan);delete noCamera.after;
  assert.throws(()=>assertCoastPanInput(noCamera,input,'fixture'),/camera evidence is missing/);
 }
});

test('a browser mouse click after a delivered drag is valid only with an unchanged selection and layer',()=>{
 const pan=coastFixture('desktop-webgl','tropnik-canvas').pans[0];pan.events.push(releaseClick(pan));
 assert.equal(assertCoastPanInput(pan,'mouse','native desktop drag'),true);
 for(const mutate of [
  value=>{value.after=structuredClone(value.before);},
  value=>{value.delta={dx:0,dy:0};value.end={...value.start};},
  value=>{value.commands.splice(3,1);},
  value=>{value.events[0].trusted=false;},
  value=>{value.events[1].pointerId++;},
  value=>{value.events.at(-1).trusted=false;},
  value=>{value.events.at(-1).pointerId++;},
  value=>{value.events.at(-1).time=value.events[0].time;},
  value=>{const click=value.events.pop();value.events.splice(1,0,click);},
  value=>{value.events.at(-1).x+=20;},
  value=>{value.events.at(-1).target='BUTTON[trail-marker]';},
  value=>{value.events.at(-1).button={trailId:'accidental'};},
  value=>{value.events.push({...value.events.at(-1)});},
  value=>{delete value.before.selection;},
  value=>{delete value.before.selection.pathname;},
  value=>{value.after.selection.pathname='';},
  value=>{value.after.selection.pathname=17;},
  ...['region','route','routeId','drawnRoute','mode','committedMode'].map(key=>value=>{value.after.selection[key]=key.includes('Mode')||key==='mode'?'overview':'unexpected-selection';}),
 ]){
  const broken=structuredClone(pan);mutate(broken);
  assert.throws(()=>assertCoastPanInput(broken,'mouse','invalid drag'));
 }
});

test('a coastline pan cannot navigate path routes when both URL search selections are empty',()=>{
 const pan=coastFixture('desktop-webgl','tropnik-canvas').pans[0];pan.events.push(releaseClick(pan));
 for(const frame of [pan.before,pan.after])Object.assign(frame.selection,{pathname:'/tropnik/regions/coast/',region:'',route:''});
 assert.equal(assertCoastPanInput(pan,'mouse','path route drag'),true);
 pan.after.selection.pathname='/tropnik/routes/route-1/';
 assert.throws(()=>assertCoastPanInput(pan,'mouse','unexpected path navigation'),/changed the pathname/);
});

test('pan selection receipts read URL selection and rendered route/layer state without application access',()=>{
 const map={dataset:{mapRouteId:'route-1',mapDrawnRoute:'route-1'}},wrap={dataset:{mapBaseTarget:'satellite',mapBaseCommitted:'satellite'}};
 const doc={querySelector:selector=>selector==='.atlas-wrap'?wrap:map};
 assert.deepEqual(inspectCoastPanSelection(doc,{pathname:'/tropnik/explore/',search:'?region=coast&route=route-1'}),{pathname:'/tropnik/explore/',region:'coast',route:'route-1',routeId:'route-1',drawnRoute:'route-1',mode:'satellite',committedMode:'satellite'});
 assert.deepEqual(inspectCoastPanSelection(doc,{pathname:'/tropnik/routes/route-1/',search:''}),{pathname:'/tropnik/routes/route-1/',region:'',route:'',routeId:'route-1',drawnRoute:'route-1',mode:'satellite',committedMode:'satellite'});
 assert.equal(inspectCoastPanSelection({querySelector:()=>null},{search:''}),null);
});
