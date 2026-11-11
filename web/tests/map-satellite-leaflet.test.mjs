import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {createGroupedSatelliteLayer} from '../lib/map-satellite-tiles.ts';

const require=createRequire(new URL('../package.json',import.meta.url));
const turn=()=>new Promise(resolve=>setImmediate(resolve));

function fixture({settled=()=>true}={}) {
 const createElement=()=>{
  const listeners=new Map();
  return {style:{},complete:false,src:'',getContext:()=>({}),decode:()=>Promise.resolve(),
   addEventListener(type,listener){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(listener);},
   removeEventListener(type,listener){listeners.get(type)?.delete(listener);},
   emit(type){for(const listener of listeners.get(type)??[])listener({type,target:this});},
   getAttribute(name){return this[name];},setAttribute(name,value){this[name]=value;},
  };
 };
 const document={documentElement:{style:{}},createElement};
 const navigator={userAgent:'Node Leaflet satellite lifecycle test',platform:'Linux'};
 const window={document,navigator,devicePixelRatio:1,screen:{},addEventListener(){},removeEventListener(){}};
 const leaflet={exports:{}};
 vm.runInNewContext(readFileSync(require.resolve('leaflet/dist/leaflet-src.js'),'utf8'),{
  document,navigator,window,module:leaflet,exports:leaflet.exports,setTimeout,clearTimeout,console,
 });
 const L=leaflet.exports;
 let zoom=6,bounds=L.latLngBounds([0,-180],[85.05112878,0]);
 const geometryReads={bounds:0,projections:0};
 const map=Object.assign(new L.Evented(),{options:{crs:{infinite:true}},getZoom:()=>zoom,
  getBounds:()=>{geometryReads.bounds++;return bounds;},
  project:(point,z)=>{geometryReads.projections++;return L.CRS.EPSG3857.latLngToPoint(L.latLng(point),z);},
 });
 const grouped=createGroupedSatelliteLayer(L,map,'https://example.test/{z}/{x}/{y}.jpg',
  {tileSize:256,maxNativeZoom:14,crossOrigin:'anonymous'},settled);
 const {layer}=grouped,completed=[];
 layer._map=map;layer._tiles={};
 const add=(id,z=6,x=0,y=0)=>{
  layer._tileZoom=z;zoom=z;
  const coords=Object.assign(L.point(x,y),{z});
  const tile=layer.createTile(coords,error=>completed.push({id,error}));
  layer._tiles[`${x}:${y}:${z}`]={el:tile,coords,current:true};
  return tile;
 };
 return {...grouped,L,map,add,completed,geometryReads,setBounds:value=>{bounds=L.latLngBounds(value);},setZoom:value=>{zoom=value;layer._tileZoom=value;}};
}

test('real Leaflet zoom cancellation releases unfinished images that never emit tileunload',async t=>{
 const env=fixture();t.after(env.dispose);
 const aborted=[],unloaded=[];
 env.layer.on('tileabort',event=>aborted.push(event.tile));
 env.layer.on('tileunload',event=>unloaded.push(event.tile));
 // TileLayer._abortLoading deletes its old zoom images directly. The real
 // installed SDK emits tileabort here, without its ordinary tileunload path.
 // More than the queue capacity must remain safe when every image is obsolete.
 for(let index=0;index<160;index++){
  env.add(`cancelled-${index}`,5);env.setZoom(6);env.layer._abortLoading();
 }
 assert.equal(aborted.length,160);assert.equal(unloaded.length,0);
 assert.deepEqual(env.completed,[],'cancelled requests cannot consume the live queue or become errors');
 const current=env.add('current',6);current.emit('load');await turn();
 assert.deepEqual(env.completed,[{id:'current',error:undefined}]);
 // Browser decode/load delivery can race the SDK abort. No cancelled image
 // may enter a new viewport batch after its coordinates have been released.
 for(const old of aborted)old.emit('load');await turn();
 assert.deepEqual(env.completed,[{id:'current',error:undefined}]);
 env.dispose();
 for(const event of ['move','moveend','zoom','viewreset','resize'])assert.equal(env.map.listens(event),false);
});

test('many real Leaflet tiles share one viewport geometry read per batch pass',async t=>{
 const env=fixture();t.after(env.dispose);
 const tiles=Array.from({length:90},(_,index)=>env.add(`tile-${index}`,6,index%15,Math.floor(index/15)));
 assert.deepEqual(env.geometryReads,{bounds:1,projections:2},'the complete SDK tile-creation burst shares its capacity view');
 await turn();
 assert.deepEqual(env.geometryReads,{bounds:2,projections:4},'one fresh snapshot serves every current-grid membership check');
 for(const tile of tiles)tile.emit('load');
 await turn();
 assert.deepEqual(env.geometryReads,{bounds:3,projections:6},'offscreen checks, current checks and release share one snapshot');
 assert.equal(env.completed.length,90);
 assert.ok(env.completed.every(item=>item.error===undefined));
});

test('a camera change before the microtask cannot reuse the tile-admission viewport',async t=>{
 const env=fixture({settled:()=>false});t.after(env.dispose);
 const old=env.add('now-offscreen',6,0,0);
 assert.equal(env.geometryReads.bounds,1);
 // A camera update can occur after createTile but before its completion
 // microtask. beforeFlush must refresh even before its public event arrives.
 env.setBounds([[0,90],[40,150]]);old.emit('load');await turn();
 assert.deepEqual(env.completed,[{id:'now-offscreen',error:undefined}]);
 for(const event of ['move','moveend','zoom','viewreset','resize']){
  const before=env.geometryReads.bounds;
  env.map.fire(event);
  env.add(`new-${event}`,6,51,28);
  assert.equal(env.geometryReads.bounds,before+1,`${event} must invalidate the capacity view before the SDK adds its next tiles`);
  await turn();
 }
});
