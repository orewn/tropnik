import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const compile=file=>ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8').replaceAll('import.meta.url',JSON.stringify(new URL(file,'https://preview.test/tests/').href)),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const managerSource=compile('../lib/custom-map-trail-raster.ts');
const workerSource=compile('../lib/custom-map-trail-raster.worker.ts');
const plain=value=>JSON.parse(JSON.stringify(value));
const microtasks=()=>new Promise(resolve=>queueMicrotask(resolve));
function bitmap(width,height){return{width,height,closed:0,close(){this.closed++;}};}
function part(id=1,values=[.5,.25,.6,.3]){return{id,points:new Float64Array(values)};}
function frame(parts=[part()],options={}){
  return{parts,width:120,height:80,transform:[100,0,0,100,-25,-10],haloWidth:.034,lineWidth:.014,haloColor:'rgba(255,254,245,.9)',lineColor:'#618253',...options};
}
class ControlledWorker {
  messages=[];
  terminated=0;
  postMessage(payload,transfer){this.messages.push({payload,transfer});}
  terminate(){this.terminated++;}
  reply(value){this.onmessage?.({data:value});}
  complete(index=this.messages.length-1,extra={}){
    const job=this.messages[index].payload,result=bitmap(job.width,job.height);
    this.reply({id:job.id,bitmap:result,...extra});return result;
  }
}
function fixture(options={}){
  const workers=[],events=[];
  const testModule={exports:{}};
  const context=vm.createContext({URL,Float64Array,queueMicrotask,setTimeout,clearTimeout,Error});
  const require=id=>{assert.fail(`Unexpected raster dependency ${id}`);};
  vm.runInContext(`(function(require,module,exports){${managerSource}\n})`,context)(require,testModule,testModule.exports);
  const raster=new testModule.exports.CustomMapTrailRaster({onChange:()=>events.push(raster.getState()),createWorker:()=>{const worker=new ControlledWorker();workers.push(worker);return worker;},...options});
  return{raster,workers,events,limits:testModule.exports.TRAIL_RASTER_LIMITS};
}

test('native paints coalesce to one active and the latest view, and only the current result becomes ready',async t=>{
  const {raster,workers,events}=fixture();t.after(()=>raster.destroy());
  const shared=[part()],first=frame(shared),middle=frame(shared,{transform:[100,0,0,100,-26,-10]}),latest=frame(shared,{transform:[100,0,0,100,-27,-10]});
  assert.equal(raster.request(first),undefined);const worker=workers[0];
  assert.deepEqual(plain(raster.getState()),{ready:false,pending:true,error:''});
  raster.request(middle);raster.request(latest);
  assert.equal(worker.messages.length,1);
  const abandoned=worker.complete(0);
  assert.equal(abandoned.closed,1);assert.equal(worker.messages.length,2);
  assert.deepEqual(plain(worker.messages[1].payload.transform),latest.transform);
  assert.equal(worker.messages[1].payload.addParts.length,0,'immutable coordinates are not cloned on another camera frame');
  const painted=worker.complete(1);await microtasks();
  assert.deepEqual(plain(raster.getState()),{ready:true,pending:false,error:''});
  assert.equal(raster.request(latest).bitmap,painted);assert.equal(worker.messages.length,2);assert.equal(events.length,1);
  const unknown=bitmap(120,80);worker.reply({id:99999,bitmap:unknown});assert.equal(unknown.closed,1);assert.equal(painted.closed,0);
});

test('geometry registration transfers private copies, retains every part, and preserves exact ordering',t=>{
  const {raster,workers}=fixture();t.after(()=>raster.destroy());
  const shared=part(),parts=Array.from({length:5000},(_,index)=>({id:index+1,points:shared.points}));
  raster.request(frame(parts));const {payload,transfer}=workers[0].messages[0];
  assert.equal(payload.partIds.length,5000);assert.equal(payload.addParts.length,5000);assert.equal(transfer.length,5000);
  assert.deepEqual([...payload.partIds],[...Array(5000)].map((_,index)=>index+1));
  assert.notEqual(payload.addParts[0].points,shared.points);assert.deepEqual([...payload.addParts[0].points],[...shared.points]);
  assert.equal(transfer[0],payload.addParts[0].points.buffer);assert.equal(shared.points.byteLength,32,'caller-owned geometry remains attached for selection/hit tests');
  assert.deepEqual(plain(payload.transform),[100,0,0,100,-25,-10]);
});

test('an exact cached country frame survives filtering, and differing style, backing scale and geometry do not alias',t=>{
  const {raster,workers}=fixture();t.after(()=>raster.destroy());
  const all=[part(1),part(2,[.7,.4,.8,.5])],country=frame(all),filtered=frame([all[1]]);
  raster.request(country);const worker=workers[0],countryBitmap=worker.complete();
  raster.request(filtered);const filteredBitmap=worker.complete();
  assert.equal(raster.request(frame([...all])).bitmap,countryBitmap,'a reconstructed parts list still finds the same exact geometry');
  assert.equal(worker.messages.length,2);
  raster.request(frame(all,{lineColor:'#f2d49b'}));assert.equal(worker.messages.length,3);assert.equal(raster.getState().ready,false);
  worker.complete();
  raster.request(frame(all,{width:240,height:160,transform:[200,0,0,200,-50,-20]}));assert.equal(worker.messages.length,4);
  worker.complete();assert.equal(filteredBitmap.closed,1,'the least recently used entry is released at the three-frame bound');
  const changed=frame([{id:1,points:new Float64Array([.1,.1,.2,.2])},all[1]]);
  assert.equal(raster.request(changed),undefined);assert.match(raster.getState().error,/identity changed/);
  assert.equal(worker.messages.length,4,'a stable part id cannot silently acquire different pixels');
});

test('clear and destruction reject late selected/filter frames and close owned bitmaps exactly once',async t=>{
  const {raster,workers,events}=fixture();t.after(()=>raster.destroy());
  const original=frame([part(1)]),next=frame([part(2)]);
  raster.request(original);const worker=workers[0],kept=worker.complete();await microtasks();
  raster.request(next);raster.clear();const late=worker.complete();await microtasks();
  assert.equal(late.closed,1);assert.deepEqual(plain(raster.getState()),{ready:false,pending:false,error:''});
  assert.equal(events.length,1,'a hidden layer is not republished by old work');
  assert.equal(raster.request(original).bitmap,kept);
  raster.request(next);raster.destroy();assert.equal(kept.closed,1);assert.equal(worker.terminated,1);
  const afterDestroy=worker.complete();await microtasks();assert.equal(afterDestroy.closed,1);assert.equal(events.length,1);
  raster.destroy();assert.equal(kept.closed,1);
});

test('the byte budget evicts complete old frames even below the entry count bound',t=>{
  const {raster,workers,limits}=fixture();t.after(()=>raster.destroy());
  assert.equal(limits.bitmapBytes,64*1024*1024);assert.equal(limits.frameBytes,32*1024*1024);
  const parts=[part()],shots=[];
  for(let index=0;index<3;index++){
    raster.request(frame(parts,{width:2048,height:4096,transform:[100,0,0,100,index,0]}));shots.push(workers[0].complete());
  }
  assert.equal(shots[0].closed,1);assert.equal(shots[1].closed,0);assert.equal(shots[2].closed,0);
  raster.destroy();assert.deepEqual(shots.map(shot=>shot.closed),[1,1,1]);
});

test('invalid and oversized frames report a stable error without starting a worker or a redraw loop',async t=>{
  const {raster,workers,events}=fixture();t.after(()=>raster.destroy());
  const invalid=frame([part()],{width:4096,height:4096});
  assert.equal(raster.request(invalid),undefined);await microtasks();
  assert.match(raster.getState().error,/32 MiB/);assert.equal(workers.length,0);assert.equal(events.length,1);
  raster.request(invalid);await microtasks();assert.equal(events.length,1);
  for(const value of [frame([part(0)]),frame([part(1,[0,1,2])]),frame([part(1,[0,1,NaN,2])]),frame([part()],{transform:[1,0,0,0,0,0]})]){
    assert.equal(raster.request(value),undefined);assert.equal(raster.getState().ready,false);assert.equal(raster.getState().pending,false);assert.ok(raster.getState().error);
  }
  assert.equal(workers.length,0);
});

test('worker failure is explicit, does not retry on every draw, and a user retry registers its geometry again',async t=>{
  const {raster,workers}=fixture();t.after(()=>raster.destroy());const value=frame([part()]);
  raster.request(value);const first=workers[0];first.reply({id:first.messages[0].payload.id,error:'No Canvas context'});await microtasks();
  assert.equal(first.terminated,1);assert.deepEqual(plain(raster.getState()),{ready:false,pending:false,error:'Trail overlay raster: No Canvas context'});
  raster.request(value);assert.equal(workers.length,1);
  raster.retry();assert.equal(workers.length,2);assert.equal(workers[1].messages[0].payload.addParts.length,1);
  const image=workers[1].complete();await microtasks();assert.equal(raster.request(value).bitmap,image);assert.equal(raster.getState().error,'');
});

test('a malformed returned bitmap is closed and cannot count as a ready viewport',async t=>{
  const {raster,workers}=fixture();t.after(()=>raster.destroy());raster.request(frame());
  const bad=bitmap(119,80);workers[0].reply({id:workers[0].messages[0].payload.id,bitmap:bad});await microtasks();
  assert.equal(bad.closed,1);assert.equal(raster.getState().ready,false);assert.match(raster.getState().error,/invalid bitmap/);
});

test('worker creation and timed-out native paint fail visibly and remain bounded',async t=>{
  const unavailable=fixture({createWorker:()=>{throw new Error('Worker unavailable');}});t.after(()=>unavailable.raster.destroy());
  assert.equal(unavailable.raster.request(frame()),undefined);await microtasks();assert.match(unavailable.raster.getState().error,/Worker unavailable/);
  const timed=fixture({timeoutMs:5});t.after(()=>timed.raster.destroy());timed.raster.request(frame());
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(timed.workers[0].terminated,1);assert.match(timed.raster.getState().error,/deadline/);
  const late=timed.workers[0].complete();assert.equal(late.closed,1);assert.equal(timed.raster.getState().ready,false);
});

function workerFixture(){
  const replies=[],surfaces=[];
  class Path {
    operations=[];
    moveTo(x,y){this.operations.push(['move',x,y]);}
    lineTo(x,y){this.operations.push(['line',x,y]);}
    addPath(path){this.operations.push(['part',path]);}
  }
  class Canvas {
    constructor(width,height){this.width=width;this.height=height;this.strokes=[];surfaces.push(this);}
    getContext(kind,options){
      this.kind=kind;this.options=options;
      const context={setTransform:(...matrix)=>{this.matrix=matrix;},stroke:path=>{this.strokes.push({path,width:context.lineWidth,color:context.strokeStyle,cap:context.lineCap,join:context.lineJoin});}};
      this.context=context;return context;
    }
    transferToImageBitmap(){return bitmap(this.width,this.height);}
  }
  const self={postMessage(payload,options){replies.push({payload,options});}};
  vm.runInNewContext(workerSource,{self,exports:{},Path2D:Path,OffscreenCanvas:Canvas,Float64Array,Error});
  return{replies,surfaces,send:job=>self.onmessage({data:job})};
}

test('the actual worker preserves disconnected parts and paints one complete path in the original two-pass order',t=>{
  const {raster,workers}=fixture({softwareRaster:true});t.after(()=>raster.destroy());
  raster.request(frame([part(1,[.95,.2,1.02,.25]),part(2,[.1,.1,.2,.2,.3,.1])],{transform:[120,30,-10,80,12,9]}));
  const actual=workerFixture(),job=workers[0].messages[0].payload;actual.send(job);
  const surface=actual.surfaces[0],strokes=surface.strokes;
  assert.deepEqual(plain(surface.options),{alpha:true,willReadFrequently:true});assert.deepEqual(surface.matrix,[120,30,-10,80,12,9]);
  assert.equal(strokes.length,2);assert.equal(strokes[0].path,strokes[1].path);
  assert.deepEqual(strokes.map(({width,color,cap,join})=>({width,color,cap,join})),[
    {width:.034,color:'rgba(255,254,245,.9)',cap:'round',join:'round'},
    {width:.014,color:'#618253',cap:'round',join:'round'},
  ]);
  assert.deepEqual(strokes[0].path.operations.map(([,path])=>path.operations),[
    [['move',.95,.2],['line',1.02,.25]],
    [['move',.1,.1],['line',.2,.2],['line',.3,.1]],
  ]);
  const response=actual.replies[0];assert.equal(response.payload.id,job.id);assert.equal(response.options.transfer[0],response.payload.bitmap);
  actual.send({...job,id:job.id+1,addParts:[],partIds:[2],dropPartIds:[1]});assert.equal(actual.surfaces[1].strokes[0].path.operations.length,1);
  actual.send({...job,id:job.id+2,addParts:[],partIds:[1],dropPartIds:[]});assert.match(actual.replies.at(-1).payload.error,/not registered/);
});

test('the actual worker rejects oversized allocation and malformed geometry before producing a bitmap',t=>{
  const {raster,workers}=fixture();t.after(()=>raster.destroy());raster.request(frame());const job=workers[0].messages[0].payload;
  for(const bad of [{...job,width:4096,height:4096},{...job,addParts:[part(1,[0,1,Infinity,2])]}]){
    const actual=workerFixture();actual.send(bad);assert.equal(actual.surfaces.length,0);assert.ok(actual.replies[0].payload.error);assert.equal(actual.replies[0].payload.bitmap,undefined);
  }
});
