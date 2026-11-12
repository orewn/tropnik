import test from 'node:test';
import assert from 'node:assert/strict';
import {TERRAIN_DISPLAY_BOUNDS,openingTerrainView,planTerrainNavigation} from '../lib/terrain-navigation.ts';
import {TerrainRenderer} from '../public/terrain/terrain-renderer.js';

const desktop={width:1280,height:800},phone={width:390,height:844};
const near=(a,b,tolerance=1e-8)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);
const view={longitude:90,latitude:55,yaw:0,pitch:.85,distanceM:5000};
const tiny=[89.999,54.999,90.001,55.001];
function inside(bounds,longitude,latitude){return longitude>=bounds[0]-1e-8&&longitude<=bounds[2]+1e-8&&latitude>=bounds[1]-1e-8&&latitude<=bounds[3]+1e-8;}

test('opening view centres the existing 2D context and changes physical scale for portrait aspect',()=>{
  const bounds=[142.68,46.95,142.91,47.12],wide=openingTerrainView(bounds,desktop),narrow=openingTerrainView(bounds,phone);
  near(wide.longitude,142.795);near(wide.latitude,47.035);assert.equal(wide.pitch,.85);assert.equal(wide.yaw,0);
  assert.ok(wide.distanceM>1000&&wide.distanceM<50000);assert.ok(narrow.distanceM>wide.distanceM);
  const result=planTerrainNavigation(wide,bounds,desktop,30);assert.ok(result);
  assert.equal(planTerrainNavigation(result.view,result.bounds,desktop,30),null,'the first complete source envelope settles');
});

test('requested windows contain independently traced frustum ground intersections at all bearings',()=>{
  const metres=6371008.8*Math.PI/180;
  for(const viewport of[desktop,phone])for(const pitch of[.5,.85,1.25])for(const yaw of[0,.8,Math.PI/2,Math.PI]){
    const input={...view,yaw,pitch},plan=planTerrainNavigation(input,tiny,viewport,30);assert.ok(plan);
    // Trace corner rays in the camera basis, then intersect world Z=0. This is
    // independent of the planner's simplified physical-footprint equations.
    const toward=[Math.sin(yaw)*Math.cos(pitch),-Math.cos(yaw)*Math.cos(pitch),Math.sin(pitch)];
    const right=[Math.cos(yaw),Math.sin(yaw),0],up=[-Math.sin(yaw)*Math.sin(pitch),Math.cos(yaw)*Math.sin(pitch),Math.cos(pitch)];
    const eye=toward.map(value=>value*input.distanceM),tan=Math.tan(21*Math.PI/180);
    for(const vertical of[-1,1])for(const horizontal of[-1,1]){
      const ray=toward.map((value,i)=>right[i]*horizontal*tan*viewport.width/viewport.height+up[i]*vertical*tan-value);
      const t=-eye[2]/ray[2],ground=eye.map((value,i)=>value+t*ray[i]);
      const longitude=input.longitude+ground[0]/(metres*Math.cos(input.latitude*Math.PI/180)),latitude=input.latitude+ground[1]/metres;
      assert.ok(inside(plan.bounds,longitude,latitude),JSON.stringify({pitch,yaw,viewport,longitude,latitude,bounds:plan.bounds}));
    }
    assert.equal(planTerrainNavigation(plan.view,plan.bounds,viewport,30),null);
  }
});

test('initial source coverage includes the real renderer full canvas after asymmetric HUD and sheet insets',t=>{
  const originalRAF=globalThis.requestAnimationFrame,originalCancel=globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};
  t.after(()=>{if(originalRAF===undefined)delete globalThis.requestAnimationFrame;else globalThis.requestAnimationFrame=originalRAF;if(originalCancel===undefined)delete globalThis.cancelAnimationFrame;else globalThis.cancelAnimationFrame=originalCancel;});
  const context=[142.78,46.95,142.83,47];
  for(const viewport of[
    {...desktop,insets:{top:176,right:80,bottom:64,left:32}},
    {...phone,insets:{top:192,right:64,bottom:64,left:16}},
    {...phone,insets:{top:192,right:16,bottom:400,left:16}},
    {width:844,height:390,insets:{top:64,right:64,bottom:64,left:16}},
  ])for(const yaw of[0,.8,Math.PI/2]){
    const initial={...openingTerrainView(context,viewport),yaw},planned=planTerrainNavigation(initial,context,viewport,30);assert.ok(planned);
    const grid={bounds:planned.bounds,width:9,height:9,elevations:Array(81).fill(300)};
    const canvas={style:{},dataset:{},getBoundingClientRect:()=>viewport,getContext:()=>({}),addEventListener(){},removeEventListener(){}};
    const renderer=new TerrainRenderer(canvas,grid,{navigation:'map',forceCanvas:true,compactViewport:true,viewportInsets:viewport.insets,initialView:initial});
    try{
      near(renderer.getView().distanceM,initial.distanceM,1e-5);
      for(const [x,y]of[[0,0],[viewport.width,0],[0,viewport.height],[viewport.width,viewport.height]]){
        const point=renderer.unproject(x,y);
        assert.ok(point,JSON.stringify({viewport,yaw,x,y,bounds:planned.bounds}));
        near(point.elevationM,300,1e-5);
      }
      assert.equal(planTerrainNavigation(renderer.getView(),planned.bounds,viewport,30),null,'the actual completed projection must settle without another source window');
    }finally{renderer.destroy();}
  }
});

test('sheet and viewport changes require new coverage even when camera distance and target are preserved',()=>{
  const firstViewport={...phone,insets:{top:192,right:64,bottom:64,left:16}},view={longitude:142.8,latitude:46.98,yaw:0,pitch:.85,distanceM:5000};
  const first=planTerrainNavigation(view,[142.799,46.979,142.801,46.981],firstViewport,30);assert.ok(first);
  const sheetViewport={...phone,insets:{top:192,right:16,bottom:400,left:16}},next=planTerrainNavigation(view,first.bounds,sheetViewport,30);
  assert.ok(next,'the full-canvas rays change when a translated sheet changes the camera projection');
  near(next.view.distanceM,view.distanceM);near(next.view.longitude,view.longitude);near(next.view.latitude,view.latitude);
  assert.equal(planTerrainNavigation(next.view,next.bounds,sheetViewport,30),null);
});

test('guard and resolution hysteresis avoid reloads on jitter, and refine only when useful',()=>{
  const first=planTerrainNavigation(view,tiny,desktop,200),span=first.bounds[2]-first.bounds[0];
  assert.ok(first);assert.equal(planTerrainNavigation({...first.view,longitude:first.view.longitude+span*.01},first.bounds,desktop,200),null);
  assert.equal(planTerrainNavigation({...first.view,distanceM:first.view.distanceM*.8},first.bounds,desktop,200),null);
  const refined=planTerrainNavigation({...first.view,distanceM:first.view.distanceM*.45},first.bounds,desktop,200);assert.ok(refined);
  assert.ok(refined.bounds[2]-refined.bounds[0]<(first.bounds[2]-first.bounds[0])*.55);
  assert.equal(planTerrainNavigation(refined.view,refined.bounds,desktop,60),null,'a loaded envelope cannot immediately ask for itself again');
  const moved=planTerrainNavigation({...first.view,longitude:first.view.longitude+span*.3},first.bounds,desktop,200);assert.ok(moved);
  assert.ok(moved.bounds[0]>first.bounds[0]);
});

test('a native regional grid larger than the request is reused at deep zoom and reloads only when coverage leaves it',()=>{
  const regional=[142.6,46.9,143,47.2],native={...view,longitude:142.8,latitude:47.05,distanceM:600};
  for(const distanceM of[600,200,60])for(const longitude of[142.68,142.8,142.9]){
    assert.equal(planTerrainNavigation({...native,longitude,distanceM},regional,desktop,30),null,'native30m detail is not created by repeated smaller requests');
  }
  const outside=planTerrainNavigation({...native,longitude:143.04},regional,desktop,30);assert.ok(outside);assert.ok(outside.bounds[2]>regional[2]);
});

test('dateline longitudes remain adjacent within the continuous Russia extent and no window requests outside it',()=>{
  const wrapped=openingTerrainView([179.8,65,-179.8,65.2],desktop);near(wrapped.longitude,180);
  const east={...view,longitude:-175,latitude:66,distanceM:5000};
  const result=planTerrainNavigation(east,[184.99,65.99,185.01,66.01],desktop,30);assert.ok(result);near(result.view.longitude,185);
  assert.ok(result.bounds[0]>180&&result.bounds[2]<191.01);
  for(const longitude of[-500,20,190,500])for(const latitude of[-80,42,81,89]){
    const plan=planTerrainNavigation({...view,longitude,latitude,distanceM:1e8},TERRAIN_DISPLAY_BOUNDS,desktop,2000);assert.ok(plan);
    for(const index of[0,1])assert.ok(plan.bounds[index]>=TERRAIN_DISPLAY_BOUNDS[index]);
    for(const index of[2,3])assert.ok(plan.bounds[index]<=TERRAIN_DISPLAY_BOUNDS[index]);
    assert.ok(inside(TERRAIN_DISPLAY_BOUNDS,plan.view.longitude,plan.view.latitude));
    assert.equal(planTerrainNavigation(plan.view,plan.bounds,desktop,2000),null,'clamped country coverage must not reload forever');
  }
});

test('country overview is stable, zooms can reach local detail, and horizon coverage is finite',()=>{
  let bounds=[...TERRAIN_DISPLAY_BOUNDS],current=openingTerrainView(bounds,desktop),updates=0;
  assert.equal(planTerrainNavigation(current,bounds,desktop),null);
  for(let i=0;i<12;i++){
    current={...current,longitude:90,latitude:55,distanceM:current.distanceM/2};
    const plan=planTerrainNavigation(current,bounds,desktop);if(plan){bounds=plan.bounds;current=plan.view;updates++;}
  }
  assert.ok(updates>=5);assert.ok(bounds[2]-bounds[0]<2);assert.ok(bounds[3]-bounds[1]<2);
  const low=planTerrainNavigation({...view,pitch:.28},tiny,desktop,30);assert.ok(low);assert.ok(low.bounds.every(Number.isFinite));
  assert.ok(low.bounds[2]-low.bounds[0]<10&&low.bounds[3]-low.bounds[1]<10);
  assert.equal(planTerrainNavigation(low.view,low.bounds,desktop,30),null);
});

test('navigation rejects malformed geometry, dimensions, camera input and source spacing before requesting data',()=>{
  for(const viewport of[{width:0,height:400},{width:400,height:NaN},{width:Infinity,height:300}])assert.throws(()=>openingTerrainView(tiny,viewport),/viewport/);
  for(const bounds of[[1,2,1,3],[10,0,11,1],[80,86,81,87],[NaN,50,90,51]])assert.throws(()=>openingTerrainView(bounds,desktop),/bounds|finite|display/);
  for(const invalid of[{...view,distanceM:0},{...view,distanceM:NaN},{...view,longitude:Infinity}])assert.throws(()=>planTerrainNavigation(invalid,tiny,desktop),/view/);
  for(const spacing of[0,-1,Infinity,NaN])assert.throws(()=>planTerrainNavigation(view,tiny,desktop,spacing),/spacing/);
});
