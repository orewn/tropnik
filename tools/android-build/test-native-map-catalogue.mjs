import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from '../../web/node_modules/typescript/lib/typescript.js';

const root=path.resolve(import.meta.dirname,'../..');
const origin='https://map.tropnik.invalid';
const native=JSON.parse(readFileSync(path.join(root,'android/app/src/main/assets/catalog-manifest.json')));
const overview=JSON.parse(readFileSync(path.join(root,'web/lib/trail-overlay.generated.json')));
const sourceMap=new Map();
for(const item of native.files){
 const url=item.sourcePath.slice('web/public'.length),source=sourceMap.get(url);
 if(source)source.ids.push(item.routeId);else sourceMap.set(url,{url,sha256:item.sha256,sizeBytes:item.bytes,ids:[item.routeId]});
}
const descriptor={schemaVersion:1,overlay:{url:overview.url,sha256:overview.sha256,sizeBytes:overview.bytes},sources:[...sourceMap.values()],referenceRouteIds:native.referenceRouteIds};

function modules(){
 const context=vm.createContext({URL,AbortController,DOMException,fetch,TextDecoder,TextEncoder,Uint8Array,crypto,performance,setTimeout,clearTimeout});
 const cache=new Map();
 function load(name){
  const filename=path.resolve(root,name.endsWith('.ts')?name:name+'.ts');
  if(cache.has(filename))return cache.get(filename).exports;
  assert.ok(filename.startsWith(root+path.sep));
  const module={exports:{}};cache.set(filename,module);
  const code=ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const fn=vm.runInContext(`(function(require,module,exports){${code}\n})`,context,{filename});
  fn(specifier=>{assert.ok(specifier.startsWith('.'));return load(path.resolve(path.dirname(filename),specifier));},module,module.exports);
  return module.exports;
 }
 return{catalogue:load('tools/android-build/native-map-catalogue.ts'),coastal:load('web/lib/reviewed-coastal-routes.ts'),overlay:load('web/lib/map-trail-overlay.ts'),mode:load('tools/android-build/native-map-mode.ts')};
}
function fixture({manifest=descriptor,request:intercept}={}){
 const api=modules(),requests=[];
 const request=async(value,options)=>{
  const url=String(value);requests.push({url,options});
  if(intercept)return intercept(url,options);
  assert.equal(new URL(url).origin,origin);assert.equal(new URL(url).search,'');
  return url===origin+'/custom-map/catalogue.json'?Response.json(manifest):new Response(readFileSync(path.join(root,'web/public',new URL(url).pathname)));
 };
 return{...api,requests,instance:new api.catalogue.NativeMapCatalogue(origin,request)};
}
const arrayBuffer=bytes=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
const pause=()=>new Promise(done=>setTimeout(done,5));
async function until(predicate){const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw new Error('Native overlay did not settle');await pause();}}

test('canonical native catalogue URLs retain exact revision and origin admission',async()=>{
 const {instance,requests}=fixture();const source=descriptor.sources[0],signal=new AbortController().signal;
 const bytes=await instance.load(source.url+'?v='+source.sha256.slice(0,16),2,signal);
 assert.equal(bytes.byteLength,source.sizeBytes);assert.equal(requests.at(-1).url,origin+source.url);
 assert.equal(requests.at(-1).options.credentials,'omit');assert.equal(requests.at(-1).options.cache,'no-store');
 const initial=requests.length;
 for(const value of ['https://foreign.invalid'+source.url,origin.replace('https://','https://u:p@')+source.url,source.url+'?token=x',source.url+'?v=0000000000000000',source.url+'?v='+source.sha256.slice(0,16)+'&x=1',source.url+'#x','/data/routes/../'+source.url.split('/').at(-1),source.url.replace('/data/','/d%61ta/'),overview.url+'?v='+overview.sha256.slice(0,16),'/private.json'])await assert.rejects(instance.load(value,2,signal));
 assert.equal(requests.length,initial,'Rejected resources must never reach even the local broker');instance.dispose();
});

test('only the exact Black Creek source and geometry receive the shared issued allowance',async()=>{
 const {instance,coastal}=fixture(),source=sourceMap.get('/data/routes/kolyma-black-creek.geojson');
 const bytes=readFileSync(path.join(root,'web/public',source.url)),geometry=JSON.parse(bytes);
 const allowance=await instance.verifyRoute(arrayBuffer(bytes),geometry,source.ids[0]);
 assert.equal(coastal.isReviewedCoastalAllowance(allowance,geometry),true);
 assert.equal(allowance.geometry.coordinates[0].length,788);
 assert.equal(coastal.isReviewedCoastalAllowance({...allowance},geometry),false);
 await assert.rejects(instance.verifyRoute(arrayBuffer(Buffer.concat([bytes,Buffer.from(' ')])),geometry,source.ids[0]),/integrity mismatch/);
 await assert.rejects(instance.verifyRoute(arrayBuffer(bytes),geometry,descriptor.sources[0].ids[0]),/integrity mismatch/);
 assert.equal(await instance.verifyRoute(arrayBuffer(bytes),geometry,'api-11111111-1111-1111-1111-111111111111'),undefined);
 const changed=JSON.parse(bytes);const line=changed.type==='FeatureCollection'?changed.features[0].geometry:changed.type==='Feature'?changed.geometry:changed;
 (line.type==='MultiLineString'?line.coordinates[0][0]:line.coordinates[0])[0]+=.001;
 assert.equal(await instance.verifyRoute(arrayBuffer(bytes),changed,source.ids[0]),undefined);instance.dispose();
});

test('the real shared overlay renders the complete native source set and obeys current filters offline',async()=>{
 const {instance,overlay,requests}=fixture();let entries=[],error='';
 const loader=new overlay.TrailOverlayLoader({url:overview.url,sha256:overview.sha256,load:(...args)=>instance.load(...args),onChange:value=>entries=value,onError:value=>error=value});
 const bounds=[19,41,191,82];
 loader.update({ids:native.referenceRouteIds,bounds,zoom:3});
 await until(()=>entries.length===overview.uniqueGeometries&&loader.inspect().pending===0);
 assert.equal(error,'');assert.equal(loader.inspect().sources,621);assert.equal(entries.length,621);
 assert.equal(requests.filter(item=>item.url===origin+overview.url).length,1);
 const source=descriptor.sources[0];
 loader.update({ids:[source.ids[0]],selectedId:source.ids[0],bounds,zoom:13});
 assert.equal(entries.length,1);assert.deepEqual([...entries[0].ids],[source.ids[0]]);
 loader.update({ids:[native.referenceOnlyRouteIds[0]],bounds,zoom:13});
 assert.equal(entries.length,0,'Geometry-free cards do not acquire an invented line');
 loader.update({ids:[],bounds,zoom:13});assert.equal(entries.length,0);assert.equal(loader.inspect().pending,0);
 loader.destroy();instance.dispose();assert.ok(requests.every(item=>item.url.startsWith(origin+'/')));
});

test('native descriptor rejects ambiguous identities and byte truncation',async()=>{
 const invalid=structuredClone(descriptor);invalid.sources[1].ids.push(invalid.sources[0].ids[0]);
 const bad=fixture({manifest:invalid});await assert.rejects(bad.instance.manifest(),/Invalid native catalogue source/);bad.instance.dispose();
 const {instance}=fixture({request:async url=>url.endsWith('/catalogue.json')?Response.json(descriptor):new Response('truncated')});
 await assert.rejects(instance.load(descriptor.sources[0].url,2,new AbortController().signal),/length mismatch/);instance.dispose();
 await assert.rejects(instance.manifest(),{name:'AbortError'});
});

test('satellite selection survives network recovery without resetting the camera or displayed ground',()=>{
 const {mode}=modules(),calls=[];
 const target={setMode:value=>calls.push(['mode',value]),setPitch:value=>calls.push(['pitch',value]),setLayers:value=>calls.push(['layers',value]),retry:()=>calls.push(['retry'])};
 const control=new mode.NativeMapModeController(target);
 control.network(true);control.select('satellite');control.network(false);control.network(true);
 assert.equal(control.requested,'satellite');assert.equal(control.online,true);
 assert.deepEqual(calls.filter(value=>value[0]==='mode').map(value=>value[1]),['detail','satellite','detail','satellite']);
 assert.ok(calls.every(value=>value[1]!=='overview'),'A retry must not discard the complete displayed ground');
 control.select('detail');assert.equal(control.requested,'detail');assert.throws(()=>control.select('3d'),/Invalid map mode/);
});
