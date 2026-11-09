import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {constrainFramedCamera,MapFrameRefit,bindMapFrameRefit} from '../lib/map-framing.ts';
import {RUSSIA_BOUNDS,russiaPadding,russiaCamera,constrainRussiaCamera} from '../public/maps/russia-viewport.js';

const territories=JSON.parse(readFileSync(new URL('../lib/territories.generated.json',import.meta.url))).territories;
const radius=6378137,worldMetres=2*Math.PI*radius;
const project=([lng,lat])=>[radius*lng*Math.PI/180,radius*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))];
const unproject=([x,y])=>[x/radius*180/Math.PI,(2*Math.atan(Math.exp(y/radius))-Math.PI/2)*180/Math.PI];
const close=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<1e-7,`${message}: ${actual} vs ${expected}`);

// Independent EPSG:3857 metre calculation of a fit, followed by the actual
// runtime camera constraint. It does not claim to render browser pixels.
function fit(bounds,view,tileSize){
 const padding=russiaPadding(view.width,view.height,view.covered);
 const sw=project([bounds[0],bounds[1]]),ne=project([bounds[2],bounds[3]]);
 const scale=Math.min((view.width-padding.left-padding.right)/(ne[0]-sw[0]),(view.height-padding.top-padding.bottom)/(ne[1]-sw[1]));
 const zoom=Math.min(11,Math.log2(scale*worldMetres/tileSize));
 const pixelsPerMetre=tileSize*2**zoom/worldMetres;
 const center=unproject([(sw[0]+ne[0])/2+(padding.right-padding.left)/2/pixelsPerMetre,(sw[1]+ne[1])/2-(padding.bottom-padding.top)/2/pixelsPerMetre]);
 return{center,zoom,padding,pixelsPerMetre};
}

const views=[
 {name:'desktop',width:1100,height:780,covered:0},
 {name:'portrait with expanded drawer',width:390,height:772,covered:420},
 {name:'compact portrait',width:320,height:640,covered:420},
];
for(const view of views)for(const tileSize of[256,512])test(`all 85 territorial bounds fit after camera constraints: ${view.name}, ${tileSize}px`,()=>{
 assert.equal(territories.length,85);
 for(const territory of territories){
  const frame=fit(territory.bounds,view,tileSize),overview=russiaCamera(view.width,view.height,frame.padding,tileSize);
  const camera=constrainFramedCamera(...frame.center,frame.zoom,overview,frame);
  close(camera.center[0],frame.center[0],`${territory.name} longitude`);
  close(camera.center[1],frame.center[1],`${territory.name} latitude`);
  close(camera.zoom,frame.zoom,`${territory.name} zoom`);
  const c=project(camera.center),b=territory.bounds,p=frame.padding;
  for(const point of [[b[0],b[1]],[b[0],b[3]],[b[2],b[1]],[b[2],b[3]]]){
   const projected=project(point),x=view.width/2+(projected[0]-c[0])*frame.pixelsPerMetre,y=view.height/2-(projected[1]-c[1])*frame.pixelsPerMetre;
   assert.ok(x>=p.left-1e-6&&x<=view.width-p.right+1e-6,`${territory.name}: longitude must remain inside the unoccluded viewport`);
   assert.ok(y>=p.top-1e-6&&y<=view.height-p.bottom+1e-6,`${territory.name}: latitude must remain above the actual drawer`);
  }
 }
});

test('real Dagestan regression reproduces the old southern clamp and retains the correct frame',()=>{
 const territory=territories.find(item=>item.shapeNames.includes('Dagestan'));
 assert.ok(territory);
 const view=views[1],frame=fit(territory.bounds,view,256),overview=russiaCamera(view.width,view.height,frame.padding,256);
 const before=constrainRussiaCamera(...frame.center,frame.zoom,overview);
 assert.ok(before.center[1]-frame.center[1]>.9,'the previous clamp must reproduce the clipped-frame regression');
 const after=constrainFramedCamera(...frame.center,frame.zoom,overview,frame);
 close(after.center[1],frame.center[1],'the calculated camera offset is retained');
});

test('a selected frame does not remove geographical limits or the country zoom floor',()=>{
 const territory=territories.find(item=>item.shapeNames.includes('Dagestan'));
 const view=views[1],frame=fit(territory.bounds,view,256),overview=russiaCamera(view.width,view.height,frame.padding,256);
 const edge=constrainFramedCamera(250,-89,frame.zoom,overview,frame);
 assert.ok(edge.center[0]<=Math.max(RUSSIA_BOUNDS[1][0],frame.center[0]));
 assert.ok(edge.center[1]>=Math.min(RUSSIA_BOUNDS[0][1],frame.center[1]));
 assert.deepEqual(constrainFramedCamera(250,-89,frame.zoom+2,overview,frame),constrainRussiaCamera(250,-89,frame.zoom+2,overview));
 assert.deepEqual(constrainFramedCamera(250,-89,frame.zoom,overview,null),constrainRussiaCamera(250,-89,frame.zoom,overview));
 close(constrainFramedCamera(100,50,-30,overview,frame).zoom,overview.zoom,'country zoom floor');
});

test('Chukotka keeps the continuous dateline frame in every equivalent world copy',()=>{
 const territory=territories.find(item=>item.shapeNames.includes('Chukotka Autonomous Okrug'));
 assert.ok(territory.bounds[2]>180&&territory.bounds[2]-territory.bounds[0]<40);
 const view=views[1],frame=fit(territory.bounds,view,256),overview=russiaCamera(view.width,view.height,frame.padding,256);
 for(const offset of[-720,-360,0,360,720]){
  const camera=constrainFramedCamera(frame.center[0]+offset,frame.center[1],frame.zoom,overview,frame);
  close(camera.center[0],frame.center[0],'continuous eastern longitude');
 }
});

function refitHarness(){
 let serial=0,allowed=true,refits=0;
 const timers=new Map(),frames=new Map();
 const refit=new MapFrameRefit({
  allowed:()=>allowed,refit:()=>refits++,
  requestFrame:callback=>{const id=++serial;frames.set(id,callback);return id;},
  cancelFrame:id=>frames.delete(id),
  defer:callback=>{const id=++serial;timers.set(id,callback);return id;},
  cancelDefer:id=>timers.delete(id),
 });
 const flush=jobs=>{const pending=[...jobs.values()];jobs.clear();pending.forEach(callback=>callback());};
 return{refit,timers,frames,setAllowed:value=>{allowed=value;},count:()=>refits,flushTimers:()=>flush(timers),flushFrames:()=>flush(frames)};
}

test('an animated drawer produces one refit after its height settles, with bounded pending work',()=>{
 const env=refitHarness();env.refit.select('dagestan');
 for(let frame=0;frame<30;frame++)env.refit.resized();
 assert.equal(env.timers.size,1);assert.equal(env.frames.size,0);assert.equal(env.count(),0);
 env.refit.settled();env.refit.settled();
 assert.equal(env.timers.size,0);assert.equal(env.frames.size,1);
 env.flushFrames();assert.equal(env.count(),1);assert.equal(env.frames.size,0);
});

test('instant and non-CSS resizes also refit once after the settle timer and next animation frame',()=>{
 const env=refitHarness();env.refit.select('chukotka');env.refit.resized();
 env.flushTimers();assert.equal(env.count(),0);assert.equal(env.frames.size,1);
 env.flushFrames();assert.equal(env.count(),1);
});

test('manual navigation cancels queued refits and stays authoritative across a style reload',()=>{
 const env=refitHarness();env.refit.select('dagestan');env.refit.settled();
 const stale=[...env.frames.values()][0];env.refit.cancel();
 env.refit.select('dagestan');env.refit.resized();env.refit.settled();stale();
 assert.equal(env.frames.size,0);assert.equal(env.timers.size,0);assert.equal(env.count(),0);
 env.refit.select('chukotka');env.refit.resized();env.flushTimers();env.flushFrames();
 assert.equal(env.count(),1,'a different selection may establish a new automatic frame');
});

test('opening a track prevents a queued territory refit from replacing its camera',()=>{
 const env=refitHarness();env.refit.select('altai');env.refit.settled();env.setAllowed(false);
 env.flushFrames();env.refit.resized();env.refit.settled();
 assert.equal(env.count(),0);assert.equal(env.timers.size,0);assert.equal(env.frames.size,0);
});

test('a stale settle callback cannot refit or cancel a newer territory request',()=>{
 const env=refitHarness();env.refit.select('dagestan');env.refit.resized();
 const stale=[...env.timers.values()][0];env.refit.select('chukotka');env.refit.resized();
 stale();assert.equal(env.timers.size,1);assert.equal(env.frames.size,0);
 env.flushTimers();env.flushFrames();assert.equal(env.count(),1);
});

test('component disposal releases pending timers and frames and cannot be revived',()=>{
 const env=refitHarness();env.refit.select('dagestan');env.refit.resized();
 const stale=[...env.timers.values()][0];env.refit.dispose();stale();
 env.refit.select('chukotka');env.refit.resized();env.refit.settled();
 assert.equal(env.timers.size,0);assert.equal(env.frames.size,0);assert.equal(env.count(),0);
});

test('map input bindings stop automatic framing while only the drawer transform transition flushes it',()=>{
 const element=()=>{
  const events=new Map();
  return{events,addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)};
 };
 const surface=element(),panel=element(),env=refitHarness();
 const unbind=bindMapFrameRefit(surface,panel,env.refit);
 for(const [index,event]of['pointerdown','touchstart','wheel'].entries()){
  env.refit.select(`territory-${index}`);env.refit.resized();surface.events.get(event)({});
  env.flushTimers();env.flushFrames();assert.equal(env.count(),0,event);
 }
 env.refit.select('keyboard');surface.events.get('keydown')({key:'ArrowUp'});env.refit.resized();
 assert.equal(env.timers.size,0);
 env.refit.select('transition');env.refit.resized();
 panel.events.get('transitionend')({target:{},propertyName:'transform'});
 panel.events.get('transitionend')({target:panel,propertyName:'opacity'});
 assert.equal(env.frames.size,0);
 panel.events.get('transitionend')({target:panel,propertyName:'transform'});env.flushFrames();
 assert.equal(env.count(),1);unbind();assert.equal(surface.events.size,0);assert.equal(panel.events.size,0);
});

test('settled drawer geometry updates even when automatic camera framing is unavailable or canceled',()=>{
 const element=()=>{
  const events=new Map();
  return{events,addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)};
 };
 const surface=element(),panel=element(),env=refitHarness(),measured=[];
 let covered=357;
 const unbind=bindMapFrameRefit(surface,panel,env.refit,()=>measured.push(covered));
 const transition=propertyName=>panel.events.get('transitionend')({target:panel,propertyName});
 env.refit.select('route-open');env.setAllowed(false);
 panel.events.get('transitionend')({target:{},propertyName:'transform'});
 transition('opacity');
 assert.deepEqual(measured,[],'unrelated transitions must not measure the drawer');
 covered=156;transition('transform');env.flushFrames();
 assert.deepEqual(measured,[156],'the settled inset must replace the intermediate animation geometry');
 assert.equal(env.count(),0,'measuring geometry must not bypass the camera permission');

 env.setAllowed(true);env.refit.select('manual-camera');surface.events.get('pointerdown')({});
 covered=420;transition('height');env.flushFrames();
 assert.deepEqual(measured,[156,420]);
 assert.equal(env.count(),0,'manual camera navigation must remain authoritative');

 env.refit.select('new-territory');covered=156;transition('transform');env.flushFrames();
 assert.deepEqual(measured,[156,420,156]);
 assert.equal(env.count(),1,'an allowed new territory may still refit after measuring');
 unbind();
 assert.equal(surface.events.size,0);assert.equal(panel.events.size,0);
});

test('an immediate sheet gesture settles geometry once and never overrides a manually moved camera',()=>{
 const element=()=>{
  const events=new Map();
  return{events,addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)};
 };
 const surface=element(),panel=element(),env=refitHarness();let measurements=0;
 const unbind=bindMapFrameRefit(surface,panel,env.refit,()=>measurements++);
 const settled=panel.events.get('tropnik:sheet-settled');
 env.refit.select('altai');
 settled({target:{}});env.flushFrames();assert.equal(measurements,0);
 settled({target:panel});env.flushFrames();
 assert.equal(measurements,1);assert.equal(env.count(),1);
 surface.events.get('pointerdown')({});
 settled({target:panel});env.flushFrames();
 assert.equal(measurements,2);assert.equal(env.count(),1,'the explicit gesture settle cannot re-enable automatic framing');
 unbind();assert.equal(panel.events.size,0);assert.equal(surface.events.size,0);
});
