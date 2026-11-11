import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {observeRequestMapLayout,assertRequestMapLayout} from '../browser-request-layout.mjs';

function environment(){
 let time=100,width=1041;
 const attributes={width:'1041',height:'928'},observers={};
 const box=()=>({x:384,y:72,width,height:928});
 const container={isConnected:true,getBoundingClientRect:box};
 const canvas={isConnected:true,getBoundingClientRect:box,get width(){return Number(attributes.width);},height:928,getAttribute:name=>attributes[name]??null};
 const document={documentElement:{clientWidth:1425},querySelector:selector=>selector==='.atlas-canvas'?container:selector==='.tropnik-map-canvas'?canvas:null};
 class ResizeObserver{constructor(callback){this.callback=callback;this.targets=[];observers.resize=this;}observe(target){this.targets.push(target);}disconnect(){this.disconnected=true;}deliver(){this.callback([]);}}
 class MutationObserver{constructor(callback){this.callback=callback;this.pending=[];observers.mutation=this;}observe(target,options){this.target=target;this.options=options;}disconnect(){this.disconnected=true;}takeRecords(){return this.pending.splice(0);}deliver(){this.callback(this.takeRecords());}}
 const context={document,window:{innerWidth:1440,innerHeight:1000,devicePixelRatio:1},performance:{now:()=>time++},ResizeObserver,MutationObserver};
 return{context,document,observers,start:()=>runInNewContext(`(${observeRequestMapLayout.toString()})()`,context),resize(value,{backing=true}={}){width=value;if(backing){observers.mutation.pending.push({attributeName:'width',oldValue:attributes.width});attributes.width=String(value);}},css(value){width=value;}};
}

test('actual observer keeps stable map/backing sizes and treats root clientWidth as diagnostic',()=>{
 const env=environment(),observer=env.start();
 assert.deepEqual(env.observers.resize.targets.length,2);assert.equal(env.observers.mutation.options.attributeOldValue,true);
 env.document.documentElement.clientWidth=1440;observer.sample();env.document.documentElement.clientWidth=1425;env.observers.resize.deliver();
 const receipt=structuredClone(observer.stop());assert.equal(assertRequestMapLayout(receipt),receipt);
 assert.equal(env.observers.resize.disconnected,true);assert.equal(env.observers.mutation.disconnected,true);
 assert.deepEqual(receipt.samples.map(sample=>sample.rootClientWidth),[1425,1440,1425,1425]);
});

test('transient fifteen-pixel expansion fails even after CSS and backing return to the baseline',()=>{
 const env=environment(),observer=env.start();
 env.resize(1056);env.observers.resize.deliver();env.observers.mutation.deliver();
 env.resize(1041);env.observers.resize.deliver();env.observers.mutation.deliver();
 const receipt=structuredClone(observer.stop());assert.deepEqual(receipt.samples[0].canvas,receipt.samples.at(-1).canvas);
 assert.deepEqual(receipt.samples[0].backing,receipt.samples.at(-1).backing);
 assert.throws(()=>assertRequestMapLayout(receipt),/changed during a request dialog/);
});

test('coalesced expand-and-restore mutations cannot hide an intermediate backing allocation at cleanup',()=>{
 const env=environment(),observer=env.start();
 env.resize(1056);env.resize(1041);
 const receipt=structuredClone(observer.stop()),mutations=receipt.samples.flatMap(sample=>sample.mutations);
 assert.deepEqual(mutations.map(value=>value.oldValue),['1041','1056']);assert.ok(mutations.every(value=>value.currentValue==='1041'));
 assert.throws(()=>assertRequestMapLayout(receipt),/transient canvas backing width changed/);
 assert.equal(env.observers.mutation.disconnected,true);
});

test('observation overflow is bounded and explicit, including a large attribute batch',()=>{
 const env=environment(),observer=env.start();
 for(let index=0;index<40;index++){env.document.documentElement.clientWidth=1425+index;observer.sample();}
 const receipt=structuredClone(observer.stop());assert.equal(receipt.samples.length,32);assert.equal(receipt.overflow,true);
 assert.throws(()=>assertRequestMapLayout(receipt),/exceeded the bound/);
 const batch=environment(),second=batch.start();for(let index=0;index<40;index++)batch.resize(1041);
 const result=structuredClone(second.stop());assert.equal(result.overflow,true);assert.ok(result.samples.every(sample=>sample.mutations.length<=32));
});

test('production request wrapper runs the same action once and always detaches observers on failure',async()=>{
 const source=await readFile(new URL('../browser-smoke.mjs',import.meta.url),'utf8');
 const start=source.indexOf('async function checkRequestOwnership('),end=source.indexOf('async function performRequestOwnership(',start);
 assert.ok(start>0&&end>start);
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const invoke=new AsyncFunction('evaluate','performRequestOwnership','observeRequestMapLayout','assertRequestMapLayout','currentExploreExperience','cdp','profile','route',source.slice(start,end)+'\nreturn checkRequestOwnership(cdp,profile,route);');
 for(const mobile of [false,true])for(const failed of [false,true]){
  const env=environment(),failure=new Error('Original native action failed'),value={route:{id:'one'}},experience={};let actions=0,evaluations=0;
  const evaluate=async(_cdp,script)=>{evaluations++;return structuredClone(runInNewContext(script,env.context));};
  const action=async()=>{actions++;if(failed)throw failure;return value;};
  const promise=invoke(evaluate,action,observeRequestMapLayout,assertRequestMapLayout,experience,{}, {mobile,name:mobile?'android-portrait':'desktop-webgl'},{id:'one'});
  if(failed)await assert.rejects(promise,error=>error===failure);else{const result=await promise;assert.deepEqual(result.route,value.route);if(!mobile)assertRequestMapLayout(result.mapLayout);}
  assert.equal(actions,1);assert.equal(evaluations,mobile?0:2);
  if(!mobile){assert.equal(env.observers.resize.disconnected,true);assert.equal(env.observers.mutation.disconnected,true);assert.equal(env.context.window.__tropnikRequestMapLayout,undefined);assertRequestMapLayout(experience.requestMapLayout);}
 }
});
