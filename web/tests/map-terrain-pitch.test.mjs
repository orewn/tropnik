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

function harness({zoom=5.905,pitch=50,focused=true,reduced=false,slope=0,softwareRenderer}={}){
 let time=0,serial=0,enabled=true,focus=focused,renderer=softwareRenderer;
 const frames=new Map(),renders=new Map(),events=[],pitchCalls=[],zoomTargets=[];
 const scheduler=queue=>({requestFrame:fn=>{const id=++serial;queue.set(id,fn);return id;},cancelFrame:id=>queue.delete(id)});
 const frame=scheduler(frames),render=scheduler(renders);
 const elevation=point=>1000+Math.max(0,(43.7-point.lat)*111195)*slope;
 const terrain={getCoverageIndex:()=>null,getElevationForLngLatZoom:elevation,getElevationForLngLat:elevation,
  getElevationAndDEMStateForLngLat:point=>({elevation:elevation(point),demState:'loaded'}),getMinTileElevationForLngLatZoom:()=>0};
 setNow(time);
 const camera=new Camera({minZoom:1.905,maxZoom:18,minPitch:0,maxPitch:75,bearingSnap:0,zoomSnap:0,renderWorldCopies:true,
  centerClampedToGround:true,terrain,requestRenderFrame:render.requestFrame,cancelRenderFrame:render.cancelFrame});
 camera.transform.resize(900,600,true);
 camera.jumpTo({center:[40.4,43.7],zoom,pitch,bearing:-12,padding:{top:30,right:20,bottom:50,left:40}});
 let inZoomEnd=false;
 const profile=new MapTerrainPitch({camera:{getZoom:()=>camera.getZoom(),getPitch:()=>camera.getPitch(),isMoving:()=>camera.isMoving(),
  easeTo:options=>{assert.equal(inZoomEnd,false,'pitch correction must leave the SDK zoomend stack');pitchCalls.push(options);camera.easeTo(options);}},
  enabled:()=>enabled,focused:()=>focus,softwareRenderer:()=>renderer,reducedMotion:()=>reduced,...frame});
 profile.remember(pitch);
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
  enable:value=>{enabled=value;},focus:value=>{focus=value;},renderer:value=>{renderer=value;}};
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

test('manual rotation cancels an already dequeued correction and the next scale bucket still applies',()=>{
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

test('installed SDK slope clearance reproduces pitch-only zoom loss, but a remembered bucket adds no drift',()=>{
 const env=harness({zoom:16.905,pitch:50,slope:.93});
 assert.ok(env.camera.getPitch()<48.5,'the real SDK must clamp the requested50-degree angle on this slope');
 const center=env.camera.getCenter();
 for(const target of [17.905,18]){
  env.camera.zoomTo(target,{duration:200});env.tick();
  const afterNative=env.camera.getZoom(),pitch=env.camera.getPitch(),zoomEnds=env.events.filter(name=>name==='zoomend').length;
  env.drain();
  assert.equal(env.camera.getZoom(),afterNative,'automatic pitch must add zero drift after the native zoomend');
  assert.equal(env.camera.getPitch(),pitch,'the SDK clearance pitch is accepted in the same requested bucket');
  assert.equal(env.events.filter(name=>name==='zoomend').length,zoomEnds);
  assert.deepEqual(env.pitchCalls,[]);
 }
 assert.ok(env.camera.getZoom()>17.999,'the native upper zoom remains reachable without a second retreat');
 close(env.camera.getCenter().lng,center.lng,'slope longitude');close(env.camera.getCenter().lat,center.lat,'slope latitude');
 const safeZoom=env.camera.getZoom();
 env.camera.easeTo({pitch:50,duration:0});
 assert.ok(safeZoom-env.camera.getZoom()>.04,'the former repeated50-degree correction reproduces measurable SDK zoom loss');
});

test('manual pitch on a slope survives more zoom in the same bucket, then a new bucket applies once',()=>{
 const env=harness({zoom:16.905,pitch:50,slope:.93,reduced:true});
 env.camera.easeTo({pitch:35,bearing:15,duration:0});
 env.camera.zoomTo(17.905,{duration:0});env.drain();
 close(env.camera.getPitch(),35,'manual angle within the50-degree profile bucket');assert.deepEqual(env.pitchCalls,[]);
 env.camera.zoomTo(8.905,{duration:0});env.drain();
 assert.deepEqual(env.pitchCalls,[{pitch:46,duration:0}]);
 env.camera.zoomTo(9.905,{duration:0});env.drain();
 assert.equal(env.pitchCalls.length,1,'a new profile is requested once, even if clearance modifies its output');
});

test('queued native button targets can reach the upper bound on sloping terrain without pitch retries',()=>{
 const env=harness({zoom:16.905,pitch:50,slope:.93});
 env.buttons.request(1);env.drain();
 assert.ok(env.camera.getZoom()>17.8);
 env.buttons.request(1);env.drain();
 assert.ok(Math.abs(env.camera.getZoom()-18)<1e-7,'the existing queue reaches its requested native upper bound');
 assert.deepEqual(env.pitchCalls,[],'no automatic50-degree retry subtracts zoom from the native target');
 assert.equal(env.frames.size+env.renders.size,0);
});

test('activation remembers its requested pitch and a first large zoom still reaches its new profile',()=>{
 const env=harness({zoom:12.905,pitch:50,reduced:true});
 env.camera.zoomTo(1.905,{duration:0});env.drain();
 assert.deepEqual(env.pitchCalls,[{pitch:20,duration:0}]);close(env.camera.getPitch(),20,'first large zoom profile');
 env.camera.zoomTo(8.905,{duration:0});env.drain();
 assert.deepEqual(env.pitchCalls.at(-1),{pitch:46,duration:0});
});

for(const reduced of [false,true])test(`software default pitch keeps native button steps and slope clearance stable (${reduced?'reduced':'animated'} motion)`,()=>{
 const env=harness({zoom:16.905,pitch:30,slope:.93,reduced,softwareRenderer:'swiftshader'});
 const center=env.camera.getCenter(),padding=env.camera.getPadding();
 for(const expected of [17.905,18]){
  env.buttons.request(1);env.drain();
  close(env.camera.getZoom(),expected,'native upper step');close(env.camera.getPitch(),30,'remembered software default');
 }
 assert.deepEqual(env.pitchCalls,[],'the software default is not retried after native terrain clearance');
 close(env.camera.getCenter().lng,center.lng,'software slope longitude');close(env.camera.getCenter().lat,center.lat,'software slope latitude');
 close(env.camera.getBearing(),-12,'software slope bearing');assert.deepEqual(env.camera.getPadding(),padding);
 assert.equal(env.frames.size+env.renders.size,0);
});

test('manual software pitch survives every zoom sharing the capped bucket, then the next profile applies once',()=>{
 const env=harness({zoom:16.905,pitch:30,slope:.93,reduced:true,softwareRenderer:'llvmpipe'});
 env.camera.easeTo({pitch:35,bearing:15,duration:0});
 for(const zoom of [17.905,8.905,5.905]){
  env.camera.zoomTo(zoom,{duration:0});env.drain();
  close(env.camera.getPitch(),35,`manual software pitch at z${zoom}`);close(env.camera.getBearing(),15,'manual software bearing');
 }
 assert.deepEqual(env.pitchCalls,[],'the cap is a default, not a maximum on manual rotation');
 env.camera.zoomTo(3.905,{duration:0});env.drain();
 close(env.camera.getPitch(),28,'next software profile');assert.deepEqual(env.pitchCalls,[{pitch:28,duration:0}]);
 env.camera.zoomTo(4.905,{duration:0});env.drain();
 close(env.camera.getPitch(),30,'return to the capped profile');assert.deepEqual(env.pitchCalls.at(-1),{pitch:30,duration:0});
});

test('a changing renderer capability is read on the deferred callback and manual movement still cancels it',()=>{
 const env=harness({zoom:12.905,pitch:50,reduced:true});
 env.profile.settled();env.renderer('softpipe');env.drain();
 assert.deepEqual(env.pitchCalls,[{pitch:30,duration:0}]);
 env.renderer(undefined);env.profile.settled();
 const stale=[...env.frames.values()];env.frames.clear();
 env.camera.easeTo({pitch:61,bearing:27,duration:0});
 for(const run of stale)run();env.drain();
 close(env.camera.getPitch(),61,'manual angle after a capability change');assert.equal(env.pitchCalls.length,1);
 env.profile.settled();env.drain();
 assert.deepEqual(env.pitchCalls.at(-1),{pitch:50,duration:0},'an unknown renderer restores the original default on the next valid correction');
});

test('terrain/style reset forgets old intent and explicit flat framing cannot inherit a stale profile',()=>{
 const env=harness({reduced:true});
 env.profile.reset();env.enable(false);env.camera.jumpTo({zoom:4.905,pitch:0});env.drain();
 assert.deepEqual(env.pitchCalls,[]);
 env.enable(true);env.profile.remember(38);env.camera.easeTo({pitch:38,duration:0});
 env.camera.zoomTo(5.905,{duration:0});env.drain();assert.deepEqual(env.pitchCalls,[],'reactivation does not repeat its already requested bucket');
 env.profile.remember(0);env.camera.jumpTo({zoom:6.905,pitch:0});env.drain();
 assert.deepEqual(env.pitchCalls,[{pitch:38,duration:0}]);
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
 assert.match(atlas,/terrainPitchControl\.current\?\.remember\(pitch\);map\.easeTo\(\{pitch,duration:reduced\?0:420\}\)/);
 assert.match(atlas,/softwareRenderer:\(\)=>softwareRenderer\.current/);
 assert.match(atlas,/terrainPitchForZoom\(region\.zoom,true,softwareRenderer\.current\)/);
 assert.match(atlas,/terrainPitchForZoom\(routeZoom,true,softwareRenderer\.current\)/);
 assert.match(atlas,/terrainPitchForZoom\(zoom,!!regionRef\.current\|\|!!trailRef\.current,softwareRenderer\.current\)/);
 assert.equal((atlas.match(/readSoftwareMapRenderer\(map\.getCanvas\(\)\)/g)||[]).length,2,'capabilities are read only at initialization and context restoration');
 assert.match(atlas,/webglcontextrestored',\(\)=>\{softwareRenderer\.current=readSoftwareMapRenderer\(map\.getCanvas\(\)\)/);
 assert.match(atlas,/zoomControl\.cancel\(\);terrainPitch\?\.reset\(\);styleGeneration/);
 assert.equal((atlas.match(/terrainPitch\?\.dispose\(\)/g)||[]).length,2,'both failed initialization and unmount release the deferred frame');
});
