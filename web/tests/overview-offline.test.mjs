import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
const publicRoot=new URL('../public/',import.meta.url);
const source=await readFile(new URL('sw.js',publicRoot),'utf8');
const manifest=JSON.parse(await readFile(new URL('maps/russia-relief/manifest.json',publicRoot),'utf8'));
async function run(corrupt=false){
 const calls=[],saved=new Map(),listeners={};
 const cache={addAll:async paths=>{for(const path of paths)saved.set(path,'shell');},put:async(path,response)=>saved.set(path,new Uint8Array(await response.arrayBuffer()))};
 const context=vm.createContext({self:{addEventListener:(name,callback)=>listeners[name]=callback},caches:{open:async()=>cache},crypto:webcrypto,Response,Uint8Array,Set,Map,Promise,Array,Number,Error,fetch:async path=>{
  calls.push(path);assert.ok(path.startsWith('/maps/russia-relief/'));
  const bytes=await readFile(new URL(path.slice(1),publicRoot));
  return new Response(corrupt&&path.endsWith('0/0/0.png')?new Uint8Array([0]):bytes);
 }});
 vm.runInContext(source,context);
 let installation;listeners.install({waitUntil:promise=>installation=promise});
 await installation;return{calls,saved};
}
test('offline shell saves all 341 actual RF overview tiles using 57 verified tile downloads',async()=>{
 const {calls,saved}=await run();
 assert.equal(calls.filter(path=>path.endsWith('.png')).length,57);
 for(const file of manifest.files)assert.equal(saved.get('/maps/russia-relief/'+file.path)?.byteLength,file.bytes,file.path);
 assert.ok(!calls.some(path=>path.includes('/api/')));
});
test('corrupt overview bytes reject installation instead of claiming a complete offline map',async()=>{
 await assert.rejects(run(true),/integrity mismatch/);
});
