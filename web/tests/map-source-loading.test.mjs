import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {VectorTileSource,RasterDEMTileSource,Evented} from 'maplibre-gl';
import {MapSourceLoading,retryMapSourceMetadata} from '../lib/map-source-loading.ts';

function harness(){
 const sources=new Map(),timers=new Map(),loading=[],failures=[],retries=[];let serial=0;
 const control=new MapSourceLoading({
  getSource:id=>sources.get(id)?.source,isSourceLoaded:id=>sources.get(id)?.loaded??false,
  metadataSources:['openmaptiles','terrain-dem','hillshade-dem'],
  retryMetadata:(id,source)=>{retries.push({id,source});sources.get(id).loaded=false;control.loading({sourceId:id});return true;},
  onLoading:value=>loading.push(value),onFailures:value=>failures.push(value),
  defer:run=>{const id=++serial;timers.set(id,run);return id;},cancelDefer:id=>timers.delete(id),
 });
 const add=id=>{sources.set(id,{source:{},loaded:false});return sources.get(id);};
 const start=(id,event={})=>{if(!sources.has(id))add(id);sources.get(id).loaded=false;control.loading({sourceId:id,...event});};
 const done=(id,event={})=>{sources.get(id).loaded=true;control.data({sourceId:id,sourceDataType:'content',...event});};
 const error=(id,event={})=>{sources.get(id).loaded=true;control.error({sourceId:id,...event});};
 const flush=()=>{const pending=[...timers.values()];timers.clear();for(const run of pending)run();};
 return{control,sources,timers,loading,failures,retries,add,start,done,error,flush};
}

test('source completion clears a visible detail notice without waiting for camera/render idle',()=>{
 const env=harness();env.start('openmaptiles');env.flush();
 assert.deepEqual(env.loading,[true]);
 env.done('openmaptiles',{sourceDataType:'metadata'});
 assert.deepEqual(env.loading,[true,false]);assert.equal(env.timers.size,0);
});

test('an error before debounce cancels its timer and cannot resurrect the notice in the next request',()=>{
 const env=harness();env.start('openmaptiles');const stale=[...env.timers.values()][0];
 env.error('openmaptiles');assert.equal(env.timers.size,0);
 stale();assert.deepEqual(env.loading,[]);
 env.start('hillshade-dem');const current=[...env.timers.keys()][0];
 stale();assert.deepEqual(env.loading,[]);assert.ok(env.timers.has(current),'stale callback must not consume the new debounce');
 env.flush();assert.deepEqual(env.loading,[true]);env.done('hillshade-dem');
 assert.deepEqual(env.loading,[true,false]);
});

test('one failed source does not clear another source still loading',()=>{
 const env=harness();env.start('openmaptiles');env.start('hillshade-dem');env.flush();
 env.error('openmaptiles');assert.deepEqual(env.loading,[true]);
 assert.deepEqual(env.failures.at(-1),[{id:'openmaptiles',retrying:false}]);
 env.done('hillshade-dem',{sourceDataType:'metadata'});assert.deepEqual(env.loading,[true,false]);
});

test('abort reconciliation waits until the SDK has removed its cancelled tile',async()=>{
 const env=harness();env.start('openmaptiles',{tile:{}});env.flush();
 env.control.aborted({sourceId:'openmaptiles',tile:{}});
 assert.deepEqual(env.loading,[true]);env.sources.get('openmaptiles').loaded=true;
 await Promise.resolve();assert.deepEqual(env.loading,[true,false]);assert.equal(env.timers.size,0);
});

test('an ordinary tile failure cannot become a metadata failure after metadata succeeded',()=>{
 const env=harness();env.start('openmaptiles');env.done('openmaptiles',{sourceDataType:'metadata'});
 // Some SDK/worker errors carry a source ID without a tile. A known metadata
 // request, not that omission alone, must be required for degraded state.
 env.start('openmaptiles');env.error('openmaptiles');
 assert.deepEqual(env.failures,[]);assert.equal(env.control.retry(),0);
 env.start('openmaptiles',{tile:{}});env.error('openmaptiles',{tile:{}});
 assert.deepEqual(env.failures,[]);
});

test('style diffs retain current-source failures and discard only removed or replaced sources',()=>{
 const env=harness();env.start('openmaptiles');env.error('openmaptiles');
 env.start('hillshade-dem');const stale=[...env.timers.values()][0];
 env.control.beforeStyleChange();env.sources.delete('hillshade-dem');env.control.styleLoaded();
 assert.deepEqual(env.failures.at(-1),[{id:'openmaptiles',retrying:false}]);
 stale();assert.deepEqual(env.loading,[]);
 env.control.beforeStyleChange();env.add('openmaptiles');env.control.styleLoaded();
 assert.deepEqual(env.failures.at(-1),[]);assert.equal(env.control.retry(),0);
});

test('pending metadata survives a style diff that retains its source object',()=>{
 const env=harness();env.start('openmaptiles');env.control.beforeStyleChange();env.control.styleLoaded();
 env.error('openmaptiles');assert.deepEqual(env.failures.at(-1),[{id:'openmaptiles',retrying:false}]);
 assert.equal(env.control.retry(),1);assert.equal(env.control.retry(),0,'retry must not overlap its own request');
 assert.deepEqual(env.failures.at(-1),[{id:'openmaptiles',retrying:true}]);
 env.done('openmaptiles',{sourceDataType:'metadata'});
 assert.deepEqual(env.failures.at(-1),[]);assert.equal(env.control.retry(),0);
});

test('disposal invalidates timers, queued abort work and late source events',async()=>{
 const env=harness();env.start('openmaptiles');const stale=[...env.timers.values()][0];
 env.control.aborted({sourceId:'openmaptiles'});env.control.dispose();
 stale();env.error('openmaptiles');await Promise.resolve();
 assert.deepEqual(env.loading,[]);assert.deepEqual(env.failures,[]);assert.equal(env.timers.size,0);
});

test('successful metadata from a different source never clears an existing failure',()=>{
 const env=harness();env.start('terrain-dem');env.error('terrain-dem');
 env.start('hillshade-dem');env.done('hillshade-dem',{sourceDataType:'metadata'});
 assert.deepEqual(env.failures.at(-1),[{id:'terrain-dem',retrying:false}]);
});

// Use the installed production bundle's actual public source classes/setUrl.
// The source's load method is the controlled boundary: this checks invocation
// and retained source settings, not network transfer, worker reload or pixels.
const style=JSON.parse(readFileSync(new URL('../public/maps/tropa-style.json',import.meta.url),'utf8'));
for(const [id,Source] of [['openmaptiles',VectorTileSource],['terrain-dem',RasterDEMTileSource],['hillshade-dem',RasterDEMTileSource]])test(`installed SDK retries the same ${id} URL through load(true)`,()=>{
 const definition=style.sources[id],source=new Source(id,definition,{},new Evented()),attempts=[];
 const before=source.serialize();
 source.load=async changed=>{attempts.push({changed,url:source.url});};
 assert.equal(retryMapSourceMetadata(source,definition),true);
 assert.deepEqual(attempts,[{changed:true,url:definition.url}]);
 assert.deepEqual(source.serialize(),before,'retry preserves source definition and tile settings');
 assert.equal(retryMapSourceMetadata(source,definition),true);
 assert.equal(attempts.length,2,'an unchanged URL is a real new source-load invocation');
});

test('retry cannot invoke an unrelated or removed source',()=>{
 let calls=0;const source={setUrl:()=>calls++};
 for(const definition of [undefined,{type:'geojson',url:'/data/area.json'},{type:'raster',tiles:['https://example.test/{z}/{x}/{y}']}])assert.equal(retryMapSourceMetadata(source,definition),false);
 assert.equal(retryMapSourceMetadata({},style.sources.openmaptiles),false);assert.equal(calls,0);
});
