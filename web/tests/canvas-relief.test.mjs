import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Run the real TypeScript host with controlled I/O. This tests admission,
// transfer ownership and lifecycle; it does not pretend to execute a GPU.
const source=readFileSync(new URL('../lib/canvas-relief.ts',import.meta.url),'utf8')
  .replace('import.meta.url',JSON.stringify('https://fixture.invalid/lib/canvas-relief.ts'));
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({autoResolve=false,byteLength=16}={}){
  const requests=[],workers=[],states=[],completed=[],timers=new Map();let timerId=0,fetching=0,maxFetching=0;
  const nodes=new Set();
  class Worker{
    constructor(){this.messages=[];this.terminated=false;workers.push(this);}
    postMessage(message){this.messages.push(message);}
    terminate(){this.terminated=true;}
    reply(index=this.messages.length-1,extra={}){this.onmessage?.({data:{id:this.messages[index].id,pixels:new Uint8ClampedArray(256*256*4),width:256,height:256,...extra}});}
  }
  class ImageData{constructor(data,width,height){this.data=data;this.width=width;this.height=height;}}
  const L={GridLayer:{extend(methods){return class{
    constructor(options){this.options=options;this.handlers={};this.redraws=0;Object.assign(this,methods);}
    on(name,callback){this.handlers[name]=callback;return this;}
    remove(){for(const tile of nodes)this.handlers.tileunload?.({tile});nodes.clear();}
    redraw(){this.redraws++;this.remove();}
  };}}};
  function loadPublicBytes(url,priority){
    fetching++;maxFetching=Math.max(maxFetching,fetching);
    let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const request={url,priority,settled:false,resolve(bytes=new ArrayBuffer(byteLength)){this.settled=true;resolve(bytes);},reject(){this.settled=true;reject(new Error('Fixture transfer failed'));}};
    requests.push(request);if(autoResolve)queueMicrotask(()=>request.resolve());
    return promise.finally(()=>{fetching--;});
  }
  const scope={exports:{},require:name=>{assert.equal(name,'./map-preload');return{loadPublicBytes};},URL,Worker,ImageData,queueMicrotask,
    setTimeout:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),
    document:{createElement(){return{dataset:{},drawn:0,getContext(){return{putImageData:()=>{this.drawn++;}};}};}}};
  vm.runInNewContext(compiled,scope);
  const relief=scope.exports.createCanvasRelief(L,value=>states.push(value));
  const add=()=>{const tile=relief.layer.createTile({z:6,x:39,y:20},(error,canvas)=>completed.push({error,canvas}));nodes.add(tile);return tile;};
  const unload=tile=>{nodes.delete(tile);relief.layer.handlers.tileunload({tile});};
  const resolvePending=size=>{for(const request of requests.filter(item=>!item.settled))request.resolve(new ArrayBuffer(size??byteLength));};
  return{relief,requests,workers,states,completed,timers,add,unload,resolvePending,maxFetching:()=>maxFetching};
}

test('current map downloads are capped at three and decoding waits for the previous result',async()=>{
  const env=fixture();for(let i=0;i<12;i++)env.add();await tick();
  assert.equal(env.requests.length,3);assert.ok(env.requests.every(item=>item.priority===0));
  env.resolvePending();await tick();assert.equal(env.workers.length,1);assert.equal(env.workers[0].messages.length,1);
  env.resolvePending();await tick();assert.equal(env.workers[0].messages.length,1);
  env.workers[0].reply();await tick();assert.equal(env.completed.length,1);assert.equal(env.completed[0].canvas.drawn,1);
  assert.equal(env.workers[0].messages.length,2);assert.ok(env.maxFetching()<=3);env.relief.destroy();
});

test('queue overflow is an explicit error, never a successfully ready blank tile',async()=>{
  const env=fixture();let overflow;for(let i=0;i<49;i++)overflow=env.add();await tick();
  assert.equal(env.requests.length,3);assert.equal(env.completed.length,1);
  assert.match(env.completed[0].error.message,/queue is full/);assert.equal(overflow.dataset.reliefState,'unavailable');
  assert.equal(overflow.drawn,0);assert.equal(env.states.includes(true),false);env.relief.destroy();
});

test('unloading an active tile keeps its worker slot and discards its late pixels',async()=>{
  const env=fixture();const old=env.add(),waiting=env.add();await tick();env.resolvePending();await tick();
  const worker=env.workers[0];env.unload(old);env.unload(waiting);const current=env.add();await tick();env.resolvePending();await tick();
  assert.equal(worker.messages.length,1);worker.reply(0);await tick();
  assert.equal(old.drawn,0);assert.equal(env.completed.length,0);assert.equal(worker.messages.length,2);
  worker.reply(1);await tick();assert.equal(current.drawn,1);assert.equal(env.completed.length,1);env.relief.destroy();
});

test('repeated pan and unload cannot enqueue unlimited ImageBitmap decodes',async()=>{
  const env=fixture({autoResolve:true});
  for(let batch=0;batch<8;batch++){
    const tiles=Array.from({length:40},()=>env.add());await tick();tiles.forEach(env.unload);await tick();
  }
  assert.equal(env.workers.length,1);assert.equal(env.workers[0].messages.length,1);
  assert.ok(env.maxFetching()<=3);assert.equal(env.completed.length,0);env.relief.destroy();
});

test('a stalled decoder applies byte backpressure before starting more downloads',async()=>{
  const env=fixture({byteLength:2*1024*1024});for(let i=0;i<48;i++)env.add();await tick();
  env.resolvePending();await tick();env.resolvePending();await tick();
  // One 2MiB tile belongs to the worker; only four more can wait in 8MiB.
  assert.equal(env.workers[0].messages.length,1);assert.equal(env.requests.length,5);
  await tick();assert.equal(env.requests.length,5);env.relief.destroy();
});

test('worker timeout releases pending jobs and stale callbacks cannot affect a fresh worker',async()=>{
  const env=fixture();env.add();env.add();await tick();env.resolvePending();await tick();
  const first=env.workers[0],late=first.onmessage,timeout=[...env.timers.values()][0];assert.equal(timeout.delay,10000);
  timeout.fn();await tick();assert.equal(first.terminated,true);assert.equal(env.timers.size,0);
  assert.equal(env.completed.length,2);assert.ok(env.completed.every(item=>item.error));
  const tile=env.add();await tick();env.resolvePending();await tick();const second=env.workers[1];
  late({data:{id:first.messages[0].id}});assert.equal(second.terminated,false);assert.equal(tile.drawn,0);
  second.reply();await tick();assert.equal(tile.drawn,1);env.relief.destroy();
});

test('worker errors and disposal clear work without starting stale downloads or paint',async()=>{
  const env=fixture();env.add();env.add();await tick();env.resolvePending();await tick();
  env.workers[0].onerror();await tick();assert.equal(env.workers[0].terminated,true);
  assert.equal(env.completed.length,2);assert.ok(env.completed.every(item=>item.error));assert.equal(env.timers.size,0);
  const tile=env.add();await tick();const before=env.completed.length;env.relief.destroy();env.resolvePending();await tick();
  assert.equal(env.workers.length,1);assert.equal(tile.drawn,0);assert.equal(env.completed.length,before);
});

test('switching to a detailed base redraws and submits transparent shading mode',async()=>{
  const env=fixture();env.add();await tick();env.resolvePending();await tick();
  assert.equal(env.workers[0].messages[0].overview,true);env.workers[0].reply();await tick();
  env.relief.setOverview(false);assert.equal(env.relief.layer.redraws,1);
  env.add();await tick();env.resolvePending();await tick();assert.equal(env.workers[0].messages[1].overview,false);
  env.relief.destroy();assert.equal(env.timers.size,0);
});
