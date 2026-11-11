import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const bounds=[179,64,181,66],mask={pixels:new Uint8Array([0,255,255,0]),source:{allowedPixels:2}};
const source=ts.transpileModule(readFileSync(new URL('../lib/custom-map-mask.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function fixture({worker=true,postFails=false}={}){
  const instances=[],timers=new Map(),fallbacks=[];let serial=0;
  class Worker{
    constructor(url,options){this.url=url;this.options=options;instances.push(this);}
    postMessage(value){if(postFails)throw new Error('post failed');this.sent=value;}
    terminate(){this.terminated=(this.terminated||0)+1;}
  }
  const fallback=(input,options)=>new Promise((resolve,reject)=>{fallbacks.push({input,options,resolve});options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});
  const dependencies={'./terrain-display-mask':{createRussiaTerrainMask:fallback},'./terrain-display-mask.worker.ts?worker&url':{default:'/assets/mask-worker.js'}};
  const context=vm.createContext({Worker:worker?Worker:undefined,URL,location:{href:'https://tropnik.example/explore'},AbortController,DOMException,
    setTimeout:(callback,ms)=>{const id=++serial;timers.set(id,{callback,ms});return id;},clearTimeout:id=>timers.delete(id)}),testModule={exports:{}};
  vm.runInContext(`(function(require,module,exports){${source}\n})`,context)(id=>{assert.ok(dependencies[id]);return dependencies[id];},testModule,testModule.exports);
  return{prepare:testModule.exports.prepareLandscapeDisplayMask,instances,timers,fallbacks,expire(){const pending=[...timers.values()];for(const {callback,ms} of pending){assert.equal(ms,20_000);callback();}}};
}

test('mask preparation sends only bounds and releases its worker, timer and handlers after transfer',async()=>{
  const env=fixture(),promise=env.prepare(bounds),worker=env.instances[0];
  assert.equal(worker.options.type,'module');assert.deepEqual(JSON.parse(JSON.stringify(worker.sent)),{type:'prepare-display-mask',bounds});
  worker.onmessage({data:{type:'display-mask-ready',mask}});assert.equal(await promise,mask);
  assert.equal(worker.terminated,1);assert.equal(worker.onmessage,null);assert.equal(worker.onerror,null);assert.equal(worker.onmessageerror,null);assert.equal(env.timers.size,0);
});

test('cancellation cannot start an already aborted job or accept a late worker mask',async()=>{
  const env=fixture(),premature=new AbortController();premature.abort();await assert.rejects(env.prepare(bounds,{signal:premature.signal}),{name:'AbortError'});assert.equal(env.instances.length,0);
  const controller=new AbortController(),promise=env.prepare(bounds,{signal:controller.signal}),worker=env.instances[0],late=worker.onmessage;
  controller.abort();await assert.rejects(promise,{name:'AbortError'});late({data:{type:'display-mask-ready',mask}});
  assert.equal(worker.terminated,1);assert.equal(env.timers.size,0);
});

test('deadline, transport failures and invalid messages fail closed and release the only worker',async()=>{
  for(const fail of [env=>env.expire(),env=>env.instances[0].onerror({message:'worker failed'}),env=>env.instances[0].onmessageerror(),env=>env.instances[0].onmessage({data:{type:'wrong'}}),env=>env.instances[0].onmessage({data:{type:'display-mask-error',error:'coverage missing'}})]){
    const env=fixture(),promise=env.prepare(bounds);fail(env);await assert.rejects(promise);assert.equal(env.instances[0].terminated,1);assert.equal(env.timers.size,0);
  }
  const env=fixture({postFails:true});await assert.rejects(env.prepare(bounds),/post failed/);assert.equal(env.instances[0].terminated,1);assert.equal(env.timers.size,0);
});

test('the cooperative fallback preserves cancellation, deadline and cleanup without an unmasked result',async()=>{
  for(const mode of ['success','abort','timeout']){
    const env=fixture({worker:false}),controller=new AbortController(),promise=env.prepare(bounds,{signal:controller.signal});
    assert.equal(env.fallbacks.length,1);assert.deepEqual(env.fallbacks[0].input,bounds);
    if(mode==='success'){env.fallbacks[0].resolve(mask);assert.equal(await promise,mask);}
    else{if(mode==='abort')controller.abort();else env.expire();await assert.rejects(promise);assert.equal(env.fallbacks[0].options.signal.aborted,true);}
    assert.equal(env.timers.size,0);assert.equal(env.instances.length,0);
  }
});
