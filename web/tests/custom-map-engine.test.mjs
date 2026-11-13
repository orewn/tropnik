import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createMapCoverage,decodeCoverage} from '../public/maps/map-coverage-lod.js';
import {mercatorUnproject} from '../lib/custom-map-camera.ts';
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
// Exact method bytes from 9110c5b23b4a6dfcb176c8e07f074d3f93239f91. Only
// this original method is substituted in reference runs; its imported helpers,
// camera and the rest of the production engine remain the same real modules.
const originalLabels=readFileSync(resolve(root,'tests/fixtures/custom-map-labels-9110c5b.txt'),'utf8');
assert.equal(createHash('sha256').update(originalLabels).digest('hex'),'39a5b7a5ca753f6ca893764b8ee7f7a3fd3acd87686d944f5ca7da5cab7ed8c9');

function fixture({view=camera,width=800,height=600,coverageArea=area,delayedCoverage=false,coverageFailures=0,coverageLoader,baselineLabels=false,groundCache=false}={}){
 let now=0,serial=0,coverageResolve,coverageAttempts=0,readyCalls=0,gestures=0,layoutReads=0;const frames=new Map(),timers=new Map(),calls=[],stores=[],observers=[],states=[],paths=[],rasters=[],grounds=[];
 let paintingLabels=false;const labelWork={sourceCoordinates:0,screenCoordinates:0,coverageTests:0,priorityCalls:0,repeatKeys:0};
 class Target{
  listeners=new Map();
  addEventListener(type,listener){const listeners=this.listeners.get(type)||new Set();listeners.add(listener);this.listeners.set(type,listeners);}
  removeEventListener(type,listener){this.listeners.get(type)?.delete(listener);}
  dispatch(type,properties={}){const event={type,button:0,preventDefault(){this.defaultPrevented=true;},...properties};for(const listener of [...(this.listeners.get(type)||[])])listener.call(this,event);return event;}
  listenerCount(){return [...this.listeners.values()].reduce((sum,listeners)=>sum+listeners.size,0);}
 }
 class Path{
  commands=[];
  constructor(source){this.source=source;paths.push(this);}
  moveTo(...args){this.commands.push(['moveTo',...args]);}lineTo(...args){this.commands.push(['lineTo',...args]);}
  rect(...args){this.commands.push(['rect',...args]);}closePath(){this.commands.push(['closePath']);}addPath(path){this.commands.push(['addPath',path]);}
 }
 function createContext(surface){
 const record=call=>calls.push({...call,surface});
 const context={font:'10px sans-serif',fillStyle:'#000000',strokeStyle:'#000000',lineWidth:1,lineCap:'butt',lineJoin:'miter',miterLimit:10,globalAlpha:1,globalCompositeOperation:'source-over',stack:[],matrix:[1,0,0,1,0,0],
  save(){this.stack.push({...Object.fromEntries(['font','fillStyle','strokeStyle','lineWidth','lineCap','lineJoin','miterLimit','globalAlpha','globalCompositeOperation','textAlign','textBaseline'].map(key=>[key,this[key]])),matrix:[...this.matrix]});record({op:'save'});},
  restore(){Object.assign(this,this.stack.pop());record({op:'restore'});},
  setTransform(...matrix){this.matrix=matrix;record({op:'setTransform',args:matrix});},
  resetTransform(){this.matrix=[1,0,0,1,0,0];record({op:'resetTransform',args:[]});},
  transform(a,b,c,d,e,f){const [aa,bb,cc,dd,ee,ff]=this.matrix;this.matrix=[aa*a+cc*b,bb*a+dd*b,aa*c+cc*d,bb*c+dd*d,aa*e+cc*f+ee,bb*e+dd*f+ff];},
  translate(x,y){this.transform(1,0,0,1,x,y);record({op:'translate',args:[x,y]});},
  scale(x,y){this.transform(x,0,0,y,0,0);record({op:'scale',args:[x,y]});},
  rotate(angle){const c=Math.cos(angle),s=Math.sin(angle);this.transform(c,s,-s,c,0,0);record({op:'rotate',args:[angle]});},
  getTransform(){const [a,b,c,d,e,f]=this.matrix;return{a,b,c,d,e,f};},
  measureText(text){const fontSize=Number(this.font.match(/([\d.]+)px/)?.[1]||10),width=text.length*fontSize*.55;record({op:'measureText',text,font:this.font,width});return{width,actualBoundingBoxAscent:fontSize*.8,actualBoundingBoxDescent:fontSize*.2};},
  fill(path,rule){record({op:'fill',path,rule,color:this.fillStyle});},
  stroke(path){record({op:'stroke',path,color:this.strokeStyle,width:this.lineWidth});},
  drawImage(bitmap,...args){record({op:'drawImage',key:bitmap.key,bitmap,args,alpha:this.globalAlpha});},
  strokeText(text,x,y){record({op:'strokeText',text,x,y,font:this.font});},
  fillText(text,x,y){record({op:'fillText',text,x,y,font:this.font});},
 };
 for(const name of ['fillRect','clearRect','strokeRect','beginPath','closePath','moveTo','lineTo','arc','ellipse','bezierCurveTo','quadraticCurveTo','roundRect','rect','clip','setLineDash'])context[name]=function(...args){record({op:name,args});};
 return context;
 }
 function matches(element,selector){
  if(selector===':focus-visible')return element.focusVisible===true;
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
  getBoundingClientRect(){layoutReads++;const w=Number.parseFloat(this.style.width)||this.clientWidth,h=Number.parseFloat(this.style.height)||this.clientHeight;return{x:0,y:0,left:0,top:0,right:w,bottom:h,width:w,height:h};}
  getContext(type,attributes){assert.equal(type,'2d');if(!this.context){this.context=createContext(this.className);this.context.getContextAttributes=()=>attributes;}return this.context;}
  focus(){}setPointerCapture(id){this.pointerCapture.add(id);}hasPointerCapture(id){return this.pointerCapture.has(id);}releasePointerCapture(id){this.pointerCapture.delete(id);}
 }
 const document={createElement:tag=>new Element(tag),createElementNS:(_namespace,tag)=>new Element(tag)},window=new Target(),host=new Element('div');
 const coverage={area:coverageArea,boundaries:collection,territories:collection,status:{ready:true,lod:'source',pending:0,error:'',version:'a'.repeat(16),cells:['test'],revision:0},updates:[],subscribers:new Set(),disposed:0,
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
 // Only native worker delivery is controlled: the real raster manager still
 // owns its cache, stale-reply rejection, source registration and bitmap close.
 class TrailRasterWorker{
  requests=[];pending=null;registered=new Map();destroyed=false;
  constructor(){rasters.push(this);}
  postMessage(payload){
   assert.equal(this.pending,null,'Only one worker paint may be in flight');
   for(const id of payload.dropPartIds)this.registered.delete(id);
   for(const part of payload.addParts)this.registered.set(part.id,part);
   assert.ok(payload.partIds.every(id=>this.registered.has(id)));
   this.pending=payload;this.requests.push(payload);
  }
  resolve(){
   assert.ok(this.pending,'A raster request must exist before it can complete');
   const job=this.pending;this.pending=null;
   const bitmap={key:'trail-raster:'+job.id,width:job.width,height:job.height,closed:false,parts:job.partIds.map(id=>this.registered.get(id)),close(){this.closed=true;}};
   this.onmessage({data:{id:job.id,bitmap}});return{bitmap,width:job.width,height:job.height};
  }
  terminate(){this.destroyed=true;}
 }
 class GroundCanvas{
  constructor(width,height){this.width=width;this.height=height;this.key='retained-ground:'+grounds.length;grounds.push(this);}
  getContext(type,attributes){assert.equal(type,'2d');if(!this.context){this.context=createContext(this.key);this.context.getContextAttributes=()=>attributes;}return this.context;}
 }
 const globals={document,window,Path2D:Path,ResizeObserver:class{constructor(callback){this.callback=callback;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}},
  ...(groundCache?{OffscreenCanvas:GroundCanvas}:{}),
  devicePixelRatio:1,navigator:{onLine:true},location:{href:'https://fixture.invalid/'},Worker:TrailRasterWorker,queueMicrotask,matchMedia:()=>({matches:false}),performance:{now:()=>now},console,URL,AbortController,crypto:globalThis.crypto,TextEncoder,
  getComputedStyle:element=>({display:element.hidden?'none':'block',visibility:'visible',opacity:'1',pointerEvents:'auto'}),
  requestAnimationFrame:callback=>{const id=++serial;frames.set(id,callback);return id;},cancelAnimationFrame:id=>frames.delete(id),
  setTimeout:(callback,delay)=>{const id=++serial;timers.set(id,{callback,at:now+delay});return id;},clearTimeout:id=>timers.delete(id)};
 const environment=vm.createContext(globals),modules=new Map();
 function load(filename){
  if(modules.has(filename))return modules.get(filename).exports;
  const testModule={exports:{}};modules.set(filename,testModule);
  const engineModule=filename===resolve(root,'lib/custom-map-engine.ts'),compiledKey=engineModule&&baselineLabels?filename+':original-labels-9110c5b':filename;
  if(!compiled.has(compiledKey)){
   let source=readFileSync(filename,'utf8');
   if(engineModule&&baselineLabels){const start=source.indexOf('  private drawLabels(){\n'),end=source.indexOf('  destroy(){\n',start);assert.ok(start>0&&end>start);source=source.slice(0,start)+originalLabels+source.slice(end);}
   compiled.set(compiledKey,ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},fileName:filename}).outputText);
  }
  const require=specifier=>{
   if(specifier==='./russia-map')return{loadRussiaGeometry:()=>{const attempt=++coverageAttempts;return coverageLoader?coverageLoader(attempt,coverage):attempt<=coverageFailures?Promise.reject(new Error('Coverage fetch failed')):coveragePromise;}};
   if(specifier==='./map-preload')return{loadPublicBytes(){assert.fail('No real download in an engine unit test');},loadPublicJSON(){assert.fail('No real download in an engine unit test');}};
   if(specifier.endsWith('?worker&url'))return{__esModule:true,default:'/workers/fixture.js'};
   let path=resolve(dirname(filename),specifier);if(!existsSync(path))path+='.ts';assert.ok(path.startsWith(root+'/'),'Only real local map modules may load');
   const result=load(path);if(specifier==='./custom-map-tiles'){tileKey=result.customTileKey;return{...result,CustomMapTiles:Tiles};}
   if(engineModule){
    const watched=specifier==='./custom-map-camera'?{mercatorUnproject:'sourceCoordinates',project:'screenCoordinates'}:specifier==='../public/maps/russia-viewport.js'?{inRussiaCoverage:'coverageTests'}:specifier==='./custom-map-labels'?{mapLabelPriority:'priorityCalls',mapLabelRepeatKey:'repeatKeys'}:{};
    if(Object.keys(watched).length)return{...result,...Object.fromEntries(Object.entries(watched).map(([name,count])=>[name,(...args)=>{if(paintingLabels)labelWork[count]++;return result[name](...args); }]))};
   }
   return result;
  };
  const run=vm.runInContext(`(function(require,module,exports){${compiled.get(compiledKey)}\n})`,environment,{filename});run(require,testModule,testModule.exports);return testModule.exports;
 }
 const exports=load(resolve(root,'lib/custom-map-engine.ts'));
 const productionDraw=exports.CustomMapEngine.prototype.draw;
 exports.CustomMapEngine.prototype.draw=function(...args){calls.push({surface:'tropnik-map-canvas',op:'draw-start'});return productionDraw.apply(this,args);};
 const productionLabels=exports.CustomMapEngine.prototype.drawLabels;
 exports.CustomMapEngine.prototype.drawLabels=function(...args){const previous=paintingLabels;paintingLabels=true;try{return productionLabels.apply(this,args);}finally{paintingLabels=previous;}};
 const engine=new exports.CustomMapEngine(host,{camera:plain(view),onState:value=>states.push(plain(value)),onReady:()=>{readyCalls++;},onGesture:()=>{gestures++;}});
 engine.setFloor({center:[105,60],zoom:1,bearingDegrees:0});
 const tick=(elapsed=16)=>{now+=elapsed;const current=[...frames.values()];frames.clear();for(const frame of current)frame(now);return current.length;};
 const flush=()=>{let count=0;while(frames.size){assert.ok(count++<40,'Own renderer left a recurring idle RAF');tick();}return count;};
 const store=stores[0],pending=(kind)=>store.requests.filter(job=>!job.settled&&(!kind||job.request.kind===kind));
 const complete=(selector=()=>true,options=()=>({}))=>{const jobs=pending().filter(selector);for(const job of jobs)store.resolve(job,options(job));return jobs;};
 const ready=async()=>{coverageResolve(coverage);await turn();complete();await turn();flush();return engine;};
 const lastSurface=(surface,clear)=>{const own=calls.filter(call=>call.surface===surface);return own.slice(own.findLastIndex(call=>call.op===clear));};
 const lastDraw=()=>[...lastSurface('tropnik-map-canvas','draw-start'),...lastSurface('tropnik-map-labels','clearRect')];
 return{engine,host,context:engine.canvas.context,window,coverage,store,states,calls,paths,rasters,grounds,frames,timers,observers,tick,flush,complete,pending,ready,coverageResolve,lastDraw,labelWork,
  verifyReviewedCoastalRoute:load(resolve(root,'lib/reviewed-coastal-routes.ts')).verifyReviewedCoastalRoute,
  get coverageAttempts(){return coverageAttempts;},get readyCalls(){return readyCalls;},get gestures(){return gestures;},get layoutReads(){return layoutReads;},
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

test('search markers and changing label obstacles preserve every retained base pixel',async t=>{
 const env=fixture();t.after(()=>env.engine.destroy());await env.ready();
 const before=env.engine.inspect().drawRevision,paintCalls=env.calls.filter(call=>call.surface==='tropnik-map-canvas');
 const marker={id:'search-result',coordinate:[40.3,43.3],label:'Найденный маршрут',kind:'trail'};
 env.engine.setMarkers([marker]);env.flush();
 assert.equal(env.engine.inspect().drawRevision,before);assert.deepEqual(env.calls.filter(call=>call.surface==='tropnik-map-canvas'),paintCalls);
 const button=env.host.querySelector('.tropnik-point-marker');assert.ok(button);assert.equal(button.getAttribute('aria-label'),'Открыть маршрут Найденный маршрут');
 env.engine.setMarkers([{...marker,active:true}]);env.engine.setObstacles([]);env.flush();
 assert.equal(button.classList.contains('is-selected'),true);assert.equal(env.engine.inspect().drawRevision,before);
 const baseCalls=env.calls.filter(call=>call.surface==='tropnik-map-canvas');
 const labelBefore=env.engine.inspect().labelRevision,obstacle={left:20,top:30,right:80,bottom:90};env.engine.setObstacles([obstacle]);env.flush();
 assert.equal(env.engine.inspect().drawRevision,before);assert.equal(env.engine.inspect().labelRevision,labelBefore+1);
 env.engine.setObstacles([{...obstacle}]);env.flush();assert.equal(env.engine.inspect().labelRevision,labelBefore+1);
 obstacle.right=120;env.engine.setObstacles([obstacle]);env.flush();assert.equal(env.engine.inspect().labelRevision,labelBefore+2,'Caller mutation must not change the retained obstacle snapshot');
 env.engine.setLabels([{id:'new-label',coordinate:[40.2,43.2],label:'Новая подпись'}]);env.engine.setMarkers([]);env.flush();
 assert.equal(env.engine.inspect().labelRevision,labelBefore+3,'A marker-only update must not cancel an already queued label paint');assert.equal(env.host.querySelector('.tropnik-point-marker'),null);
 assert.equal(env.engine.inspect().drawRevision,before);assert.deepEqual(env.calls.filter(call=>call.surface==='tropnik-map-canvas'),baseCalls,'No terrain, tile, mask or route command may replay for an obstacle or text update');
 env.engine.setRegion([]);env.engine.setLabels([]);env.engine.setMarkers([]);env.flush();
 assert.equal(env.engine.inspect().drawRevision,before+1,'A queued full geographic paint must survive later marker and label updates');
});

test('point markers update actual label collisions without replaying terrain or discarding nearby names',async t=>{
 const env=fixture();t.after(()=>env.engine.destroy());await env.ready();
 const coordinate=env.coordinateAt({x:370,y:270}),marker={id:'route',coordinate,label:'Маршрут',kind:'trail'};
 env.engine.setLabels([{id:'peak',coordinate,label:'Минометная · 2483 м',kind:'peak',rank:3},{id:'town',coordinate:env.coordinateAt({x:620,y:170}),label:'Приморск',rank:1}]);env.flush();
 const label=()=>env.engine.getLabelDiagnostics().find(item=>item.id==='peak'),town=()=>env.engine.getLabelDiagnostics().find(item=>item.id==='town');
 assert.equal(label().reason,'drawn');assert.equal(town().reason,'drawn');
 const baseline=plain(env.calls.filter(call=>call.surface==='tropnik-map-canvas')),draws=env.engine.inspect().drawRevision,work=plain(env.labelWork),initialRect=plain(label().rect);
 env.engine.setMarkers([marker]);env.flush();
 const button=env.host.querySelector('.tropnik-point-marker');button.getBoundingClientRect=()=>assert.fail('Point marker collision layout must not measure the DOM');
 assert.equal(button.style.transition,'none','Generic button motion must not make a marker trail the current Canvas camera');
 assert.equal(label().reason,'collision');assert.equal(town().reason,'drawn');
 assert.equal(env.lastDraw().some(call=>call.op==='fillText'&&call.text==='Минометная · 2483 м'),false,'The label surface must actually erase the covered text');
 const unchanged=env.engine.inspect().labelRevision;
 env.engine.setMarkers([{...marker,label:'Новое название маршрута'}]);env.flush();
 assert.equal(env.engine.inspect().labelRevision,unchanged,'Unchanged footprints need no label repaint');assert.equal(button.getAttribute('aria-label'),'Открыть маршрут Новое название маршрута');
 env.engine.setMarkers([]);env.flush();assert.equal(label().reason,'drawn');

 // The ordinary painted circle ends one pixel before this label. Its larger
 // transparent hit target overlaps it; the selected circle's shadow reaches it.
 const beside={...marker,coordinate:env.coordinateAt({x:initialRect.left-18,y:270})};
 env.engine.setMarkers([beside]);env.flush();assert.equal(label().reason,'drawn','Compact circle bounds must preserve a neighbouring named label');
 env.engine.setMarkers([{...beside,active:true}]);env.flush();assert.equal(label().reason,'collision','The larger selected circle must invalidate the label-only frame');assert.equal(env.host.querySelector('.tropnik-point-marker').style.transition,'none');
 env.engine.setMarkers([beside]);env.flush();assert.equal(label().reason,'drawn');
 const focused=env.host.querySelector('.tropnik-point-marker');focused.focusVisible=true;focused.dispatch('focus');env.flush();assert.equal(label().reason,'collision');
 focused.focusVisible=false;focused.dispatch('blur');env.flush();assert.equal(label().reason,'drawn');
 env.engine.setMarkers([{...marker,active:true}]);env.flush();assert.equal(label().reason,'collision');
 env.engine.setMarkers([{...marker,coordinate:env.coordinateAt({x:-100,y:270})}]);env.flush();assert.equal(env.host.querySelector('.tropnik-point-marker').hidden,true);assert.equal(label().reason,'drawn','An offscreen marker must not retain its old obstacle');
 env.engine.setMarkers([]);env.engine.setPosition(coordinate);env.flush();assert.equal(label().reason,'collision');
 env.engine.setPosition(null);env.flush();assert.equal(label().reason,'drawn');
 env.engine.setMarkers([{...marker,kind:'plan'}]);env.flush();assert.equal(label().reason,'collision');
 const planner=env.host.querySelector('.tropnik-point-marker');assert.equal(planner.style.transition,'none');
 env.engine.setMarkers([{...marker,kind:'position',active:true}]);env.flush();assert.equal(label().reason,'collision');
 const position=env.host.querySelector('.tropnik-point-marker');assert.notEqual(position,planner,'Changing kind must replace the painted marker');assert.equal(position.style.transition,'none');
 env.engine.setMarkers([]);env.flush();assert.equal(label().reason,'drawn');
 assert.equal(town().reason,'drawn');assert.equal(env.engine.inspect().drawRevision,draws);
 assert.deepEqual(plain(env.calls.filter(call=>call.surface==='tropnik-map-canvas')),baseline,'Only the label surface may repaint for point-marker changes');
 for(const key of ['sourceCoordinates','coverageTests','priorityCalls','repeatKeys'])assert.equal(env.labelWork[key],work[key],'Marker changes must not rebuild static '+key);
 assert.equal(env.frames.size,0);const revision=env.engine.inspect().labelRevision;env.tick(1000);assert.equal(env.engine.inspect().labelRevision,revision,'No marker/label feedback loop remains');
});

test('point-marker collision and DOM placement use the same live camera through pan, zoom, resize and visibility changes',async t=>{
 const env=fixture({view:{...camera,zoom:7}});t.after(()=>env.engine.destroy());await env.ready();
 const coordinate=env.coordinateAt({x:400,y:300}),marker={id:'live-route',coordinate,label:'Выбранный маршрут',kind:'trail',active:true};
 env.engine.setLabels([{id:'covered',coordinate,label:'Санкт-Петербург',rank:0},{id:'free',coordinate:env.coordinateAt({x:515,y:180}),label:'Выборг',rank:1}]);env.engine.setMarkers([marker]);env.flush();
 const button=env.host.querySelector('.tropnik-point-marker');button.getBoundingClientRect=()=>assert.fail('No per-frame marker geometry read');
 const assertCurrent=()=>{
  const p=env.engine.project(coordinate),record=env.engine.getLabelDiagnostics().find(item=>item.id==='covered');
  assert.equal(button.hidden,false);assert.equal(button.style.transform,`translate(${p.x-22}px,${p.y-22}px)`);assert.equal(button.style.transition,'none');
  assert.equal(record.x,p.x);assert.equal(record.y,p.y);assert.equal(record.reason,'collision','A previous-frame footprint must not expose the covered label');
 };
 assertCurrent();assert.equal(env.engine.getLabelDiagnostics().find(item=>item.id==='free').reason,'drawn');
 const warm=plain(env.labelWork);
 env.engine.canvas.dispatch('pointerdown',{pointerId:97,clientX:400,clientY:300});const reads=env.layoutReads;
 for(const [x,y]of [[540,370],[430,270],[400,300]]){env.engine.canvas.dispatch('pointermove',{pointerId:97,clientX:x,clientY:y});env.flush();assertCurrent();assert.equal(env.layoutReads,reads,'Dragging must not measure DOM geometry after placing markers');}
 for(const key of ['sourceCoordinates','coverageTests','priorityCalls','repeatKeys'])assert.equal(env.labelWork[key],warm[key],'Moving markers must retain static label '+key);
 env.engine.canvas.dispatch('pointerup',{pointerId:97,clientX:400,clientY:300});env.flush();assertCurrent();
 env.engine.setCamera({center:coordinate,zoom:9,bearingDegrees:17.3});env.flush();assertCurrent();
 env.engine.setPitch(30);env.flush();assertCurrent();
 env.host.clientWidth=620;env.host.clientHeight=460;env.observers[0].callback();env.flush();assertCurrent();
 env.engine.setCamera({center:[50,50],zoom:9});env.flush();assert.equal(button.hidden,true);assert.equal(env.engine.getLabelDiagnostics().find(item=>item.id==='covered').reason,'outside-viewport');
 env.engine.setCamera({center:coordinate,zoom:9});env.flush();assertCurrent();
 env.engine.setMode('satellite');env.flush();assertCurrent();env.complete();await env.settle();assertCurrent();
 env.engine.setActive(false);const revision=env.engine.inspect().labelRevision;env.engine.setMarkers([]);env.tick();assert.equal(env.engine.inspect().labelRevision,revision);
 env.engine.setActive(true);env.flush();assert.equal(env.engine.getLabelDiagnostics().find(item=>item.id==='covered').reason,'drawn');
 assert.equal(env.frames.size,0);
});

test('independent labels retain collision, density and lifecycle without an extra empty compositor surface',async t=>{
 const env=fixture();t.after(()=>env.engine.destroy());await env.ready();
 const labels=env.host.querySelector('.tropnik-map-labels');assert.ok(labels);assert.equal(labels.hidden,true);assert.equal(labels.getAttribute('aria-hidden'),'true');
 assert.equal(labels.width,env.engine.canvas.width);assert.equal(labels.height,env.engine.canvas.height);assert.equal(labels.style.width,env.engine.canvas.style.width);assert.equal(labels.style.height,env.engine.canvas.style.height);
 assert.equal(labels.context.getContextAttributes().alpha,true);assert.equal(env.engine.canvas.context.getContextAttributes().alpha,false);
 const label={id:'centre',coordinate:[...camera.center],label:'Проверяемая подпись'};
 env.engine.setLabels([label]);env.flush();assert.equal(labels.hidden,false);assert.equal(env.engine.getLabelDiagnostics()[0].visible,true);
 const ground=env.engine.inspect().drawRevision,point=env.engine.project(label.coordinate);
 env.engine.setObstacles([{left:point.x-120,right:point.x+120,top:point.y-30,bottom:point.y+30}]);env.flush();
 assert.equal(env.engine.getLabelDiagnostics()[0].reason,'collision');assert.equal(labels.hidden,true);assert.equal(env.engine.inspect().drawRevision,ground);
 env.engine.setObstacles([]);env.flush();assert.equal(labels.hidden,false);assert.equal(env.engine.getLabelDiagnostics()[0].visible,true);
 const latest=JSON.parse(env.host.dataset.mapInspection);assert.equal(latest.labelRevision,env.engine.inspect().labelRevision);assert.equal(latest.labels[0].visible,true,'Read-only inspection must describe the actually refreshed label surface');
 env.host.clientWidth=620;env.host.clientHeight=460;env.observers[0].callback();env.flush();assert.equal(labels.width,env.engine.canvas.width);assert.equal(labels.height,env.engine.canvas.height);assert.equal(labels.width,620);assert.equal(labels.height,460);
 const labelPaints=env.engine.inspect().labelRevision;env.engine.setActive(false);env.engine.setLabels([]);env.tick();assert.equal(env.engine.inspect().labelRevision,labelPaints);
 env.engine.setActive(true);await env.settle();assert.equal(labels.hidden,true);
 env.engine.setLabels([label]);env.engine.destroy();env.flush();assert.equal(labels.isConnected,false);assert.equal(env.host.children.length,0);assert.equal(env.frames.size,0);
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
 const env=fixture({view:{...camera,bearingDegrees:12}});t.after(()=>env.engine.destroy());await env.ready();
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

test('opaque cartography and relief commit as one complete ground, with partial and total failures retried in place',async t=>{
 for(const kind of ['vector','relief'])for(const all of [false,true]){
  const env=fixture();t.after(()=>env.engine.destroy());await env.ready();
  const before=plain(env.engine.inspect().tiles);env.engine.setCamera({center:[41,44],zoom:9});
  const jobs=env.pending(kind),failed=all?jobs:jobs.slice(0,1);assert.ok(jobs.length>1);
  for(const job of failed)env.store.reject(job);
  env.complete(job=>job.request.kind!==(kind==='vector'?'relief':'vector'));await env.settle();
  assert.deepEqual(plain(env.engine.inspect().tiles.detail),before.detail,'A lone layer may not replace one half of the displayed ground');
  assert.deepEqual(plain(env.engine.inspect().tiles.relief),before.relief);
  env.complete();await env.settle();
  assert.equal(env.engine.getState().loading,false);assert.ok(env.engine.getState().error);
  assert.deepEqual(plain(env.engine.inspect().tiles.detail),before.detail);assert.deepEqual(plain(env.engine.inspect().tiles.relief),before.relief);
  const view=plain(env.engine.getCamera()),message=env.engine.getState().error,requests=env.store.requests.length;
  env.engine.retry();assert.equal(env.engine.getState().loading,true);assert.equal(env.engine.getState().error,message);
  assert.equal(env.store.requests.length-requests,failed.length,'Completed cached tiles are reused; only failed cells need a retry');
  const retryRequests=env.store.requests.length;for(let i=0;i<20;i++)env.engine.retry();assert.equal(env.store.requests.length,retryRequests,'Repeated retry input shares the active attempt');
  env.complete();await env.settle();assert.deepEqual(plain(env.engine.getCamera()),view);
  assert.equal(env.engine.getState().loading,false);assert.equal(env.engine.getState().error,'');assert.equal(env.engine.getState().reliefReady,true);
  assert.equal(env.engine.inspect().tiles.detail.length,jobs.length);assert.equal(env.engine.inspect().tiles.relief.length,jobs.length);
  assert.ok(env.engine.inspect().tiles.detail.every(tile=>tile.z===9));assert.ok(env.engine.inspect().tiles.relief.every(tile=>tile.z===9));
  assert.ok(env.store.pins.at(-1).length<=3*64,'Only current requests and committed ground remain pinned');
 }
});

test('the actual Chukotka camera commits sparse ocean DEM failures but still rejects missing visible land',async t=>{
 const read=url=>readFileSync(resolve(root,'public'+url)),manifest=JSON.parse(read('/data/map-coverage/manifest.json'));
 const coverage=createMapCoverage(manifest,decodeCoverage(JSON.parse(read(manifest.base.url))),{fetch:async url=>new Response(read(url))});t.after(()=>coverage.dispose());
 const view={center:[175.2139700208105,67.19878382541751],zoom:5.272349250356769,bearingDegrees:0};
 await coverage.updateView([156.27536453198246,59.701315217699936,194.15257550963855,72.91795683482115],view.zoom);
 for(const failLand of [false,true]){
  const env=fixture({view,width:1041,height:928,coverageArea:coverage.area});t.after(()=>env.engine.destroy());await turn();
  env.engine.setPadding({top:96,right:88,bottom:96,left:40});
  const relief=env.pending('relief'),missing=relief.filter(({request:r})=>r.y===12&&r.x>=60&&r.x<=66||r.x===65&&r.y===14||r.x===64&&r.y===18||failLand&&r.x===63&&r.y===13);
  assert.equal(relief.length,56);assert.equal(missing.length,failLand?10:9);
  for(const job of missing)env.store.reject(job,'Preview resource unavailable (404)');env.complete();await env.settle();
  assert.equal(env.engine.getState().loading,false);assert.equal(env.pending().length,0);
  if(failLand){assert.ok(env.engine.getState().error);assert.equal(env.engine.getState().committedMode,'overview');assert.equal(env.engine.inspect().tiles.relief.length,0);}
  else{
   assert.equal(env.engine.getState().error,'');assert.equal(env.engine.getState().committedMode,'detail');assert.equal(env.engine.getState().reliefReady,true);
   assert.equal(env.engine.inspect().tiles.relief.length,relief.length-missing.length);assert.equal(env.engine.inspect().tiles.detail.length,56,'Every successfully loaded vector remains available');
   assert.ok(env.engine.inspect().tiles.relief.some(tile=>tile.x===64&&tile.y===13),'The real dateline island remains loaded');
  }
 }
});

function hiddenRelief(env){
 const job=env.pending('relief').find(({request:r})=>(r.x+1)/2**r.z*360-180<39.9);assert.ok(job,'Fixture has a tile wholly west of its actual coverage');return job;
}
function islandInTile(request){
 const n=2**request.z,coordinates=[[.49,.49],[.51,.49],[.51,.51],[.49,.51],[.49,.49]].map(([x,y])=>mercatorUnproject({x:(request.x+x)/n,y:(request.y+y)/n}));
 return{type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[coordinates]}};
}
function revealMissingTile(env,job){env.coverage.area={type:'FeatureCollection',features:[area,islandInTile(job.request)]};notifyCoverage(env,{revision:1});}

test('a new immutable mask revision loads an island in a previously hidden failed tile without camera movement',async t=>{
 const env=fixture();t.after(()=>env.engine.destroy());await turn();const missing=hiddenRelief(env);env.store.reject(missing);env.complete();await env.settle();
 assert.equal(env.engine.getState().error,'');assert.equal(env.engine.getState().committedMode,'detail');const before=env.store.requests.length,view=plain(env.engine.getCamera());
 revealMissingTile(env,missing);assert.equal(env.engine.getState().loading,true);assert.equal(env.store.requests.length,before+1);assert.equal(env.pending()[0].key,missing.key);
 env.complete();await env.settle();assert.equal(env.engine.getState().error,'');assert.deepEqual(plain(env.engine.getCamera()),view);assert.ok(env.engine.inspect().tiles.relief.some(tile=>tile.key===missing.key));
 notifyCoverage(env,{pending:3,ready:false});notifyCoverage(env,{pending:0,ready:true});await env.settle();assert.equal(env.store.requests.length,before+1,'Status-only coverage events never start another tile batch');
});

test('a mask revision after ground commit but before deferred overview completion queues only one bounded recovery',async t=>{
 const env=fixture();t.after(()=>env.engine.destroy());await turn();const missing=hiddenRelief(env);env.store.reject(missing);env.complete(job=>job.request.kind!=='overview');await env.settle();
 assert.equal(env.engine.getState().committedMode,'detail');assert.equal(env.engine.getState().loading,true);assert.ok(env.pending('overview').length>0);
 const before=env.store.requests.length;revealMissingTile(env,missing);assert.equal(env.store.requests.length,before,'The active overview is allowed to finish');
 env.complete(job=>job.request.kind==='overview');await env.settle();assert.equal(env.store.requests.length,before+1);assert.equal(env.pending().length,1);assert.equal(env.pending()[0].key,missing.key);
 env.store.reject(env.pending()[0]);await env.settle();assert.ok(env.engine.getState().error);assert.equal(env.engine.getState().loading,false);
 for(let i=0;i<4;i++)await env.settle();notifyCoverage(env,{pending:0,ready:true});await env.settle();
 assert.equal(env.store.requests.length,before+1,'A real failure at the same mask revision must not make an automatic request loop');assert.equal(env.pending().length,0);
 env.engine.retry();env.complete();await env.settle();assert.equal(env.engine.getState().error,'');assert.ok(env.engine.inspect().tiles.relief.some(tile=>tile.key===missing.key));
});

test('ground finishing after a mask revision checks the new land before committing, and complete batches need no reload',async t=>{
 const env=fixture();t.after(()=>env.engine.destroy());await turn();const missing=hiddenRelief(env);env.store.reject(missing);revealMissingTile(env,missing);env.complete();await env.settle();
 assert.ok(env.engine.getState().error);assert.equal(env.engine.getState().committedMode,'overview');assert.equal(env.pending().length,0);
 env.engine.retry();env.complete();await env.settle();assert.equal(env.engine.getState().error,'');const count=env.store.requests.length;
 env.coverage.area={type:'FeatureCollection',features:[area,islandInTile(missing.request)]};notifyCoverage(env,{revision:2});await env.settle();
 assert.equal(env.store.requests.length,count,'A fully delivered ground batch survives a mask revision without any extra tile request');
});

test('required failures stay atomic in rotated native and fallback footprints, including a land strip above UI padding',async t=>{
 for(const [width,height,bearingDegrees] of [[1920,1080,0],[1920,1080,45],[1920,1080,90],[3840,2160,45]]){
  const env=fixture({view:{...camera,zoom:18,bearingDegrees},width,height});t.after(()=>env.engine.destroy());await turn();
  const jobs=env.pending('relief');assert.ok(jobs.length>0&&jobs.length<=64);assertViewportRequests(env,jobs.map(job=>job.request),width,height);
  assert.equal(jobs.every(job=>job.request.z===18),width===1920);env.store.reject(jobs[0]);env.complete();await env.settle();
  assert.ok(env.engine.getState().error);assert.equal(env.engine.getState().committedMode,'overview');assert.equal(env.engine.inspect().tiles.relief.length,0);
 }
 const view={center:[175.2139700208105,67.19878382541751],zoom:5.272349250356769,bearingDegrees:0},top={type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[180.1,72.6],[180.2,72.6],[180.2,72.7],[180.1,72.7],[180.1,72.6]]]}};
 const env=fixture({view,width:1041,height:928,coverageArea:top});t.after(()=>env.engine.destroy());await turn();env.engine.setPadding({top:96,right:88,bottom:96,left:40});
 const point=env.engine.project([180.15,72.65]);assert.ok(point.y>0&&point.y<96,'The land lies on the real canvas but above the framing inset');
 const failed=env.pending('relief').find(job=>job.request.x===64&&job.request.y===12);assert.ok(failed);env.store.reject(failed);env.complete();await env.settle();assert.ok(env.engine.getState().error);assert.equal(env.engine.getState().committedMode,'overview');
});

test('a wholly masked missing detail batch clears old satellite mode without inventing relief readiness',async t=>{
 const env=fixture({coverageArea:collection});t.after(()=>env.engine.destroy());await env.ready();env.engine.setMode('satellite');env.complete();await env.settle();assert.equal(env.engine.getState().committedMode,'satellite');
 for(const [key,tile] of env.store.cache)if(tile.kind==='relief'||tile.kind==='vector'&&!tile.transparent)env.store.cache.delete(key);
 env.engine.setMode('detail');const missing=env.pending();assert.ok(missing.some(job=>job.request.kind==='relief')&&missing.some(job=>job.request.kind==='vector'));
 for(const job of missing)env.store.reject(job,'Source has no data under the outside mask');await env.settle();
 assert.equal(env.engine.getState().error,'');assert.equal(env.engine.getState().committedMode,'detail');assert.equal(env.engine.getState().reliefReady,false);assert.equal(env.engine.getState().localDetail,false);assert.equal(env.engine.getState().imagerySource,undefined);assert.equal(env.engine.getState().imageryTarget,undefined);
 assert.equal(env.engine.inspect().tiles.imagery.length,0);assert.equal(env.engine.inspect().tiles.relief.length,0);assert.equal(env.engine.inspect().tiles.detail.length,0);assert.equal(env.pending().length,0);
});

test('a cold satellite to relief transition retains imagery, labels and source attribution until both ground layers succeed',async t=>{
 const env=fixture({view:{...camera,bearingDegrees:12}});t.after(()=>env.engine.destroy());await env.ready();
 env.engine.setMode('satellite');env.complete();await env.settle();
 const before=plain(env.engine.inspect()),drawn=env.lastDraw().filter(call=>call.op==='drawImage').map(call=>call.key);
 for(const [key,tile] of env.store.cache)if(tile.kind==='relief'||tile.kind==='vector'&&!tile.transparent)env.store.cache.delete(key);
 env.engine.setMode('detail');await env.settle();
 assert.equal(env.engine.getState().mode,'detail');assert.equal(env.engine.getState().committedMode,'satellite');assert.equal(env.engine.getState().imagerySource,'eox-s2');
 assert.deepEqual(plain(env.engine.inspect().tiles.imagery),before.tiles.imagery);assert.deepEqual(env.lastDraw().filter(call=>call.op==='drawImage').map(call=>call.key),drawn);
 const relief=env.pending('relief');assert.ok(relief.length>1);env.complete(job=>job.request.kind!=='relief');await env.settle();
 assert.equal(env.engine.getState().committedMode,'satellite');assert.deepEqual(env.lastDraw().filter(call=>call.op==='drawImage').map(call=>call.key),drawn);
 env.store.reject(relief[0]);env.complete();await env.settle();assert.ok(env.engine.getState().error);assert.equal(env.engine.getState().committedMode,'satellite');
 assert.deepEqual(plain(env.engine.getCamera()),before.camera);assert.deepEqual(plain(env.engine.inspect().tiles.imagery),before.tiles.imagery);
 const held=env.store.pins.at(-1);for(const tile of before.tiles.imagery)assert.ok(held.includes(tile.key),'The previous image must stay alive throughout failure and retry');
 env.engine.retry();env.complete();await env.settle();
 assert.equal(env.engine.getState().committedMode,'detail');assert.equal(env.engine.getState().imagerySource,undefined);assert.equal(env.engine.getState().error,'');
 assert.equal(env.engine.inspect().tiles.imagery.length,0);assert.equal(env.engine.inspect().tiles.relief.length,relief.length);
 assert.ok(env.lastDraw().some(call=>call.op==='drawImage'&&call.key.startsWith('relief:')));assert.equal(env.lastDraw().some(call=>call.op==='drawImage'&&call.key.startsWith('eox-')),false);
 const released=env.store.pins.at(-1);for(const tile of before.tiles.imagery)assert.equal(released.includes(tile.key),false,'Replaced imagery becomes evictable after successful commit');
});

test('a failed satellite cartographic overlay retains complete imagery without committing partial objects',async t=>{
 const env=fixture();t.after(()=>env.engine.destroy());await env.ready();const before=plain(env.engine.inspect().tiles);
 env.engine.setMode('satellite');const overlay=env.pending('vector');assert.ok(overlay.length>1);env.store.reject(overlay[0]);env.complete();await env.settle();
 assert.equal(env.engine.getState().committedMode,'satellite');assert.equal(env.engine.getState().imageryLoading,false);assert.match(env.engine.getState().error,/Подписи и тропы/);
 assert.equal(env.engine.inspect().tiles.detail.length,0);assert.equal(env.engine.inspect().tiles.relief.length,0);assert.ok(env.engine.inspect().tiles.imagery.length>0);assert.ok(before.detail.length>0);
 env.engine.setMode('satellite');env.complete();await env.settle();assert.equal(env.engine.getState().committedMode,'satellite');assert.equal(env.engine.getState().error,'');
});

test('startup coverage recovers through retry or online without duplicate loads or losing the selected camera',async t=>{
 for(const trigger of ['retry','online']){
  const env=fixture({delayedCoverage:true,coverageFailures:1});t.after(()=>env.engine.destroy());await env.settle();
  const before=plain(env.engine.getCamera()),message=env.engine.getState().error;assert.ok(message);assert.equal(env.engine.getState().ready,false);assert.equal(env.engine.getState().loading,false);assert.equal(env.coverageAttempts,1);
  if(trigger==='retry')env.engine.retry();else env.window.dispatch('online');
  for(let i=0;i<10;i++){env.engine.retry();env.window.dispatch('online');}
  assert.equal(env.coverageAttempts,2);assert.equal(env.engine.getState().loading,true);assert.equal(env.engine.getState().error,message);
  env.coverageResolve(env.coverage);await env.settle();env.complete();await env.settle();
  assert.equal(env.engine.getState().ready,true);assert.equal(env.engine.getState().loading,false);assert.equal(env.engine.getState().error,'');assert.equal(env.readyCalls,1);assert.equal(env.coverage.subscribers.size,1);
  assert.deepEqual(plain(env.engine.getCamera()),before);assert.ok(env.engine.inspect().tiles.detail.length>0);
 }
});

test('destroy during a retried coverage load releases its late result without callbacks, resources or state resurrection',async()=>{
 const env=fixture({delayedCoverage:true,coverageFailures:1});await env.settle();env.engine.retry();assert.equal(env.coverageAttempts,2);
 env.engine.destroy();const states=env.states.length;env.coverageResolve(env.coverage);await env.settle();
 assert.equal(env.coverage.disposed,1);assert.equal(env.readyCalls,0);assert.equal(env.coverage.subscribers.size,0);assert.equal(env.states.length,states);assert.equal(env.store.requests.length,0);assert.equal(env.frames.size,0);assert.equal(env.host.children.length,0);
 env.engine.retry();env.window.dispatch('online');assert.equal(env.coverageAttempts,2);
});

test('online during a pending coverage failure schedules one recovery attempt after it settles',async t=>{
 let reject;const first=new Promise((_resolve,no)=>{reject=no;});
 const env=fixture({coverageLoader:(attempt,coverage)=>attempt===1?first:Promise.resolve(coverage)});t.after(()=>env.engine.destroy());
 assert.equal(env.engine.getState().loading,true);for(let i=0;i<8;i++)env.window.dispatch('online');assert.equal(env.coverageAttempts,1);
 reject(new Error('Connection returned before the old request failed'));await env.settle();assert.equal(env.coverageAttempts,2);env.complete();await env.settle();
 assert.equal(env.engine.getState().ready,true);assert.equal(env.engine.getState().error,'');assert.equal(env.readyCalls,1);
});

test('online during a pending tile failure retries the failed cell once, without an automatic retry loop',async t=>{
 const env=fixture();t.after(()=>env.engine.destroy());await env.ready();env.engine.setCamera({center:[41,44],zoom:9});
 const missing=env.pending('relief')[0];for(let i=0;i<8;i++)env.window.dispatch('online');env.store.reject(missing);env.complete();await env.settle();
 const retry=env.pending('relief');assert.equal(retry.length,1);assert.equal(retry[0].key,missing.key);assert.equal(env.engine.getState().loading,true);
 env.store.reject(retry[0]);await env.settle();assert.equal(env.engine.getState().loading,false);assert.ok(env.engine.getState().error);assert.equal(env.pending().length,0);
 const requests=env.store.requests.length;await env.settle();env.tick(10_000);await env.settle();assert.equal(env.store.requests.length,requests,'One online event cannot create repeated retries against a failed server');
});

test('a superseded retry cannot replace the latest mode or pin the retired satellite batch again',async t=>{
 const env=fixture();t.after(()=>env.engine.destroy());await env.ready();env.engine.setMode('satellite');env.complete();await env.settle();
 const imagery=plain(env.engine.inspect().tiles.imagery);for(const [key,tile] of env.store.cache)if(tile.kind==='relief'||tile.kind==='vector'&&!tile.transparent)env.store.cache.delete(key);
 env.engine.setMode('detail');const pending=env.pending();env.engine.setMode('satellite');await env.settle();assert.equal(env.engine.getState().committedMode,'satellite');
 for(const job of pending)env.store.reject(job,'Superseded relief request');await env.settle();assert.equal(env.engine.getState().committedMode,'satellite');assert.equal(env.engine.getState().error,'');assert.deepEqual(plain(env.engine.inspect().tiles.imagery),imagery);
 env.engine.setMode('detail');env.complete();await env.settle();const pins=env.store.pins.at(-1);assert.equal(env.engine.getState().committedMode,'detail');for(const tile of imagery)assert.equal(pins.includes(tile.key),false);
});

test('Home and north controls publish manual navigation intent so pending route selection cannot take the camera back',async t=>{
 const env=fixture({view:{...camera,bearingDegrees:30}});t.after(()=>env.engine.destroy());await env.ready();
 const initial=env.gestures;env.engine.canvas.dispatch('keydown',{key:'Home'});assert.equal(env.gestures,initial+1);env.tick(250);env.flush();assert.equal(env.engine.getCamera().zoom,1);
 env.engine.north();assert.equal(env.gestures,initial+2);env.tick(250);env.flush();assert.equal(env.engine.getCamera().bearingDegrees,0);
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
 const firstText=draw.findIndex(call=>call.op==='fillText'),lastMask=draw.findLastIndex(call=>call.op==='fill'&&call.rule==='evenodd');assert.ok(firstText>lastMask&&lastMask>=0,'The mask must finish before complete admitted glyphs are painted');assert.equal(draw.some(call=>call.op==='clip'),false);
 for(const label of diagnostics.filter(item=>item.visible)){assert.ok(label.rect.left>=12&&label.rect.right<=800-12);assert.ok(label.rect.right-label.rect.left>=label.width);}
});

function labelSnapshot(env){
 return{records:plain(env.engine.getLabelDiagnostics()),total:env.engine.inspectLabels({schemaVersion:1,names:['__fixture_missing_name__'],limit:1}).labelInspection.totalCandidates,
  hidden:env.host.querySelector('.tropnik-map-labels').hidden,paint:plain(env.lastDraw().filter(call=>call.surface==='tropnik-map-labels'))};
}

test('static label preparation preserves the pinned original decisions and paint through camera, input, coverage and layer changes',async t=>{
 const current=fixture({view:{...camera,zoom:12}}),original=fixture({view:{...camera,zoom:12},baselineLabels:true}),pair=[current,original],inputs=new Map();
 t.after(()=>pair.forEach(env=>env.engine.destroy()));
 const equivalent=phase=>assert.deepEqual(labelSnapshot(current),labelSnapshot(original),phase);
 const labels=(env,job,prefix='')=>{
  const specs=job.request.kind==='vector'?[
   {point:{x:250,y:180},text:prefix+'Москва',rank:9,priorityCity:true,placeClass:'city'},
   {point:{x:470,y:300},text:'Вершина',kind:'peak',rank:3,elevation:3210.4},
   {point:{x:470,y:300},text:'Вершина',kind:'peak',rank:3,elevation:3211.4},
   {point:{x:680,y:170},text:'Тропа «Тест»',kind:'path',rank:4},
   {point:{x:720,y:170},text:'Тропа Тест',kind:'path',rank:4},
  ]:job.request.kind==='relief'?[{point:{x:300,y:500},text:'1000 м',kind:'contour',rank:9,elevation:1000}]:[];
  return{labels:specs.map(({point,text,...properties})=>env.labelFor(job,env.coordinateAt(point),text,properties)).filter(label=>label.x>=0&&label.x<1&&label.y>=0&&label.y<1)};
 };
 for(const env of pair){
  await turn();const additional=[{id:'external',coordinate:env.coordinateAt({x:430,y:460}),label:'External',kind:'path',rank:0},{id:'hole',coordinate:[40.7,43.7],label:'Hole',rank:0},{id:'foreign',coordinate:[39.99,43.5],label:'Foreign',rank:1}];
  inputs.set(env,additional);env.engine.setLabels(additional);env.complete(()=>true,job=>labels(env,job));await env.settle();
 }
 equivalent('Cold construction must keep the exact original order, reasons, coordinates and draw commands');
 const cold=plain(current.labelWork),coldOriginal=plain(original.labelWork),coldPaint=current.calls.filter(call=>call.op==='measureText').length;
 assert.equal(cold.sourceCoordinates,6);assert.equal(current.engine.getLabelDiagnostics().find(label=>label.id==='hole').reason,'outside-coverage');
 assert.ok(current.engine.getLabelDiagnostics().some(label=>label.reason==='duplicate'));assert.ok(current.engine.getLabelDiagnostics().some(label=>label.reason==='repeated-name'));
 for(const env of pair){env.engine.setRegion([]);env.flush();}
 equivalent('An unchanged warm paint must remain byte-for-byte equivalent at the command/diagnostic boundary');
 for(const env of pair)env.engine.canvas.dispatch('pointerdown',{pointerId:81,clientX:400,clientY:300});
 for(const [x,y]of [[408,304],[416,308],[400,300]]){
  for(const env of pair){env.engine.canvas.dispatch('pointermove',{pointerId:81,clientX:x,clientY:y});env.flush();}
  equivalent('A native pan keeps current screen positions and dynamic collision decisions');
 }
 for(const key of ['sourceCoordinates','coverageTests','priorityCalls','repeatKeys'])assert.equal(current.labelWork[key],cold[key],`Warm movement must not repeat static ${key}`);
 assert.ok(original.labelWork.sourceCoordinates>coldOriginal.sourceCoordinates);assert.ok(original.labelWork.coverageTests>coldOriginal.coverageTests);
 assert.ok(current.labelWork.screenCoordinates>cold.screenCoordinates,'Point-to-screen projection still runs on camera frames');
 assert.ok(current.calls.filter(call=>call.op==='measureText').length>coldPaint,'Current font measurements must not be frozen with the source metadata');
 for(const env of pair){env.engine.canvas.dispatch('pointerup',{pointerId:81,clientX:400,clientY:300});env.flush();}
 equivalent('Pointer release retains the same labels');

 const beforeCallerMutation=plain(current.engine.getLabelDiagnostics());
 for(const env of pair){const additional=inputs.get(env);additional[0].label='Changed caller';additional[0].coordinate[0]+=.004;env.engine.setRegion([]);env.flush();}
 equivalent('Mutating caller-owned labels must not corrupt either retained frame');
 assert.deepEqual(plain(current.engine.getLabelDiagnostics()),beforeCallerMutation,'setLabels owns the original supplied coordinates and text');
 const beforeReplace=current.labelWork.sourceCoordinates;
 for(const env of pair){env.engine.setLabels(inputs.get(env));env.flush();}
 equivalent('A later setLabels call must install the mutated input as a new snapshot');
 assert.equal(current.engine.getLabelDiagnostics().find(label=>label.id==='external').label,'Changed caller');assert.ok(current.labelWork.sourceCoordinates>beforeReplace);

 for(const env of pair){env.engine.setObstacles([{left:200,right:520,top:140,bottom:340}]);env.flush();}
 equivalent('Obstacle changes recompute collisions without reusing admitted rectangles');
 for(const env of pair){env.engine.setObstacles([]);env.flush();}
 equivalent('Removing an obstacle restores original diagnostics rather than stale collision reasons');
 const beforeTransform=current.labelWork.sourceCoordinates;
 for(const env of pair){env.engine.setCamera({...env.engine.getCamera(),bearingDegrees:17.3},false);env.flush();}
 equivalent('A fractional bearing recalculates positions and collision footprints');
 for(const env of pair){env.engine.setPitch(30);env.flush();}
 equivalent('Pitch keeps current projected coordinates rather than the previous flat frame');
 for(const env of pair){env.host.clientWidth=620;env.host.clientHeight=460;env.observers[0].callback();env.flush();}
 equivalent('Resize updates the actual label surface, viewport budget and collision decisions');
 for(const env of pair){env.host.clientWidth=800;env.host.clientHeight=600;env.observers[0].callback();env.engine.setPitch(0);env.engine.setCamera({...env.engine.getCamera(),bearingDegrees:0},false);env.flush();}
 equivalent('Restoring the original canvas geometry preserves the original commands');
 assert.equal(current.labelWork.sourceCoordinates,beforeTransform,'Dynamic transforms must not rebuild unchanged source coordinates');
 for(const env of pair){env.engine.setLayers({relief:false});env.flush();}
 equivalent('Hiding measured relief removes its height annotations from the candidate set');
 assert.equal(current.engine.getLabelDiagnostics().some(label=>label.label==='1000 м'),false);
 for(const env of pair){env.engine.setLayers({relief:true});env.flush();}
 equivalent('Restoring measured relief restores its annotations');
 assert.ok(current.engine.getLabelDiagnostics().some(label=>label.label==='1000 м'));
 const previousCoverage=current.labelWork.coverageTests;
 for(const env of pair){const next=plain(area);next.geometry.coordinates.pop();env.coverage.area=next;notifyCoverage(env,{revision:1});env.flush();}
 equivalent('A newly committed immutable area invalidates a previously rejected geographic anchor');
 assert.equal(current.engine.getLabelDiagnostics().find(label=>label.id==='hole').reason,'outside-viewport');assert.ok(current.labelWork.coverageTests>previousCoverage);
 const afterCoverage=plain(current.labelWork);
 for(const env of pair){notifyCoverage(env,{pending:1,error:'Refinement pending'});env.engine.setRegion([]);env.flush();}
 equivalent('Progress on the same geometry does not alter candidate admission');
 assert.equal(current.labelWork.sourceCoordinates,afterCoverage.sourceCoordinates);assert.equal(current.labelWork.coverageTests,afterCoverage.coverageTests);

 for(const zoom of [4.99,5.01,8,9,9.99,10.01,12]){
  for(const env of pair){env.engine.setCamera({...camera,zoom},false);env.flush();}
  equivalent('Zoom '+zoom+' preserves source/height gates, typography and current positions');
  const records=current.engine.getLabelDiagnostics();assert.equal(records.some(label=>label.label==='1000 м'),zoom>=10);
  assert.equal(records.some(label=>label.label==='Москва'),zoom>=5);assert.ok(records.some(label=>label.id==='external'),'Additional labels remain available below the source-label threshold');
 }
 for(const env of pair){env.engine.setMode('overview');env.flush();}
 equivalent('Overview keeps only the additional label inputs');
 assert.ok(current.engine.getLabelDiagnostics().every(label=>['external','hole','foreign'].includes(label.id)));
 for(const env of pair){env.engine.setMode('satellite');env.complete(()=>true,job=>labels(env,job));await env.settle();}
 equivalent('Newly committed satellite overlays replace their source batch');assert.equal(current.engine.getState().committedMode,'satellite');
 assert.equal(current.engine.getLabelDiagnostics().some(label=>label.label==='1000 м'),false);
 for(const env of pair){env.engine.setMode('detail');env.flush();}
 equivalent('Requested detail must retain satellite-label semantics until the replacement commits');assert.equal(current.engine.getState().committedMode,'satellite');
 for(const env of pair){env.complete(()=>true,job=>labels(env,job));await env.settle();}
 equivalent('Committed measured relief restores its own source annotations');assert.equal(current.engine.getState().committedMode,'detail');
 for(const env of pair){env.engine.setLayers({paths:false});env.complete(()=>true,job=>labels(env,job,'Новая '));await env.settle();}
 equivalent('A newly committed source batch invalidates the previous label metadata even at the same camera');
 assert.ok(current.engine.getLabelDiagnostics().some(label=>label.label==='Новая Москва'));
});

test('label coverage work remains lazy behind the original budget while every warm diagnostic is recomputed',async t=>{
 const current=fixture({view:{...camera,zoom:14}}),original=fixture({view:{...camera,zoom:14},baselineLabels:true}),pair=[current,original];
 t.after(()=>pair.forEach(env=>env.engine.destroy()));
 for(const env of pair){await env.ready();env.engine.setLabels(Array.from({length:80},(_,index)=>({id:'label-'+index,coordinate:env.coordinateAt({x:40+(index%10)*80,y:50+Math.floor(index/10)*70}),label:String(index),rank:4})));env.flush();}
 assert.deepEqual(labelSnapshot(current),labelSnapshot(original));
 const records=current.engine.getLabelDiagnostics(),visible=records.filter(label=>label.visible).length,covered=current.labelWork.coverageTests,priority=current.labelWork.priorityCalls;
 assert.equal(visible,26);assert.equal(covered,visible,'Cold preparation must not query source admission for candidates beyond the drawn-label budget');assert.ok(records.some(label=>label.reason==='budget'));
 for(const env of pair){env.engine.setRegion([]);env.flush();}
 assert.deepEqual(labelSnapshot(current),labelSnapshot(original));assert.equal(current.labelWork.coverageTests,covered);assert.equal(current.labelWork.priorityCalls,priority);
 const untouched=current.engine.getLabelDiagnostics(),inspected=current.engine.inspectLabels({schemaVersion:1,names:['0'],limit:1}).labels;
 untouched[0].coordinate[0]=0;untouched[0].rect.left=0;inspected[0].coordinate[1]=0;inspected[0].rect.top=0;
 assert.deepEqual(labelSnapshot(current),labelSnapshot(original),'Both public diagnostic APIs must protect retained coordinates and rectangles from caller mutation');
 for(const env of pair){env.engine.setObstacles([{left:0,right:800,top:0,bottom:195}]);env.flush();}
 assert.deepEqual(labelSnapshot(current),labelSnapshot(original));
 const blocked=current.engine.getLabelDiagnostics();assert.equal(blocked.filter(label=>label.visible).length,26);assert.ok(blocked.some(label=>label.reason==='collision'));
 assert.ok(current.labelWork.coverageTests>covered&&current.labelWork.coverageTests<80,'Only newly reached candidates are admitted when obstacles free the later budget');
 const expanded=current.labelWork.coverageTests;
 for(const env of pair){env.engine.setObstacles([]);env.flush();}
 assert.deepEqual(labelSnapshot(current),labelSnapshot(original));assert.equal(current.labelWork.coverageTests,expanded,'A warm frame reuses true/false source admission but recomputes current reasons');
 assert.equal(current.engine.getLabelDiagnostics()[0].visible,true);assert.notEqual(current.engine.getLabelDiagnostics()[0].coordinate[0],0);
});

test('the engine keeps source priority-city typography and bounds diagnostic candidates',async t=>{
 const env=fixture({view:{...camera,zoom:10}});t.after(()=>env.engine.destroy());await turn();
 const vector=env.pending('vector'),city=vector.find(job=>{const label=env.labelFor(job,camera.center,'Москва');return label.x>=0&&label.x<=1&&label.y>=0&&label.y<=1;});assert.ok(city);
 env.complete(job=>job!==city);env.store.resolve(city,{labels:[env.labelFor(city,camera.center,'Москва',{rank:9,priorityCity:true})]});await env.settle();
 const painted=env.lastDraw().find(call=>call.op==='fillText'&&call.text==='Москва');assert.ok(painted);assert.match(painted.font,/20px/,'A source priority city must keep its geographic city typography');
 const labels=Array.from({length:1000},(_,index)=>env.labelFor(city,[39.8,43.5],'Outside '+index));
 const current=env.store.cache.get(city.key);current.labels=labels;env.engine.setLabels([]);env.flush();assert.equal(env.engine.getLabelDiagnostics().length,512);assert.equal(env.lastDraw().some(call=>call.op==='fillText'&&call.text.startsWith('Outside ')),false);
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

test('trail and lake names repeat only at readable distances while distinct same-named points remain',async t=>{
 const env=fixture({view:{...camera,zoom:14},width:1200,height:600});t.after(()=>env.engine.destroy());await turn();
 const candidates=[
  {point:{x:250,y:160},text:'Экотропа «Восьмёрка»',kind:'path',rank:1},
  {point:{x:500,y:160},text:'Экотропа "Восьмёрка"',kind:'path',rank:2},
  {point:{x:960,y:160},text:'Экотропа «Восьмёрка»',kind:'path',rank:3},
  {point:{x:250,y:300},text:'Большое озеро',kind:'water',rank:1},
  {point:{x:450,y:300},text:'Большое озеро',kind:'water',rank:2},
  {point:{x:700,y:420},text:'Беседка',kind:'poi',symbol:'shelter',rank:1},
  {point:{x:900,y:420},text:'Беседка',kind:'poi',symbol:'shelter',rank:2},
 ];
 env.complete(()=>true,job=>({labels:job.request.kind==='vector'?candidates.map(({point,text,...options})=>env.labelFor(job,env.coordinateAt(point),text,options)).filter(label=>label.x>=0&&label.x<1&&label.y>=0&&label.y<1):[]}));await env.settle();
 const labels=plain(env.engine.getLabelDiagnostics());
 assert.equal(labels.filter(label=>label.visible&&label.label.startsWith('Экотропа')).length,2,'A nearby tile seam duplicate disappears but a distant line segment remains identifiable');
 assert.equal(labels.find(label=>label.label==='Экотропа "Восьмёрка"').reason,'repeated-name');
 assert.equal(labels.filter(label=>label.visible&&label.label==='Большое озеро').length,1);
 assert.equal(labels.filter(label=>label.visible&&label.label==='Беседка').length,2,'Distinct source landmarks are never silently merged by their name');
});

test('measured contour numbers follow the visible relief and never leak onto committed satellite imagery',async t=>{
 const env=fixture({view:{...camera,zoom:14}});t.after(()=>env.engine.destroy());await turn();
 const measuredLabels=job=>({labels:job.request.kind==='relief'?[env.labelFor(job,camera.center,'400 м',{kind:'contour',rank:6,elevation:400})].filter(label=>label.x>=0&&label.x<1&&label.y>=0&&label.y<1):[]});
 env.complete(()=>true,measuredLabels);await env.settle();
 const visible=()=>env.engine.getLabelDiagnostics().some(label=>label.visible&&label.label==='400 м');
 assert.equal(visible(),true,'A measured index elevation must appear on the relief layer');
 env.engine.setLayers({relief:false});await env.settle();assert.equal(visible(),false,'Hiding relief also removes its height annotations');
 env.engine.setLayers({relief:true});env.complete(()=>true,measuredLabels);await env.settle();assert.equal(visible(),true);
 const before=plain(env.engine.getCamera());env.engine.setMode('satellite');await env.settle();
 assert.equal(visible(),true,'The retained relief remains annotated until replacement imagery commits');
 env.complete();await env.settle();assert.equal(env.engine.getState().committedMode,'satellite');assert.equal(visible(),false);
 env.engine.setMode('detail');env.complete(()=>true,measuredLabels);await env.settle();assert.equal(visible(),true);
 assert.deepEqual(plain(env.engine.getCamera()),before,'Layer annotations cannot move the camera');
});

test('readable label plates are measured before admission and do not use a heavy glyph outline',async t=>{
 const env=fixture();t.after(()=>env.engine.destroy());await env.ready();
 env.engine.setLabels([{id:'plate',coordinate:[...camera.center],label:'Название маршрута',kind:'path'}]);env.flush();
 const label=env.engine.getLabelDiagnostics().find(label=>label.id==='plate'),draw=env.lastDraw();assert.equal(label.visible,true);
 const text=draw.find(call=>call.op==='fillText'&&call.text==='Название маршрута'),plate=draw.find(call=>call.op==='roundRect');assert.ok(text);assert.ok(plate);
 const [x,y,width,height,radius]=plate.args;assert.equal(radius,4);assert.ok(width>=label.width+16);assert.ok(height>=24);
 assert.ok(x>=label.rect.left&&x+width<=label.rect.right&&y>=label.rect.top&&y+height<=label.rect.bottom,'The visible surface must fit inside its collision footprint');
 assert.equal(draw.some(call=>call.op==='strokeText'),false,'Opaque text plates replace per-glyph white fringes');
 assert.ok(draw.findIndex(call=>call.op==='fillText')>draw.findIndex(call=>call.op==='roundRect'));
 env.engine.setObstacles([{left:x+width-1,right:x+width+10,top:y,bottom:y+height}]);env.flush();
 assert.equal(env.engine.getLabelDiagnostics()[0].reason,'collision','Controls touching the plate edge exclude the entire name');
});

test('the mobile viewport admits priority geography before crowded local labels and enforces a smaller density budget',async t=>{
 const env=fixture({view:{...camera,zoom:14},width:390,height:800});t.after(()=>env.engine.destroy());await turn();
 const positions=Array.from({length:64},(_,i)=>({x:30+(i%8)*47,y:42+Math.floor(i/8)*94}));
 const candidates=positions.map((point,index)=>({point,text:String(index),rank:4}));
 candidates.push({point:{x:195,y:400},text:'Южно-Сахалинск',rank:9,priorityCity:true});
 env.complete(()=>true,job=>({labels:job.request.kind==='vector'?candidates.map(({point,text,...options})=>env.labelFor(job,env.coordinateAt(point),text,options)).filter(label=>label.x>=0&&label.x<1&&label.y>=0&&label.y<1):[]}));await env.settle();
 const labels=plain(env.engine.getLabelDiagnostics());assert.equal(labels.find(label=>label.label==='Южно-Сахалинск').visible,true);
 assert.ok(labels.filter(label=>label.visible).length<=17,'390px mobile map retains enough terrain between names');
 assert.ok(labels.some(label=>label.reason==='budget'),'Sparse non-overlapping labels still have a viewport-area density limit');
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
 const env=fixture({delayedCoverage:true});assert.equal(env.engine.getState().loading,true);env.engine.destroy();const states=env.states.length;env.coverageResolve(env.coverage);await env.settle();assert.equal(env.coverage.disposed,1);assert.equal(env.store.requests.length,0);assert.equal(env.states.length,states);assert.equal(env.readyCalls,0);assert.equal(env.frames.size,0);
});

test('landscape reads the current visible ground through framing, bearing and pitch without changing the map',async t=>{
 const width=373,height=774,env=fixture({width,height,view:{center:[179.9,66],zoom:8,bearingDegrees:37}});t.after(()=>env.engine.destroy());await env.ready();
 const map=env.engine,padding={left:24,right:80,top:88,bottom:525};map.setPadding(padding);
 const envelope=points=>{const values=points.map(point=>map.unproject(point));return[Math.min(...values.map(p=>p[0])),Math.min(...values.map(p=>p[1])),Math.max(...values.map(p=>p[0])),Math.max(...values.map(p=>p[1]))];};
 const close=(actual,expected)=>actual.forEach((value,index)=>assert.ok(Math.abs(value-expected[index])<1e-9,`${value} differs from ${expected[index]}`));
 for(const pitch of [0,40,60]){
  map.setPitch(pitch);
  const before=plain(map.getCamera()),whole=plain(map.getBounds()),draws=map.inspect().drawRevision,requests=env.store.requests.length;
  close(whole,envelope([{x:0,y:0},{x:width,y:0},{x:width,y:height},{x:0,y:height}]));
  close(map.getVisibleBounds(),envelope([{x:24,y:88},{x:293,y:88},{x:293,y:249},{x:24,y:249}]));
  // A sheet can finish moving before its queued layout observer updates the
  // stored insets. The caller can supply its fresh measured rectangle directly.
  const current={...padding,bottom:300};
  close(map.getVisibleBounds(current),envelope([{x:24,y:88},{x:293,y:88},{x:293,y:474},{x:24,y:474}]));
  assert.deepEqual(plain(map.getBounds()),whole,'Default bounds must retain the complete canvas');
  assert.deepEqual(plain(map.getCamera()),before,'Opening the scene must not refit or move the map');
  assert.equal(map.inspect().drawRevision,draws);assert.equal(env.store.requests.length,requests,'A bounds read must not start new source work');
 }
});

test('public inspection publishes fresh scene insets without refitting and tolerates a transient covered resize',async t=>{
 const env=fixture({width:373,height:774});t.after(()=>env.engine.destroy());await env.ready();
 const map=env.engine,padding={left:24,right:80,top:88,bottom:525};map.setPadding(padding);
 let published=JSON.parse(env.host.dataset.mapInspection);
 assert.deepEqual(published.viewport,{width:373,height:774,padding});assert.deepEqual(published.visibleBounds,plain(map.getVisibleBounds()));
 const camera=plain(map.getCamera()),whole=plain(map.getBounds()),draws=map.inspect().drawRevision,requests=env.store.requests.length;
 const current={...padding,bottom:300};map.setPadding(current);published=JSON.parse(env.host.dataset.mapInspection);
 assert.equal(published.viewport.padding.bottom,300);assert.deepEqual(published.visibleBounds,plain(map.getVisibleBounds()));
 assert.notDeepEqual(published.visibleBounds,whole);assert.deepEqual(plain(map.getCamera()),camera);assert.equal(map.inspect().drawRevision,draws);assert.equal(env.store.requests.length,requests);
 current.bottom=100;assert.equal(map.inspect().viewport.padding.bottom,300,'The published framing must not retain a caller-owned mutable object');
 env.host.clientHeight=200;
 assert.doesNotThrow(()=>env.observers[0].callback());assert.equal(map.inspect().visibleBounds,null,'Old sheet insets can temporarily cover the resized canvas');
 map.setPadding({left:24,right:80,top:40,bottom:64});published=JSON.parse(env.host.dataset.mapInspection);
 assert.equal(published.viewport.height,200);assert.ok(published.visibleBounds?.every(Number.isFinite));assert.deepEqual(published.visibleBounds,plain(map.getVisibleBounds()));
 assert.deepEqual(plain(map.getCamera()),camera,'Publishing geometry must not change the manually selected view');
});

test('zoom controls accumulate every rapid input across RAF, reversals and both clamped ends',async t=>{
 for(const elapsed of [0,16,40]){
  const env=fixture();t.after(()=>env.engine.destroy());await env.ready();const map=env.engine;
  const burst=directions=>{for(const delta of directions){map.zoomBy(delta);if(elapsed)env.tick(elapsed);}env.flush();};
  burst([1,1,1,1]);assert.equal(map.getCamera().zoom,12,`Four plus inputs separated by ${elapsed}ms must all count`);
  burst([-1,-1,-1,-1]);assert.equal(map.getCamera().zoom,8,`Four minus inputs separated by ${elapsed}ms must all count`);
  burst([1,1,1,-1]);assert.equal(map.getCamera().zoom,10,'A reversal applies to the requested scale, not an intermediate frame');
  map.setCamera({...camera,zoom:17});env.flush();burst([1,1,1,1]);assert.equal(map.getCamera().zoom,18);
  burst([-1]);assert.equal(map.getCamera().zoom,17,'Inputs beyond maximum cannot create a hidden zoom debt');
  map.setCamera({...camera,zoom:2});env.flush();burst([-1,-1,-1,-1]);assert.equal(map.getCamera().zoom,1);
  burst([1]);assert.equal(map.getCamera().zoom,2,'Inputs below the floor cannot create a hidden zoom debt');
  assert.equal(env.host.dataset.mapMoving,'false');assert.equal(env.frames.size,0);
 }
});

test('manual gestures, programmatic camera and fit discard a superseded zoom-control target',async t=>{
 const env=fixture();t.after(()=>env.engine.destroy());await env.ready();const map=env.engine;
 const pending=()=>{map.setCamera(camera);env.flush();for(let i=0;i<4;i++)map.zoomBy(1);env.tick(48);};
 pending();map.setCamera({...camera,zoom:6});map.zoomBy(1);env.flush();assert.equal(map.getCamera().zoom,7);
 pending();map.fit([40.5,43.5,40.51,43.51],{top:24,right:24,bottom:24,left:24},9,false);const fit=plain(map.getCamera());
 map.zoomBy(1);env.flush();assert.ok(Math.abs(map.getCamera().zoom-fit.zoom-1)<1e-9,'The next zoom must begin from the fitted view');
 pending();const interruptedZoom=map.getCamera().zoom;
 map.canvas.dispatch('pointerdown',{pointerId:37,clientX:300,clientY:250});map.canvas.dispatch('pointermove',{pointerId:37,clientX:340,clientY:280});map.canvas.dispatch('pointerup',{pointerId:37,clientX:340,clientY:280});
 const panned=plain(map.getCamera());assert.equal(panned.zoom,interruptedZoom);assert.notDeepEqual(panned.center,camera.center);
 map.zoomBy(1);env.flush();assert.ok(Math.abs(map.getCamera().zoom-panned.zoom-1)<1e-9,'Dragging owns the displayed camera and cancels its old button target');
 pending();map.canvas.dispatch('wheel',{clientX:310,clientY:240,deltaY:-80,deltaMode:0});const wheeled=plain(map.getCamera());
 map.zoomBy(1);env.flush();assert.ok(Math.abs(map.getCamera().zoom-wheeled.zoom-1)<1e-9,'A new wheel anchor must not inherit the old button target');
});

test('pausing or disposing during a zoom burst cancels future camera work',async()=>{
 const env=fixture();await env.ready();const map=env.engine;
 for(let i=0;i<4;i++)map.zoomBy(1);env.tick(48);const paused=plain(map.getCamera());map.setActive(false);env.tick(1000);
 assert.deepEqual(plain(map.getCamera()),paused);assert.equal(env.frames.size,0);
 map.setActive(true);map.zoomBy(1);env.flush();assert.ok(Math.abs(map.getCamera().zoom-paused.zoom-1)<1e-9,'A paused animation cannot survive as a stale button target');
 for(let i=0;i<4;i++)map.zoomBy(1);env.tick(32);const before=plain(map.getCamera()),draws=map.inspect().drawRevision;
 map.destroy();env.complete();await env.settle();env.tick(1000);
 assert.deepEqual(plain(map.getCamera()),before);assert.equal(map.inspect().drawRevision,draws);assert.equal(env.frames.size,0);assert.equal(env.timers.size,0);
});

test('every map zoom key accumulates native autorepeat and leaves modified browser shortcuts alone',async t=>{
 const env=fixture();t.after(()=>env.engine.destroy());await env.ready();const map=env.engine;
 for(const [keys,delta]of [[['+','=','Add','PageUp'],1],[['-','−','Subtract','PageDown'],-1]])for(const key of keys){
  map.setCamera(camera);env.flush();
  for(let index=0;index<4;index++){
   const event=map.canvas.dispatch('keydown',{key,repeat:index>0});assert.equal(event.defaultPrevented,true,`${key} must be handled by the map`);env.tick(16);
  }
  env.flush();assert.equal(map.getCamera().zoom,8+4*delta,`${key} autorepeat lost a zoom step`);
  for(const modifier of ['altKey','ctrlKey','metaKey']){
   const before=plain(map.getCamera()),event=map.canvas.dispatch('keydown',{key,repeat:true,[modifier]:true});env.flush();
   assert.equal(event.defaultPrevented,undefined);assert.deepEqual(plain(map.getCamera()),before,`${key} must not steal a modified browser shortcut`);
  }
 }
 map.setCamera(camera);env.flush();for(let index=0;index<4;index++)map.zoomBy(1);env.tick(48);
 const interrupted=plain(map.getCamera());map.canvas.dispatch('keydown',{key:'ArrowRight'});env.flush();
 assert.equal(map.getCamera().zoom,interrupted.zoom);assert.notDeepEqual(plain(map.getCamera().center),interrupted.center);
 map.canvas.dispatch('keydown',{key:'+'});env.flush();assert.ok(Math.abs(map.getCamera().zoom-interrupted.zoom-1)<1e-9,'Arrow navigation replaces the pending button target');
 map.canvas.dispatch('keydown',{key:'Home'});env.flush();assert.equal(map.getCamera().zoom,1);map.canvas.dispatch('keydown',{key:'+'});env.flush();assert.equal(map.getCamera().zoom,2);
 assert.equal(env.frames.size,0);assert.equal(env.host.dataset.mapMoving,'false');
});

test('territorial boundaries toggle actual vector bitmaps in detail and satellite without reloading unrelated layers',async t=>{
 for(const mode of ['detail','satellite']){
  const env=fixture();t.after(()=>env.engine.destroy());await env.ready();const map=env.engine;
  map.setRoute({type:'LineString',coordinates:[[40.4,43.4],[40.6,43.6]]},'kept-route');
  if(mode==='satellite'){map.setMode(mode);env.complete();await env.settle();}else env.flush();
  const before=plain(map.inspect()),keys=before.tiles.detail.map(tile=>tile.key),camera=plain(map.getCamera());assert.ok(keys.length>0);
  map.setLayers({boundaries:false});const replacements=env.pending();
  assert.ok(replacements.length>0);assert.ok(replacements.every(job=>job.request.kind==='vector'&&job.request.boundaries===false));
  assert.ok(replacements.every(job=>job.request.transparent===(mode==='satellite')));env.complete();await env.settle();
  const hidden=plain(map.inspect());assert.ok(hidden.tiles.detail.every(tile=>!keys.includes(tile.key)));assert.deepEqual(hidden.tiles.overview,before.tiles.overview);assert.deepEqual(hidden.tiles.relief,before.tiles.relief);assert.deepEqual(hidden.tiles.imagery,before.tiles.imagery);
  assert.equal(hidden.drawnRoute,'kept-route');assert.deepEqual(plain(map.getCamera()),camera);
  map.setLayers({boundaries:true});assert.equal(env.pending().length,0,'Re-enabling uses the retained boundary-enabled bitmap cache');await env.settle();
  assert.deepEqual(plain(map.inspect().tiles.detail.map(tile=>tile.key)),keys);assert.equal(map.inspect().drawnRoute,'kept-route');assert.equal(map.getState().error,'');
 }
});

function notifyCoverage(env,status){
 env.coverage.status={...env.coverage.status,...status};
 for(const listener of env.coverage.subscribers)listener(env.coverage);
}

function coveragePaint(env){
 const draw=env.lastDraw();
 return{
  area:draw.find(call=>call.op==='fill'&&call.color==='#dce5cf')?.path,
  mask:draw.findLast(call=>call.op==='fill'&&call.rule==='evenodd')?.path,
  boundaries:draw.find(call=>call.op==='stroke'&&call.color==='rgba(95,123,87,.45)')?.path,
  selected:draw.find(call=>call.op==='fill'&&call.color==='rgba(92,128,70,.10)')?.path,
  selectedBoundary:draw.find(call=>call.op==='stroke'&&call.color==='#688360')?.path,
  route:draw.find(call=>call.op==='stroke'&&call.color==='#244d3c')?.path,
 };
}

function coverageFixture(){
 // An oblique view keeps the underlays visible while these tests inspect the
 // actual coverage paths. Fully covered axis-aligned detail may occlude them.
 const env=fixture({view:{...camera,bearingDegrees:12}});
 const alpha={...plain(area),properties:{shapeName:'alpha'}};
 const beta={type:'Feature',properties:{shapeName:'beta'},geometry:{type:'Polygon',coordinates:[[[40.8,43],[41.5,43],[41.5,44],[40.8,44],[40.8,43]]]}};
 env.coverage.territories={type:'FeatureCollection',features:[alpha,beta]};
 env.coverage.boundaries={type:'FeatureCollection',features:[
  {type:'Feature',properties:{shapeName:'alpha'},geometry:{type:'LineString',coordinates:[[40,42],[42,45]]}},
  {type:'Feature',properties:{shapeName:'beta'},geometry:{type:'LineString',coordinates:[[40.8,43],[41.5,44]]}},
 ]};
 return env;
}

test('coverage progress and failure publish current status without rebuilding or redrawing unchanged geometry',async t=>{
 const env=coverageFixture();t.after(()=>env.engine.destroy());await env.ready();
 env.engine.setRoute({type:'LineString',coordinates:[[40.2,43.3],[40.4,43.4],[40.8,43.5]]},'coverage-route');
 env.engine.setRegion(['alpha']);env.flush();
 const painted=coveragePaint(env),pathCount=env.paths.length,drawRevision=env.engine.inspect().drawRevision;
 const cameraBefore=plain(env.engine.getCamera()),requestsBefore=env.store.requests.length;
 assert.ok(Object.values(painted).every(Boolean),'The fixture must paint every coverage role and its route');
 const states=[
  {pending:3,ready:false,error:''},{pending:2,ready:false,error:''},{pending:1,ready:false,error:''},
  {pending:0,ready:false,error:'coverage-unavailable'},{pending:0,ready:true,error:''},
 ];
 for(const status of states){
  notifyCoverage(env,status);
  assert.deepEqual(JSON.parse(env.host.dataset.mapCoverage),plain(env.coverage.status),'Progress and error diagnostics must remain current');
  assert.deepEqual(JSON.parse(env.host.dataset.mapInspection).coverage,plain(env.coverage.status),'Public renderer inspection must expose progress without waiting for another draw');
  assert.equal(env.host.dataset.mapCoverageState,status.ready?'ready':'loading');
 }
 assert.equal(env.paths.length,pathCount,'Status-only coverage notifications must not allocate or reconstruct Path2D geometry');
 assert.equal(env.frames.size,0,'A progress/error notification without new geometry must not queue a map repaint');
 assert.equal(env.engine.inspect().drawRevision,drawRevision);
 for(const role of Object.keys(painted))assert.equal(coveragePaint(env)[role],painted[role]);
 assert.deepEqual(plain(env.engine.getCamera()),cameraBefore);assert.equal(env.store.requests.length,requestsBefore);
 assert.equal(env.host.dataset.mapDrawnRoute,'coverage-route');
});

test('a committed coverage revision atomically refreshes real geometry and labels while same-revision selection still works',async t=>{
 const env=coverageFixture();t.after(()=>env.engine.destroy());await env.ready();
 env.engine.setRoute({type:'LineString',coordinates:[[40.2,43.3],[40.4,43.4],[40.8,43.5]]},'coverage-route');
 env.engine.setRegion(['alpha']);env.engine.setLabels([{id:'new-ground',coordinate:[40.7,43.7],label:'Current source ground'}]);env.flush();
 assert.equal(env.engine.getLabelDiagnostics().find(label=>label.id==='new-ground').reason,'outside-coverage');
 const before=coveragePaint(env),drawRevision=env.engine.inspect().drawRevision;
 const cameraBefore=plain(env.engine.getCamera()),requestsBefore=env.store.requests.length;
 const next=plain(area);next.geometry.coordinates[1]=next.geometry.coordinates[1].map(([lng,lat])=>[lng,lat+.4]);
 env.coverage.area=next;
 env.coverage.boundaries={type:'FeatureCollection',features:[{type:'Feature',properties:{shapeName:'alpha'},geometry:{type:'LineString',coordinates:[[40,42],[41,44],[42,45]]}},env.coverage.boundaries.features[1]]};
 env.coverage.territories={type:'FeatureCollection',features:[{...plain(next),properties:{shapeName:'alpha'}},env.coverage.territories.features[1]]};
 notifyCoverage(env,{revision:1,pending:0,ready:true,error:''});
 assert.equal(env.engine.inspect().drawRevision,drawRevision,'An atomic source notification must not paint midway through its update');
 assert.equal(env.frames.size,1);env.flush();
 const after=coveragePaint(env);
 for(const role of ['area','mask','boundaries','selected','selectedBoundary'])assert.notEqual(after[role],before[role],`${role} must use the newly committed source geometry`);
 assert.notDeepEqual(after.area.commands,before.area.commands);
 assert.notDeepEqual(after.boundaries.commands,before.boundaries.commands);
 assert.equal(after.mask.commands.find(command=>command[0]==='addPath')[1],after.area,'The outside mask must reference this same committed area');
 assert.equal(after.area.commands.filter(command=>command[0]==='closePath').length,2,'The source polygon hole must survive the update');
 assert.equal(after.route,before.route);assert.equal(env.engine.inspect().drawRevision,drawRevision+1);
 assert.equal(env.engine.getLabelDiagnostics().find(label=>label.id==='new-ground').visible,true,'Label source admission must use the same new coverage');
 const allocations=env.paths.length;env.engine.setRegion(['beta']);env.flush();
 const selected=coveragePaint(env);
 for(const role of ['area','mask','boundaries','route'])assert.equal(selected[role],after[role]);
 assert.notEqual(selected.selected,after.selected);assert.notEqual(selected.selectedBoundary,after.selectedBoundary);
 assert.equal(env.paths.length,allocations+1,'Only the new selected polygon compiles; the actual boundary path is already retained');
 assert.deepEqual(plain(env.engine.getCamera()),cameraBefore);assert.equal(env.store.requests.length,requestsBefore);
 assert.equal(env.host.dataset.mapDrawnRoute,'coverage-route');
});

function pathCommands(path){
 return path.commands.flatMap(command=>command[0]==='addPath'?pathCommands(command[1]):[command]);
}

test('neighbouring coverage revisions reuse unchanged cell paths without losing source order, holes or antimeridian vertices',async t=>{
 const env=fixture({view:{...camera,bearingDegrees:12}});t.after(()=>env.engine.destroy());
 const feature=(cell,role,geometry)=>({type:'Feature',properties:{cell,role,shapeName:cell},geometry});
 const west=feature('west','area',plain(area.geometry));
 const east=feature('east','area',{type:'MultiPolygon',coordinates:[
  [[[179.8,65],[-179.8,65],[-179.8,66],[179.8,66],[179.8,65]],[[179.9,65.2],[179.9,65.4],[-179.9,65.4],[-179.9,65.2],[179.9,65.2]]],
  [[[177.2,63],[177.4,63],[177.4,63.2],[177.2,63.2],[177.2,63]]],
 ]});
 const westBoundary=feature('west','territory-boundary',{type:'MultiLineString',coordinates:[[[40,42],[40.1234567,42.7654321],[42,45]],[[41,43],[41.5,44]]]});
 const eastBoundary=feature('east','territory-boundary',{type:'LineString',coordinates:[[179.8,65],[-179.8,65],[-179.8,66]]});
 const westTerritory=feature('west','territory',plain(west.geometry)),eastTerritory=feature('east','territory',plain(east.geometry));
 const fc=features=>({type:'FeatureCollection',features});
 const install=(eastArea=east,eastLine=eastBoundary,eastRegion=eastTerritory)=>{
  env.coverage.area=fc([{...west},eastArea]);
  env.coverage.boundaries=fc([{...westBoundary},eastLine]);
  env.coverage.territories=fc([{...westTerritory},eastRegion]);
 };
 const expectations=()=>({
  area:pathCommands(env.geometryPath(env.coverage.area).path),
  boundaries:pathCommands(env.geometryPath(env.coverage.boundaries).path),
  selected:pathCommands(env.geometryPath(env.coverage.territories).path),
  selectedBoundary:pathCommands(env.geometryPath(env.coverage.boundaries).path),
 });
 const closes=()=>env.paths.reduce((sum,path)=>sum+path.commands.filter(command=>command[0]==='closePath').length,0);
 const assertGeometry=expected=>{
  const painted=coveragePaint(env);
  for(const role of ['area','boundaries','selected','selectedBoundary'])assert.deepEqual(pathCommands(painted[role]),expected[role],`${role} must preserve every projected source vertex and ring command`);
  assert.deepEqual(pathCommands(painted.mask),[['rect',-3,-3,8,8],...expected.area]);
  return painted;
 };
 install();const initialExpected=expectations();await env.ready();env.engine.setRegion(['west','east']);
 const route={type:'LineString',coordinates:[[40.2,43.3],[40.4,43.4],[40.8,43.5]]};
 env.engine.setRoute(route,'kept-route');env.flush();
 const first=assertGeometry(initialExpected),cameraBefore=plain(env.engine.getCamera()),requestsBefore=env.store.requests.length;
 const firstCloses=closes(),firstDraw=env.engine.inspect().drawRevision;
 install();notifyCoverage(env,{revision:1});
 assert.equal(closes(),firstCloses,'New role collections with the same immutable cells must not repeat any closePath');
 assert.equal(env.engine.inspect().drawRevision,firstDraw);assert.equal(env.frames.size,1);env.flush();
 const same=assertGeometry(initialExpected);
 for(const role of ['area','boundaries','selected','selectedBoundary'])assert.deepEqual(same[role].commands,first[role].commands,'New feature wrappers must reuse the geometry identity');
 assert.equal(same.route,first.route);

 const nextEast=plain(east);nextEast.geometry.coordinates[0][0][1]=[-179.7123456,65.0123456];
 const nextBoundary=plain(eastBoundary);nextBoundary.geometry.coordinates.splice(1,0,[179.9876543,65.1234567]);
 const nextTerritory=feature('east','territory',plain(nextEast.geometry));
 install(nextEast,nextBoundary,nextTerritory);const nextExpected=expectations(),beforeCommitCloses=closes(),beforeCommitDraw=env.engine.inspect().drawRevision;
 notifyCoverage(env,{revision:2});
 assert.equal(closes()-beforeCommitCloses,6,'Only the changed area and selected territory compile their three rings again');
 assert.equal(env.engine.inspect().drawRevision,beforeCommitDraw,'All coverage roles must commit before the next paint');
 assert.equal(env.frames.size,1);env.flush();const next=assertGeometry(nextExpected);
 for(const role of ['area','boundaries','selected','selectedBoundary']){
  assert.equal(next[role].commands[0][1],first[role].commands[0][1],`${role} must retain the untouched western cell`);
  assert.notEqual(next[role].commands[1][1],first[role].commands[1][1],`${role} must replace the changed eastern cell`);
 }
 assert.equal(next.route,first.route);assert.deepEqual(plain(env.engine.getCamera()),cameraBefore);assert.equal(env.store.requests.length,requestsBefore);
 install();const beforeReturnCloses=closes();notifyCoverage(env,{revision:3});env.flush();assertGeometry(initialExpected);
 assert.equal(closes(),beforeReturnCloses,'Returning to an immutable cell still held by coverage cache reuses its compiled path');

 route.coordinates[1]=[40.6,43.45];env.engine.setRoute(route,'kept-route');env.flush();const changedRoute=coveragePaint(env).route;
 assert.notEqual(changedRoute,first.route,'Caller-owned routes must remain outside the immutable coverage cache');
 assert.notDeepEqual(pathCommands(changedRoute),pathCommands(first.route));assert.equal(env.host.dataset.mapDrawnRoute,'kept-route');
 assert.deepEqual(plain(env.engine.getCamera()),cameraBefore);
 env.engine.destroy();const allocations=env.paths.length;notifyCoverage(env,{revision:4});env.flush();
 assert.equal(env.paths.length,allocations,'Disposed coverage subscriptions cannot compile or resurrect source paths');
});

test('named label inspection reads retained decisions beyond 512 without repainting or changing the current frame',async t=>{
 const env=fixture({view:{...camera,zoom:10}});t.after(()=>env.engine.destroy());await env.ready();
 const tiles=env.engine.inspect().tiles.detail.map(tile=>env.store.cache.get(tile.key));assert.ok(tiles.length>=7);
 let serial=0;
 for(const tile of tiles.slice(0,7))tile.labels=Array.from({length:96},()=>({x:.5,y:.5,text:'Retained '+serial++,kind:'place',rank:4}));
 env.engine.setLabels([]);env.flush();assert.equal(env.engine.getLabelDiagnostics().length,512);
 const before=plain(env.engine.inspect()),dataset=env.host.dataset.mapInspection,calls=env.calls.length,paths=env.paths.length,frames=env.frames.size,requests=env.store.requests.length;
 const request={schemaVersion:1,names:['Retained 600'],limit:100},detail={request};
 env.host.dispatch('tropnik-map-label-inspection',{detail});
 assert.equal(typeof detail.response,'string');const result=JSON.parse(detail.response);
 assert.deepEqual(result.labelInspection,{schemaVersion:1,names:request.names,limit:100,totalCandidates:672,retainedCandidates:672,matchingCandidates:1,truncated:false});
 assert.equal(result.labels.length,1);assert.equal(result.labels[0].label,'Retained 600');
 for(const key of ['camera','drawRevision','labelRevision'])assert.deepEqual(result[key],before[key]);
 assert.equal(env.host.dataset.mapInspection,dataset);assert.deepEqual(plain(env.engine.inspect()),before);
 assert.equal(env.calls.length,calls,'A diagnostic request must not measure or paint');assert.equal(env.paths.length,paths);assert.equal(env.frames.size,frames);assert.equal(env.store.requests.length,requests);
 const invalid={request:{...request,limit:101}};env.host.dispatch('tropnik-map-label-inspection',{detail:invalid});
 assert.equal(JSON.parse(invalid.response).error,'Invalid label inspection request');assert.equal(env.host.dataset.mapInspection,dataset);
 env.engine.destroy();const detached={request};env.host.dispatch('tropnik-map-label-inspection',{detail:detached});
 assert.equal(detached.response,undefined,'Destroy removes the read-only listener');assert.equal(env.engine.getLabelDiagnostics().length,0);
});

test('selected Chukotka keeps the real polygon fill but never outlines the source coverage-cell cut',async t=>{
 const bytes=readFileSync(resolve(root,'public/data/map-coverage/base.coverage'));
 const source=decodeCoverage(JSON.parse(bytes.toString('utf8'))),name='Chukotka Autonomous Okrug';
 const pick=role=>source.features.find(feature=>feature.properties.cell==='0b0a-'&&feature.properties.shapeName===name&&feature.properties.role===role);
 const territory=pick('territory'),boundary=pick('territory-boundary');assert.ok(territory&&boundary);
 // Pin the exact source features exercised here. Unrelated coverage refinements
 // must not force this regression case to bless a different Chukotka geometry.
 // Both decoded features are unchanged from release c1d1648.
 assert.equal(createHash('sha256').update(JSON.stringify(territory)).digest('hex'),'98b83ce39ea9d2dff5bf90911aaa75dac625027c9fb45365235a119aa9eec51e');
 assert.equal(createHash('sha256').update(JSON.stringify(boundary)).digest('hex'),'3a7a723e36ee75da007b8f7fc710ca34fa5e401d9abe946d040554642fd675b5');
 const lines=geometry=>geometry.type==='MultiPolygon'?geometry.coordinates.flat():geometry.coordinates;
 const crossing=geometry=>lines(geometry).flatMap(line=>line.slice(1).flatMap((point,index)=>{
  const previous=line[index];return previous[0]===180&&point[0]===180&&Math.min(previous[1],point[1])<67.5&&Math.max(previous[1],point[1])>67.5?[[previous,point]]:[];
 }));
 assert.deepEqual(crossing(territory.geometry),[[[180,68.9707828],[180,65.03596]]],'The real source must reproduce the visible artificial edge');
 assert.deepEqual(crossing(boundary.geometry),[],'The genuine line source must not contain that cell cut');
 const sourceBefore=JSON.stringify([territory,boundary]),env=fixture({view:{center:[180,67.5],zoom:5,bearingDegrees:0},coverageArea:territory});t.after(()=>env.engine.destroy());
 env.coverage.territories={type:'FeatureCollection',features:[territory]};env.coverage.boundaries={type:'FeatureCollection',features:[boundary]};
 const expectedFill=pathCommands(env.geometryPath(territory).path),expectedBoundary=pathCommands(env.geometryPath(boundary).path);
 await env.ready();env.engine.setRegion([name]);env.flush();const painted=coveragePaint(env);
 assert.deepEqual(pathCommands(painted.selected),expectedFill,'Every source polygon coordinate and ring remains in the fill');
 assert.deepEqual(pathCommands(painted.selectedBoundary),expectedBoundary,'Only genuine boundary coordinates may be stroked');
 assert.notEqual(painted.selected,painted.selectedBoundary);assert.equal(env.lastDraw().some(call=>call.op==='stroke'&&call.path===painted.selected),false);
 const mask=painted.mask,cameraBefore=plain(env.engine.getCamera());env.engine.setLayers({boundaries:false});env.complete();await env.settle();
 const hidden=coveragePaint(env);assert.equal(hidden.boundaries,undefined);assert.equal(hidden.selected,painted.selected);assert.equal(hidden.selectedBoundary,painted.selectedBoundary);assert.equal(hidden.mask,mask);
 env.engine.setMode('satellite');env.complete();await env.settle();
 assert.equal(env.lastDraw().find(call=>call.op==='stroke'&&call.color==='#e7eacc')?.path,painted.selectedBoundary,'Satellite preserves the same real selected border');
 assert.equal(env.lastDraw().find(call=>call.op==='fill'&&call.color==='rgba(92,128,70,.10)')?.path,painted.selected);
 assert.deepEqual(plain(env.engine.getCamera()),cameraBefore);assert.equal(JSON.stringify([territory,boundary]),sourceBefore);
 env.engine.setRegion([]);env.flush();assert.equal(coveragePaint(env).selected,undefined);assert.equal(env.lastDraw().some(call=>call.op==='stroke'&&call.color==='#e7eacc'),false);
 env.engine.destroy();const count=env.calls.length;notifyCoverage(env,{revision:1});env.flush();assert.equal(env.calls.length,count);
});

function underlayPaint(env){
 const draw=env.lastDraw();return{draw,paper:draw.filter(call=>call.surface==='tropnik-map-canvas'&&call.op==='fillRect'),area:draw.filter(call=>call.surface==='tropnik-map-canvas'&&call.op==='fill'&&call.color==='#dce5cf'),overview:draw.filter(call=>call.surface==='tropnik-map-canvas'&&call.op==='drawImage'&&call.alpha===.95)};
}

test('fully covered opaque detail skips only the occluded underlays and preserves mask, route, selected border and labels',async t=>{
 const env=fixture();t.after(()=>env.engine.destroy());
 env.coverage.territories={type:'FeatureCollection',features:[{...plain(area),properties:{shapeName:'alpha'}}]};
 env.coverage.boundaries={type:'FeatureCollection',features:[{type:'Feature',properties:{shapeName:'alpha'},geometry:{type:'LineString',coordinates:[[40,42],[42,45]]}}]};
 await env.ready();env.engine.setRegion(['alpha']);env.engine.setRoute({type:'LineString',coordinates:[[40.3,43.3],[40.7,43.6]]},'retained-route');
 env.engine.setLabels([{id:'kept-label',coordinate:[40.3,43.4],label:'Kept label'}]);env.flush();
 const tile=env.store.cache.get(env.engine.inspect().tiles.detail[0].key);assert.equal(tile.transparent,false);
 tile.transparent=true;env.engine.setLayers({});env.flush();const baseline=underlayPaint(env);
 assert.equal(baseline.paper.length,1);assert.equal(baseline.area.length,1);assert.ok(baseline.overview.length>0);
 tile.transparent=false;env.engine.setLayers({});env.flush();const optimized=underlayPaint(env);
 assert.equal(optimized.paper.length,0);assert.equal(optimized.area.length,0);assert.equal(optimized.overview.length,0);
 const retained=baseline.draw.filter(call=>!baseline.paper.includes(call)&&!baseline.area.includes(call)&&!baseline.overview.includes(call));
 assert.deepEqual(optimized.draw,retained,'The optimization must not change any remaining paint operation or ordering');
 assert.ok(optimized.draw.some(call=>call.op==='fill'&&call.rule==='evenodd'));
 assert.ok(optimized.draw.some(call=>call.op==='stroke'&&call.color==='#244d3c'));assert.ok(optimized.draw.some(call=>call.op==='stroke'&&call.color==='#688360'));
 assert.ok(optimized.draw.some(call=>call.op==='fillText'&&call.text==='Kept label'));
 assert.equal(env.host.dataset.mapDrawnRoute,'retained-route');assert.deepEqual([env.engine.canvas.width,env.engine.canvas.height],[800,600]);
 assert.ok(env.engine.inspect().tiles.detail.every(item=>item.width===512&&item.height===512));
});

test('incomplete, transparent or incompatible detail always retains the old country and overview underlays',async t=>{
 const cases=[
  ['transparent',env=>{env.store.cache.get(env.engine.inspect().tiles.detail[0].key).transparent=true;}],
  ['closed-size',env=>{env.store.cache.get(env.engine.inspect().tiles.detail[0].key).bitmap.width=0;}],
  ['wrong-height',env=>{env.store.cache.get(env.engine.inspect().tiles.detail[0].key).bitmap.height=511;}],
  ['mixed-grid',env=>{env.store.cache.get(env.engine.inspect().tiles.detail[0].key).z--;}],
  ['rotated',env=>env.engine.setCamera({...env.engine.getCamera(),bearingDegrees:12},false)],
  ['pitched',env=>env.engine.setPitch(40)],
  ['high-zoom',env=>env.engine.setCamera({...env.engine.getCamera(),zoom:13},false)],
  ['below-detail',env=>env.engine.setCamera({...env.engine.getCamera(),zoom:4.6},false)],
  ['overview',env=>env.engine.setMode('overview')],
  ['satellite-staging',env=>env.engine.setMode('satellite')],
 ];
 for(const [name,change]of cases){
  const env=fixture();t.after(()=>env.engine.destroy());await env.ready();change(env);env.engine.setLayers({});env.flush();
  const actual=underlayPaint(env);assert.equal(actual.paper.length,1,name);assert.equal(actual.area.length,1,name);assert.ok(actual.overview.length>0,name);
 }
 const env=fixture();t.after(()=>env.engine.destroy());await turn();const missing=env.pending('vector')[0];assert.ok(missing);
 env.store.reject(missing);env.complete();await env.settle();const incomplete=underlayPaint(env);
 assert.equal(incomplete.paper.length,1);assert.equal(incomplete.area.length,1,'A rejected central tile cannot prove opaque coverage');assert.ok(incomplete.overview.length>0);
});

test('opaque coverage is re-evaluated against the live camera and backing extent before new tiles arrive',async t=>{
 const env=fixture();t.after(()=>env.engine.destroy());await env.ready();
 assert.equal(underlayPaint(env).paper.length,0);assert.equal(underlayPaint(env).area.length,0);
 env.engine.setCamera({...env.engine.getCamera(),center:[45.5,43.5]},false);env.flush();
 assert.ok(env.pending('vector').length>0);assert.equal(underlayPaint(env).paper.length,1);assert.equal(underlayPaint(env).area.length,1,'A retained batch must not hide newly exposed ground');assert.ok(underlayPaint(env).overview.length>0);
 env.complete();await env.settle();assert.equal(underlayPaint(env).paper.length,0);assert.equal(underlayPaint(env).area.length,0,'A complete new batch may occlude the underlays again');
 env.host.clientWidth=1600;env.observers[0].callback();env.flush();assert.equal(env.engine.canvas.width,1600);
 assert.ok(env.pending('vector').length>0);assert.equal(underlayPaint(env).paper.length,1);assert.equal(underlayPaint(env).area.length,1,'The old batch cannot cover a larger actual canvas');
 env.complete();await env.settle();assert.equal(underlayPaint(env).paper.length,0);assert.equal(underlayPaint(env).area.length,0);
 assert.ok(env.engine.inspect().tiles.detail.every(tile=>tile.width===512&&tile.height===512));assert.equal(env.engine.getCamera().zoom,camera.zoom);
});

const restoredGround=env=>env.lastDraw().filter(call=>call.surface==='tropnik-map-canvas'&&call.op==='drawImage'&&String(call.key).startsWith('retained-ground:'));
const groundCopies=env=>env.calls.filter(call=>String(call.surface).startsWith('retained-ground:')&&call.op==='drawImage').length;
function warmGround(env){for(let i=0;i<3;i++){env.engine.setLayers({});env.flush();}assert.equal(restoredGround(env).length,1,'A stationary map must actually restore its retained ground');}

test('stationary overlay and selected-route changes reuse ground while their lines and final mask stay current',async t=>{
 const env=fixture({groundCache:true});t.after(()=>env.engine.destroy());await env.ready();warmGround(env);
 const entry=(id,y)=>({key:id,ids:[id],parts:[{bounds:[40.2,y,40.8,y],lines:[[[40.2,y],[40.8,y]]]}]});
 env.engine.setTrailOverlay([entry('first',43.4)]);env.flush();warmGround(env);
 const surface=restoredGround(env)[0].bitmap,copies=groundCopies(env),mask=env.lastDraw().find(call=>call.op==='fill'&&call.rule==='evenodd')?.path;
 assert.ok(mask);
 for(const [name,change,hasOverlay,hasRoute]of [
  ['different filter',()=>env.engine.setTrailOverlay([entry('second',43.55)]),true,false],
  ['empty results',()=>env.engine.setTrailOverlay([]),false,false],
  ['selected route',()=>env.engine.setRoute({type:'LineString',coordinates:[[40.2,43.35],[40.8,43.6]]},'selected'),false,true],
  ['clear selected route',()=>env.engine.setRoute(undefined),false,false],
 ]){
  change();env.flush();const draw=env.lastDraw(),restored=restoredGround(env);assert.equal(restored.length,1,name);assert.equal(restored[0].bitmap,surface,name);
  assert.equal(groundCopies(env),copies,'Overlay-only changes must not recapture the base');
  assert.equal(draw.some(call=>call.op==='drawImage'&&call.bitmap!==surface),false,'A hit does not replay the unchanged tile batches');
  assert.equal(draw.some(call=>call.op==='stroke'&&call.color==='#618253'),hasOverlay,name);
  assert.equal(draw.some(call=>call.op==='stroke'&&call.color==='#244d3c'),hasRoute,name);
  assert.ok(draw.findIndex(call=>call.op==='fill'&&call.path===mask)>draw.indexOf(restored[0]),'The current outside/hole mask remains after the restored ground');
  assert.equal(env.context.globalCompositeOperation,'source-over','Copying opaque ground must not leak copy composition into routes or masks');
 }
 assert.equal(env.grounds.filter(surface=>surface.width&&surface.height).length,1,'Only one bounded ground canvas is retained');
});

test('retained ground rejects changed camera, source batches, coverage, styles and backing dimensions',async t=>{
 const cases=[
  ['pan',env=>env.engine.setCamera({...env.engine.getCamera(),center:[40.55,43.5]},false)],
  ['zoom',env=>env.engine.setCamera({...env.engine.getCamera(),zoom:8.1},false)],
  ['bearing',env=>env.engine.setCamera({...env.engine.getCamera(),bearingDegrees:17},false),false],
  ['pitch',env=>env.engine.setPitch(25),false],
  ['resize',env=>{env.host.clientWidth=850;env.observers[0].callback();}],
  ['new detail batch',env=>{env.engine.detail={...env.engine.detail,tiles:[...env.engine.detail.tiles]};env.engine.setLayers({});}],
  ['new relief batch',env=>{env.engine.relief={...env.engine.relief,tiles:[...env.engine.relief.tiles]};env.engine.setLayers({});}],
  ['coverage',env=>{env.coverage.area=plain(area);env.coverage.area.geometry.coordinates[0][0][0]+=.01;notifyCoverage(env,{revision:1});}],
  ['selected boundary',env=>env.engine.setRegion(['alpha'])],
  ['boundaries hidden',env=>env.engine.setLayers({boundaries:false})],
  ['relief hidden',env=>env.engine.setLayers({relief:false})],
  ['mode',env=>env.engine.setMode('overview')],
  ['line cap history',env=>{env.context.lineCap='square';env.engine.setLayers({});}],
  ['line join history',env=>{env.context.lineJoin='bevel';env.engine.setLayers({});}],
  ['miter history',env=>{env.context.miterLimit=4;env.engine.setLayers({});}],
 ];
 for(const [name,change,captures=true]of cases){
  const env=fixture({groundCache:true});t.after(()=>env.engine.destroy());
  env.coverage.territories={type:'FeatureCollection',features:[{...plain(area),properties:{shapeName:'alpha'}}]};
  env.coverage.boundaries={type:'FeatureCollection',features:[{type:'Feature',properties:{shapeName:'alpha'},geometry:{type:'LineString',coordinates:[[40,42],[42,45]]}}]};
  await env.ready();warmGround(env);const copies=groundCopies(env);change(env);env.flush();
  assert.equal(restoredGround(env).length,0,name+': stale ground must not be reused');
  assert.equal(groundCopies(env),copies+Number(captures),name+': eligible stationary paint captures once; transformed views retain the original painter');
  assert.ok(env.lastDraw().some(call=>call.op==='drawImage'&&!String(call.key).startsWith('retained-ground:')),name+': real source tiles remain visible');
 }
});

test('ground capture pauses during gestures and animation, respects its memory budget and releases on destruction',async t=>{
 const env=fixture({groundCache:true});t.after(()=>env.engine.destroy());await env.ready();warmGround(env);const canvas=env.engine.canvas;
 let copies=groundCopies(env);env.engine.setCamera({...env.engine.getCamera(),bearingDegrees:17},false);env.engine.setPitch(25);env.flush();
 assert.equal(groundCopies(env),copies,'A rotated and pitched frame must not force an intermediate native raster flush');assert.equal(restoredGround(env).length,0);
 assert.ok(env.lastDraw().some(call=>call.op==='drawImage'),'Transformed views retain their real direct ground painter');
 env.engine.setCamera({...env.engine.getCamera(),bearingDegrees:0},false);env.engine.setPitch(0);env.flush();warmGround(env);
 copies=groundCopies(env);canvas.dispatch('pointerdown',{pointerId:7,clientX:300,clientY:250});canvas.dispatch('pointermove',{pointerId:7,clientX:330,clientY:250});env.flush();
 assert.equal(groundCopies(env),copies,'Moving pointer frames must not copy a full backing store');assert.equal(restoredGround(env).length,0);
 canvas.dispatch('pointerup',{pointerId:7,clientX:330,clientY:250});env.flush();assert.ok(groundCopies(env)>copies,'The settled gesture may retain its final ground');
 copies=groundCopies(env);env.engine.setCamera({...env.engine.getCamera(),center:[40.7,43.5]},true);env.tick(16);env.tick(16);
 assert.equal(groundCopies(env),copies,'Animated camera frames must not recapture');env.flush();assert.ok(groundCopies(env)>copies);
 const owned=[...env.grounds];env.host.clientWidth=5000;env.host.clientHeight=2000;env.observers[0].callback();env.flush();
 assert.ok(owned.every(surface=>surface.width===0&&surface.height===0),'An over-budget backing frame releases the earlier allocation');
 assert.equal(restoredGround(env).length,0);assert.ok(env.lastDraw().some(call=>call.op==='drawImage'),'The original direct renderer remains available above the cache budget');
 env.host.clientWidth=800;env.host.clientHeight=600;env.observers[0].callback();env.complete();await env.settle();warmGround(env);
 env.engine.destroy();assert.ok(env.grounds.every(surface=>surface.width===0&&surface.height===0),'Destroy releases every retained backing surface');
});

test('catalogue overlay preserves every source part, culls distant geometry and retains the selected exact line in both modes',async t=>{
 const env=fixture();t.after(()=>env.engine.destroy());await env.ready();
 const part=(coordinates)=>({bounds:[Math.min(...coordinates.map(p=>p[0])),Math.min(...coordinates.map(p=>p[1])),Math.max(...coordinates.map(p=>p[0])),Math.max(...coordinates.map(p=>p[1]))],lines:[coordinates,coordinates]});
 const first={key:'a',ids:['a','a-alias'],parts:[part([[39,43.5],[42,43.5]]),part([[40.4,43.55],[40.6,43.55]])]},second={key:'b',ids:['b'],parts:[part([[40.3,43.3],[40.7,43.6]])]},far={key:'far',ids:['far'],parts:[part([[110,60],[111,61]])]};
 env.engine.setTrailOverlay([first,second,far]);env.flush();
 const overlay=()=>env.lastDraw().find(call=>call.op==='stroke'&&['#618253','#f2d49b'].includes(call.color));
 const before=overlay();assert.ok(before);assert.equal(before.path.commands.filter(command=>command[0]==='addPath').length,3);
 assert.equal(pathCommands(before.path).filter(command=>command[0]==='moveTo').length,3,'Disconnected source parts each start with moveTo');
 assert.equal(env.engine.inspect().catalogueOverlay.preparedSources,2);assert.equal(env.engine.inspect().catalogueOverlay.preparedParts,3);
 const compiledPaths=env.paths.filter(path=>path.commands.some(command=>command[0]==='lineTo')).length;
 env.engine.setLayers({});env.flush();assert.equal(overlay().path,before.path,'An unchanged view reuses its aggregated path');
 env.engine.setMode('satellite');env.complete();await env.settle();assert.equal(overlay().color,'#f2d49b');assert.equal(overlay().path,before.path);
 env.engine.setRoute({type:'LineString',coordinates:[[40.3,43.3],[40.45,43.49],[40.7,43.6]]},'a-alias');env.flush();
 assert.equal(env.engine.inspect().catalogueOverlay.preparedSources,1,'All aliases of selected source are removed from the background layer');
 const draw=env.lastDraw(),selected=draw.findIndex(call=>call.op==='stroke'&&call.color==='#244d3c'),background=draw.findIndex(call=>call===overlay());assert.ok(selected>background);
 env.engine.setLayers({paths:false});env.complete();await env.settle();assert.equal(overlay(),undefined);assert.equal(env.engine.inspect().drawnRoute,'a-alias');
 env.engine.setLayers({paths:true});env.complete();await env.settle();assert.ok(overlay());
 assert.equal(env.paths.filter(path=>path.commands.some(command=>command[0]==='lineTo')).length,compiledPaths+1,'Only the newly selected raw geometry compiles; mode/filter updates reuse catalogue parts');
 env.engine.setTrailOverlay([]);env.flush();assert.equal(overlay(),undefined);assert.equal(env.engine.inspect().drawnRoute,'a-alias');
});

test('close catalogue geometry replaces the overview without joining parts and pan/zoom keeps bounded batches',async t=>{
 const env=fixture({view:{...camera,zoom:13}});t.after(()=>env.engine.destroy());await env.ready();
 const coarse=[[40.49,43.5],[40.51,43.5]],detail=[[40.49,43.5],[40.5,43.501],[40.51,43.5]],bounds=[40.49,43.5,40.51,43.501];
 const entry={key:'a',ids:['a'],parts:[{bounds,lines:[coarse,coarse]}]};env.engine.setTrailOverlay([entry]);env.flush();
 const stroke=()=>env.lastDraw().find(call=>call.op==='stroke'&&call.color==='#618253');assert.equal(pathCommands(stroke().path).filter(command=>command[0]==='lineTo').length,1);
 env.engine.setTrailOverlay([{...entry,detail:[{bounds,lines:[detail]}]}]);env.flush();assert.equal(pathCommands(stroke().path).filter(command=>command[0]==='lineTo').length,2);assert.equal(env.engine.inspect().catalogueOverlay.exactSources,1);
 env.engine.setCamera({...camera,center:[50,55],zoom:13});env.flush();assert.equal(stroke(),undefined);assert.equal(env.engine.inspect().catalogueOverlay.preparedParts,0);
});

function denseTrailEntry(){
 const parts=Array.from({length:300},(_,index)=>{const y=43.4+index*.0005,coordinates=[[40.2,y],[40.8,y]];return{bounds:[40.2,y,40.8,y],lines:[coordinates,coordinates]};});
 return{key:'dense',ids:['dense'],parts};
}

test('dense catalogue lines become selectable only with their committed raster and disappear immediately with filters or paths',async t=>{
 const env=fixture();t.after(()=>env.engine.destroy());await env.ready();
 const entry=denseTrailEntry(),coordinate=[40.5,43.4];env.engine.setTrailOverlay([entry]);env.flush();
 assert.equal(env.rasters.length,1,'Dense source geometry must use the asynchronous raster surface');
 const raster=env.rasters[0];assert.equal(raster.pending.partIds.length,300);
 assert.ok(raster.pending.addParts.every(part=>part.points.length===4),'Source parts remain disconnected in the worker payload');
 assert.equal(env.engine.pickTrail(env.engine.project(coordinate)),undefined,'Pending invisible background lines cannot be selected');
 assert.equal(env.lastDraw().some(call=>call.op==='stroke'&&call.color==='#618253'),false,'Dense paths must not synchronously replay on the UI canvas');
 const completed=raster.resolve();await env.settle();
 const draw=env.lastDraw(),index=draw.findIndex(call=>call.op==='drawImage'&&call.bitmap===completed.bitmap);assert.ok(index>=0);
 assert.deepEqual(draw[index].args,[0,0],'A physical worker bitmap is composited exactly once without a second world transform');
 const priorTransform=draw.slice(0,index).findLast(call=>call.op==='setTransform');assert.deepEqual(priorTransform.args,[1,0,0,1,0,0]);
 const mask=coveragePaint(env).mask;assert.ok(draw.findIndex(call=>call.op==='fill'&&call.path===mask)>index,'Ordinary worker trails retain the existing country mask');
 assert.equal(env.engine.pickTrail(env.engine.project(coordinate)),'dense');
 env.engine.setTrailOverlay([]);env.flush();
 assert.equal(env.engine.pickTrail(env.engine.project(coordinate)),undefined);
 assert.equal(env.lastDraw().some(call=>call.op==='drawImage'&&String(call.key).startsWith('trail-raster:')),false);
 env.engine.setTrailOverlay([entry]);env.flush();env.engine.setCamera({...env.engine.getCamera(),center:[40.55,43.5]},false);env.flush();assert.ok(raster.pending);
 env.engine.setLayers({paths:false});env.complete();await env.settle();
 assert.equal(env.engine.inspect().catalogueOverlay.pending,false,'Switching paths off invalidates pending catalogue publication');assert.equal(env.engine.pickTrail(env.engine.project(coordinate)),undefined);
 const hidden=raster.resolve();await env.settle();assert.equal(hidden.bitmap.closed,true,'A late hidden-layer reply must be disposed instead of published');
 env.engine.setRoute({type:'LineString',coordinates:[[40.2,43.4],[40.8,43.4]]},'selected');env.flush();
 assert.equal(env.engine.pickTrail(env.engine.project(coordinate)),'selected','The exact selected route remains independent of background paths');
});

test('dense trail bitmaps are reused only for the same camera and palette and are disposed with the engine',async()=>{
 const env=fixture();await env.ready();const entry=denseTrailEntry();env.engine.setTrailOverlay([entry]);env.flush();const raster=env.rasters[0];
 const first=raster.resolve();await env.settle();const requests=raster.requests.length;
 env.engine.setLayers({});env.flush();assert.equal(raster.requests.length,requests,'An unchanged paint reuses its exact worker frame');
 assert.ok(env.lastDraw().some(call=>call.op==='drawImage'&&call.bitmap===first.bitmap));
 env.engine.setCamera({...env.engine.getCamera(),center:[40.55,43.5]},false);env.flush();
 assert.ok(raster.pending);assert.notDeepEqual(raster.pending.transform,raster.requests[0].transform);
 assert.deepEqual(raster.pending.partIds,raster.requests[0].partIds);assert.equal(raster.pending.addParts.length,0,'A camera change reuses registered immutable source coordinates');
 assert.equal(env.lastDraw().some(call=>call.op==='drawImage'&&call.bitmap===first.bitmap),false,'A previous camera bitmap cannot be painted at the new camera');
 const moved=raster.resolve();await env.settle();assert.ok(env.lastDraw().some(call=>call.op==='drawImage'&&call.bitmap===moved.bitmap));
 env.engine.setMode('satellite');env.complete();await env.settle();assert.ok(raster.pending);assert.equal(raster.pending.lineColor,'#f2d49b');
 assert.equal(env.lastDraw().some(call=>call.op==='drawImage'&&call.bitmap===moved.bitmap),false,'A relief bitmap cannot pass for the satellite palette');
 const satellite=raster.resolve();await env.settle();env.engine.destroy();assert.equal(raster.destroyed,true);assert.equal(satellite.bitmap.closed,true);assert.equal(first.bitmap.closed,true);assert.equal(moved.bitmap.closed,true);
});

test('only the verified coastal snapshot crosses the unchanged mask; ordinary and shifted tracks remain masked',async t=>{
 const env=fixture({view:{center:[150.94,59.56],zoom:11,bearingDegrees:0}});t.after(()=>env.engine.destroy());await env.ready();
 const source=JSON.parse(readFileSync(resolve(root,'public/data/routes/kolyma-black-creek.geojson'),'utf8')),url='/data/routes/kolyma-black-creek.geojson';
 const allowance=await env.verifyReviewedCoastalRoute(url,source);assert.ok(allowance);
 const before=coveragePaint(env),mask=before.mask,maskIndex=draw=>draw.findIndex(call=>call.op==='fill'&&call.path===mask);
 env.engine.setRoute(source,'coastal',allowance);env.flush();
 let draw=env.lastDraw();assert.ok(draw.findIndex(call=>call.op==='stroke'&&call.color==='#244d3c')>maskIndex(draw));assert.equal(env.engine.inspect().reviewedCoastal.selected,true);
 assert.equal(coveragePaint(env).mask,mask);assert.equal(coveragePaint(env).area,before.area,'Review does not modify land/country coverage');
 const shifted=plain(source);shifted.features[0].geometry.coordinates[0][100][0]+=.001;
 assert.equal(await env.verifyReviewedCoastalRoute(url,shifted),undefined);
 env.engine.setRoute(shifted,'shifted',allowance);env.flush();draw=env.lastDraw();
 assert.equal(env.engine.inspect().reviewedCoastal.selected,false);assert.ok(draw.findIndex(call=>call.op==='stroke'&&call.color==='#244d3c')<maskIndex(draw));
 env.engine.setRoute(undefined);env.engine.setTrailOverlay([{key:'routes/kolyma-black-creek.geojson',ids:['coastal'],parts:[],coastal:allowance}]);env.flush();draw=env.lastDraw();
 assert.equal(env.engine.inspect().reviewedCoastal.overlaySources,1);assert.ok(draw.findIndex(call=>call.op==='stroke'&&call.color==='#618253')>maskIndex(draw));assert.equal(coveragePaint(env).mask,mask);
 env.engine.setMode('satellite');env.complete();await env.settle();draw=env.lastDraw();assert.ok(draw.findIndex(call=>call.op==='stroke'&&call.color==='#f2d49b')>maskIndex(draw));
 env.engine.setLayers({paths:false});env.complete();await env.settle();assert.equal(env.engine.inspect().reviewedCoastal.overlaySources,0);assert.equal(env.lastDraw().some(call=>call.op==='stroke'&&call.color==='#f2d49b'),false);
});
