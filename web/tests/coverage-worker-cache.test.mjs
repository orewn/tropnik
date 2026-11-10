import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {rewriteScript} from '../../tools/pages-preview/paths.mjs';

const source=await readFile(new URL('../public/sw.js',import.meta.url),'utf8');
const origin='https://coverage-fixture.invalid';
const MiB=1024*1024;
function worker({base='/',bytes=MiB/2,failWrite=false}={}) {
 const handlers={},stored=new Map([[base+'offline-safety.html',new Response('saved emergency viewer')]]);
 let requests=0;
 const path=value=>typeof value==='string'?value:new URL(value.url).pathname;
 const cache={
  async keys(){return [...stored.keys()].map(key=>({url:origin+key}));},
  async match(key){return stored.get(path(key))?.clone();},
  async delete(key){return stored.delete(path(key));},
  async put(key,response){if(failWrite)throw new Error('Quota exceeded');stored.set(path(key),response.clone());},
 };
 const script=base==='/'?source:rewriteScript(source,'sw.js',{base});
 vm.runInNewContext(script,{
  self:{location:{origin},addEventListener(name,handler){handlers[name]=handler;}},
  URL,Response,Uint8Array,caches:{async open(){return cache;}},
  async fetch(){requests++;const response=new Response(new Uint8Array(bytes),{headers:{'Content-Type':'application/octet-stream'}});Object.defineProperty(response,'type',{value:'basic'});return response;},
 });
 async function get(file){let result,done;handlers.fetch({request:{url:origin+base+'data/map-coverage/cells/'+file+'.coverage',method:'GET',headers:new Headers()},respondWith(p){result=p;},waitUntil(p){done=p;}});const response=await result;await done;return response;}
 return {stored,get,requests:()=>requests};
}

test('visited geometry cache stays bounded during concurrent panning and preserves the emergency shell',async t=>{
 for(const base of ['/','/tropnik/'])await t.test(base,async()=>{
  const env=worker({base});
  const responses=await Promise.all(Array.from({length:70},(_,i)=>env.get('cell-'+i)));
  assert.ok(responses.every(response=>response.status===200));
  const geometry=[...env.stored.entries()].filter(([key])=>key.includes('/cells/'));
  assert.equal(geometry.length,64);
  assert.ok(geometry.reduce((sum,[,response])=>sum+Number(response.headers.get('x-tropnik-coverage-bytes')),0)<=32*MiB);
  assert.equal(await env.stored.get(base+'offline-safety.html').text(),'saved emergency viewer');
  assert.equal(env.stored.has(base+'data/map-coverage/cells/cell-0.coverage'),false);
  await env.get('cell-69');assert.equal(env.requests(),70,'revisiting the latest geometry must use the saved response');
 });
});

test('a geometry payload beyond the per-cell limit is delivered but not retained',async()=>{
 const env=worker({bytes:3*MiB+1});const response=await env.get('oversize');
 assert.equal((await response.arrayBuffer()).byteLength,3*MiB+1);
 assert.equal(env.stored.size,1);
});

test('cache quota failure never masks a successful map download',async()=>{
 const env=worker({failWrite:true});const response=await env.get('quota');
 assert.equal(response.status,200);assert.equal((await response.arrayBuffer()).byteLength,MiB/2);assert.equal(env.stored.size,1);
});
