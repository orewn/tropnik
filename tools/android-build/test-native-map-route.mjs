import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from '../../web/node_modules/typescript/lib/typescript.js';
const source=readFileSync(new URL('./native-map-route.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const context={exports:{},URL,AbortController,fetch,TextDecoder};vm.runInNewContext(compiled,context);
const {NativeMapRouteLoader}=context.exports;
const origin='https://map.tropnik.invalid';
const url=version=>`${origin}/native-route/7-${version}.geojson`;
const geometry=id=>({type:'LineString',coordinates:[[40,43],[40.1,43.1]],id});
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};}
function fixture(request,verify){const drawn=[];return{drawn,loader:new NativeMapRouteLoader(origin,(value,id,coastal)=>drawn.push({value,id,coastal}),request,verify)};}

for(const injected of [false,true])test(`selected route ${injected?'explicit':'default'} fetch preserves the browser receiver contract`,async()=>{
 const requests=[],drawn=[],expected=geometry('reviewed');
 async function browserFetch(value,options){
  if(this!==undefined)throw new TypeError('Illegal invocation');
  requests.push({url:String(value),options});return Response.json(expected);
 }
 const runtime={exports:{},URL,AbortController,fetch:browserFetch,TextDecoder};vm.runInNewContext(compiled,runtime);
 const draw=(value,id)=>drawn.push({value,id});
 const Loader=runtime.exports.NativeMapRouteLoader;
 const loader=injected?new Loader(origin,draw,browserFetch):new Loader(origin,draw);
 try{
  await loader.update({version:1,id:'reviewed',url:url(1)});
  assert.equal(drawn.at(-1).id,'reviewed');assert.equal(JSON.stringify(drawn.at(-1).value),JSON.stringify(expected));
  assert.deepEqual(requests.map(item=>item.url),[url(1)]);
  assert.equal(requests[0].options.credentials,'omit');assert.equal(requests[0].options.signal.aborted,false);
 }finally{loader.dispose();}
});

test('a failed replacement immediately removes the previous card route',async()=>{
 const pending=deferred();let requests=0;
 const {drawn,loader}=fixture(async()=>++requests===1?Response.json(geometry('old')):pending.promise);
 await loader.update({version:1,id:'old',url:url(1)});
 assert.equal(drawn.at(-1).id,'old');
 const replacing=loader.update({version:2,id:'new',url:url(2)});
 assert.equal(drawn.at(-1).value,undefined);
 pending.resolve(new Response('',{status:503}));
 await assert.rejects(replacing,/unavailable/);
 assert.equal(drawn.at(-1).value,undefined);
});
test('a late response cannot replace a newer route even when fetch ignores abort',async()=>{
 const first=deferred(),second=deferred(),requests=[];
 const {drawn,loader}=fixture((address,options)=>{requests.push({address,options});return requests.length===1?first.promise:second.promise;});
 const old=loader.update({version:1,id:'old',url:url(1)});
 const current=loader.update({version:2,id:'current',url:url(2)});
 assert.equal(requests[0].options.signal.aborted,true);
 assert.equal(requests[1].options.credentials,'omit');
 second.resolve(Response.json(geometry('current')));await current;
 first.resolve(Response.json(geometry('old')));await old;
 assert.equal(drawn.at(-1).id,'current');
 assert.equal(drawn.some(value=>value.id==='old'),false);
 const count=drawn.length;await loader.update({version:2,id:'replay',url:url(2)});
 assert.equal(drawn.length,count,'replayed state cannot clear the current route');
});
test('clearing and disposal abort pending routes without reviving a previous line',async()=>{
 const pending=deferred();let signal;
 const {drawn,loader}=fixture((_address,options)=>{signal=options.signal;return pending.promise;});
 const old=loader.update({version:1,id:'old',url:url(1)});
 await loader.update({version:2});assert.equal(signal.aborted,true);
 pending.resolve(Response.json(geometry('old')));await old;
 assert.equal(drawn.every(value=>value.value===undefined),true);
 loader.dispose();const count=drawn.length;await loader.update({version:3,id:'late',url:url(3)});
 assert.equal(drawn.length,count);
});
test('foreign or credential-bearing resources fail closed before any request',async()=>{
 let requests=0;const {drawn,loader}=fixture(async()=>{requests++;return Response.json(geometry('bad'));});
 const invalid=['https://foreign.invalid/native-route/7-1.geojson',origin+'/private.json',origin+'/native-route/7-1.geojson?secret=x','https://name:pass@map.tropnik.invalid/native-route/7-1.geojson'];
 for(const [i,address]of invalid.entries())await assert.rejects(loader.update({version:i+1,url:address}),/Invalid route/);
 assert.equal(requests,0);assert.equal(drawn.length,invalid.length);assert.equal(drawn.every(value=>value.value===undefined),true);
});

test('late verified allowances cannot revive a replaced or disposed route',async()=>{
 const verified=deferred();let entered;
 const started=new Promise(done=>entered=done),token={key:'reviewed-source'};
 const {drawn,loader}=fixture(async()=>Response.json(geometry('old')),async()=>{entered();return verified.promise;});
 const old=loader.update({version:1,id:'old',url:url(1)});await started;
 await loader.update({version:2});verified.resolve(token);await old;
 assert.equal(drawn.every(value=>value.value===undefined),true);
 loader.dispose();
});

test('selected geometry is committed only after its original bytes are verified',async()=>{
 const expected=geometry('reviewed'),token={key:'reviewed-source'};
 const {drawn,loader}=fixture(async()=>Response.json(expected),async(bytes,value,id)=>{
   assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)),expected);
   assert.equal(value.id,id);assert.equal(drawn.at(-1).value,undefined);return token;
 });
 await loader.update({version:1,id:'reviewed',url:url(1)});
 assert.equal(drawn.at(-1).coastal,token);
 const failed=fixture(async()=>Response.json(expected),async()=>{throw new Error('integrity mismatch');});
 await assert.rejects(failed.loader.update({version:1,id:'reviewed',url:url(1)}),/integrity mismatch/);
 assert.equal(failed.drawn.at(-1).value,undefined);
});
