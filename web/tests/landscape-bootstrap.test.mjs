import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../scripts/landscape-bootstrap.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(){
 const windowEvents=new Map(),documentEvents=new Map(),jobs=[],instances=[],timers=new Map();let nextTimer=0;
 const node=id=>({hidden:id==='retry',getBoundingClientRect:()=>({width:1200}),setAttribute(){},focus(){},
  cloneNode(){return node(id);},replaceWith(replacement){elements[id]=replacement;}});
 const elements=Object.fromEntries(['terrain','status','feedback','retry','info','about','close','zoom-in','zoom-out','rotate','reset'].map(id=>[id,node(id)]));
 const document={documentElement:{dataset:{}},visibilityState:'visible',getElementById:id=>elements[id],querySelector:()=>({getBoundingClientRect:()=>({height:120})}),addEventListener:(name,fn)=>documentEvents.set(name,fn),removeEventListener:name=>documentEvents.delete(name)};
 const window={addEventListener:(name,fn)=>windowEvents.set(name,fn),removeEventListener:name=>windowEvents.delete(name)};
 const createTerrainModelAsync=(_grid,{signal})=>new Promise((resolve,reject)=>{jobs.push({resolve,signal});signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
 class TerrainRenderer{
  constructor(canvas,_grid,options){this.canvas=canvas;this.options=options;this.visibility=[];instances.push(this);}
  setGeometry(){}setViewportInsets(){}setVisible(value){this.visibility.push(value);}destroy(){this.destroyed=true;}zoomBy(){}rotate(){}reset(){}
 }
 const context={document,window,innerHeight:900,AbortController,createTerrainModelAsync,TerrainRenderer,
  setTimeout:fn=>{const id=++nextTimer;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)};
 runInNewContext(source+'\nmountLandscape({},{});',context);
 return{document,windowEvents,documentEvents,jobs,instances,elements,timers};
}
test('standalone starts one cooperative preparation and never creates a renderer after disposal',async()=>{
 const env=setup();assert.equal(env.jobs.length,1);assert.equal(env.instances.length,0);
 env.windowEvents.get('pagehide')({persisted:false});assert.equal(env.jobs[0].signal.aborted,true);
 await tick();env.jobs[0].resolve({});await tick();assert.equal(env.instances.length,0);assert.equal(env.documentEvents.size,0);
});
test('a fast hide/show retries preparation once without a detached or duplicate scene',async()=>{
 const env=setup();env.document.visibilityState='hidden';env.documentEvents.get('visibilitychange')();
 env.document.visibilityState='visible';env.documentEvents.get('visibilitychange')();await tick();
 assert.equal(env.jobs.length,2);env.jobs[1].resolve({prepared:true});await tick();
 assert.equal(env.instances.length,1);assert.equal(env.instances[0].options.preparedModel.prepared,true);
});
test('bfcache and tab visibility retain a ready renderer and ordinary disposal destroys it',async()=>{
 const env=setup();env.jobs[0].resolve({});await tick();const renderer=env.instances[0];
 env.windowEvents.get('pagehide')({persisted:true});env.windowEvents.get('pageshow')({persisted:true});
 env.document.visibilityState='hidden';env.documentEvents.get('visibilitychange')();
 env.document.visibilityState='visible';env.documentEvents.get('visibilitychange')();
 assert.equal(env.jobs.length,1);assert.equal(env.instances.length,1);assert.deepEqual(renderer.visibility,[false,true,false,true]);
 env.windowEvents.get('pagehide')({persisted:false});assert.equal(renderer.destroyed,true);
});
test('terminal failure after the first frame requires a fresh canvas and cannot be revived by stale callbacks',async()=>{
 const env=setup();env.jobs[0].resolve({});await tick();const first=env.instances[0];
 first.options.onRender();assert.equal(env.document.documentElement.dataset.sceneState,'ready');
 first.options.onFatal('No graphics context');
 assert.equal(env.document.documentElement.dataset.sceneState,'failed');
 assert.equal(first.destroyed,true);assert.equal(env.elements.retry.hidden,false);assert.equal(env.timers.size,0);
 first.options.onRender();assert.equal(env.document.documentElement.dataset.sceneState,'failed');
 env.document.visibilityState='hidden';env.documentEvents.get('visibilitychange')();
 env.document.visibilityState='visible';env.documentEvents.get('visibilitychange')();
 assert.equal(env.jobs.length,1);assert.equal(env.instances.length,1);
 env.elements.retry.onclick();assert.equal(env.document.documentElement.dataset.sceneState,'loading');
 assert.notEqual(env.elements.terrain,first.canvas);assert.equal(env.jobs.length,2);
 first.options.onRender();first.options.onFatal('Late failed-context callback');
 assert.equal(env.document.documentElement.dataset.sceneState,'loading');
 env.jobs[1].resolve({});await tick();const second=env.instances[1];second.options.onRender();
 assert.equal(env.document.documentElement.dataset.sceneState,'ready');
 assert.notEqual(second,first);assert.notEqual(second.canvas,first.canvas);assert.equal(env.elements.retry.hidden,true);
 env.windowEvents.get('pagehide')({persisted:false});
});
