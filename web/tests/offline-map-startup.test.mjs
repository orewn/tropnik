import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../public/offline.js',import.meta.url),'utf8');
const start=source.slice(source.indexOf('async function createMap(){'),source.indexOf('\nfunction connect(){'));
assert.ok(start.startsWith('async function createMap(){'));

async function launch({coarse=false,online=false,cached=[],importFails=false,cacheFails=false,gl=true}={}){
 const calls={imports:0,probes:0,released:0,masks:[],cache:[],engine:''};
 const context={window:{matchMedia:()=>({matches:coarse}),caches:{}},navigator:{onLine:online},coverage:null,
  caches:{async match(url){calls.cache.push(url);if(cacheFails)throw new Error('Cache disabled');return cached.includes(url)?{}:undefined;}},
  document:{createElement(){calls.probes++;return {getContext(){return gl?{getExtension:()=>({loseContext(){calls.released++;}})}:null;}};}},
  mapVisible(){},async loadMapCoverage({canonicalMask}){calls.masks.push(canonicalMask);return {area:{type:'FeatureCollection',features:[]}};},
  async createGL(){calls.engine='webgl';return 'webgl';},async createLeaflet(){calls.engine='canvas';return 'canvas';},
  async importEngine(){calls.imports++;if(importFails)throw new Error('Module unavailable offline');return {};},
 };
 // Execute the application's startup function with unavailable optional modules
 // and real asynchronous rejection, without importing its DOM bootstrap.
 const result=await vm.runInNewContext(start.replace("import('/maps/maplibre-gl.mjs')",'importEngine()')+'\ncreateMap()',context);
 return {...calls,result};
}

test('a cold phone starts its guaranteed Canvas shell even when WebGL is supported',async()=>{
 const value=await launch({coarse:true});
 assert.equal(value.result,'canvas');assert.equal(value.probes,0);assert.equal(value.imports,0);assert.deepEqual(value.masks,[false]);
});

test('offline desktop uses Canvas when any optional WebGL dependency is absent or cache is inaccessible',async()=>{
 for(const options of [{},{cached:['/maps/maplibre-gl.mjs','/maps/maplibre-gl.css']},{cacheFails:true}]){
  const value=await launch(options);assert.equal(value.result,'canvas');assert.equal(value.imports,0);assert.deepEqual(value.masks,[false]);
 }
});

test('a rejected WebGL import falls back to a noncanonical Canvas coverage session',async()=>{
 const value=await launch({online:true,importFails:true});
 assert.equal(value.result,'canvas');assert.equal(value.imports,1);assert.equal(value.released,1);assert.deepEqual(value.masks,[false]);
});

test('cached desktop WebGL remains available and an unsupported context falls back',async()=>{
 const cached=['/maps/maplibre-gl.mjs','/maps/maplibre-gl.css','/maps/maplibre-worker.js'];
 const value=await launch({cached});assert.equal(value.result,'webgl');assert.deepEqual(value.masks,[true]);assert.equal(value.released,1);
 const fallback=await launch({cached,gl:false});assert.equal(fallback.result,'canvas');assert.equal(fallback.imports,0);
});
