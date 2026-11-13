import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {compileFunction} from 'node:vm';

const source=readFileSync(new URL('../verify-deployed.mjs',import.meta.url),'utf8');
const start=source.indexOf('async function request('),end=source.indexOf('\n// Pages can briefly',start);
assert.ok(start>=0&&end>start,'Use the actual bounded public request implementation');
const requestSource=source.slice(start,end);
const browserCalls=[...source.matchAll(/await (request\('browser-verification\.json'[^)]*\))/g)];
assert.equal(browserCalls.length,1,'Exercise the actual browser report request call site');
const browserCall=browserCalls[0][1];
const loadingCalls=[...source.matchAll(/await (request\('browser-map-loading-verification\.json'[^)]*\))/g)];
assert.equal(loadingCalls.length,1,'Exercise the actual mandatory map-loading receipt request');
const loadingCall=loadingCalls[0][1];

// Transport-only tests use opaque synthetic bytes, not a fabricated successful
// browser receipt. The production assertBrowserReport remains unchanged and is
// exercised by the deployed full-report gate.
function harness(size){
 const calls=[],site=new URL('https://orewn.github.io/tropnik/'),expectedBuild='0123456789abcdef';
 const chunk=Buffer.alloc(Math.min(size,64*1024),0x78);
 let delivered=0;
 const fetch=async(url,options)=>{
  calls.push({url:url.href,options});
  return{status:200,body:(async function*(){
   let remaining=size;
   while(remaining){const length=Math.min(remaining,chunk.length);remaining-=length;delivered+=length;yield chunk.subarray(0,length);}
  })()};
 };
 const make=compileFunction(
  'let checks=0;\n'+requestSource+'\nreturn {request,readBrowser:async()=>'+browserCall+',readMapLoading:async()=>'+loadingCall+',checks:()=>checks};',
  ['assert','createHash','fetch','site','expectedBuild','URL','AbortSignal','Buffer']);
 return{...make(assert,createHash,fetch,site,expectedBuild,URL,AbortSignal,Buffer),calls,delivered:()=>delivered};
}

test('the real browser request streams the retained 16,534,673-byte proof body without truncation',async()=>{
 const size=16_534_673,env=harness(size),result=await env.readBrowser();
 assert.equal(result.bytes,size);assert.equal(result.text.length,size);
 assert.equal(result.sha256,createHash('sha256').update(Buffer.alloc(size,0x78)).digest('hex'));
 assert.equal(env.delivered(),size);assert.equal(env.checks(),1);
 assert.equal(env.calls.length,1);assert.equal(env.calls[0].url,'https://orewn.github.io/tropnik/browser-verification.json?tropnik-build=0123456789abcdef');
 assert.equal(env.calls[0].options.redirect,'error');assert.equal(env.calls[0].options.cache,'no-store');
 assert.ok(env.calls[0].options.signal instanceof AbortSignal);
});

test('the real browser request still rejects even one byte above 32 MiB',async()=>{
 const size=32*1024*1024+1,env=harness(size);
 await assert.rejects(env.readBrowser(),/exceeds its response budget/);
 assert.equal(env.delivered(),size);assert.equal(env.checks(),0);
});

test('the ordinary public request accepts its existing exact 4 MiB boundary',async()=>{
 const size=4*1024*1024,env=harness(size),result=await env.request('build-info.json');
 assert.equal(result.bytes,size);assert.equal(result.text.length,size);assert.equal(env.checks(),1);
});

for(const path of ['build-info.json','assets/site.js']){
 test('the ordinary '+path+' request still rejects one byte above 4 MiB',async()=>{
  const env=harness(4*1024*1024+1);
  await assert.rejects(env.request(path),/exceeds its response budget/);assert.equal(env.checks(),0);
 });
}

test('the larger body limit is explicit at the browser call site, not a changed global default',async()=>{
 const env=harness(16_534_673);
 await assert.rejects(env.request('browser-verification.json'),/exceeds its response budget/);
 assert.ok(env.delivered()<16_534_673);assert.equal(env.checks(),0);
});

test('the mandatory map-loading proof uses the original bounded same-origin public transport',async()=>{
 const size=4*1024*1024,env=harness(size),result=await env.readMapLoading();
 assert.equal(result.bytes,size);assert.equal(result.text.length,size);assert.equal(env.checks(),1);
 assert.equal(env.calls[0].url,'https://orewn.github.io/tropnik/browser-map-loading-verification.json?tropnik-build=0123456789abcdef');
 assert.equal(env.calls[0].options.redirect,'error');assert.equal(env.calls[0].options.cache,'no-store');
 const oversized=harness(size+1);await assert.rejects(oversized.readMapLoading(),/exceeds its response budget/);assert.equal(oversized.checks(),0);
});
