import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {MapZoomButtons,MAP_ZOOM_BUTTONS,bindZoomButtonCancellation} from '../lib/map-zoom-buttons.ts';

function harness({engine='leaflet',zoom=10,min=2,max=18,synchronous=false,deferred=false}={}){
 let actual=zoom,busy=false,destination,serial=0,minimum=min,maximum=max;
 const frames=new Map(),applied=[];
 const buttons=new MapZoomButtons({
  zoom:()=>actual,bounds:()=>({min:minimum,max:maximum}),busy:()=>busy,
  requestFrame:fn=>{const id=++serial;frames.set(id,fn);return id;},cancelFrame:id=>frames.delete(id),
  apply:target=>{
   assert.equal(busy,false,'a new SDK zoom must wait for the previous animation');
   applied.push(target);destination=target;
   if(synchronous){actual=target;buttons.settled();return;}
   if(deferred)return;
   busy=true;actual=engine==='leaflet'?target:actual+(target-actual)*.25;
  },
 });
 const flush=()=>{assert.ok(frames.size<=1,'pending work is bounded to one frame');const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn());};
 return{buttons,frames,applied,flush,zoom:()=>actual,
  bounds:(min,max)=>{minimum=min;maximum=max;},
  externalZoom:value=>{actual=value;busy=true;},
  begin:()=>{busy=true;actual=destination;},
  finish:()=>{actual=destination??actual;busy=false;buttons.settled();},
 };
}

for(const [engine,step] of [['leaflet',MAP_ZOOM_BUTTONS.leafletStep],['maplibre',MAP_ZOOM_BUTTONS.maplibreStep]]){
 test(`${engine}: four rapid presses in one frame apply their whole requested zoom`,()=>{
  const env=harness({engine});
  for(let press=0;press<4;press++)env.buttons.request(step);
  assert.equal(env.frames.size,1);env.flush();
  assert.deepEqual(env.applied,[10+4*step]);
  env.finish();env.flush();assert.equal(env.zoom(),10+4*step);assert.equal(env.frames.size,0);
 });

 test(`${engine}: presses during animation accumulate from the desired target, not an intermediate frame`,()=>{
  const env=harness({engine});env.buttons.request(step);env.flush();
  for(let press=0;press<3;press++){env.buttons.request(step);env.flush();}
  assert.deepEqual(env.applied,[10+step],'the running SDK animation is not repeatedly restarted');
  env.finish();env.flush();
  assert.deepEqual(env.applied,[10+step,10+4*step]);
  env.finish();env.flush();assert.equal(env.zoom(),10+4*step);assert.equal(env.frames.size,0);
  for(let press=0;press<4;press++)env.buttons.request(-step);
  env.flush();env.finish();env.flush();assert.equal(env.zoom(),10,'the opposite burst returns exactly to its starting zoom');
 });
}

test('a zoom scheduled by the SDK for its next frame still owns the in-flight slot',()=>{
 const env=harness({deferred:true});env.buttons.request(.75);env.flush();
 env.buttons.request(.75);env.flush();assert.deepEqual(env.applied,[10.75]);
 env.begin();env.finish();env.flush();assert.deepEqual(env.applied,[10.75,11.5]);
 env.begin();env.finish();env.flush();assert.equal(env.zoom(),11.5);assert.equal(env.frames.size,0);
});

test('reversing direction during a zoom preserves the algebraic total',()=>{
 const env=harness({engine:'maplibre'});env.buttons.request(1);env.flush();
 env.buttons.request(1);env.buttons.request(-1);env.buttons.request(-1);env.flush();
 env.finish();env.flush();assert.deepEqual(env.applied,[11,10]);
 env.finish();env.flush();assert.equal(env.zoom(),10);assert.equal(env.frames.size,0);
});

test('both zoom bounds saturate per press and do not store hidden overshoot',()=>{
 const env=harness({zoom:17.5});
 for(let press=0;press<12;press++)env.buttons.request(.75);
 env.buttons.request(-.75);env.flush();assert.deepEqual(env.applied,[17.25]);
 env.finish();env.flush();
 for(let press=0;press<30;press++)env.buttons.request(-.75);
 env.buttons.request(.75);env.flush();assert.deepEqual(env.applied,[17.25,2.75]);
 env.finish();env.flush();assert.equal(env.zoom(),2.75);
});

test('a changed country zoom floor is re-read before applying a pending zoom',()=>{
 const env=harness({zoom:3});env.buttons.request(-.75);env.bounds(2.8,18);env.flush();
 assert.deepEqual(env.applied,[2.8]);env.finish();env.flush();
 env.buttons.request(2);env.bounds(2.8,4);env.flush();assert.deepEqual(env.applied,[2.8,4]);
});

test('an external animation parks the target until zoomend without polling frames',()=>{
 const env=harness();env.externalZoom(11);env.buttons.request(.75);env.flush();
 assert.equal(env.frames.size,0);assert.deepEqual(env.applied,[]);
 env.finish();env.flush();assert.deepEqual(env.applied,[11.75]);
 env.finish();env.flush();assert.equal(env.zoom(),11.75);
});

test('reduced-motion synchronous zoomend does not recurse, lose presses or stick in flight',()=>{
 const env=harness({synchronous:true});
 for(let press=0;press<4;press++){env.buttons.request(.75);env.flush();}
 env.flush();assert.deepEqual(env.applied,[10.75,11.5,12.25,13]);assert.equal(env.zoom(),13);assert.equal(env.frames.size,0);
 env.buttons.request(-.75);env.flush();env.flush();assert.equal(env.zoom(),12.25);assert.equal(env.frames.size,0);
});

test('cancellation forgets a queued burst and later zoomend cannot revive it',()=>{
 const env=harness();env.buttons.request(.75);env.flush();
 env.buttons.request(.75);env.buttons.cancel();env.finish();env.flush();
 assert.deepEqual(env.applied,[10.75]);assert.equal(env.frames.size,0);
 env.buttons.request(-.75);env.flush();assert.deepEqual(env.applied,[10.75,10]);
});

test('a stale extracted frame cannot apply or cancel a newer request',()=>{
 const env=harness();env.buttons.request(.75);const stale=[...env.frames.values()][0];
 env.buttons.cancel();env.buttons.request(-.75);stale();
 assert.equal(env.frames.size,1);assert.deepEqual(env.applied,[]);
 env.flush();assert.deepEqual(env.applied,[9.25]);
});

test('disposal releases pending work and ignores late SDK events and button presses',()=>{
 const env=harness();env.buttons.request(.75);const stale=[...env.frames.values()][0];
 env.buttons.dispose();stale();env.buttons.request(1);env.buttons.settled();env.flush();
 assert.deepEqual(env.applied,[]);assert.equal(env.frames.size,0);
});

test('invalid input and malformed camera limits never reach the SDK',()=>{
 const env=harness();for(const value of [NaN,Infinity,-Infinity,0])env.buttons.request(value);
 assert.equal(env.frames.size,0);
 env.bounds(19,18);env.buttons.request(.75);assert.equal(env.frames.size,0);
 env.bounds(2,18);env.buttons.request(.75);env.bounds(NaN,18);env.flush();assert.deepEqual(env.applied,[]);
});

test('manual pointer, touch, wheel and navigation keys cancel the queue; unrelated keys do not',()=>{
 const events=new Map();
 const surface={addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)};
 const env=harness();const unbind=bindZoomButtonCancellation(surface,env.buttons);
 for(const event of ['pointerdown','touchstart','wheel']){
  env.buttons.request(.75);events.get(event)({});env.flush();assert.deepEqual(env.applied,[],event);
 }
 for(const key of ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','+','=','-','−','Home','End','PageUp','PageDown']){
  env.buttons.request(.75);events.get('keydown')({key});env.flush();assert.deepEqual(env.applied,[],key);
 }
 env.buttons.request(.75);events.get('keydown')({key:'Tab'});env.flush();assert.deepEqual(env.applied,[10.75]);
 unbind();assert.equal(events.size,0);
});

// Reproduce the browser SDK's actual early-return guard with the installed
// Leaflet implementation. The DOM stub only avoids painting in this unit test;
// native browser touch and animation delivery is checked by the Pages audit.
test('installed Leaflet drops raw zoomIn while CSS zoom is active, but the queue retains every increment',()=>{
 const require=createRequire(new URL('../package.json',import.meta.url));
 const document={documentElement:{style:{}},createElement:()=>({style:{},getContext:()=>({})})};
 const navigator={userAgent:'Node zoom regression',platform:'Linux'};
 const window={document,navigator,devicePixelRatio:1,screen:{},addEventListener(){},removeEventListener(){}};
 const sdkModule={exports:{}};
 vm.runInNewContext(readFileSync(require.resolve('leaflet/dist/leaflet-src.js'),'utf8'),{
  document,navigator,window,module:sdkModule,exports:sdkModule.exports,setTimeout:()=>0,clearTimeout(){},console,
 });
 const L=sdkModule.exports;
 const map={_zoom:14,_animatingZoom:false,options:{zoomDelta:.75},
  setZoom(target){
   if(this._animatingZoom&&L.Map.prototype._tryAnimatedZoom.call(this))return this;
   this._zoom=target;this._animatingZoom=true;return this;
  },
 };
 for(let press=0;press<4;press++)L.Map.prototype.zoomIn.call(map,.75);
 assert.equal(map._zoom,14.75,'the existing raw SDK calls reproduce the lost-press regression');
 map._zoom=14;map._animatingZoom=false;
 let serial=0;const frames=new Map();
 const buttons=new MapZoomButtons({zoom:()=>map._zoom,bounds:()=>({min:2,max:18}),busy:()=>map._animatingZoom,
  apply:target=>map.setZoom(target),requestFrame:fn=>{const id=++serial;frames.set(id,fn);return id;},cancelFrame:id=>frames.delete(id),
 });
 const flush=()=>{const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn());};
 buttons.request(.75);flush();for(let press=0;press<3;press++){buttons.request(.75);flush();}
 map._animatingZoom=false;buttons.settled();flush();
 assert.equal(map._zoom,17,'all four button increments survive the real Leaflet animation guard');
 map._animatingZoom=false;buttons.settled();flush();assert.equal(frames.size,0);
});
