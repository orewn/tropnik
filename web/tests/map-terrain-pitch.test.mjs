import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {MapTerrainPitch} from '../lib/map-terrain-pitch.ts';
import {MapZoomButtons} from '../lib/map-zoom-buttons.ts';

// Execute the installed SDK's camera, Mercator projection and movement events.
// Only reduced-motion detection, time, render scheduling and DEM samples are
// supplied by the harness; there is no DOM, WebGL context or browser here.
const require=createRequire(new URL('../package.json',import.meta.url)),ts=require('typescript');
const sdk=dirname(require.resolve('maplibre-gl/package.json')),sdkRequire=createRequire(resolve(sdk,'package.json')),modules=new Map();
function load(path){
 if(path.endsWith('/util/browser.ts'))return{browser:{prefersReducedMotion:false}};
 if(modules.has(path))return modules.get(path).exports;
 const loadedModule={exports:{}};modules.set(path,loadedModule);
 const compiled=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,esModuleInterop:true,useDefineForClassFields:false}}).outputText;
 new Function('require','module','exports',compiled)(id=>id.startsWith('.')?load(resolve(dirname(path),id)):sdkRequire(id),loadedModule,loadedModule.exports);
 return loadedModule.exports;
}
const {Camera}=load(resolve(sdk,'src/ui/camera.ts'));
const {setNow}=load(resolve(sdk,'src/util/time_control.ts'));
const close=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<1e-8,`${label}: ${actual} versus ${expected}`);

function harness({zoom=5.905,pitch=50,focused=true,reduced=false}={}){
 let time=0,serial=0,enabled=true,focus=focused;
 const frames=new Map(),renders=new Map(),events=[],pitchCalls=[],zoomTargets=[];
 const scheduler=queue=>({requestFrame:fn=>{const id=++serial;queue.set(id,fn);return id;},cancelFrame:id=>queue.delete(id)});
 const frame=scheduler(frames),render=scheduler(renders);
 const terrain={getCoverageIndex:()=>null,getElevationForLngLatZoom:()=>1000,getElevationForLngLat:()=>1000,
  getElevationAndDEMStateForLngLat:()=>({elevation:1000,demState:'loaded'}),getMinTileElevationForLngLatZoom:()=>0};
 setNow(time);
 const camera=new Camera({minZoom:1.905,maxZoom:18,minPitch:0,maxPitch:75,bearingSnap:0,zoomSnap:0,renderWorldCopies:true,
  centerClampedToGround:true,terrain,requestRenderFrame:render.requestFrame,cancelRenderFrame:render.cancelFrame});
 camera.transform.resize(900,600,true);
 camera.jumpTo({center:[40.4,43.7],zoom,pitch,bearing:-12,padding:{top:30,right:20,bottom:50,left:40}});
 let inZoomEnd=false;
 const profile=new MapTerrainPitch({camera:{getZoom:()=>camera.getZoom(),getPitch:()=>camera.getPitch(),isMoving:()=>camera.isMoving(),
  easeTo:options=>{assert.equal(inZoomEnd,false,'pitch correction must leave the SDK zoomend stack');pitchCalls.push(options);camera.easeTo(options);}},
  enabled:()=>enabled,focused:()=>focus,reducedMotion:()=>reduced,...frame});
 const buttons=new MapZoomButtons({zoom:()=>camera.getZoom(),bounds:()=>({min:1.905,max:18}),busy:()=>camera.isZooming(),...frame,
  apply:target=>{zoomTargets.push(target);camera.zoomTo(target,{duration:reduced?0:200});}});
 camera.on('movestart',()=>{events.push('movestart');profile.moving();});
 camera.on('zoomend',()=>{inZoomEnd=true;events.push('zoomend');buttons.settled();profile.settled();inZoomEnd=false;});
 camera.on('pitchend',()=>events.push('pitchend'));
 camera.on('moveend',()=>events.push('moveend'));
 const flush=()=>{const pending=[...frames];frames.clear();for(const [,fn] of pending)fn();};
 const tick=(ms=250)=>{time+=ms;setNow(time);const pending=[...renders];renders.clear();for(const [,fn] of pending)fn();};
 const drain=()=>{let count=0;while(frames.size||renders.size){assert.ok(++count<30,'camera work must terminate without polling');flush();tick();}};
 return{camera,profile,buttons,frames,renders,events,pitchCalls,zoomTargets,flush,tick,drain,
  enable:value=>{enabled=value;},focus:value=>{focus=value;}};
}

test('selected-route correction leaves zoomend and preserves SDK zoom, center, bearing and padding',()=>{
 const env=harness();const center=env.camera.getCenter(),padding=env.camera.getPadding();
 env.camera.zoomTo(4.905,{duration:200});env.tick();
 assert.equal(env.pitchCalls.length,0,'the zoomend callback only schedules work');
 assert.deepEqual(env.events,['movestart','zoomend','moveend']);
 env.drain();
 assert.deepEqual(env.pitchCalls,[{pitch:38,duration:180}]);
 close(env.camera.getZoom(),4.905,'zoom');close(env.camera.getPitch(),38,'pitch');
 close(env.camera.getCenter().lng,center.lng,'longitude');close(env.camera.getCenter().lat,center.lat,'latitude');
 close(env.camera.getBearing(),-12,'bearing');assert.deepEqual(env.camera.getPadding(),padding);
 assert.equal(env.events.filter(name=>name==='zoomend').length,1,'pitch-only ease must not emit another zoomend');
 assert.equal(env.camera.isMoving(),false);
});

for(const reduced of [false,true])test(`four native SDK button steps keep their complete sum across profile thresholds (${reduced?'reduced':'animated'} motion)`,()=>{
 const env=harness({zoom:1.905,pitch:20,reduced});
 const center=env.camera.getCenter();
 env.buttons.request(1);env.flush();
 for(let i=0;i<3;i++){env.buttons.request(1);env.flush();}
 env.tick();env.drain();
 close(env.camera.getZoom(),5.905,'four positive steps');close(env.camera.getPitch(),38,'focused approach pitch');
 close(env.camera.getCenter().lng,center.lng,'longitude');close(env.camera.getCenter().lat,center.lat,'latitude');
 assert.equal(env.zoomTargets.at(-1),5.905);
 assert.ok(env.pitchCalls.every(call=>call.pitch===38),'queued zoom takes priority over obsolete intermediate pitch');
 for(let i=0;i<4;i++)env.buttons.request(-1);
 env.drain();
 close(env.camera.getZoom(),1.905,'four negative steps');close(env.camera.getPitch(),20,'focused overview pitch');
 assert.equal(env.events.filter(name=>name==='zoomend').length,env.zoomTargets.length,'pitch corrections add no zoom events');
 assert.equal(env.frames.size+env.renders.size,0);
});

test('the focused route uses every existing scale bucket and overview keeps its own profile',()=>{
 const env=harness({reduced:true});
 for(const [zoom,expected] of [[1.905,20],[3.905,28],[5.905,38],[8.905,46],[12.905,50]]){
  env.camera.jumpTo({zoom});env.drain();close(env.camera.getPitch(),expected,`focused z${zoom}`);
 }
 env.focus(false);env.camera.jumpTo({zoom:3.905});env.drain();close(env.camera.getPitch(),22,'unfocused overview');
});

test('manual rotation cancels an already dequeued correction and survives until the next zoom',()=>{
 const env=harness({reduced:true});
 env.camera.jumpTo({zoom:4.905});
 const stale=[...env.frames.values()];env.frames.clear();
 env.camera.easeTo({pitch:61,bearing:27,duration:0});
 for(const run of stale)run();env.drain();
 assert.deepEqual(env.pitchCalls,[]);close(env.camera.getPitch(),61,'manual pitch');close(env.camera.getBearing(),27,'manual bearing');
 env.camera.jumpTo({zoom:3.905});env.drain();
 close(env.camera.getPitch(),28,'next zoom restores the scale profile');close(env.camera.getBearing(),27,'manual bearing after zoom');
});

test('terrain disabled or replaced before the frame prevents stale camera work',()=>{
 const env=harness();env.camera.jumpTo({zoom:4.905});env.enable(false);env.drain();
 assert.deepEqual(env.pitchCalls,[]);
 env.enable(true);env.profile.settled();env.profile.dispose();env.drain();
 env.profile.settled();assert.equal(env.frames.size,0);assert.deepEqual(env.pitchCalls,[]);
});

test('one correction frame is bounded and a new pan cancels its saved callback',()=>{
 const env=harness();for(let i=0;i<10;i++)env.profile.settled();assert.equal(env.frames.size,1);
 const stale=[...env.frames.values()][0];env.camera.easeTo({center:[41,44],duration:200});
 stale();env.drain();assert.deepEqual(env.pitchCalls,[]);close(env.camera.getCenter().lng,41,'manual pan');
});

test('Atlas prioritizes queued zoom, invalidates pitch on movement, and does not clear a newer moving state',()=>{
 const atlas=readFileSync(new URL('../components/Atlas.tsx',import.meta.url),'utf8');
 assert.match(atlas,/zoomControl\.settled\(\);\s*terrainPitch\?\.settled\(\)/);
 assert.match(atlas,/focused:\(\)=>!!regionRef\.current\|\|!!trailRef\.current/);
 assert.match(atlas,/map\.on\('movestart',\(\)=>\{terrainPitch\?\.moving\(\)/);
 assert.match(atlas,/!map\.isMoving\(\)&&container\.current\)\{delete container\.current\.dataset\.mapCamera/);
 assert.equal((atlas.match(/terrainPitch\?\.dispose\(\)/g)||[]).length,2,'both failed initialization and unmount release the deferred frame');
});
