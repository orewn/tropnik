import test from 'node:test';
import assert from 'node:assert/strict';
import {installTerrainGPUDraws,observeTerrainGPUDraws} from '../browser-gpu-draws.mjs';

// A public WebGL2 facade, not a renderer: calls are synchronous and no browser,
// server, SDK object, animation frame or actual GPU is created by these tests.
function fixture({extension=true,counterBits=64}={}){
 const calls=[],queries=[],failures=new Map(),returns=new Map();let tick=0;
 const state={activeQuery:null,available:false,disjoint:false,onDraw:null,contextError:null};
 const ext={TIME_ELAPSED_EXT:0x88BF,GPU_DISJOINT_EXT:0x8FBB,QUERY_COUNTER_BITS_EXT:0x8864};
 const gl={drawingBufferWidth:1024,drawingBufferHeight:768,
  CURRENT_QUERY:0x8865,QUERY_RESULT:0x8866,QUERY_RESULT_AVAILABLE:0x8867,
  FRAMEBUFFER:0x8D40,DRAW_FRAMEBUFFER:0x8CA9,READ_FRAMEBUFFER:0x8CA8,COLOR_ATTACHMENT0:0x8CE0,
  TEXTURE0:0x84C0,TEXTURE_2D:0x0DE1,TEXTURE_CUBE_MAP:0x8513,TEXTURE_3D:0x806F,TEXTURE_2D_ARRAY:0x8C1A,
  TEXTURE_MIN_FILTER:0x2801,TEXTURE_MAG_FILTER:0x2800,NEAREST_MIPMAP_LINEAR:0x2702,LINEAR:0x2601,LINEAR_MIPMAP_LINEAR:0x2703,
  RGBA8:0x8058,RGBA:0x1908,UNSIGNED_BYTE:0x1401,UNSIGNED_SHORT:0x1403,TRIANGLES:0x0004,
  SHADER_TYPE:0x8B4F,VERTEX_SHADER:0x8B31,FRAGMENT_SHADER:0x8B30,ACTIVE_UNIFORMS:0x8B86,
  SAMPLER_2D:0x8B5E,SAMPLER_CUBE:0x8B60,SAMPLER_3D:0x8B5F,SAMPLER_2D_ARRAY:0x8DC1,
  INT_SAMPLER_2D:0x8DCA,UNSIGNED_INT_SAMPLER_2D:0x8DD2,
 };
 const method=(name,implementation=()=>undefined)=>{
  gl[name]=function(...args){
   calls.push({method:name,thisValue:this,args});
   if(failures.has(name))throw failures.get(name);
   const value=implementation(...args);
   return returns.has(name)?returns.get(name):value;
  };
 };
 method('getExtension',name=>name==='EXT_disjoint_timer_query_webgl2'&&extension?ext:null);
 method('getQuery',(target,pname)=>{
  assert.equal(target,ext.TIME_ELAPSED_EXT);
  if(pname===ext.QUERY_COUNTER_BITS_EXT)return counterBits;
  assert.equal(pname,gl.CURRENT_QUERY);return state.activeQuery;
 });
 method('getParameter',pname=>{assert.equal(pname,ext.GPU_DISJOINT_EXT,'Draw metadata must not issue synchronous GL state queries');return state.disjoint;});
 method('createQuery',()=>{const query={id:queries.length+1,nanoseconds:250000,available:null,deleted:false};queries.push(query);return query;});
 method('beginQuery',(target,query)=>{assert.equal(target,ext.TIME_ELAPSED_EXT);assert.equal(state.activeQuery,null,'Timer queries must never nest');state.activeQuery=query;});
 method('endQuery',target=>{assert.equal(target,ext.TIME_ELAPSED_EXT);assert.ok(queries.includes(state.activeQuery),'Never end a foreign query');state.activeQuery=null;});
 method('getQueryParameter',(query,pname)=>{
  assert.ok(queries.includes(query));assert.equal(query.deleted,false);
  if(pname===gl.QUERY_RESULT_AVAILABLE)return query.available??state.available;
  assert.equal(pname,gl.QUERY_RESULT);assert.equal(query.available??state.available,true,'Read a result only after availability');
  assert.equal(state.disjoint,false,'A disjoint result is not a GPU duration');return query.nanoseconds;
 });
 method('deleteQuery',query=>{assert.ok(queries.includes(query),'Never delete a foreign query');assert.equal(query.deleted,false,'Delete each owned query at most once');query.deleted=true;});
 method('getAttachedShaders',program=>program.shaders);
 method('getShaderSource',shader=>shader.source);
 method('getShaderParameter',(shader,pname)=>{assert.equal(pname,gl.SHADER_TYPE);return shader.type;});
 method('getProgramParameter',(program,pname)=>{assert.equal(pname,gl.ACTIVE_UNIFORMS);return program.uniforms.length;});
 method('getActiveUniform',(program,index)=>program.uniforms[index]);
 method('getUniformLocation',(program,name)=>({program,name}));
 for(const name of ['useProgram','bindFramebuffer','framebufferTexture2D','viewport','activeTexture','bindTexture','texStorage2D','texImage2D','texParameterf','texParameteri','uniform1i','uniform1iv','linkProgram'])method(name);
 for(const name of ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced','drawRangeElements','generateMipmap'])method(name,(...args)=>state.onDraw?.(name,args));
 const originals=Object.fromEntries(Object.entries(gl).filter(([,value])=>typeof value==='function'));
 class Canvas{
  constructor(context=gl,{maplibre=true}={}){this.context=context;this.maplibre=maplibre;this.className=maplibre?'maplibregl-canvas':'other-canvas';context.canvas=this;}
  matches(selector){assert.equal(selector,'canvas.maplibregl-canvas');return this.maplibre;}
  getContext(...args){calls.push({method:'getContext',thisValue:this,args});if(state.contextError)throw state.contextError;return this.context;}
 }
 const root={HTMLCanvasElement:Canvas,performance:{now:()=>++tick}},originalGetContext=Canvas.prototype.getContext,canvas=new Canvas();
 const count=name=>calls.filter(call=>call.method===name).length;
 const program=(label='terrainRaster',uniforms=[{name:'u_image',size:1,type:gl.SAMPLER_2D}])=>({uniforms,shaders:[
  {type:gl.VERTEX_SHADER,source:`#define SHADER_NAME ${label}\nvoid main() { gl_Position=vec4(0.); }`},
  {type:gl.FRAGMENT_SHADER,source:`#define SHADER_NAME ${label}\nuniform sampler2D u_image;\nvoid main() {}`},
 ]});
 const attach=(options={})=>{const controller=installTerrainGPUDraws(root,options);assert.equal(canvas.getContext('webgl2'),gl);return controller;};
 return{root,gl,canvas,Canvas,ext,state,calls,queries,failures,returns,originals,originalGetContext,count,program,attach};
}

test('the serialized installer observes only a matching WebGL2 canvas and preserves getContext behavior',()=>{
 const f=fixture(),install=(0,eval)(`(${installTerrainGPUDraws.toString()})`),controller=install(f.root);
 assert.equal(f.root.__tropnikTerrainGPUDraws,controller);assert.equal(install(f.root),controller);
 const otherGL={...f.gl},other=new f.Canvas(otherGL,{maplibre:false}),attributes={antialias:true};
 assert.equal(other.getContext('webgl2',attributes),otherGL);assert.equal(otherGL.drawElements,f.originals.drawElements);
 assert.equal(f.canvas.getContext('webgl',attributes),f.gl);assert.equal(f.gl.drawElements,f.originals.drawElements);
 assert.equal(f.canvas.getContext('webgl2',attributes),f.gl);assert.notEqual(f.gl.drawElements,f.originals.drawElements);
 const contextCalls=f.calls.filter(call=>call.method==='getContext');assert.equal(contextCalls.length,3);
 assert.equal(contextCalls[2].thisValue,f.canvas);assert.deepEqual(contextCalls[2].args,['webgl2',attributes]);
 const failure=new Error('Native getContext failed');f.state.contextError=failure;
 assert.throws(()=>f.canvas.getContext('webgl2',attributes),error=>error===failure);assert.equal(f.count('getContext'),4);
 const receipt=controller.stop();assert.equal(receipt.contexts.length,1);assert.equal(f.Canvas.prototype.getContext,f.originalGetContext);
 assert.equal(f.gl.drawElements,f.originals.drawElements);assert.equal(otherGL.drawElements,f.originals.drawElements);
});

test('wrapping preserves draw this, arguments, return and original failure with exactly one native call',()=>{
 const f=fixture(),controller=f.attach(),value={native:'draw-return'},args=[f.gl.TRIANGLES,9,f.gl.UNSIGNED_SHORT,12];
 f.returns.set('drawElements',value);f.gl.useProgram(f.program());controller.start({zoom:14.905});
 assert.equal(f.gl.drawElements(...args),value);
 const native=f.calls.find(call=>call.method==='drawElements');assert.equal(native.thisValue,f.gl);assert.deepEqual(native.args,args);assert.equal(f.count('drawElements'),1);
 const alien={};assert.equal(f.gl.drawElements.call(alien,...args),value);assert.equal(f.calls.filter(call=>call.method==='drawElements').at(-1).thisValue,alien);
 const failure=new Error('Native draw failed');f.failures.set('drawElements',failure);
 assert.throws(()=>f.gl.drawElements(...args),error=>error===failure);assert.equal(f.count('drawElements'),3);
 assert.equal(f.count('beginQuery'),2);assert.equal(f.count('endQuery'),2);assert.equal(f.state.activeQuery,null);
 const receipt=controller.stop('action-error');assert.equal(receipt.totals.drawCalls,2);assert.equal(receipt.events[1].originalError,failure.message);
 f.state.available=true;assert.equal(controller.collect({final:true}).queries.completed,2);
});

test('metadata follows public bindings before arming and requires no per-draw state queries',()=>{
 const f=fixture(),controller=f.attach(),gl=f.gl,program=f.program(),texture={},framebuffer={};
 gl.useProgram(program);gl.activeTexture(gl.TEXTURE0+3);gl.bindTexture(gl.TEXTURE_2D,texture);
 gl.texStorage2D(gl.TEXTURE_2D,9,gl.RGBA8,256,512);gl.texParameterf(gl.TEXTURE_2D,0x84FE,8);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
 const location=gl.getUniformLocation(program,'u_image');gl.uniform1i(location,3);
 gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);gl.viewport(7,9,256,512);
 assert.equal(f.count('getAttachedShaders'),0,'Shader metadata is lazy until the single measured action');
 gl.drawElements(gl.TRIANGLES,6,gl.UNSIGNED_SHORT,0);assert.equal(f.count('beginQuery'),0);
 controller.start();const synchronousReads=f.count('getParameter');
 gl.bindFramebuffer(gl.READ_FRAMEBUFFER,{});gl.drawElements(gl.TRIANGLES,6,gl.UNSIGNED_SHORT,0);gl.drawElements(gl.TRIANGLES,6,gl.UNSIGNED_SHORT,0);
 assert.equal(f.count('getParameter'),synchronousReads);assert.equal(f.count('getAttachedShaders'),1,'Program reflection is cached');
 gl.texParameterf(gl.TEXTURE_2D,0x84FE,2);gl.generateMipmap(gl.TEXTURE_2D);
 const receipt=controller.stop(),event=receipt.events[0];assert.equal(receipt.totals.drawCalls,2);assert.equal(receipt.totals.mipmapCalls,1);
 assert.equal(event.programLabel,'terrainRaster');assert.deepEqual(event.viewport,[7,9,256,512]);assert.equal(event.framebuffer.kind,'offscreen');assert.equal(event.framebuffer.attachments[0].texture.width,256);
 assert.equal(event.textures[0].uniform,'u_image');assert.equal(event.textures[0].unit,3);
 assert.deepEqual(Object.fromEntries(['width','height','levels','internalFormat','anisotropy','minFilter','allocation'].map(key=>[key,event.textures[0].texture[key]])),{width:256,height:512,levels:9,internalFormat:gl.RGBA8,anisotropy:8,minFilter:gl.LINEAR_MIPMAP_LINEAR,allocation:'texStorage2D'});
 assert.equal(receipt.events[2].textures[0].texture.anisotropy,2,'Earlier event metadata must not mutate with later state');
 assert.equal(receipt.events[2].method,'generateMipmap');assert.equal(receipt.events[2].submittedVerticesOrIndices,0);
 assert.equal(receipt.programs[0].shaders.length,2);assert.match(receipt.programs[0].shaders[0].hash,/^[a-f0-9]{8}$/);
});

test('all supported draw entry points retain their exact counts, instances and index types',()=>{
 const f=fixture(),controller=f.attach(),gl=f.gl;gl.useProgram(f.program());controller.start();
 const cases=[['drawElements',[gl.TRIANGLES,9,gl.UNSIGNED_SHORT,0],9,1],['drawArrays',[gl.TRIANGLES,2,7],7,1],['drawElementsInstanced',[gl.TRIANGLES,5,gl.UNSIGNED_SHORT,0,3],5,3],['drawArraysInstanced',[gl.TRIANGLES,0,4,2],4,2],['drawRangeElements',[gl.TRIANGLES,0,12,6,gl.UNSIGNED_SHORT,0],6,1]];
 for(const [method,args] of cases){const returned={method};f.returns.set(method,returned);assert.equal(gl[method](...args),returned);assert.equal(f.count(method),1);assert.deepEqual(f.calls.find(call=>call.method===method).args,args);}
 const receipt=controller.stop();assert.equal(receipt.totals.drawCalls,5);assert.equal(receipt.totals.submittedVerticesOrIndices,45);
 for(let i=0;i<cases.length;i++){const [method,,count,instances]=cases[i],event=receipt.events[i];assert.equal(event.method,method);assert.equal(event.count,count);assert.equal(event.instances,instances);assert.equal(event.indexType,method.includes('Arrays')?null:gl.UNSIGNED_SHORT);}
});

test('active sampler arrays follow uniform offsets and image allocations without claiming unused declarations',()=>{
 const f=fixture(),controller=f.attach(),gl=f.gl,program=f.program('textureArray',[{name:'u_images[0]',type:gl.SAMPLER_2D,size:2}]);
 program.shaders[1].source='#define SHADER_NAME textureArray\nuniform sampler2D u_images[2];\nuniform sampler2D u_unused;\nvoid main() {}';
 gl.useProgram(program);gl.activeTexture(gl.TEXTURE0+1);gl.bindTexture(gl.TEXTURE_2D,{});gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,{width:128,height:96});
 gl.activeTexture(gl.TEXTURE0+2);gl.bindTexture(gl.TEXTURE_2D,{});gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,512,256,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
 const location=gl.getUniformLocation(program,'u_images');gl.uniform1iv(location,new Int32Array([7,1,2,6]),1,2);
 controller.start();gl.drawArrays(gl.TRIANGLES,0,3);const receipt=controller.stop();
 assert.equal(receipt.programs[0].samplerEnumeration,'public-active-uniforms');assert.deepEqual(receipt.programs[0].samplers,[{name:'u_images[0]',type:gl.SAMPLER_2D,size:2}]);
 assert.deepEqual(receipt.events[0].textures.map(({uniform,unit,texture})=>({uniform,unit,width:texture.width,height:texture.height,allocation:texture.allocation})),[{uniform:'u_images[0]',unit:1,width:128,height:96,allocation:'texImage2D'},{uniform:'u_images[0]',unit:2,width:512,height:256,allocation:'texImage2D'}]);
 assert.equal(f.count('getActiveUniform'),1);assert.equal(receipt.events[0].textures.some(texture=>texture.uniform==='u_unused'),false);
});

test('foreign queries are neither nested nor ended, including ownership changing inside a native draw',()=>{
 const f=fixture(),controller=f.attach(),foreign={},gl=f.gl;gl.useProgram(f.program());controller.start();
 f.state.activeQuery=foreign;gl.drawArrays(gl.TRIANGLES,0,3);assert.equal(f.count('beginQuery'),0);assert.equal(f.count('endQuery'),0);assert.equal(f.state.activeQuery,foreign);
 f.state.activeQuery=null;f.state.onDraw=()=>{f.state.activeQuery=foreign;};gl.drawArrays(gl.TRIANGLES,0,3);
 assert.equal(f.count('beginQuery'),1);assert.equal(f.count('endQuery'),0);assert.equal(f.state.activeQuery,foreign);assert.equal(f.count('drawArrays'),2);assert.equal(f.count('deleteQuery'),1);
 const receipt=controller.stop();assert.deepEqual(receipt.events.map(event=>event.timerStatus),['interference','query-owner-changed']);assert.equal(receipt.queries.interference,2);assert.equal(receipt.queries.pending,0);
});

test('an active foreign timer at arming disables measurement without altering that timer or native draws',()=>{
 const f=fixture(),controller=f.attach(),foreign={};f.state.activeQuery=foreign;
 const armed=controller.start();f.gl.drawArrays(f.gl.TRIANGLES,0,3);const receipt=controller.stop();
 assert.equal(armed.contexts[0].timer.reason,'external-query-active');assert.equal(f.state.activeQuery,foreign);assert.equal(f.count('drawArrays'),1);assert.equal(f.count('beginQuery'),0);assert.equal(f.count('endQuery'),0);assert.equal(receipt.queries.completed,0);
});

test('a timer setup failure cannot suppress or repeat the native draw',()=>{
 const f=fixture(),controller=f.attach(),failure=new Error('Timer creation failed');controller.start();f.failures.set('beginQuery',failure);
 f.gl.drawArrays(f.gl.TRIANGLES,0,3);const receipt=controller.stop();assert.equal(f.count('drawArrays'),1);assert.equal(f.count('beginQuery'),1);assert.equal(f.count('endQuery'),0);assert.equal(f.count('deleteQuery'),1);
 assert.equal(receipt.queries.errors,1);assert.equal(receipt.queries.pending,0);assert.equal(receipt.events[0].timerStatus,'query-error');
});

test('query sampling is capped at 128 globally and eight per group without losing native calls',()=>{
 const f=fixture(),controller=f.attach({maxQueries:10000,maxQueriesPerGroup:10000}),gl=f.gl;controller.start();
 for(let group=0;group<17;group++){gl.useProgram(f.program(`program${group}`));for(let draw=0;draw<9;draw++)gl.drawArrays(gl.TRIANGLES,0,3);}
 const receipt=controller.stop();assert.equal(f.count('drawArrays'),153);assert.equal(f.count('createQuery'),128);assert.equal(f.count('beginQuery'),128);assert.equal(f.count('endQuery'),128);
 assert.equal(receipt.limits.maxQueries,128);assert.equal(receipt.limits.maxQueriesPerGroup,8);assert.equal(receipt.queries.attempted,128);assert.equal(receipt.queries.pending,128);
 assert.equal(receipt.queries.groupLimitSkipped,16);assert.equal(receipt.queries.limitSkipped,9);assert.ok(receipt.groups.every(group=>group.queryAttempts<=8));
 const final=controller.collect({final:true});assert.equal(final.queries.pending,0);assert.equal(final.queries.unavailable,128);assert.equal(f.count('deleteQuery'),128);assert.equal(f.calls.some(call=>call.method==='getQueryParameter'&&call.args[1]===gl.QUERY_RESULT),false);
});

test('event and group storage remain bounded while total native work stays visible',()=>{
 const f=fixture(),controller=f.attach({maxEvents:2,maxGroups:1}),gl=f.gl;controller.start();
 for(let i=0;i<5;i++){gl.useProgram(f.program(`bounded${i}`));gl.drawArrays(gl.TRIANGLES,0,3);}
 const receipt=controller.stop();assert.equal(f.count('drawArrays'),5);assert.equal(receipt.totals.drawCalls,5);assert.equal(receipt.events.length,2);assert.equal(receipt.groups.length,1);assert.equal(receipt.totals.eventsDropped,3);assert.equal(receipt.totals.groupsDropped,4);
 assert.equal(f.count('createQuery'),1);assert.equal(receipt.queries.groupLimitSkipped,4);
});

for(const options of [{extension:false},{counterBits:0}])test(`unsupported timer evidence remains explicit (${JSON.stringify(options)})`,()=>{
 const f=fixture(options),controller=f.attach();controller.start();f.gl.drawArrays(f.gl.TRIANGLES,0,3);controller.stop();const receipt=controller.collect({final:true});
 assert.equal(f.count('drawArrays'),1);assert.equal(f.count('createQuery'),0);assert.equal(f.count('beginQuery'),0);assert.equal(f.count('getQueryParameter'),0);assert.equal(receipt.contexts[0].timer.supported,false);assert.equal(receipt.queries.unsupported,1);assert.equal(receipt.events[0].gpuNanoseconds,null);
 assert.equal(receipt.contexts[0].timer.reason,options.extension===false?'extension-unavailable':'zero-counter-bits');
});

test('unavailable results are never read and final collection deletes each pending query once',()=>{
 const f=fixture(),controller=f.attach(),gl=f.gl;controller.start();gl.drawArrays(gl.TRIANGLES,0,3);controller.stop();
 for(let i=0;i<2;i++){const pending=controller.collect();assert.equal(pending.queries.pending,1);assert.equal(pending.queries.completed,0);assert.equal(f.count('deleteQuery'),0);}
 const receipt=controller.collect({final:true});assert.equal(receipt.collectionPasses,3);assert.equal(receipt.queries.pending,0);assert.equal(receipt.queries.unavailable,1);assert.equal(receipt.events[0].timerStatus,'unavailable-after-bounded-collection');assert.equal(receipt.events[0].gpuNanoseconds,null);
 assert.equal(f.calls.filter(call=>call.method==='getQueryParameter'&&call.args[1]===gl.QUERY_RESULT).length,0);assert.equal(f.count('deleteQuery'),1);controller.collect({final:true});assert.equal(f.count('deleteQuery'),1);
});

test('only available non-disjoint results contribute nanoseconds and group timing',()=>{
 const f=fixture(),controller=f.attach(),gl=f.gl;controller.start();gl.drawArrays(gl.TRIANGLES,0,3);gl.drawArrays(gl.TRIANGLES,0,3);controller.stop();
 f.queries[0].available=true;f.queries[0].nanoseconds=0;f.queries[1].available=true;f.queries[1].nanoseconds=1250000;
 const receipt=controller.collect({final:true});assert.equal(receipt.queries.completed,2);assert.equal(receipt.queries.pending,0);assert.deepEqual(receipt.events.map(event=>event.gpuNanoseconds),[0,1250000]);assert.equal(receipt.groups[0].timedCalls,2);assert.equal(receipt.groups[0].gpuNanoseconds,1250000);
 const reads=f.calls.filter(call=>call.method==='getQueryParameter');assert.deepEqual(reads.map(call=>[call.args[0].id,call.args[1]]),[[1,gl.QUERY_RESULT_AVAILABLE],[1,gl.QUERY_RESULT],[2,gl.QUERY_RESULT_AVAILABLE],[2,gl.QUERY_RESULT]]);
});

test('disjoint invalidates already collected timings and discards pending results without reading them',()=>{
 const f=fixture(),controller=f.attach(),gl=f.gl;controller.start();gl.drawArrays(gl.TRIANGLES,0,3);gl.drawArrays(gl.TRIANGLES,0,3);controller.stop();
 f.queries[0].available=true;assert.equal(controller.collect().queries.completed,1);const reads=f.calls.filter(call=>call.method==='getQueryParameter'&&call.args[1]===gl.QUERY_RESULT).length;
 f.state.disjoint=true;f.queries[1].available=true;const receipt=controller.collect({final:true});
 assert.equal(receipt.queries.completed,0);assert.equal(receipt.queries.pending,0);assert.equal(receipt.queries.disjoint,2);assert.equal(receipt.groups[0].timedCalls,0);assert.equal(receipt.groups[0].gpuNanoseconds,0);
 assert.deepEqual(receipt.events.map(event=>[event.timerStatus,event.gpuNanoseconds]),[['disjoint',null],['disjoint',null]]);assert.equal(f.calls.filter(call=>call.method==='getQueryParameter'&&call.args[1]===gl.QUERY_RESULT).length,reads);assert.equal(f.count('deleteQuery'),2);
});

for(const failedRead of ['getQuery','getParameter'])test(`failed ${failedRead} cannot certify a non-disjoint timing at collection`,()=>{
 const f=fixture(),controller=f.attach(),gl=f.gl;controller.start();gl.drawArrays(gl.TRIANGLES,0,3);controller.stop();f.state.available=true;f.failures.set(failedRead,new Error('State unavailable'));
 const receipt=controller.collect({final:true});assert.equal(receipt.queries.completed,0);assert.equal(receipt.events[0].gpuNanoseconds,null);assert.equal(receipt.queries.pending,0);assert.equal(f.calls.some(call=>call.method==='getQueryParameter'&&call.args[1]===gl.QUERY_RESULT),false);assert.equal(f.count('drawArrays'),1);
});

test('collection never reads results or ends an unrelated active timer',()=>{
 const f=fixture(),controller=f.attach(),foreign={};controller.start();f.gl.drawArrays(f.gl.TRIANGLES,0,3);controller.stop();f.state.activeQuery=foreign;f.state.available=true;
 const ended=f.count('endQuery'),receipt=controller.collect({final:true});assert.equal(f.state.activeQuery,foreign);assert.equal(f.count('endQuery'),ended);assert.equal(f.count('getQueryParameter'),0);assert.equal(receipt.queries.completed,0);assert.equal(receipt.queries.pending,0);assert.equal(receipt.events[0].timerStatus,'external-query-active-at-collection');
});

test('one arm and stop restore exact original methods and never re-arm or collect while drawing',()=>{
 const f=fixture(),controller=f.attach(),label={beforeZoom:14.905};controller.start(label);controller.start({beforeZoom:15.905});assert.equal(f.count('getExtension'),1);
 f.gl.drawArrays(f.gl.TRIANGLES,0,3);assert.equal(controller.collect({final:true}).collectionPasses,0);assert.equal(f.count('getQueryParameter'),0);
 const receipt=controller.stop('action-error');assert.equal(receipt.recording,false);assert.equal(receipt.started,true);assert.equal(receipt.stopped,true);assert.equal(receipt.stopReason,'action-error');assert.deepEqual(receipt.label,label);
 assert.equal(f.Canvas.prototype.getContext,f.originalGetContext);for(const [name,original] of Object.entries(f.originals))assert.equal(f.gl[name],original,`${name} must be restored`);
 const begins=f.count('beginQuery');f.gl.drawArrays(f.gl.TRIANGLES,0,3);assert.equal(f.count('beginQuery'),begins);assert.deepEqual(controller.start({rearm:true}),receipt);assert.deepEqual(controller.stop('again'),receipt);
});

test('the action adapter arms once, preserves the result and bounds pending collection to three passes',async()=>{
 const order=[],receipt={label:{zoom:14.905}},value={camera:{zoom:15.905}};let actions=0,collections=0;
 const result=await observeTerrainGPUDraws(async()=>{actions++;order.push('action');return value;},{receipt,
  control:async(method,argument)=>{order.push(method);if(method==='start')assert.deepEqual(argument,receipt.label);if(method==='stop')assert.equal(argument,'action-complete');if(method==='collect'){collections++;assert.deepEqual(argument,{final:collections===3});}return{queries:{pending:1},recording:method==='start'};},
  sleep:async duration=>{assert.equal(duration,50);order.push('wait');},
 });
 assert.equal(result,value);assert.equal(actions,1);assert.equal(collections,3);assert.deepEqual(order,['start','action','stop','collect','wait','collect','wait','collect']);assert.equal(receipt.status,'completed');assert.deepEqual(receipt.collectionErrors,[]);assert.equal(receipt.diagnosticOnly,true);assert.equal(receipt.verified,false);assert.equal(receipt.releaseEligible,false);
});

test('an available collection stops immediately after the unchanged native action',async()=>{
 const order=[];let actions=0;const value={ok:true};
 assert.equal(await observeTerrainGPUDraws(async()=>{order.push('action');actions++;return value;},{control:async method=>{order.push(method);return{queries:{pending:0}};},sleep:()=>assert.fail('No sleep after all queries finish')}),value);
 assert.equal(actions,1);assert.deepEqual(order,['start','action','stop','collect']);
});

for(const failedMethod of ['start','stop','collect'])test(`observer ${failedMethod} failures never replace or retry the original action failure`,async()=>{
 const failure=new Error('The maplibre map did not settle'),evidence={timeoutMs:15000,requiredIdleObservations:4,samples:[{frameMs:9000}]};failure.settleDiagnostics=evidence;
 const receipt={},calls=[],sleeps=[];let actions=0;
 const caught=await observeTerrainGPUDraws(async()=>{actions++;throw failure;},{receipt,
  control:async(method,argument)=>{calls.push({method,argument});if(method===failedMethod)throw new Error(`Observer ${method} failed`);return{queries:{pending:1}};},
  sleep:async duration=>{sleeps.push(duration);},
 }).then(()=>assert.fail('The action must fail'),error=>error);
 assert.equal(caught,failure);assert.equal(caught.settleDiagnostics,evidence);assert.equal(actions,1);assert.equal(calls.filter(call=>call.method==='start').length,1);assert.equal(calls.filter(call=>call.method==='stop').length,1);assert.equal(calls.find(call=>call.method==='stop').argument,'action-error');assert.equal(calls.filter(call=>call.method==='collect').length,3);assert.deepEqual(sleeps,[50,50]);assert.equal(receipt.status,'failed');assert.ok(receipt.collectionErrors.some(error=>error.method===failedMethod));
});

test('an unavailable observer receipt cannot replace the original action failure',async()=>{
 const failure=new Error('Native settle failed'),receipt={};let actions=0,collections=0,waits=0;
 const caught=await observeTerrainGPUDraws(async()=>{actions++;throw failure;},{receipt,
  control:async method=>{if(method==='collect')collections++;return{available:false,reason:'observer-missing'};},
  sleep:async duration=>{assert.equal(duration,50);waits++;},
 }).then(()=>assert.fail('The action must fail'),error=>error);
 assert.equal(caught,failure);assert.equal(actions,1);assert.equal(collections,3);assert.equal(waits,2);assert.equal(receipt.status,'failed');assert.equal(receipt.result.available,false);
});
