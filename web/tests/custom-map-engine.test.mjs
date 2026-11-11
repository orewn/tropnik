import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the production engine and its actual camera, framing, source-admission,
// route and label modules. Only browser surfaces and asynchronous tile delivery
// are controlled. No SDK, network response replacement or source-string gate.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const compiled=new Map(),turn=()=>new Promise(done=>setImmediate(done));
const plain=value=>JSON.parse(JSON.stringify(value));
const camera={center:[40.5,43.5],zoom:8,bearingDegrees:0};
const area={type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[40,42],[42,42],[42,45],[40,45],[40,42]],[[40.65,43.65],[40.65,43.75],[40.75,43.75],[40.75,43.65],[40.65,43.65]]]}};
const collection={type:'FeatureCollection',features:[]};

function fixture({view=camera,width=800,height=600,coverageArea=area,delayedCoverage=false}={}){
 let now=0,serial=0,coverageResolve;const frames=new Map(),timers=new Map(),calls=[],stores=[],observers=[],states=[];
 class Target{
  listeners=new Map();
  addEventListener(type,listener){const listeners=this.listeners.get(type)||new Set();listeners.add(listener);this.listeners.set(type,listeners);}
  removeEventListener(type,listener){this.listeners.get(type)?.delete(listener);}
  dispatch(type,properties={}){const event={type,button:0,preventDefault(){this.defaultPrevented=true;},...properties};for(const listener of [...(this.listeners.get(type)||[])])listener.call(this,event);return event;}
  listenerCount(){return [...this.listeners.values()].reduce((sum,listeners)=>sum+listeners.size,0);}
 }
 class Path{
  commands=[];
  constructor(source){this.source=source;}
  moveTo(...args){this.commands.push(['moveTo',...args]);}lineTo(...args){this.commands.push(['lineTo',...args]);}
  rect(...args){this.commands.push(['rect',...args]);}closePath(){this.commands.push(['closePath']);}addPath(path){this.commands.push(['addPath',path]);}
 }
 const context={font:'10px sans-serif',fillStyle:'#000000',strokeStyle:'#000000',lineWidth:1,globalAlpha:1,stack:[],
  save(){this.stack.push(Object.fromEntries(['font','fillStyle','strokeStyle','lineWidth','globalAlpha','textAlign','textBaseline'].map(key=>[key,this[key]])));calls.push({op:'save'});},
  restore(){Object.assign(this,this.stack.pop());calls.push({op:'restore'});},
  measureText(text){const fontSize=Number(this.font.match(/([\d.]+)px/)?.[1]||10),width=text.length*fontSize*.55;calls.push({op:'measureText',text,font:this.font,width});return{width,actualBoundingBoxAscent:fontSize*.8,actualBoundingBoxDescent:fontSize*.2};},
  fill(path,rule){calls.push({op:'fill',path,rule,color:this.fillStyle});},
  stroke(path){calls.push({op:'stroke',path,color:this.strokeStyle,width:this.lineWidth});},
  drawImage(bitmap,...args){calls.push({op:'drawImage',key:bitmap.key,bitmap,args,alpha:this.globalAlpha});},
  strokeText(text,x,y){calls.push({op:'strokeText',text,x,y,font:this.font});},
  fillText(text,x,y){calls.push({op:'fillText',text,x,y,font:this.font});},
 };
 for(const name of ['setTransform','resetTransform','translate','scale','rotate','fillRect','clearRect','strokeRect','beginPath','closePath','moveTo','lineTo','arc','ellipse','bezierCurveTo','quadraticCurveTo','roundRect','rect','clip','setLineDash'])context[name]=function(...args){calls.push({op:name,args});};
 function matches(element,selector){
  if(selector.startsWith(':'))return false;
  const classes=[...selector.matchAll(/\.([\w-]+)/g)].map(match=>match[1]);
  if(classes.length)return classes.every(name=>element.classList.contains(name));
  return selector.toUpperCase()===element.tagName;
 }
 class Element extends Target{
  children=[];dataset={};className='';hidden=false;attributes={};isConnected=true;pointerCapture=new Set();clientWidth=width;clientHeight=height;
  constructor(tag){super();this.tagName=tag.toUpperCase();this.style={setProperty(name,value){this[name]=value;},getPropertyValue(name){return this[name]||'';},removeProperty(name){delete this[name];}};this.classList={contains:name=>this.className.split(/\s+/).includes(name),add:(...names)=>{this.className=[...new Set([...this.className.split(/\s+/).filter(Boolean),...names])].join(' ');},remove:(...names)=>{this.className=this.className.split(/\s+/).filter(name=>!names.includes(name)).join(' ');},toggle:(name,force)=>{const enabled=force??!this.classList.contains(name);this.classList[enabled?'add':'remove'](name);return enabled;}};}
  appendChild(element){element.parentElement=this;this.children.push(element);return element;}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;this.isConnected=false;}
  setAttribute(name,value){this.attributes[name]=String(value);}getAttribute(name){return this.attributes[name]??null;}
  removeAttribute(name){delete this.attributes[name];}hasAttribute(name){return Object.hasOwn(this.attributes,name);}
  contains(element){return element===this||this.children.some(child=>child.contains(element));}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(selector.split(',').some(value=>matches(child,value))?[child]:[]),...child.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  closest(selector){return matches(this,selector)?this:this.parentElement?.closest(selector)||null;}
  matches(selector){return matches(this,selector);}
  getBoundingClientRect(){const w=Number.parseFloat(this.style.width)||this.clientWidth,h=Number.parseFloat(this.style.height)||this.clientHeight;return{x:0,y:0,left:0,top:0,right:w,bottom:h,width:w,height:h};}
  getContext(type){assert.equal(type,'2d');return context;}
  focus(){}setPointerCapture(id){this.pointerCapture.add(id);}hasPointerCapture(id){return this.pointerCapture.has(id);}releasePointerCapture(id){this.pointerCapture.delete(id);}
 }
 const document={createElement:tag=>new Element(tag),createElementNS:(_namespace,tag)=>new Element(tag)},window=new Target(),host=new Element('div');
 const coverage={area:coverageArea,boundaries:collection,territories:collection,status:{ready:true,lod:'source',pending:0,error:'',version:'a'.repeat(16),cells:['test']},updates:[],subscribers:new Set(),disposed:0,
  subscribe(listener){this.subscribers.add(listener);return()=>this.subscribers.delete(listener);},
  async updateView(bounds,zoom){this.updates.push({bounds:[...bounds],zoom});},dispose(){this.disposed++;}};
 const coveragePromise=new Promise(done=>{coverageResolve=done;});
 if(!delayedCoverage)coverageResolve(coverage);
 let tileKey;
 class Tiles{
  cache=new Map();jobs=new Map();requests=[];pins=[];active=true;destroyed=false;
  constructor(){stores.push(this);}
  get resident(){return this.cache.size;}get pending(){return this.jobs.size;}
  setActive(active){this.active=active;}pin(keys){this.pins.push([...keys]);}
  snapshot(){return{resident:this.resident,pending:this.pending,enabled:this.active,errors:[]};}
  load(request){const key=tileKey(request);if(this.cache.has(key))return Promise.resolve(this.cache.get(key));if(this.jobs.has(key))return this.jobs.get(key).promise;
   const job={key,request:{...request},settled:false};job.promise=new Promise((done,reject)=>{job.done=done;job.reject=reject;});this.jobs.set(key,job);this.requests.push(job);return job.promise;
  }
  resolve(job,{labels=[],local=false}={}){assert.equal(job.settled,false);job.settled=true;const bitmap={key:job.key,width:512,height:512,closed:false,close(){this.closed=true;}},tile={...job.request,key:job.key,bitmap,labels,local,contours:0};if(this.jobs.get(job.key)===job)this.jobs.delete(job.key);if(!this.destroyed)this.cache.set(job.key,tile);job.done(tile);return tile;}
  reject(job,message='Source failed'){assert.equal(job.settled,false);job.settled=true;if(this.jobs.get(job.key)===job)this.jobs.delete(job.key);job.reject(new Error(message));}
  destroy(){this.destroyed=true;this.active=false;for(const tile of this.cache.values())tile.bitmap.close();this.cache.clear();}
 }
 const globals={document,window,Path2D:Path,ResizeObserver:class{constructor(callback){this.callback=callback;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}},
  devicePixelRatio:1,navigator:{onLine:true},matchMedia:()=>({matches:false}),performance:{now:()=>now},console,URL,AbortController,
  getComputedStyle:element=>({display:element.hidden?'none':'block',visibility:'visible',opacity:'1',pointerEvents:'auto'}),
  requestAnimationFrame:callback=>{const id=++serial;frames.set(id,callback);return id;},cancelAnimationFrame:id=>frames.delete(id),
  setTimeout:(callback,delay)=>{const id=++serial;timers.set(id,{callback,at:now+delay});return id;},clearTimeout:id=>timers.delete(id)};
 const environment=vm.createContext(globals),modules=new Map();
 function load(filename){
  if(modules.has(filename))return modules.get(filename).exports;
  const testModule={exports:{}};modules.set(filename,testModule);
  if(!compiled.has(filename))compiled.set(filename,ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},fileName:filename}).outputText);
  const require=specifier=>{
   if(specifier==='./russia-map')return{loadRussiaGeometry:()=>coveragePromise};
   if(specifier==='./map-preload')return{loadPublicBytes(){assert.fail('No real download in an engine unit test');},loadPublicJSON(){assert.fail('No real download in an engine unit test');}};
   if(specifier.endsWith('?worker&url'))return{__esModule:true,default:'/workers/fixture.js'};
   let path=resolve(dirname(filename),specifier);if(!existsSync(path))path+='.ts';assert.ok(path.startsWith(root+'/'),'Only real local map modules may load');
   const result=load(path);if(specifier==='./custom-map-tiles'){tileKey=result.customTileKey;return{...result,CustomMapTiles:Tiles};}return result;
  };
  const run=vm.runInContext(`(function(require,module,exports){${compiled.get(filename)}\n})`,environment,{filename});run(require,testModule,testModule.exports);return testModule.exports;
 }
 const exports=load(resolve(root,'lib/custom-map-engine.ts'));
 const engine=new exports.CustomMapEngine(host,{camera:plain(view),onState:value=>states.push(plain(value))});
 engine.setFloor({center:[105,60],zoom:1,bearingDegrees:0});
 const tick=(elapsed=16)=>{now+=elapsed;const current=[...frames.values()];frames.clear();for(const frame of current)frame(now);return current.length;};
 const flush=()=>{let count=0;while(frames.size){assert.ok(count++<40,'Own renderer left a recurring idle RAF');tick();}return count;};
 const store=stores[0],pending=(kind)=>store.requests.filter(job=>!job.settled&&(!kind||job.request.kind===kind));
 const complete=(selector=()=>true,options=()=>({}))=>{const jobs=pending().filter(selector);for(const job of jobs)store.resolve(job,options(job));return jobs;};
 const ready=async()=>{coverageResolve(coverage);await turn();complete();await turn();flush();return engine;};
 const lastDraw=()=>calls.slice(calls.findLastIndex(call=>call.op==='fillRect'));
 return{engine,host,context,window,coverage,store,states,calls,frames,timers,observers,tick,flush,complete,pending,ready,coverageResolve,lastDraw,
  async settle(){await turn();flush();},geometryPath:exports.geometryPath,
  coordinateAt:point=>engine.unproject(point),labelFor(job,coordinate,text,options={}){const p=load(resolve(root,'lib/custom-map-camera.ts')).mercatorProject(coordinate),n=2**job.request.z;return{x:p.x*n-job.request.x,y:p.y*n-job.request.y,text,kind:'place',rank:4,...options};}};
}

test('production engine coalesces changes, has no idle draw loop and pauses animation/tiles offscreen',async t=>{
 const env=fixture();t.after(()=>env.engine.destroy());await env.ready();const before=env.engine.inspect().drawRevision;
 env.engine.setLabels([]);env.engine.setRegion([]);env.engine.setObstacles([]);env.engine.setLayers({boundaries:false});
 env.flush();assert.equal(env.engine.inspect().drawRevision,before+1);assert.equal(env.frames.size,0);env.tick(1000);assert.equal(env.engine.inspect().drawRevision,before+1);
 env.engine.setCamera({...camera,zoom:9},true);assert.equal(env.host.dataset.mapMoving,'true');env.engine.setActive(false);
 const paused=env.engine.inspect().drawRevision;env.engine.setLabels([{id:'held',coordinate:[40.3,43.3],label:'Held'}]);env.tick(1000);
 assert.equal(env.engine.inspect().drawRevision,paused);assert.equal(env.store.active,false);assert.equal(env.host.dataset.mapMoving,'false');
 env.engine.setActive(true);await env.settle();assert.equal(env.store.active,true);assert.ok(env.engine.inspect().drawRevision>paused);assert.equal(env.frames.size,0);
});

test('late source batches cannot replace a newer camera or resurrect state after destroy',async()=>{
 const env=fixture();await turn();const old=env.pending();assert.ok(old.length>0);
 env.engine.setCamera({center:[100,55],zoom:8});const latest=env.pending().filter(job=>!old.includes(job));assert.ok(latest.length>0);
 for(const job of latest)env.store.resolve(job);await env.settle();const current=plain(env.engine.inspect());
 for(const job of old)env.store.reject(job,'Old viewport failed');await env.settle();
 assert.deepEqual(plain(env.engine.inspect().tiles),current.tiles);assert.deepEqual(plain(env.engine.getCamera()),current.camera);assert.equal(env.engine.getState().error,'');assert.equal(env.engine.getState().loading,false);
 env.engine.setCamera({center:[130,55],zoom:8});const pending=env.pending(),revision=env.engine.inspect().drawRevision,count=env.states.length;
 env.engine.destroy();for(const job of pending)env.store.resolve(job);await env.settle();
 assert.equal(env.engine.inspect().drawRevision,revision);assert.equal(env.states.length,count);assert.equal(env.host.children.length,0);assert.equal(env.window.listenerCount(),0);assert.equal(env.engine.canvas.listenerCount(),0);assert.equal(env.coverage.disposed,1);assert.equal(env.observers[0].disconnected,true);assert.equal(env.store.destroyed,true);
});

test('pending and failed satellite batches retain the actual previous ground until all images commit',async t=>{
 const env=fixture();t.after(()=>env.engine.destroy());await env.ready();
 const ground=env.lastDraw().filter(call=>call.op==='drawImage').map(call=>call.key);assert.ok(ground.some(key=>key.startsWith('relief:')));assert.ok(ground.some(key=>key.startsWith('vector:')));
 env.engine.setMode('satellite');env.complete(job=>!job.request.kind.startsWith('eox-'));await env.settle();
 const pending=env.pending('eox-s2');assert.ok(pending.length>1);assert.equal(env.engine.getState().committedMode,'detail');assert.equal(env.engine.getState().imageryLoading,true);
 assert.deepEqual(env.lastDraw().filter(call=>call.op==='drawImage').map(call=>call.key),ground,'Preload must retain the already painted detail/relief, not a transparent replacement');
 for(const job of pending.slice(1))env.store.resolve(job);await env.settle();assert.equal(env.engine.inspect().tiles.imagery.length,0);
 env.store.reject(pending[0]);await env.settle();assert.equal(env.engine.getState().committedMode,'detail');assert.ok(env.engine.getState().error);assert.equal(env.engine.inspect().tiles.imagery.length,0);
 assert.deepEqual(env.lastDraw().filter(call=>call.op==='drawImage').map(call=>call.key),ground);
 env.engine.setMode('satellite');env.complete();await env.settle();assert.equal(env.engine.getState().committedMode,'satellite');assert.equal(env.engine.getState().imagerySource,'eox-s2');assert.equal(env.engine.getState().imageryLoading,false);
 assert.equal(env.engine.inspect().tiles.imagery.length,pending.length);assert.ok(env.lastDraw().some(call=>call.op==='drawImage'&&call.key.startsWith('eox-s2:')));
});

test('base changes keep real route paths and markers; clearing geometry never claims another painted line',async t=>{
 const env=fixture();t.after(()=>env.engine.destroy());await env.ready();
 const line={type:'LineString',coordinates:[[40.2,43.3],[40.4,43.4],[40.8,43.5]]};
 env.engine.setRoute(line,'route-a');env.flush();const edges=env.host.querySelectorAll('.route-edge-marker'),strokes=env.lastDraw().filter(call=>call.op==='stroke'&&call.color==='#244d3c');assert.equal(edges.length,2);assert.equal(strokes.length,1);const path=strokes[0].path;
 env.engine.setMode('overview');await env.settle();assert.equal(env.host.dataset.mapDrawnRoute,'route-a');assert.deepEqual(env.host.querySelectorAll('.route-edge-marker'),edges);assert.equal(env.lastDraw().find(call=>call.op==='stroke'&&call.color==='#244d3c').path,path);
 env.engine.setRoute(undefined,'route-b');env.flush();assert.equal(env.host.querySelectorAll('.route-edge-marker').length,0);assert.equal(env.lastDraw().some(call=>call.op==='stroke'&&call.color==='#244d3c'),false);assert.equal(env.host.dataset.mapDrawnRoute,'','A selected card without source geometry is not a painted route');
 env.engine.setRoute({type:'FeatureCollection',features:[]},'empty');env.flush();assert.equal(env.host.dataset.mapDrawnRoute,'','An empty source response must not become a painted route');
 env.engine.setRoute({type:'MultiLineString',coordinates:[line.coordinates,[[41,44],[41.1,44.1]]]},'multipart');env.flush();assert.equal(env.host.querySelectorAll('.route-edge-marker').length,0);const multi=env.lastDraw().find(call=>call.op==='stroke'&&call.color==='#244d3c').path;assert.equal(multi.commands.filter(command=>command[0]==='moveTo').length,2,'Source parts must remain separate');
});

test('source admission and whole-glyph drawing follow the mask without truncating foreign or colliding labels',async t=>{
 const env=fixture();t.after(()=>env.engine.destroy());await env.ready();
 env.engine.setLabels([
  {id:'foreign',coordinate:[39.99,43.5],label:'Foreign anchor',rank:0},
  {id:'border',coordinate:[40.01,43.5],label:'Целая российская подпись',rank:1},
  {id:'hole',coordinate:[40.7,43.7],label:'Hole anchor',rank:2},
  {id:'long',coordinate:[41.9,43.5],label:'X'.repeat(100),rank:3},
  {id:'first',coordinate:[41,44],label:'First',rank:4},
  {id:'collision',coordinate:[41,44],label:'Second',rank:5},
  {id:'same-west',coordinate:[40.3,43.2],label:'Same name',rank:6},
  {id:'same-east',coordinate:[41.2,44.4],label:'Same name',rank:7},
  {id:'duplicate',coordinate:[41.2,44.4],label:'Same name',rank:8},
 ]);env.flush();const diagnostics=plain(env.engine.getLabelDiagnostics()),byId=id=>diagnostics.find(item=>item.id===id),draw=env.lastDraw();
 assert.equal(byId('foreign').reason,'outside-coverage');assert.equal(byId('hole').reason,'outside-coverage');assert.equal(byId('border').visible,true);assert.equal(byId('long').visible,false);assert.equal(byId('collision').reason,'collision');
 assert.equal(draw.filter(call=>call.op==='fillText'&&call.text==='Same name').length,2,'Equal names at different source anchors must not disappear');assert.equal(byId('duplicate').visible,false);
 const firstText=draw.findIndex(call=>call.op==='strokeText'),lastMask=draw.findLastIndex(call=>call.op==='fill'&&call.rule==='evenodd');assert.ok(firstText>lastMask&&lastMask>=0,'The mask must finish before complete admitted glyphs are painted');assert.equal(draw.some(call=>call.op==='clip'),false);
 for(const label of diagnostics.filter(item=>item.visible)){assert.ok(label.rect.left>=12&&label.rect.right<=800-12);assert.ok(label.rect.right-label.rect.left>=label.width);}
});

test('the engine keeps source priority-city typography and bounds diagnostic candidates',async t=>{
 const env=fixture({view:{...camera,zoom:10}});t.after(()=>env.engine.destroy());await turn();
 const vector=env.pending('vector'),city=vector.find(job=>{const label=env.labelFor(job,camera.center,'Москва');return label.x>=0&&label.x<=1&&label.y>=0&&label.y<=1;});assert.ok(city);
 env.complete(job=>job!==city);env.store.resolve(city,{labels:[env.labelFor(city,camera.center,'Москва',{rank:9,priorityCity:true})]});await env.settle();
 const painted=env.lastDraw().find(call=>call.op==='fillText'&&call.text==='Москва');assert.ok(painted);assert.match(painted.font,/20px/,'A source priority city must keep its geographic city typography');
 const labels=Array.from({length:1000},(_,index)=>env.labelFor(city,[39.8,43.5],'Outside '+index));
 const current=env.store.cache.get(city.key);current.labels=labels;env.engine.setObstacles([]);env.flush();assert.equal(env.engine.getLabelDiagnostics().length,512);assert.equal(env.lastDraw().some(call=>call.op==='fillText'&&call.text.startsWith('Outside ')),false);
});

test('source outdoor glyphs and names share one whole collision footprint at the viewport edge',async t=>{
 const env=fixture();t.after(()=>env.engine.destroy());await turn();
 const candidates=[
  {point:{x:400,y:300},text:'Camp',symbol:'camp',rank:1},
  {point:{x:600,y:200},text:'',symbol:'water',rank:2},
  {point:{x:400,y:321},text:'Overlapping name',rank:3},
  {point:{x:400,y:575},text:'Bottom camp',symbol:'camp',rank:4},
 ];
 env.complete(()=>true,job=>({labels:job.request.kind==='vector'?candidates.map(({point,text,...options})=>env.labelFor(job,env.coordinateAt(point),text,{kind:'poi',...options})).filter(label=>label.x>=0&&label.x<1&&label.y>=0&&label.y<1):[]}));await env.settle();
 const labels=plain(env.engine.getLabelDiagnostics()),camp=labels.find(label=>label.label==='Camp'),unnamed=labels.find(label=>label.label===''),collision=labels.find(label=>label.label==='Overlapping name'),bottom=labels.find(label=>label.label==='Bottom camp');
 assert.equal(camp.visible,true);assert.equal(unnamed.visible,true,'A classified but unnamed water point retains its source symbol');assert.equal(collision.reason,'collision');
 assert.equal(bottom.visible,false,'A glyph must not admit a name that extends below the canvas');
 const draw=env.lastDraw(),text=draw.find(call=>call.op==='fillText'&&call.text==='Camp');assert.ok(text.y>camp.y);assert.ok(camp.rect.top<=camp.y-12&&camp.rect.bottom>=text.y+6);assert.equal(draw.some(call=>call.op==='fillText'&&call.text===''),false);
 assert.ok(draw.filter(call=>call.op==='stroke'&&typeof call.path?.source==='string').length>=6,'Source glyphs use the actual own vector paths');
});

test('a successful current detail or overview viewport clears an error belonging to the previous area',async t=>{
 for(const zoom of [8,4]){
  const env=fixture();t.after(()=>env.engine.destroy());await turn();
  for(const job of env.pending())if(job.request.kind==='vector')env.store.reject(job);else env.store.resolve(job);
  await env.settle();assert.ok(env.engine.getState().error);
  env.engine.setCamera({center:[100,55],zoom});env.complete();await env.settle();
  assert.equal(env.engine.getState().loading,false);assert.ok(env.engine.inspect().tiles[zoom>=5?'detail':'overview'].length>0);assert.equal(env.engine.getState().error,'',`A finished new z${zoom} source must not carry the previous geographic failure`);
 }
});

test('unexpected native capture loss releases the moving state and settles the actual camera',async t=>{
 const env=fixture();t.after(()=>env.engine.destroy());await env.ready();
 env.engine.canvas.dispatch('pointerdown',{pointerId:7,clientX:300,clientY:250});env.engine.canvas.dispatch('pointermove',{pointerId:7,clientX:330,clientY:275});assert.equal(env.host.dataset.mapMoving,'true');
 env.engine.canvas.pointerCapture.delete(7);env.engine.canvas.dispatch('lostpointercapture',{pointerId:7,clientX:330,clientY:275});await env.settle();
 assert.equal(env.host.dataset.mapMoving,'false');assert.equal(env.engine.canvas.classList.contains('is-moving'),false);assert.equal(env.host.dataset.mapLongitude,String(env.engine.getCamera().center[0]));
});

test('native double-click keeps the selected geographic pixel fixed at pitched40/60 degree views',async t=>{
 for(const pitch of [40,60]){
  const env=fixture();t.after(()=>env.engine.destroy());await env.ready();env.engine.setPitch(pitch);env.flush();
  const point={x:220,y:170},coordinate=env.engine.unproject(point),before=env.engine.getCamera().zoom;
  env.engine.canvas.dispatch('dblclick',{clientX:point.x,clientY:point.y});env.tick(250);env.flush();
  assert.equal(env.engine.getCamera().zoom,before+1);const after=env.engine.project(coordinate);
  assert.ok(Math.hypot(after.x-point.x,after.y-point.y)<1e-6,`The pitched${pitch} double-click moved its actual geographic anchor`);
 }
});

// Independent polygon clipping checks screen-space overlap. The production
// planner uses separating axes, so this oracle does not repeat its algorithm.
function clippedArea(points,width,height){
 let polygon=points;
 for(const [axis,bound,above] of [['x',0,true],['x',width,false],['y',0,true],['y',height,false]]){
  const input=polygon;polygon=[];
  for(let index=0;index<input.length;index++){
   const start=input[index],end=input[(index+1)%input.length],inside=point=>above?point[axis]>=bound:point[axis]<=bound;
   if(inside(start)!==inside(end)){
    const fraction=(bound-start[axis])/(end[axis]-start[axis]);
    polygon.push({x:start.x+(end.x-start.x)*fraction,y:start.y+(end.y-start.y)*fraction});
   }
   if(inside(end))polygon.push(end);
  }
 }
 return Math.abs(polygon.reduce((sum,point,index)=>{const next=polygon[(index+1)%polygon.length];return sum+point.x*next.y-next.x*point.y;},0))/2;
}
function assertViewportRequests(env,requests,width,height){
 assert.ok(requests.length>0&&requests.length<=64,'The visible batch must remain bounded');
 assert.equal(new Set(requests.map(request=>`${request.z}/${request.x}/${request.y}`)).size,requests.length);
 for(const request of requests){
  const n=2**request.z,polygon=[[request.x,request.y],[request.x+1,request.y],[request.x+1,request.y+1],[request.x,request.y+1]].map(([x,y])=>env.engine.project([x/n*360-180,Math.atan(Math.sinh(Math.PI*(1-2*y/n)))*180/Math.PI]));
  assert.ok(clippedArea(polygon,width,height)>1e-5,`Invisible ${request.kind} tile ${request.z}/${request.x}/${request.y} wastes the budget`);
 }
 for(let row=0;row<=12;row++)for(let column=0;column<=20;column++){
  const [longitude,latitude]=env.coordinateAt({x:.01+(width-.02)*column/20,y:.01+(height-.02)*row/12}),sine=Math.sin(latitude*Math.PI/180),worldX=(longitude+180)/360,worldY=.5-Math.log((1+sine)/(1-sine))/(4*Math.PI);
  assert.ok(requests.some(request=>{const n=2**request.z;return request.x===Math.floor(worldX*n)&&request.y===Math.floor(worldY*n);}),`The current visible geographic point ${column}/20,${row}/12 has no tile`);
 }
}

test('FullHD rotated viewports retain z18 and spend their bounded tile budget on visible ground',async t=>{
 for(const bearingDegrees of [0,45,90]){
  const width=1920,height=1080,env=fixture({view:{center:[40,50],zoom:18,bearingDegrees},width,height});t.after(()=>env.engine.destroy());await turn();
  for(const kind of ['vector','relief']){
   const requests=env.pending(kind).map(job=>job.request);assert.ok(requests.every(request=>request.z===18),`FullHD bearing${bearingDegrees} ${kind} must preserve detail z18`);assert.ok(requests.every(request=>request.paintZoom===18));assertViewportRequests(env,requests,width,height);
  }
 }
});

test('4K fallback stays bounded and preserves the display paint zoom without claiming native density',async t=>{
 const width=3840,height=2160,env=fixture({view:{center:[40,50],zoom:18,bearingDegrees:45},width,height});t.after(()=>env.engine.destroy());await turn();
 for(const kind of ['vector','relief']){
  const requests=env.pending(kind).map(job=>job.request);assert.ok(requests.every(request=>request.z<18),'This oversized viewport needs bounded coarser bitmaps');assert.ok(requests.every(request=>request.paintZoom===18),'Fallback bitmaps keep display-scale style calculations');assertViewportRequests(env,requests,width,height);
 }
});

test('a released view disposes a late coverage source without loading or invoking ready callbacks',async()=>{
 const env=fixture({delayedCoverage:true});env.engine.destroy();env.coverageResolve(env.coverage);await env.settle();assert.equal(env.coverage.disposed,1);assert.equal(env.store.requests.length,0);assert.equal(env.states.length,0);assert.equal(env.frames.size,0);
});
