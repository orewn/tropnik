import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {createGroupedSatelliteLayer} from '../lib/map-satellite-tiles.ts';

const require=createRequire(new URL('../package.json',import.meta.url));
const turn=()=>new Promise(resolve=>setImmediate(resolve));

function fixture() {
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
 let zoom=6;
 const map=Object.assign(new L.Evented(),{options:{crs:{infinite:true}},getZoom:()=>zoom,
  getBounds:()=>L.latLngBounds([0,-180],[85.05112878,0]),
  project:(point,z)=>L.CRS.EPSG3857.latLngToPoint(L.latLng(point),z),
 });
 const grouped=createGroupedSatelliteLayer(L,map,'https://example.test/{z}/{x}/{y}.jpg',
  {tileSize:256,maxNativeZoom:14,crossOrigin:'anonymous'},()=>true);
 const {layer}=grouped,completed=[];
 layer._map=map;layer._tiles={};
 const add=(id,z=6)=>{
  layer._tileZoom=z;zoom=z;
  const coords=Object.assign(L.point(0,0),{z});
  const tile=layer.createTile(coords,error=>completed.push({id,error}));
  layer._tiles[`0:0:${z}`]={el:tile,coords,current:true};
  return tile;
 };
 return {...grouped,L,map,add,completed,setZoom:value=>{zoom=value;layer._tileZoom=value;}};
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
 assert.equal(env.map.listens('moveend'),false);assert.equal(env.map.listens('resize'),false);
});
