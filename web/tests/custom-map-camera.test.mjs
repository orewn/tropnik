import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
 CUSTOM_MAP_TILE_SIZE,MERCATOR_MAX_LATITUDE,longitudeNear,mercatorProject,mercatorUnproject,
 project,unproject,projectPath,pan,zoomAt,rotateAt,fitBounds,continuousBounds,cameraBounds,pinch,
 CustomMapPointerSession,normalizeWheelDelta,wheelZoomDelta,keyboardCameraAction,
 pointToSegment,hitPolyline,hitPolygon,hitGeometry,
} from '../lib/custom-map-camera.ts';

const near=(actual,expected,epsilon=1e-7)=>assert.ok(Math.abs(actual-expected)<=epsilon,`${actual} differs from ${expected}`);
const samePoint=(actual,expected,epsilon=1e-6)=>{near(actual.x,expected.x,epsilon);near(actual.y,expected.y,epsilon);};
const sameCamera=(actual,expected)=>{near(actual.zoom,expected.zoom);near(actual.center[0],expected.center[0]);near(actual.center[1],expected.center[1]);near(actual.bearingDegrees??0,expected.bearingDegrees??0);};
const viewport={width:412,height:847};
const camera={center:[179.4,62],zoom:6.35,bearingDegrees:37};

test('unit Mercator keeps exact world copies and finite polar limits',()=>{
 assert.equal(CUSTOM_MAP_TILE_SIZE,256);
 assert.deepEqual(mercatorProject([0,0]),{x:.5,y:.5});
 near(mercatorProject([180,90]).y,0);near(mercatorProject([-180,-90]).y,1);
 assert.equal(mercatorProject([540,0]).x,2);
 near(mercatorUnproject({x:2,y:0})[0],540);near(mercatorUnproject({x:2,y:0})[1],MERCATOR_MAX_LATITUDE);
 assert.equal(longitudeNear(-169,105),191);
 assert.equal(longitudeNear(191,-175),-169);
 for(const coordinate of [[NaN,0],[0,Infinity],[]])assert.throws(()=>mercatorProject(coordinate),RangeError);
});

test('bearing rotates geographic directions consistently and does not apply DPR',()=>{
 const view={width:1000,height:800},northUp={center:[0,0],zoom:2};
 samePoint(project(northUp,view,[1,0]),{x:500+1024/360,y:400});
 samePoint(project({...northUp,bearingDegrees:90},view,[1,0]),{x:500,y:400-1024/360});
 const north=project({...northUp,bearingDegrees:90},view,[0,1]);
 assert.ok(north.x<500);near(north.y,400);
 samePoint(project({...northUp,bearingDegrees:450},view,[1,0]),project({...northUp,bearingDegrees:90},view,[1,0]));
});

test('screen/geographic conversions roundtrip fractional zoom, bearing and dateline',()=>{
 for(const zoom of [1.2,6.35,14.75,18])for(const bearingDegrees of [-179,-45,0,37,90,179]){
  const value={...camera,zoom,bearingDegrees};
  for(const point of [{x:0,y:0},{x:206.125,y:423.875},{x:411.5,y:846.5}]){
   const geographic=unproject(value,viewport,point);
   if(Math.abs(geographic[1])<=MERCATOR_MAX_LATITUDE)samePoint(project(value,viewport,geographic,{wrapLongitude:false}),point,2e-6);
  }
 }
 const east=project({center:[180,0],zoom:5},viewport,[-179,0]),west=project({center:[180,0],zoom:5},viewport,[179,0]);
 near(east.x-west.x,256*2**5*2/360);
});

test('a dateline route remains a short connected path, with an explicit unwrapped mode for masks',()=>{
 const view={width:900,height:600},c={center:[0,0],zoom:2};
 const path=projectPath(c,view,[[179,1],[-179,1],[-177,1]]);
 near(path[1].x-path[0].x,1024*2/360);near(path[2].x-path[1].x,1024*2/360);
 const mask=projectPath(c,view,[[-180,0],[180,0]],{wrapLongitude:false});
 near(mask[1].x-mask[0].x,1024);
});

test('panning and zoom/rotation anchors preserve geographic pixels at every bearing',()=>{
 const marker=[179.7,62.15],delta={x:37.25,y:-23.125},anchor={x:54.25,y:203.75};
 for(const bearingDegrees of [0,42,90,-135]){
  const c={...camera,bearingDegrees},before=project(c,viewport,marker),moved=pan(c,delta);
  samePoint(project(moved,viewport,marker),{x:before.x+delta.x,y:before.y+delta.y});
  const fixed=unproject(c,viewport,anchor);
  for(const target of [2,10,25]){
   const next=zoomAt(c,viewport,target,anchor,{minZoom:4,maxZoom:12});
   near(next.zoom,Math.min(12,Math.max(4,target)));samePoint(project(next,viewport,fixed),anchor);
  }
  samePoint(project(rotateAt(c,viewport,bearingDegrees+71,anchor),viewport,fixed),anchor);
 }
 let moved=camera;
 for(let i=0;i<1000;i++)moved=pan(moved,{x:.125,y:-.0625});
 sameCamera(moved,pan(camera,{x:125,y:-62.5}));
});

test('all 85 real territorial frames fit the unoccluded screen, also when rotated',()=>{
 const territories=JSON.parse(readFileSync(new URL('../lib/territories.generated.json',import.meta.url))).territories;
 assert.equal(territories.length,85);
 const padding={left:24,right:80,top:88,bottom:536};
 for(const bearingDegrees of [0,35,90,165])for(const territory of territories){
  const c=fitBounds(territory.bounds,viewport,{padding,bearingDegrees,maxZoom:11,referenceLongitude:105});
  assert.ok(c.zoom<=11);
  const [w,s,e,n]=continuousBounds(territory.bounds,105);
  for(const point of [[w,s],[w,n],[e,s],[e,n]]){
   const p=project(c,viewport,point,{wrapLongitude:false});
   assert.ok(p.x>=padding.left-1e-6&&p.x<=viewport.width-padding.right+1e-6,`${territory.name} horizontal fit at ${bearingDegrees}`);
   assert.ok(p.y>=padding.top-1e-6&&p.y<=viewport.height-padding.bottom+1e-6,`${territory.name} vertical fit at ${bearingDegrees}`);
  }
 }
});

test('dateline fits preserve the declared span and empty bounds use a finite maxZoom',()=>{
 const a=fitBounds([170,50,-170,60],viewport,{padding:30,maxZoom:12});
 const b=fitBounds([170,50,190,60],viewport,{padding:30,maxZoom:12});
 sameCamera(a,b);near(a.center[0],180);
 sameCamera(fitBounds([170,50,-170,60],viewport,{referenceLongitude:-175}),fitBounds([-190,50,-170,60],viewport));
 assert.ok(fitBounds([-170,-10,170,10],viewport).zoom<fitBounds([170,-10,-170,10],viewport).zoom-3);
 const point=fitBounds([180,60,180,60],viewport,{maxZoom:13,padding:{bottom:300}});
 near(point.zoom,13);samePoint(project(point,viewport,[180,60]),{x:206,y:(847-300)/2});
 assert.throws(()=>fitBounds([0,2,1,1],viewport),RangeError);
 assert.throws(()=>fitBounds([0,0,1,1],viewport,{padding:{left:300,right:200}}),RangeError);
 assert.throws(()=>zoomAt(camera,viewport,7,undefined,{minZoom:9,maxZoom:8}),RangeError);
});

test('rotated camera bounds include all corners in one continuous world',()=>{
 const c={...camera,zoom:4.2,bearingDegrees:51},bounds=cameraBounds(c,viewport);
 assert.ok(bounds[2]>180);assert.ok(bounds[2]-bounds[0]<180);
 for(const p of [{x:0,y:0},{x:412,y:0},{x:412,y:847},{x:0,y:847}]){
  const [lng,lat]=unproject(c,viewport,p);
  assert.ok(lng>=bounds[0]-1e-9&&lng<=bounds[2]+1e-9&&lat>=bounds[1]-1e-9&&lat<=bounds[3]+1e-9);
 }
});

test('landscape bounds use the framed visible rectangle without including the covered mobile sheet',()=>{
 const view={width:373,height:774},padding={left:24,right:80,top:88,bottom:525};
 const routeBounds=[86.2,50.1,86.3,50.13],fitted=fitBounds(routeBounds,view,{padding,maxZoom:18}),before=structuredClone(fitted);
 const full=cameraBounds(fitted,view),visible=cameraBounds(fitted,view,padding);
 for(const coordinate of [[routeBounds[0],routeBounds[1]],[routeBounds[2],routeBounds[3]]]){
  assert.ok(coordinate[0]>=visible[0]-1e-9&&coordinate[0]<=visible[2]+1e-9);
  assert.ok(coordinate[1]>=visible[1]-1e-9&&coordinate[1]<=visible[3]+1e-9);
 }
 const height=bounds=>mercatorProject([0,bounds[1]]).y-mercatorProject([0,bounds[3]]).y;
 near(height(visible)/height(full),(774-88-525)/774,1e-8);
 assert.ok(height(visible)<height(full)/4,'The covered sheet must not enlarge the terrain grid');
 samePoint(project(fitted,view,[visible[0],visible[3]]),{x:24,y:88});
 samePoint(project(fitted,view,[visible[2],visible[1]]),{x:293,y:249});
 assert.deepEqual(fitted,before,'Reading a landscape crop must not refit the source camera');
 for(const bearingDegrees of [0,37,90]){
  const c={center:[179.9,66],zoom:7.25,bearingDegrees},bounds=cameraBounds(c,view,padding);
  const corners=[{x:24,y:88},{x:293,y:88},{x:293,y:249},{x:24,y:249}].map(p=>unproject(c,view,p));
  [Math.min(...corners.map(p=>p[0])),Math.min(...corners.map(p=>p[1])),Math.max(...corners.map(p=>p[0])),Math.max(...corners.map(p=>p[1]))].forEach((value,index)=>near(bounds[index],value));
  assert.ok(bounds[2]>bounds[0]&&bounds[2]-bounds[0]<3,'The crop stays in one continuous dateline world');
 }
 assert.deepEqual(cameraBounds(fitted,view,{}),full);
 assert.throws(()=>cameraBounds(fitted,view,{bottom:774}),RangeError);
 assert.throws(()=>cameraBounds(fitted,view,{top:-1}),RangeError);
});

test('pinch translates its centroid and clamps zoom without losing the anchor',()=>{
 const start=[{x:100,y:220},{x:260,y:220}],current=[{x:80,y:280},{x:400,y:280}];
 const anchor=unproject(camera,viewport,{x:180,y:220});
 const next=pinch(camera,viewport,start,current,{maxZoom:7});
 near(next.zoom,7);samePoint(project(next,viewport,anchor),{x:240,y:280});
 const rotated=pinch(camera,viewport,start,[{x:180,y:140},{x:180,y:300}],{},true);
 near(rotated.zoom,camera.zoom);near(rotated.bearingDegrees,camera.bearingDegrees-90);
 samePoint(project(rotated,viewport,anchor),{x:180,y:220});
 const coincident=pinch(camera,viewport,[{x:200,y:300},{x:200,y:300}],[{x:201,y:302},{x:201,y:302}]);
 assert.ok(Number.isFinite(coincident.zoom));sameCamera(coincident,pan(camera,{x:1,y:2}));
});

test('native pointer transitions retain ownership and rebase without one-finger jumps',()=>{
 const session=new CustomMapPointerSession({minZoom:2,maxZoom:12});
 session.begin(1,{x:100,y:200},camera,viewport);
 const dragged=session.move(1,{x:120,y:230});sameCamera(dragged,pan(camera,{x:20,y:30}));
 session.begin(2,{x:280,y:230},dragged,viewport);
 sameCamera(session.move(2,{x:280,y:230}),dragged);
 const zoomed=session.move(2,{x:360,y:230});near(zoomed.zoom,dragged.zoom+Math.log2(1.5));
 session.end(1);
 sameCamera(session.move(2,{x:360,y:230}),zoomed);
 sameCamera(session.move(2,{x:365.5,y:226.5}),pan(zoomed,{x:5.5,y:-3.5}));
 const current=session.move(2,{x:365.5,y:226.5});
 session.begin(3,{x:190,y:420},current,viewport);
 session.begin(4,{x:30,y:40},current,viewport);
 assert.equal(session.move(4,{x:100,y:120}),undefined,'third contact does not change the active pair');
 session.end(2);
 sameCamera(session.move(4,{x:100,y:120}),current,'new active pair starts at its current positions');
 session.cancel();assert.equal(session.activePointers,0);assert.equal(session.move(3,{x:200,y:400}),undefined);
 session.begin(7,{x:10,y:10},camera,viewport);sameCamera(session.move(7,{x:10,y:10}),camera);
 session.end(7);assert.equal(session.activePointers,0);
});

test('wheel delta modes agree and keyboard moves in screen axes at a rotated bearing',()=>{
 near(normalizeWheelDelta(3,1),48);near(normalizeWheelDelta(.06,2,800),48);
 near(wheelZoomDelta(48),wheelZoomDelta(3,1));near(wheelZoomDelta(48),-.1);
 assert.throws(()=>normalizeWheelDelta(1,3),RangeError);
 const c={...camera,bearingDegrees:90},marker=project(c,viewport,c.center);
 samePoint(project(keyboardCameraAction(c,viewport,'ArrowLeft',{panPixels:36.5}),viewport,c.center),{x:marker.x+36.5,y:marker.y});
 near(keyboardCameraAction(c,viewport,'+',{zoomStep:.25,maxZoom:6.5}).zoom,6.5);
 near(keyboardCameraAction(c,viewport,'PageDown',{zoomStep:.5,minZoom:6}).zoom,6);
 assert.equal(keyboardCameraAction(c,viewport,'Tab'),undefined);
});

test('segment hit distance is exact in CSS pixels and disconnected source parts stay separate',()=>{
 assert.deepEqual(pointToSegment({x:5,y:3},{x:0,y:0},{x:10,y:0}),{distance:3,fraction:.5,point:{x:5,y:0}});
 assert.equal(hitPolyline({x:5,y:3},[{x:0,y:0},{x:10,y:0}],2.99),undefined);
 near(hitPolyline({x:5,y:3},[{x:0,y:0},{x:10,y:0}],3).distance,3);
 near(pointToSegment({x:2,y:3},{x:2,y:2},{x:2,y:2}).distance,1);
 const c={center:[180,0],zoom:7,bearingDegrees:27},v={width:800,height:600};
 const route={type:'MultiLineString',coordinates:[[[178,0],[179,0]],[[-179,0],[-178,0]]]};
 assert.equal(hitGeometry(project(c,v,[180,0]),route,c,v,10),false,'no invented segment joins disjoint route parts');
 assert.equal(hitGeometry(project(c,v,[-178.5,0]),route,c,v,1),true);
 assert.equal(hitGeometry(project(c,v,[180,0]),{type:'LineString',coordinates:[[179,0],[-179,0]]},c,v,1),true);
});

test('polygon selection follows dateline rings and excludes holes in the same world',()=>{
 const c={center:[181,55],zoom:5,bearingDegrees:42},v={width:900,height:700};
 const polygon={type:'Polygon',coordinates:[[[175,50],[-175,50],[-175,60],[175,60],[175,50]],[[-179,54],[-177,54],[-177,56],[-179,56],[-179,54]]]};
 assert.equal(hitGeometry(project(c,v,[178,55]),polygon,c,v),true);
 assert.equal(hitGeometry(project(c,v,[-178,55]),polygon,c,v),false);
 assert.equal(hitGeometry(project(c,v,[170,55]),polygon,c,v),false);
 const square=[[{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}],[{x:4,y:4},{x:6,y:4},{x:6,y:6},{x:4,y:6}]];
 assert.equal(hitPolygon({x:0,y:5},square),true);assert.equal(hitPolygon({x:4,y:5},square),false);
 assert.equal(hitGeometry({x:0,y:0},null,c,v),false);
});

test('camera operations leave caller-owned arrays, pointers and viewports unchanged',()=>{
 const c=Object.freeze({center:Object.freeze([179,60]),zoom:6,bearingDegrees:30}),view=Object.freeze({...viewport}),point=Object.freeze({x:100,y:200});
 const before=JSON.stringify({c,view,point});
 project(c,view,[-179,60]);pan(c,point);zoomAt(c,view,7,point);rotateAt(c,view,-20,point);
 const session=new CustomMapPointerSession();session.begin(1,point,c,view);session.move(1,point);session.end(1);
 assert.equal(JSON.stringify({c,view,point}),before);
});
