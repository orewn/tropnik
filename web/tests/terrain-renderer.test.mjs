import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createTerrainModel, createTerrainModelAsync, validatePreparedTerrainModel, buildTerrainMesh, selectTerrainMeshStride, visibleTerrainSampleWindow, selectVisibleTerrainMesh, drapeTerrainRoute, sampleTerrainMeshElevation, sampleTerrainShadow, TerrainRenderer, validateTerrainCartography, sampleTerrainCartography} from '../public/terrain/terrain-renderer.js';

const grid = (width=6,height=5) => ({width,height,bounds:[40,43,40.02,43.02],elevations:Array.from({length:width*height},(_,i)=>100+(i%width)*12+Math.floor(i/width)*5+(i%3===0?90:0))});

test('async preparation shares the exact calculation and yields to other tasks',async()=>{
  const source=grid(65,65),sync=createTerrainModel(source);let finished=false;
  const pending=createTerrainModelAsync(source).then(model=>{finished=true;return model;});
  await new Promise(resolve=>setTimeout(resolve,0));assert.equal(finished,false,'preparation must yield between bounded vertex ranges');
  const asyncModel=await pending;
  assert.deepEqual(asyncModel.heights,sync.heights);assert.deepEqual(asyncModel.normals,sync.normals);assert.deepEqual(asyncModel.normalTexture,sync.normalTexture);
  const controller=new AbortController(),cancelled=createTerrainModelAsync(source,{signal:controller.signal});controller.abort();
  await assert.rejects(cancelled,error=>error.name==='AbortError');
});

test('prepared models fail closed for altered provenance, dimensions, values or detached buffers',()=>{
  const source={...grid(3,3),schemaVersion:1,source:{name:'DEM',url:'https://example.test/dem',license:'test',checkedAt:'2026-11-06'}};
  const original=createTerrainModel(source),copy=structuredClone(original);
  assert.equal(validatePreparedTerrainModel(source,copy),copy);
  for(const corrupt of [m=>{m.grid.width=4;},m=>{m.grid.source.url+='-other';},m=>{m.grid.elevations[0]+=1;},m=>{m.scale=Infinity;},m=>{m.heights[0]+=.01;},m=>{m.normals[0]=NaN;},m=>{m.normalTexture=new Uint8Array(4);},m=>{structuredClone(m.heights.buffer,{transfer:[m.heights.buffer]});}]){
    const model=structuredClone(original);corrupt(model);assert.throws(()=>validatePreparedTerrainModel(source,model),/Prepared terrain/);
  }
});

function renderedHeight(model,mesh,x,y) {
  for(let i=0;i<mesh.indices.length;i+=3){
    const vertices=Array.from(mesh.indices.slice(i,i+3),index=>[(mesh.uv[index*2]-.5)*model.width,(.5-mesh.uv[index*2+1])*model.height,model.heights[mesh.sampleIds[index]]]);
    const [a,b,c]=vertices,den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
    const u=((b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(y-c[1]))/den,v=((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(y-c[1]))/den,w=1-u-v;
    if(Math.min(u,v,w)>=-1e-6)return u*a[2]+v*b[2]+w*c[2];
  }
  throw new Error('Point outside actual rendered triangles');
}

test('route follows actual LOD triangles across cells and diagonals, including ragged edges',()=>{
  const model=createTerrainModel(grid()),source=[[[-model.width/2,-model.height/2,999],[model.width/2,model.height/2,999]],[[-model.width/2,model.height*.19,999],[model.width/2,-model.height*.27,999]]];
  const unchanged=JSON.stringify(source),lift=Math.max(1.5,Math.min(model.cellX,model.cellY)*.08)/model.scale;
  for(const step of [1,2,3,4,8]){
    const mesh=buildTerrainMesh(model,step),route=drapeTerrainRoute(model,source,step);
    assert.ok(route.length>=source.length);
    for(const [a,b] of route)for(const t of [0,.25,.5,.75,1]){
      const p=a.map((value,i)=>value+(b[i]-value)*t),surface=renderedHeight(model,mesh,p[0],p[1]);
      assert.ok(Math.abs(p[2]-surface-lift)<2e-7,`stride=${step}: route clearance differs from real mesh`);
    }
  }
  assert.equal(JSON.stringify(source),unchanged,'display draping must preserve the source route');
});

test('mesh sampling preserves the final row/column and rejects invalid input before traversal',()=>{
  const model=createTerrainModel(grid());
  const expected=model.heights[model.grid.width-1]*model.scale+model.base;
  assert.equal(sampleTerrainMeshElevation(model,model.widthM/2,model.heightM/2,3),expected);
  assert.equal(sampleTerrainMeshElevation(model,NaN,0,1),null);
  assert.equal(sampleTerrainMeshElevation(model,model.widthM,0,1),null);
  assert.throws(()=>drapeTerrainRoute(model,[[[1e100,0,0],[0,0,0]]],1),/outside/);
  assert.throws(()=>drapeTerrainRoute(model,[],0),/stride/);
});

test('bounded shadow traversal finds a one-cell ridge between the old exponential ray samples',()=>{
  const width=129,height=129,elevations=Array(width*height).fill(0);
  for(let y=0;y<height;y++)elevations[y*width+84]=500;
  const model=createTerrainModel({width,height,bounds:[0,0,.0115,.0115],elevations}),stats={};
  const visibility=sampleTerrainShadow(model,0,0,0,[Math.SQRT1_2,0,Math.SQRT1_2],32,stats);
  assert.ok(visibility<.01,'500m ridge at 20 cells must block the 45-degree ray');
  assert.ok(stats.queries<=32);assert.equal(stats.limitReached,false);
});

test('off-ray maxima never cast a shadow by themselves and refinement has a fixed work budget',()=>{
  const width=129,height=129,elevations=Array(width*height).fill(0);elevations[65*width+84]=500;
  const model=createTerrainModel({width,height,bounds:[0,0,.0115,.0115],elevations}),stats={};
  assert.equal(sampleTerrainShadow(model,0,0,0,[Math.SQRT1_2,0,Math.SQRT1_2],48,stats),1,'adjacent high texel is not an on-ray occluder');
  assert.ok(stats.queries<=48);
  assert.equal(sampleTerrainShadow(model,0,0,0,[Math.SQRT1_2,0,Math.SQRT1_2],1,stats),1,'unresolved bounds cannot invent a shadow');
  assert.equal(stats.queries,1);assert.equal(stats.limitReached,true);
  sampleTerrainShadow(model,0,0,0,[Math.SQRT1_2,0,Math.SQRT1_2],1e9,stats);assert.ok(stats.queries<=48);
  const bytes=model.shadowPyramid.reduce((sum,level)=>sum+level.data.byteLength,0);
  assert.ok(bytes<128*128*4*1.34,'maximum pyramid storage is bounded and shared by all rays');
});

function environment(t,{gpuFailure=false,gl=null,cloneFails=false,width=80,height=60}={}) {
  const originalRAF=globalThis.requestAnimationFrame,originalCancel=globalThis.cancelAnimationFrame;
  const frames=new Map();let nextId=0;
  globalThis.requestAnimationFrame=callback=>{const id=++nextId;frames.set(id,callback);return id;};
  globalThis.cancelAnimationFrame=id=>frames.delete(id);
  t.after(()=>{if(originalRAF===undefined)delete globalThis.requestAnimationFrame;else globalThis.requestAnimationFrame=originalRAF;if(originalCancel===undefined)delete globalThis.cancelAnimationFrame;else globalThis.cancelAnimationFrame=originalCancel;});
  const listeners=new Map(),doc={visibilityState:'visible',addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
  const ctx={createImageData:(w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}),putImageData(image){this.lastImage=image;}};
  const badGL={MAX_TEXTURE_SIZE:1,MAX_VERTEX_TEXTURE_IMAGE_UNITS:2,VERTEX_SHADER:3,FRAGMENT_SHADER:4,COMPILE_STATUS:5,getParameter:()=>4096,createShader:()=>({}),shaderSource(){},compileShader(){},getShaderParameter:()=>false,getShaderInfoLog:()=>'synthetic compiler failure',deleteShader(){},getExtension:()=>null};
  const parent={child:null,replaceChild(next,previous){assert.equal(this.child,previous);this.child=next;next.parentNode=this;previous.parentNode=null;}};
  const makeCanvas=(isClone=false)=>({style:{touchAction:'pan-y'},dataset:{},ownerDocument:doc,parentNode:null,width:0,height:0,events:new Map(),
    getContext(type){return type==='webgl2'?(gpuFailure&&!isClone?badGL:gl):(isClone&&cloneFails?null:ctx);},
    getBoundingClientRect:()=>({width,height,left:0,top:0,right:width,bottom:height}),
    addEventListener(name,fn){this.events.set(name,fn);},removeEventListener(name,fn){if(this.events.get(name)===fn)this.events.delete(name);},
    cloneNode(){const copy=makeCanvas(true);copy.style={...this.style};return copy;},
  });
  const canvas=makeCanvas();parent.child=canvas;canvas.parentNode=parent;
  return {canvas,ctx,parent,frames,doc,listeners,resize(w,h){width=w;height=h;},flush(){const ready=[...frames.values()];frames.clear();ready.forEach(fn=>fn(0));}};
}

function recordingGL({anisotropy=0,deferred=true,samples=4,frameStatus='ready',loseRenderbufferBinding=false}={}){
  const counts={framebuffers:0,renderbuffers:0,buffers:0,deletedBuffers:0,contextReleasedBuffers:0,vertexArrays:0,deletedVertexArrays:0,contextReleasedVertexArrays:0,bufferUploads:[],shadowBudgets:[],textures:0,deletedTextures:0,contextReleasedTextures:0,invalidObjectCalls:0,uploads:[],anisotropyQueries:0,anisotropyValues:[],shaderSources:[],stencilState:[],draws:[],resolves:[],polls:[],maxPendingSyncs:0,deletedSyncs:0,renderbufferQueries:[],missingRenderbufferBindings:0},enums=new Map(),generations=new WeakMap(),liveTextures=new Set(),liveSyncs=new Set(),liveBuffers=new Set(),liveVertexArrays=new Set();let next=1,gl,generation=0,error=0,drawFramebuffer=null,readFramebuffer=null,renderbuffer=null,nativeRenderbuffer=null,program=null;
  const create=type=>{const object={};generations.set(object,generation);if(type==='Texture')liveTextures.add(object);if(type==='Buffer')liveBuffers.add(object);if(type==='VertexArray'){liveVertexArrays.add(object);counts.vertexArrays++;}if(type==='Sync'){liveSyncs.add(object);counts.maxPendingSyncs=Math.max(counts.maxPendingSyncs,liveSyncs.size);}return object;};
  const remove=(type,object)=>{
    if(generations.get(object)!==generation){counts.invalidObjectCalls++;error=gl.INVALID_OPERATION;return;}
    generations.delete(object);if(type==='Buffer'){liveBuffers.delete(object);counts.deletedBuffers++;}if(type==='VertexArray'){liveVertexArrays.delete(object);counts.deletedVertexArrays++;}if(type==='Texture'){counts.deletedTextures++;liveTextures.delete(object);}if(type==='Sync'){liveSyncs.delete(object);counts.deletedSyncs++;}
  };
  const extension={MAX_TEXTURE_MAX_ANISOTROPY_EXT:0x84ff,TEXTURE_MAX_ANISOTROPY_EXT:0x84fe};
  const methods={NO_ERROR:0,getParameter:key=>{
      if(key===extension.MAX_TEXTURE_MAX_ANISOTROPY_EXT)return anisotropy;
      if(key===gl.SAMPLES)return samples;if(key===gl.DEPTH_BITS)return 24;if(key===gl.STENCIL_BITS)return 8;
      if([gl.RED_BITS,gl.GREEN_BITS,gl.BLUE_BITS].includes(key))return 8;if(key===gl.ALPHA_BITS)return 0;return 16384;
    },getError:()=>{const result=error;error=0;return result;},getExtension:name=>{if(name!=='EXT_texture_filter_anisotropic')return null;counts.anisotropyQueries++;return anisotropy?extension:null;},getShaderParameter:()=>true,getProgramParameter:()=>true,
    getFramebufferAttachmentParameter:()=>deferred?gl.LINEAR:gl.SRGB,
    getInternalformatParameter:()=>new Int32Array([samples]),
    bindFramebuffer:(target,object)=>{if(target===gl.FRAMEBUFFER||target===gl.DRAW_FRAMEBUFFER)drawFramebuffer=object;if(target===gl.FRAMEBUFFER||target===gl.READ_FRAMEBUFFER)readFramebuffer=object;},
    // Model a command cache separately from the native driver binding. A same-object
    // bind is elided; a native reset need not update that cache.
    bindRenderbuffer:(_target,object)=>{if(renderbuffer!==object)nativeRenderbuffer=object;renderbuffer=object;},
    renderbufferStorageMultisample:(_target,count,format,width,height)=>{Object.assign(nativeRenderbuffer,{samples:count,format,width,height});if(loseRenderbufferBinding)nativeRenderbuffer=null;},
    renderbufferStorage:(_target,format,width,height)=>{Object.assign(nativeRenderbuffer,{samples:0,format,width,height});if(loseRenderbufferBinding)nativeRenderbuffer=null;},
    getRenderbufferParameter:(_target,parameter)=>{
      if(!nativeRenderbuffer){counts.missingRenderbufferBindings++;error=gl.INVALID_OPERATION;return null;}
      const buffer=nativeRenderbuffer;let value=0;
      if(parameter===gl.RENDERBUFFER_SAMPLES)value=buffer.samples;
      else if([gl.RENDERBUFFER_RED_SIZE,gl.RENDERBUFFER_GREEN_SIZE,gl.RENDERBUFFER_BLUE_SIZE].includes(parameter))value=buffer.format===gl.RGB8?8:0;
      else if(parameter===gl.RENDERBUFFER_DEPTH_SIZE)value=buffer.format===gl.RGB8?0:24;
      else if(parameter===gl.RENDERBUFFER_STENCIL_SIZE)value=buffer.format===gl.DEPTH24_STENCIL8?8:0;
      counts.renderbufferQueries.push({parameter,value,format:buffer.format,width:buffer.width,height:buffer.height});
      if(loseRenderbufferBinding)nativeRenderbuffer=null;return value;
    },
    useProgram:value=>{program=value;},
    bufferData:(target,data)=>counts.bufferUploads.push({target,length:data.length,bytes:data.byteLength,values:data.slice(0,16)}),
    drawArrays:(...args)=>counts.draws.push({kind:'arrays',framebuffer:drawFramebuffer,program,args}),
    drawElements:(...args)=>counts.draws.push({kind:'elements',framebuffer:drawFramebuffer,program,args}),
    blitFramebuffer:(...args)=>counts.resolves.push({read:readFramebuffer,draw:drawFramebuffer,args}),
    fenceSync:(condition,flags)=>{assert.equal(condition,gl.SYNC_GPU_COMMANDS_COMPLETE);assert.equal(flags,0);return create('Sync');},
    clientWaitSync:(sync,flags,timeout)=>{assert.ok(liveSyncs.has(sync));counts.polls.push({flags,timeout});return frameStatus==='pending'?gl.TIMEOUT_EXPIRED:frameStatus==='failed'?gl.WAIT_FAILED:gl.ALREADY_SIGNALED;},
    texParameterf:(_target,key,value)=>{if(key===extension.TEXTURE_MAX_ANISOTROPY_EXT)counts.anisotropyValues.push(value);},
    shaderSource:(_shader,source)=>counts.shaderSources.push(source),
    stencilMask:value=>counts.stencilState.push(['mask',value]),stencilFunc:(...values)=>counts.stencilState.push(['function',...values]),stencilOp:(...values)=>counts.stencilState.push(['operation',...values]),
    checkFramebufferStatus:()=>gl.FRAMEBUFFER_COMPLETE,getUniformLocation:(_program,name)=>name,
    uniform1i:(name,value)=>{if(name==='uSteps')counts.shadowBudgets.push(value);},
    createFramebuffer:()=>{counts.framebuffers++;return create('Framebuffer');},createRenderbuffer:()=>{counts.renderbuffers++;return create('Renderbuffer');},createBuffer:()=>{counts.buffers++;return create('Buffer');},
    createTexture:()=>{counts.textures++;return create('Texture');},deleteTexture:object=>remove('Texture',object),
    texImage2D:(_target,_level,_internal,width,height,_border,_format,_type,data)=>counts.uploads.push({width,height,pixels:data?.slice(0,16)}),
  };
  gl=new Proxy(methods,{get(target,key){
    if(key in target)return target[key];
    if(/^[A-Z0-9_]+$/.test(String(key))){if(!enums.has(key))enums.set(key,next++);return enums.get(key);}
    if(String(key).startsWith('create'))return()=>create(String(key).slice(6));
    if(String(key).startsWith('delete'))return object=>remove(String(key).slice(6),object);return()=>{};
  }});
  return{gl,counts,setFrameStatus(value){frameStatus=value;},pendingSyncs:()=>liveSyncs.size,liveTextures:()=>liveTextures.size,liveBuffers:()=>liveBuffers.size,liveVertexArrays:()=>liveVertexArrays.size,loseContext(){generation++;counts.contextReleasedTextures+=liveTextures.size;counts.contextReleasedBuffers+=liveBuffers.size;counts.contextReleasedVertexArrays+=liveVertexArrays.size;liveTextures.clear();liveBuffers.clear();liveVertexArrays.clear();liveSyncs.clear();drawFramebuffer=null;readFramebuffer=null;renderbuffer=null;nativeRenderbuffer=null;program=null;}};
}

test('LOD hysteresis avoids toggling near a zoom threshold while retaining hard limits',()=>{
  const source={width:129,height:129};let stride=selectTerrainMeshStride(source,15000);
  assert.equal(stride,2);
  for(const budget of[16000,17000,18000,16500,19000]){stride=selectTerrainMeshStride(source,budget,stride);assert.equal(stride,2);}
  stride=selectTerrainMeshStride(source,23000,stride);assert.equal(stride,1);
  stride=selectTerrainMeshStride(source,15000,stride);assert.equal(stride,1);
  assert.equal(selectTerrainMeshStride(source,12000,stride),2);
  assert.equal(selectTerrainMeshStride({width:513,height:513},1e9,1,66049),2,'hard vertex limit overrides hysteresis');
});

test('pointerdown/up and wheel state cannot recreate buffers, switch LOD or allocate shadow targets',t=>{
  const record=recordingGL(),env=environment(t,{gl:record.gl,width:1000,height:700});
  const oldDpr=globalThis.devicePixelRatio;globalThis.devicePixelRatio=2;t.after(()=>{if(oldDpr===undefined)delete globalThis.devicePixelRatio;else globalThis.devicePixelRatio=oldDpr;});
  let writes=0,w=0,h=0;Object.defineProperty(env.canvas,'width',{get:()=>w,set:value=>{w=value;writes++;}});Object.defineProperty(env.canvas,'height',{get:()=>h,set:value=>{h=value;writes++;}});
  const renderer=new TerrainRenderer(env.canvas,grid(129,129));env.flush();assert.ok(renderer.gpu);
  const before={width:w,height:h,writes,stride:renderer.canvas.dataset.meshStride,framebuffers:record.counts.framebuffers,buffers:record.counts.buffers};
  env.canvas.events.get('pointerdown')({button:0,pointerId:1,clientX:10,clientY:10});env.flush();
  env.canvas.events.get('pointerup')({pointerId:1});env.flush();renderer.wheeling=true;renderer.request();env.flush();renderer.wheeling=false;renderer.request();env.flush();
  assert.deepEqual({width:w,height:h,writes,stride:renderer.canvas.dataset.meshStride,framebuffers:record.counts.framebuffers,buffers:record.counts.buffers},before);
  assert.deepEqual(record.counts.shadowBudgets,[48]);
  renderer.rotate(.00001);env.flush();assert.equal(record.counts.framebuffers,before.framebuffers);assert.deepEqual(record.counts.shadowBudgets,[48,48],'even a small rotation updates light without angle quantization');
  renderer.destroy();
});

test('clamped zoom no-ops neither redraw nor erase an already pending frame',t=>{
  const record=recordingGL(),env=environment(t,{gl:record.gl});let rendered=0;
  const renderer=new TerrainRenderer(env.canvas,grid(3,3),{onRender:()=>rendered++});
  const initial=renderer.frame;renderer.zoomBy(1);
  assert.equal(renderer.frame,initial);assert.equal(renderer.dirty,true);assert.equal(env.frames.size,1);
  env.flush();assert.equal(rendered,1);assert.equal(env.frames.size,0);
  renderer.zoomBy(100);assert.equal(renderer.zoom,5);assert.equal(env.frames.size,1);
  const firstClamp=renderer.frame;renderer.zoomBy(1.2);
  assert.equal(renderer.frame,firstClamp);assert.equal(renderer.dirty,true);env.flush();assert.equal(rendered,2);
  for(let i=0;i<12;i++)renderer.zoomBy(1.2);
  assert.equal(env.frames.size,0);assert.equal(renderer.dirty,false);env.flush();assert.equal(rendered,2);
  renderer.request();const pending=renderer.frame;renderer.zoomBy(1.2);
  assert.equal(renderer.frame,pending);assert.equal(renderer.dirty,true);assert.equal(env.frames.size,1);env.flush();assert.equal(rendered,3);
  renderer.zoomBy(.8);assert.equal(renderer.zoom,4);assert.equal(env.frames.size,1);env.flush();assert.equal(rendered,4);
  renderer.zoomBy(.001);assert.equal(renderer.zoom,.65);assert.equal(env.frames.size,1);env.flush();assert.equal(rendered,5);
  for(let i=0;i<12;i++)renderer.zoomBy(.8);
  assert.equal(env.frames.size,0);assert.equal(renderer.dirty,false);env.flush();assert.equal(rendered,5);
  renderer.zoomBy(2);assert.equal(renderer.zoom,1.3);assert.equal(env.frames.size,1);env.flush();assert.equal(rendered,6);
  renderer.destroy();
});

test('deferred terrain preserves MSAA and keeps the default canvas untouched until a zero-wait fence signals',t=>{
  const oldDpr=globalThis.devicePixelRatio;globalThis.devicePixelRatio=2;t.after(()=>{if(oldDpr===undefined)delete globalThis.devicePixelRatio;else globalThis.devicePixelRatio=oldDpr;});
  const record=recordingGL({frameStatus:'pending'}),env=environment(t,{gl:record.gl}),source=grid(3,3),frames=[];
  const renderer=new TerrainRenderer(env.canvas,source,{displayMask:displayMask(source,[255,0,0,255]),onRender:info=>frames.push(info)});
  env.flush();assert.equal(frames.length,0);assert.equal(record.pendingSyncs(),1);assert.equal(env.canvas.width,0);assert.equal(env.canvas.height,0);
  assert.ok(record.counts.draws.every(draw=>draw.framebuffer!==null),'expensive terrain and shadow work cannot dirty the default canvas');
  assert.deepEqual(renderer.gpu.frameFormat,{samples:4,depth:24,stencil:8,depthFormat:record.gl.DEPTH24_STENCIL8});
  const draws=record.counts.draws.length,targets=record.counts.framebuffers;
  for(let i=0;i<3;i++)env.flush();
  assert.equal(record.counts.draws.length,draws);assert.equal(record.counts.framebuffers,targets);assert.equal(record.pendingSyncs(),1);assert.equal(frames.length,0);
  assert.equal(record.counts.resolves.length,1);const resolve=record.counts.resolves[0];assert.ok(resolve.read&&resolve.draw);assert.notEqual(resolve.read,resolve.draw);
  assert.deepEqual(resolve.args,[0,0,160,120,0,0,160,120,record.gl.COLOR_BUFFER_BIT,record.gl.NEAREST]);
  assert.ok(record.counts.polls.every(poll=>poll.flags===0&&poll.timeout===0),'the main thread must never wait for GPU completion');
  record.setFrameStatus('ready');env.flush();
  assert.equal(frames.length,1);assert.equal(frames[0].renderer,'webgl2');assert.equal(frames[0].pixelRatio,2);assert.equal(frames[0].meshStride,1);
  assert.deepEqual([env.canvas.width,env.canvas.height],[160,120]);assert.equal(env.canvas.dataset.terrainPresentation,'deferred-msaa');assert.equal(env.canvas.dataset.terrainPending,'false');
  const visible=record.counts.draws.filter(draw=>draw.framebuffer===null);assert.equal(visible.length,1);assert.equal(visible[0].program,renderer.gpu.present.program);
  assert.equal(record.pendingSyncs(),0);assert.equal(record.counts.maxPendingSyncs,1);assert.equal(env.frames.size,0);renderer.destroy();
});

test('allocation restores native renderbuffer binding for every checked parameter, including resize and depth-only targets',t=>{
  for(const masked of[false,true]){
    const record=recordingGL({loseRenderbufferBinding:true}),env=environment(t,{gl:record.gl}),source=grid(3,3),frames=[];
    let width=80,height=60;env.canvas.getBoundingClientRect=()=>({width,height,left:0,top:0,right:width,bottom:height});
    const renderer=new TerrainRenderer(env.canvas,source,{...(masked?{displayMask:displayMask(source,[255,0,0,255])}:{}),onRender:info=>frames.push(info)});
    env.flush();assert.ok(renderer.gpu,'a stale native binding must not force the Canvas fallback');
    assert.equal(frames.length,1);assert.equal(frames[0].renderer,'webgl2');assert.equal(frames[0].graphicsFallback,null);
    assert.equal(record.counts.missingRenderbufferBindings,0);assert.equal(record.counts.renderbufferQueries.length,8);
    assert.deepEqual(record.counts.renderbufferQueries.filter(query=>query.parameter===record.gl.RENDERBUFFER_SAMPLES).map(query=>query.value),[4,4]);
    assert.equal(record.counts.renderbufferQueries.find(query=>query.parameter===record.gl.RENDERBUFFER_DEPTH_SIZE).value,24);
    assert.equal(record.counts.renderbufferQueries.find(query=>query.parameter===record.gl.RENDERBUFFER_STENCIL_SIZE).value,masked?8:0);
    width=110;height=75;renderer.request();env.flush();
    assert.equal(frames.length,2);assert.equal(frames[1].renderer,'webgl2');assert.equal(frames[1].graphicsFallback,null);
    assert.equal(record.counts.renderbufferQueries.length,16);assert.equal(record.counts.missingRenderbufferBindings,0);
    assert.ok(record.counts.renderbufferQueries.slice(8).every(query=>query.width===110&&query.height===75));
    assert.equal(record.counts.resolves.length,2);assert.equal(record.pendingSyncs(),0);renderer.destroy();
  }
});

test('restoring the binding never admits a changed sample count or color/depth precision',t=>{
  for(const [parameter,value,reason]of[['RENDERBUFFER_SAMPLES',2,/sample count changed/],['RENDERBUFFER_RED_SIZE',7,/precision changed/],['RENDERBUFFER_DEPTH_SIZE',16,/precision changed/]]){
    const record=recordingGL({loseRenderbufferBinding:true}),read=record.gl.getRenderbufferParameter,frames=[];
    record.gl.getRenderbufferParameter=(target,key)=>{const actual=read(target,key);return key===record.gl[parameter]?value:actual;};
    const env=environment(t,{gl:record.gl}),renderer=new TerrainRenderer(env.canvas,grid(3,3),{onRender:info=>frames.push(info)});
    env.flush();assert.equal(frames.length,0,'an invalid target cannot be presented as ready WebGL');assert.equal(record.counts.resolves.length,0);assert.equal(record.pendingSyncs(),0);
    env.flush();assert.equal(frames.length,1);assert.equal(frames[0].renderer,'canvas2d');assert.equal(frames[0].graphicsFallback.stage,'render');assert.match(frames[0].graphicsFallback.reason,reason);
    assert.equal(record.counts.missingRenderbufferBindings,0);renderer.destroy();
  }
});

test('pending frames coalesce camera, cartography, route and resize without publishing or clearing an obsolete view',t=>{
  const record=recordingGL(),env=environment(t,{gl:record.gl}),source=grid(3,3),frames=[];
  let width=80,height=60;env.canvas.getBoundingClientRect=()=>({width,height,left:0,top:0,right:width,bottom:height});
  const renderer=new TerrainRenderer(env.canvas,source,{onRender:info=>frames.push(info)});env.flush();assert.equal(frames.length,1);
  record.setFrameStatus('pending');renderer.zoomBy(2);env.flush();const uploads=record.counts.uploads.length,draws=record.counts.draws.length;
  renderer.zoomBy(1.5);renderer.setCartography(cartography(source));renderer.setGeometry({type:'LineString',coordinates:[[40.001,43.01],[40.019,43.01]]});
  width=110;height=75;renderer.setViewportInsets({top:3,bottom:4});
  for(let i=0;i<3;i++)env.flush();
  assert.equal(record.counts.uploads.length,uploads,'texture replacement must wait behind the completed frame boundary');assert.equal(record.counts.draws.length,draws);
  assert.deepEqual([env.canvas.width,env.canvas.height],[80,60]);assert.equal(frames.length,1);assert.equal(record.pendingSyncs(),1);
  record.setFrameStatus('ready');env.flush();
  assert.equal(frames.length,1,'a completed but obsolete view is not labelled as the new camera');assert.deepEqual([env.canvas.width,env.canvas.height],[80,60]);assert.equal(record.pendingSyncs(),0);
  record.setFrameStatus('pending');env.flush();
  assert.equal(record.pendingSyncs(),1);assert.equal(record.counts.maxPendingSyncs,1);assert.equal(frames.length,1);assert.deepEqual([env.canvas.width,env.canvas.height],[80,60]);
  assert.deepEqual(renderer.gpu.cartographySize,[2,2]);assert.ok(record.counts.uploads.length>uploads);
  record.setFrameStatus('ready');env.flush();
  assert.equal(frames.length,2);assert.deepEqual(frames.map(frame=>frame.view.zoom),[1,3]);assert.equal(frames[1].cartography.loadedTiles,1);
  assert.deepEqual([env.canvas.width,env.canvas.height],[110,75]);assert.ok(Number(env.canvas.dataset.routeRenderSegments)>0);assert.equal(env.frames.size,0);
  renderer.destroy();assert.equal(record.counts.deletedTextures,record.counts.textures);
});

test('pending GPU work pauses while hidden and releases its fence on destruction',t=>{
  const record=recordingGL({frameStatus:'pending'}),env=environment(t,{gl:record.gl});let rendered=0;
  const renderer=new TerrainRenderer(env.canvas,grid(3,3),{onRender:()=>rendered++});env.flush();assert.equal(record.pendingSyncs(),1);
  renderer.setVisible(false);assert.equal(env.frames.size,0);const polls=record.counts.polls.length;env.flush();assert.equal(record.counts.polls.length,polls);
  renderer.warmup();env.flush();assert.equal(record.pendingSyncs(),1);assert.equal(rendered,0);
  renderer.destroy();assert.equal(record.pendingSyncs(),0);assert.equal(env.frames.size,0);env.flush();assert.equal(rendered,0);
  assert.equal(record.counts.deletedTextures,record.counts.textures);assert.equal(record.counts.invalidObjectCalls,0);
});

test('a lost pending generation is abandoned and recovery presents only a newly completed frame',t=>{
  const record=recordingGL({frameStatus:'pending'}),env=environment(t,{gl:record.gl}),frames=[];
  const renderer=new TerrainRenderer(env.canvas,grid(3,3),{onRender:info=>frames.push(info)});env.flush();const old=renderer.pendingGPU;
  record.loseContext();env.canvas.events.get('webglcontextlost')({preventDefault(){}});
  assert.equal(renderer.pendingGPU,null);assert.equal(env.frames.size,0);assert.equal(frames.length,0);
  env.canvas.events.get('webglcontextrestored')();env.flush();assert.ok(renderer.pendingGPU);assert.notEqual(renderer.pendingGPU.gpu,old.gpu);assert.equal(frames.length,0);
  record.setFrameStatus('ready');env.flush();assert.equal(frames.length,1);assert.equal(frames[0].renderer,'webgl2');assert.equal(frames[0].graphicsFallback,null);
  assert.equal(record.pendingSyncs(),0);assert.equal(record.counts.invalidObjectCalls,0);renderer.destroy();
  assert.equal(record.counts.deletedTextures+record.counts.contextReleasedTextures,record.counts.textures);
});

test('unsupported default colour encoding retains the original direct WebGL rendering path',t=>{
  const record=recordingGL({deferred:false}),env=environment(t,{gl:record.gl});let info;
  const renderer=new TerrainRenderer(env.canvas,grid(3,3),{onRender:value=>{info=value;}});env.flush();
  assert.equal(renderer.gpu.frameFormat,null);assert.equal(env.canvas.dataset.terrainPresentation,'direct');assert.equal(info.renderer,'webgl2');assert.equal(info.graphicsFallback,null);
  assert.equal(record.counts.polls.length,0);assert.equal(record.counts.resolves.length,0);assert.ok(record.counts.draws.some(draw=>draw.kind==='elements'&&draw.framebuffer===null));renderer.destroy();
});

test('a failed completion query cannot publish a pending frame as ready WebGL',t=>{
  const record=recordingGL({frameStatus:'pending'}),env=environment(t,{gl:record.gl}),frames=[];
  const renderer=new TerrainRenderer(env.canvas,grid(3,3),{onRender:info=>frames.push(info)});env.flush();record.setFrameStatus('failed');env.flush();
  assert.equal(frames.length,0);assert.equal(renderer.pendingGPU,null);assert.equal(record.pendingSyncs(),0);
  env.flush();assert.equal(frames.length,1);assert.equal(frames[0].renderer,'canvas2d');assert.equal(frames[0].graphicsFallback.stage,'presentation');
  renderer.destroy();assert.equal(record.counts.invalidObjectCalls,0);
});

test('renderer retains validated prepared buffers instead of recomputing the model',t=>{
  const env=environment(t),source=grid(3,3),prepared=createTerrainModel(source),renderer=new TerrainRenderer(env.canvas,source,{forceCanvas:true,preparedModel:prepared});
  assert.equal(renderer.model,prepared);assert.equal(renderer.model.normals,prepared.normals);renderer.destroy();
});

function cartography(source,color=[180,60,30,255]){
 const pixels=new Uint8ClampedArray(16);for(let at=0;at<16;at+=4)pixels.set(color,at);
 return{width:2,height:2,pixels,source:{name:'Source map',bounds:[...source.bounds],projection:'regular-longitude-latitude',sampleLayout:'grid-nodes',rowOrder:'north-to-south',columnOrder:'west-to-east',requestedTiles:1,loadedTiles:1}};
}
function displayMask(source,values=[0,0,0,0]){return{width:2,height:2,pixels:new Uint8Array(values),source:{scope:'russia-display-area',coverageVersion:'a'.repeat(16),lod:'source',cells:['test'],bounds:[...source.bounds],projection:'regular-longitude-latitude',sampleLayout:'pixel-cells',rowOrder:'north-to-south',columnOrder:'west-to-east',boundaryRule:'exclude-intersecting-texels',allowedPixels:values.filter(value=>value===255).length}};}

test('Canvas display mask clips terrain, cartography, rim and route before the first frame without changing elevations',t=>{
  const env=environment(t),source=grid(3,3),original=structuredClone(source),prepared=createTerrainModel(source),heights=prepared.heights.slice(),mask=displayMask(source);
  const renderer=new TerrainRenderer(env.canvas,source,{forceCanvas:true,preparedModel:prepared,displayMask:mask});
  assert.notEqual(renderer.displayMask.pixels,mask.pixels);mask.pixels.fill(255);
  renderer.setCartography(cartography(source));renderer.setGeometry({type:'LineString',coordinates:[[40.001,43.01],[40.019,43.01]]});env.flush();
  const image=env.ctx.lastImage.data;for(let at=0;at<image.length;at+=4)assert.deepEqual([...image.subarray(at,at+4)],[223,230,218,255]);
  assert.equal(renderer.canvas.dataset.displayMask,'russia-display-area');assert.deepEqual(source,original);assert.deepEqual(prepared.heights,heights);
  assert.ok([...renderer.software.boundaries.values()].every(boundary=>boundary.count===0),'a rectangular decorative rim cannot expose excluded land');
  assert.equal(env.frames.size,0);renderer.rotate(.4);env.flush();assert.ok(renderer.software.depth.every(value=>value===Infinity));
  renderer.destroy();assert.equal(renderer.displayMask,null);assert.equal(renderer.software.displayMask,null);
});

test('GPU display mask retains one owned texture across frames and restores it after context loss or Canvas fallback',t=>{
  const record=recordingGL(),env=environment(t,{gl:record.gl}),source=grid(3,3),mask=displayMask(source,[255,0,0,255]);
  const renderer=new TerrainRenderer(env.canvas,source,{displayMask:mask});env.flush();assert.equal(renderer.gpu.displayMask,renderer.displayMask);
  const before=record.counts.textures;renderer.rotate(.2);env.flush();assert.equal(record.counts.textures,before,'camera changes do not recreate the geographic mask');
  const owned=renderer.displayMask;record.loseContext();env.canvas.events.get('webglcontextlost')({preventDefault(){}});env.canvas.events.get('webglcontextrestored')();env.flush();
  assert.equal(renderer.displayMask,owned);assert.equal(renderer.gpu.displayMask,owned);
  record.loseContext();env.canvas.events.get('webglcontextlost')({preventDefault(){}});renderer.fallbackAfterLoss();env.flush();
  assert.equal(renderer.software.displayMask,owned);assert.equal(renderer.canvas.dataset.displayMask,'russia-display-area');
  renderer.destroy();assert.equal(record.counts.deletedTextures+record.counts.contextReleasedTextures,record.counts.textures);assert.equal(record.counts.invalidObjectCalls,0);assert.equal(env.frames.size,0);
});
test('only a validated fully allowed mask removes the terrain discard while preserving mask and route state',t=>{
  const source=grid(3,3),snapshots=[];
  for(const values of[[255,255,255,0],[0,0,0,0],[255,255,255,255]]){
    const record=recordingGL(),env=environment(t,{gl:record.gl}),mask=displayMask(source,values);
    const renderer=new TerrainRenderer(env.canvas,source,{displayMask:mask});env.flush();
    assert.equal(renderer.gpu.displayMask,renderer.displayMask);assert.notEqual(renderer.displayMask.pixels,mask.pixels);
    assert.equal(renderer.canvas.dataset.displayMask,'russia-display-area');
    assert.ok([...renderer.gpu.meshes.values()].every(mesh=>mesh.boundaryCount===0),'full mask still suppresses the decorative rim');
    assert.ok(record.counts.uploads.some(upload=>upload.width===2&&upload.height===2&&[...upload.pixels].every((value,index)=>value===values[index])));
    snapshots.push({terrain:record.counts.shaderSources[1],route:record.counts.shaderSources[5],stencil:record.counts.stencilState.slice()});
    if(values.every(value=>value===255)){
      const specialized=record.counts.shaderSources[1],owned=renderer.displayMask;
      mask.pixels.fill(0);mask.source.allowedPixels=0;
      record.loseContext();env.canvas.events.get('webglcontextlost')({preventDefault(){}});env.canvas.events.get('webglcontextrestored')();env.flush();
      assert.equal(renderer.gpu.displayMask,owned);assert.equal(owned.source.allowedPixels,4);
      assert.equal(record.counts.shaderSources.filter(source=>source.includes('vec3 perturbNormal(')).at(-1),specialized,'restoration selects from the owned validated mask');
    }
    renderer.destroy();
  }
  const [mixed,empty,full]=snapshots,discard=' if(texture(uDisplayMask,vUV).r<.5)discard;\n';
  assert.equal(mixed.terrain,empty.terrain);assert.ok(mixed.terrain.includes(discard));
  assert.equal(full.terrain,mixed.terrain.replace(discard,''),'all material calculations and uniforms are unchanged');
  assert.equal(full.route,mixed.route);assert.ok(full.route.includes('texture(uDisplayMask,uv).r<.5'));
  assert.deepEqual(full.stencil,mixed.stencil);assert.ok(full.stencil.length>0);
  const record=recordingGL(),env=environment(t,{gl:record.gl}),bad=displayMask(source,[255,255,255,0]);bad.source.allowedPixels=4;
  assert.throws(()=>new TerrainRenderer(env.canvas,source,{displayMask:bad}),/mask/);
  assert.equal(record.counts.shaderSources.length,0,'unverified metadata cannot choose a shader');
  const unmasked=new TerrainRenderer(env.canvas,source);env.flush();
  assert.equal(record.counts.shaderSources[1],mixed.terrain,'the absent-mask path is unchanged');unmasked.destroy();
});
test('cartography validates bounded pixels, exact geographic grid alignment and source coverage',()=>{
 const source=grid(),valid=cartography(source);assert.equal(validateTerrainCartography(valid,source),valid);
 const detailed={...valid,width:2048,height:2048,pixels:new Uint8ClampedArray(2048*2048*4)};assert.equal(validateTerrainCartography(detailed,source),detailed);
 for(const change of[s=>s.width=2049,s=>s.height=1,s=>s.pixels=new Uint8ClampedArray(15),s=>s.source.bounds[0]+=.0001,s=>s.source.projection='EPSG:3857',s=>s.source.sampleLayout='pixel-centres',s=>s.source.rowOrder='south-to-north',s=>s.source.loadedTiles=2,s=>s.source.requestedTiles=17]){
  const value=structuredClone(valid);change(value);assert.throws(()=>validateTerrainCartography(value,source),/cartography/);
 }
});
test('cartography pixel sampling matches DEM grid nodes and uses premultiplied coverage at gaps',()=>{
 const surface=cartography(grid());surface.pixels.set([255,0,0,255,0,255,0,255,0,0,255,255,0,0,0,0]);
 assert.deepEqual(sampleTerrainCartography(surface,0,0),[255,0,0,255]);
 assert.deepEqual(sampleTerrainCartography(surface,1,0),[0,255,0,255]);
 assert.deepEqual(sampleTerrainCartography(surface,0,1),[0,0,255,255]);
 assert.deepEqual(sampleTerrainCartography(surface,1,1),[0,0,0,0]);
 assert.deepEqual(sampleTerrainCartography(surface,.5,.5),[85,85,85,191.25]);
 assert.deepEqual(sampleTerrainCartography(null,.5,.5),[0,0,0,0]);
});
test('Canvas cartography changes actual pixels while retaining heights, source buffers and idle lifecycle',t=>{
 const env=environment(t),source=grid(3,3),renderer=new TerrainRenderer(env.canvas,source,{forceCanvas:true});env.flush();
 const neutral=env.ctx.lastImage.data.slice(),heights=renderer.model.heights.slice(),normals=renderer.model.normals.slice(),surface=cartography(source);
 renderer.setVisible(false);renderer.setCartography(surface);assert.equal(env.frames.size,0);
 assert.notEqual(renderer.cartography.pixels,surface.pixels);surface.pixels.fill(0);
 renderer.warmup();env.flush();assert.notDeepEqual(env.ctx.lastImage.data,neutral);
 assert.equal(renderer.cartography.pixels[0],180);assert.equal(renderer.canvas.dataset.cartography,'source');
 assert.deepEqual(renderer.model.heights,heights);assert.deepEqual(renderer.model.normals,normals);
 renderer.setCartography(null);renderer.warmup();env.flush();assert.deepEqual(env.ctx.lastImage.data,neutral);
 assert.equal(env.frames.size,0);assert.equal(renderer.software.cartography,null);
 renderer.destroy();assert.equal(renderer.cartography,null);
});
test('GPU cartography replaces one texture, restores source cover after context loss and releases all textures',t=>{
 const record=recordingGL(),env=environment(t,{gl:record.gl}),source=grid(3,3),renderer=new TerrainRenderer(env.canvas,source);env.flush();
 const before={textures:record.counts.textures,deleted:record.counts.deletedTextures,uploads:record.counts.uploads.length};
 renderer.setCartography(cartography(source,[180,60,30,128]));
 assert.equal(record.counts.textures,before.textures+1);assert.equal(record.counts.deletedTextures,before.deleted+1);
 assert.equal(record.counts.uploads.length,before.uploads+1,'cover updates must never replace the DEM texture');
 assert.deepEqual([...record.counts.uploads.at(-1).pixels.slice(0,4)],[90,30,15,128]);
 env.flush();record.loseContext();env.canvas.events.get('webglcontextlost')({preventDefault(){}});env.canvas.events.get('webglcontextrestored')();env.flush();
 assert.deepEqual(renderer.gpu.cartographySize,[2,2]);assert.equal(renderer.cartography.pixels[0],180);
 renderer.setCartography(null);assert.deepEqual(renderer.gpu.cartographySize,[1,1]);assert.equal(renderer.cartography,null);
 renderer.destroy();assert.equal(record.counts.deletedTextures+record.counts.contextReleasedTextures,record.counts.textures);assert.equal(record.counts.invalidObjectCalls,0);assert.equal(env.frames.size,0);
});

test('oblique cartography filtering respects device limits and never queries extensions per frame',t=>{
 for(const available of[0,2,16]){
  const record=recordingGL({anisotropy:available}),env=environment(t,{gl:record.gl}),source=grid(3,3),renderer=new TerrainRenderer(env.canvas,source);env.flush();
  const before=record.counts.anisotropyValues.length;
  renderer.setCartography(cartography(source));env.flush();renderer.rotate(.1);env.flush();
  assert.equal(record.counts.anisotropyQueries,1);
  assert.equal(record.counts.anisotropyValues.length,before+(available?1:0));
  assert.ok(record.counts.anisotropyValues.every(value=>value===Math.min(4,available)));
  renderer.destroy();
 }
});

test('hidden warmup renders one real frame, coalesces calls, and stays idle afterwards',t=>{
  const env=environment(t);let rendered=0;
  const renderer=new TerrainRenderer(env.canvas,grid(3,3),{forceCanvas:true,onRender:()=>rendered++});
  renderer.setVisible(false);assert.equal(env.frames.size,0);
  renderer.warmup();renderer.warmup();assert.equal(env.frames.size,1);env.flush();
  assert.equal(rendered,1);assert.ok(env.ctx.lastImage);assert.equal(env.frames.size,0);
  renderer.setGeometry({type:'LineString',coordinates:[[40,43.005],[40.02,43.015]]});
  assert.equal(env.frames.size,0,'hidden updates alone must not start an idle render loop');
  renderer.warmup();env.flush();assert.equal(rendered,2);assert.equal(env.frames.size,0);
  renderer.destroy();renderer.warmup();assert.equal(env.frames.size,0);
});

test('hidden document defers warmup until visibility resumes',t=>{
  const env=environment(t);let rendered=0;
  env.doc.visibilityState='hidden';const renderer=new TerrainRenderer(env.canvas,grid(3,3),{forceCanvas:true,onRender:()=>rendered++});
  renderer.setVisible(false);renderer.warmup();assert.equal(env.frames.size,0);
  env.doc.visibilityState='visible';env.listeners.get('visibilitychange')();env.flush();
  assert.equal(rendered,1);assert.equal(env.frames.size,0);renderer.destroy();
});

test('screen-space route thickness cannot pull an occluded trail through terrain depth',t=>{
  const env=environment(t),renderer=new TerrainRenderer(env.canvas,grid(3,3),{forceCanvas:true});
  renderer.setVisible(false);
  const pixels=new Uint8ClampedArray(10*10*4).fill(17),before=pixels.slice(),depth=new Float32Array(100).fill(.5);
  renderer.software.routeCapsule([1,5,.50001,1],[9,5,.50001,1],2,[255,0,0],10,10,pixels,depth);
  assert.deepEqual(pixels,before,'even a small positive depth separation must stay occluded');
  renderer.software.routeCapsule([1,5,.49999,1],[9,5,.49999,1],2,[255,0,0],10,10,pixels,depth);
  assert.notDeepEqual(pixels,before,'a closer trail must remain visible');renderer.destroy();
});

test('fallback canvas is restored on destroy and the same original canvas can be retried',t=>{
  const env=environment(t,{gpuFailure:true});
  for(let attempt=0;attempt<2;attempt++){
    let frame;const renderer=new TerrainRenderer(env.canvas,grid(3,3),{onRender:value=>{frame=value;}});
    assert.notEqual(env.parent.child,env.canvas);renderer.setVisible(false);renderer.warmup();env.flush();
    assert.equal(renderer.canvas.dataset.renderer,'canvas2d');assert.deepEqual(frame.graphicsFallback,{stage:'initialization',reason:'Terrain shader: synthetic compiler failure'});renderer.destroy();
    assert.equal(env.parent.child,env.canvas);assert.equal(env.canvas.style.touchAction,'pan-y');assert.equal(env.frames.size,0);
  }
});

test('failed fallback allocation leaves the original DOM canvas and controls available for retry',t=>{
  const env=environment(t,{gpuFailure:true,cloneFails:true});
  assert.throws(()=>new TerrainRenderer(env.canvas,grid(3,3)),/рендер/);
  assert.equal(env.parent.child,env.canvas);assert.equal(env.canvas.parentNode,env.parent);assert.equal(env.canvas.style.touchAction,'pan-y');assert.equal(env.frames.size,0);
});

test('terminal context loss after the first frame invalidates the session and a fresh renderer can retry',t=>{
  const record=recordingGL(),env=environment(t,{gl:record.gl,cloneFails:true});let rendered=0;const fatal=[];
  const renderer=new TerrainRenderer(env.canvas,grid(3,3),{onRender:()=>rendered++,onFatal:message=>fatal.push(message)});
  env.flush();assert.equal(rendered,1);
  env.canvas.events.get('webglcontextlost')({preventDefault(){}});
  renderer.fallbackAfterLoss();
  assert.equal(renderer.failed,true);assert.equal(renderer.destroyed,true);assert.equal(fatal.length,1);
  assert.equal(env.canvas.events.size,0);assert.equal(env.frames.size,0);
  renderer.setVisible(false);renderer.setVisible(true);renderer.warmup();
  assert.equal(env.frames.size,0,'an ended renderer cannot masquerade as a new graphics session');
  const retryCanvas=env.canvas.cloneNode(false);retryCanvas.getContext=type=>type==='2d'?env.ctx:null;let retried=0;
  const replacement=new TerrainRenderer(retryCanvas,grid(3,3),{forceCanvas:true,onRender:()=>retried++});
  env.flush();assert.notEqual(replacement,renderer);assert.equal(replacement.failed,false);assert.equal(retried,1);replacement.destroy();
});

test('a terminal Canvas failure after ready releases resources and reports fatal exactly once',t=>{
  const env=environment(t);let rendered=0,fatal=0;
  const renderer=new TerrainRenderer(env.canvas,grid(3,3),{forceCanvas:true,onRender:()=>rendered++,onFatal:()=>fatal++});
  env.flush();assert.equal(rendered,1);
  renderer.software.render=()=>{throw new Error('Canvas resource allocation failed');};
  renderer.request();env.flush();
  assert.equal(renderer.failed,true);assert.equal(renderer.destroyed,true);assert.equal(fatal,1);
  assert.equal(env.canvas.events.size,0);assert.equal(env.frames.size,0);assert.equal(renderer.software.image,null);
  renderer.warmup();renderer.terminalFailure('Repeated notification');
  assert.equal(fatal,1);assert.equal(rendered,1);assert.equal(env.frames.size,0);
});

test('host callback exceptions cannot break rendering or cleanup',t=>{
  const env=environment(t),renderer=new TerrainRenderer(env.canvas,grid(3,3),{forceCanvas:true,onRender(){throw new Error('host UI');},onError(){throw new Error('host error UI');}});
  assert.doesNotThrow(()=>env.flush());renderer.software.render=()=>{throw new Error('raster failure');};
  renderer.request();assert.doesNotThrow(()=>env.flush());renderer.destroy();assert.equal(env.frames.size,0);
});

test('default fit and measured insets keep the complete DEM inside the unobscured viewport',t=>{
  const env=environment(t,{width:390,height:844}),renderer=new TerrainRenderer(env.canvas,grid(),{forceCanvas:true,compactViewport:true});
  let camera;renderer.software.render=(_mesh,value)=>{camera=value;};
  renderer.setViewportInsets({top:72,right:48,bottom:132,left:16});env.flush();
  const m=camera.matrix,model=renderer.model,viewport={left:16,right:342,top:72,bottom:712};
  const points=[];for(let row=0;row<model.grid.height;row++)for(let col=0;col<model.grid.width;col++)points.push([(col/(model.grid.width-1)-.5)*model.width,(.5-row/(model.grid.height-1))*model.height,model.heights[row*model.grid.width+col]]);
  for(const x of[-model.width/2,model.width/2])for(const y of[-model.height/2,model.height/2])points.push([x,y,(model.min-model.base)/model.scale-.012]);
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for(const[x,y,z]of points){
    const w=m[3]*x+m[7]*y+m[11]*z+m[15];
    const px=((m[0]*x+m[4]*y+m[8]*z+m[12])/w+camera.offset[0]+1)*195;
    const py=(1-(m[1]*x+m[5]*y+m[9]*z+m[13])/w-camera.offset[1])*422;
    minX=Math.min(minX,px);maxX=Math.max(maxX,px);minY=Math.min(minY,py);maxY=Math.max(maxY,py);
    assert.ok(px>=viewport.left+(viewport.right-viewport.left)*.099&&px<=viewport.right-(viewport.right-viewport.left)*.099);
    assert.ok(py>=viewport.top+(viewport.bottom-viewport.top)*.099&&py<=viewport.bottom-(viewport.bottom-viewport.top)*.099);
  }
  assert.ok(Math.max((maxX-minX)/(viewport.right-viewport.left),(maxY-minY)/(viewport.bottom-viewport.top))>.7,'canonical terrain should use the frame rather than sit inside an oversized spherical fit');
  const distance=camera.distance;renderer.rotate(Math.PI/2);env.flush();assert.equal(camera.distance,distance,'orbit must not pump camera distance');
  renderer.zoomBy(1.7);renderer.setViewportInsets({bottom:600});env.flush();assert.equal(renderer.zoom,1.7);
  renderer.setViewportInsets({top:Infinity,right:1e9,bottom:1e9,left:-100});env.flush();assert.ok([...camera.matrix,...camera.offset].every(Number.isFinite));
  renderer.reset();env.flush();assert.equal(renderer.zoom,1);renderer.destroy();
});

test('map mode pans with primary drag, orbits with alternate drag and settles once without programmatic recursion',async t=>{
  const env=environment(t,{width:800,height:600}),changes=[];
  const renderer=new TerrainRenderer(env.canvas,grid(9,9),{navigation:'map',forceCanvas:true,onViewChange:(view,reason)=>changes.push({view,reason})});
  const initial=renderer.getView(),down=env.canvas.events.get('pointerdown'),move=env.canvas.events.get('pointermove'),up=env.canvas.events.get('pointerup');
  down({button:0,pointerId:1,clientX:400,clientY:300});move({pointerId:1,clientX:460,clientY:330});
  assert.equal(renderer.yaw,initial.yaw);assert.notEqual(renderer.getView().longitude,initial.longitude);assert.equal(changes.length,0);
  up({pointerId:1});await new Promise(resolve=>setTimeout(resolve,5));assert.equal(changes.length,1);assert.equal(changes[0].reason,'gesture');
  const translated=renderer.getView();down({button:2,pointerId:2,clientX:400,clientY:300});move({pointerId:2,clientX:470,clientY:320});up({pointerId:2});
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(changes.length,2);assert.notEqual(renderer.yaw,translated.yaw);assert.equal(renderer.getView().longitude,translated.longitude);
  renderer.setView(initial);await new Promise(resolve=>setTimeout(resolve,5));assert.equal(changes.length,2);assert.ok(Math.abs(renderer.getView().distanceM-initial.distanceM)<1e-8);
  renderer.panBy(0,1e8);assert.ok(renderer.getView().latitude<=85);renderer.destroy();assert.equal(env.frames.size,0);
});

test('geographic projection and picking agree on actual LOD triangles, including the dateline',t=>{
  const env=environment(t,{width:800,height:600}),source={...grid(9,7),bounds:[179.9,65,180.1,65.2]};
  const renderer=new TerrainRenderer(env.canvas,source,{navigation:'map',forceCanvas:true});
  // Keep the check at one true source node on each side of the longitude wrap.
  renderer.meshStride=2;
  for(const longitude of[179.975,-179.975]){
    const latitude=65.1,p=renderer.project(longitude,latitude);assert.ok(p);const hit=renderer.unproject(p.x,p.y);assert.ok(hit);
    const expected=longitude<0?longitude+360:longitude;
    assert.ok(Math.abs(hit.longitude-expected)<1e-6);assert.ok(Math.abs(hit.latitude-latitude)<1e-6);
    const height=sampleTerrainMeshElevation(renderer.model,(expected-180)/.2*renderer.model.widthM,0,2);
    assert.ok(Math.abs(hit.elevationM-height)<.02);
  }
  assert.equal(renderer.unproject(-1,100),null);assert.equal(renderer.project(0,0),null);
  assert.throws(()=>renderer.setView({...renderer.getView(),distanceM:NaN}),/view/);renderer.destroy();
});

test('terrain replacement preserves geographic camera and canvas until a new completed frame, discarding obsolete GPU work',t=>{
  const record=recordingGL(),env=environment(t,{gl:record.gl,width:160,height:120}),frames=[];
  const source=grid(9,9),renderer=new TerrainRenderer(env.canvas,source,{navigation:'map',onRender:value=>frames.push(value)});env.flush();
  renderer.setCartography(cartography(source));renderer.setGeometry({type:'LineString',coordinates:[[40.001,43.01],[40.019,43.01]]});env.flush();
  const view=renderer.getView();renderer.setView({...view,longitude:40.012,latitude:43.012});env.flush();
  record.setFrameStatus('pending');renderer.zoomBy(1.1);env.flush();assert.equal(record.pendingSyncs(),1);
  const expected=renderer.getView(),count=frames.length,canvas=env.parent.child,dimensions=[canvas.width,canvas.height];
  const replacement={...grid(11,7),bounds:[40.002,43.002,40.032,43.032]};replacement.elevations=replacement.elevations.map(value=>value+300);
  const prepared=createTerrainModel(replacement);renderer.setTerrain(replacement,{preparedModel:prepared});
  assert.equal(renderer.model,prepared);assert.equal(env.parent.child,canvas);assert.deepEqual([canvas.width,canvas.height],dimensions);assert.equal(frames.length,count);assert.equal(record.pendingSyncs(),0);
  const current=renderer.getView();for(const key of['longitude','latitude','yaw','pitch','distanceM'])assert.ok(Math.abs(current[key]-expected[key])<1e-7,key);
  assert.equal(renderer.cartography,null);assert.deepEqual(renderer.route,[]);assert.equal(canvas.dataset.routeSegments,'0');
  env.flush();assert.equal(record.pendingSyncs(),1);assert.equal(frames.length,count);record.setFrameStatus('ready');env.flush();assert.equal(frames.length,count+1);
  assert.equal(frames.at(-1).sourceVertices,77);assert.equal(record.counts.invalidObjectCalls,0);renderer.destroy();assert.equal(record.liveTextures(),0);assert.equal(record.pendingSyncs(),0);
});

test('invalid replacement cannot remove the working scene; map surfaces have no cut slab and sun stays geographic',t=>{
  const record=recordingGL(),env=environment(t,{gl:record.gl}),source=grid(7,7),renderer=new TerrainRenderer(env.canvas,source,{navigation:'map'});env.flush();
  const model=renderer.model,gpu=renderer.gpu,heights=model.heights.slice(),shadowCount=record.counts.shadowBudgets.length;
  assert.equal([...gpu.meshes.values()][0].boundaryCount,0);
  renderer.rotate(.6);env.flush();assert.equal(record.counts.shadowBudgets.length,shadowCount,'rotating the camera does not rotate the sun');
  assert.throws(()=>renderer.setTerrain({...source,elevations:[NaN]}),/elevation/);assert.equal(renderer.gpu,gpu);assert.equal(renderer.model,model);assert.deepEqual(model.heights,heights);
  record.loseContext();env.canvas.events.get('webglcontextlost')({preventDefault(){}});env.canvas.events.get('webglcontextrestored')();env.flush();assert.equal(renderer.gpu.mapMode,true);
  renderer.destroy();assert.equal(record.liveTextures(),0);
});

test('native regional coverage can zoom to a close physical view without manufacturing a denser grid',t=>{
 const env=environment(t,{width:1000,height:700}),source={...grid(9,9),bounds:[142.68,46.87,142.94,47.04]};
 const renderer=new TerrainRenderer(env.canvas,source,{navigation:'map',forceCanvas:true,initialView:{longitude:142.81,latitude:46.955,yaw:0,pitch:.85,distanceM:1500}});
 const model=renderer.model,opening=renderer.getView();for(let i=0;i<14;i++)renderer.zoomBy(1.4);
 assert.equal(renderer.model,model);assert.ok(renderer.getView().distanceM<opening.distanceM/4);assert.ok(renderer.getView().zoom<=1024);
 renderer.destroy();
});


test('Canvas map spends its fixed vertex budget on the visible native DEM while preserving the source',t=>{
 const source=JSON.parse(readFileSync(new URL('../public/terrain-regions/south-sakhalin-v1/terrain-grid.json',import.meta.url),'utf8'));
 const env=environment(t,{width:1262,height:580}),frames=[];
 const renderer=new TerrainRenderer(env.canvas,source,{navigation:'map',forceCanvas:true,onRender:frame=>frames.push(frame),initialView:{longitude:142.81,latitude:46.955,yaw:0,pitch:.85,distanceM:26590}});
 // Keep this native-data check about selection/allocation. Pixel equivalence is
 // exercised independently below with the real compatibility rasterizer.
 let mesh;renderer.software.render=value=>{mesh=value;};
 const elevations=[...source.elevations],heights=renderer.model.heights.slice();env.flush();
 const wide=frames.at(-1);assert.equal(wide.meshStride,8);assert.equal(wide.sourceVertices,417120);
 renderer.setView({...renderer.getView(),distanceM:2659});env.flush();
 const close=frames.at(-1);assert.equal(close.meshStride,2);assert.ok(close.renderedVertices<=16641);assert.ok(close.meshWindow[2]-close.meshWindow[0]<source.width-1);
 assert.equal(close.renderedVertices,mesh.count);assert.equal(close.triangles,mesh.indices.length/3);
 for(let i=0;i<mesh.count;i++){
  const id=mesh.sampleIds[i],x=id%source.width,y=Math.floor(id/source.width);
  assert.equal(x%close.meshStride,0);assert.equal(y%close.meshStride,0);
  assert.ok(Math.abs(mesh.uv[i*2]-x/(source.width-1))<1e-7);assert.ok(Math.abs(mesh.uv[i*2+1]-y/(source.height-1))<1e-7);
 }
 renderer.setView({...renderer.getView(),distanceM:600});env.flush();assert.equal(frames.at(-1).meshStride,1);
 for(const longitude of[142.795,142.8,142.81,142.82]){renderer.setView({...renderer.getView(),longitude});env.flush();assert.ok(frames.at(-1).renderedVertices<=16641);assert.ok(renderer.windowMeshes.size<=2);}
 assert.deepEqual(source.elevations,elevations);assert.deepEqual(renderer.model.heights,heights);assert.equal(renderer.meshes.size,0);
 renderer.destroy();assert.equal(renderer.windowMeshes.size,0);
});

test('visible mesh windows conservatively include every real projected sample across tilt, rotation and insets',t=>{
 const source={...grid(129,129),bounds:[142.7,46.9,142.8,47]},env=environment(t,{width:390,height:844});
 source.elevations=source.elevations.map((_,i)=>80+620*Math.exp(-((i%129-80)**2+(Math.floor(i/129)-47)**2)/330)+50*Math.sin(i%129/9));
 const renderer=new TerrainRenderer(env.canvas,source,{navigation:'map',forceCanvas:true});let camera;
 renderer.software.render=(_mesh,value)=>{camera=value;};
 for(const [yaw,pitch,insets] of[[0,.85,{top:192,right:64,bottom:64,left:16}],[1.3,.48,{bottom:400,left:16,right:16}],[-2.6,1.22,{top:70,left:84}],[.4,.28,{top:900,right:500,bottom:900,left:500}]]){
  renderer.setViewportInsets(insets);renderer.setView({longitude:142.75,latitude:46.95,yaw,pitch,distanceM:1800});env.flush();
  const selected=selectVisibleTerrainMesh(renderer.model,camera,16641,3),window=visibleTerrainSampleWindow(renderer.model,camera),m=camera.matrix,model=renderer.model;
  assert.ok(window);assert.ok(selected.count<=16641);assert.ok(Number.isInteger(Math.log2(selected.step)));
  let visible=0;
  for(let row=0;row<source.height;row++)for(let col=0;col<source.width;col++){
   const x=(col/(source.width-1)-.5)*model.width,y=(.5-row/(source.height-1))*model.height,z=model.heights[row*source.width+col];
   const w=m[3]*x+m[7]*y+m[11]*z+m[15],px=(m[0]*x+m[4]*y+m[8]*z+m[12])/w+camera.offset[0],py=(m[1]*x+m[5]*y+m[9]*z+m[13])/w+camera.offset[1],pz=(m[2]*x+m[6]*y+m[10]*z+m[14])/w;
   if(w<=camera.near||Math.abs(px)>1||Math.abs(py)>1||Math.abs(pz)>1)continue;
   visible++;assert.ok(col>=window[0]-1e-6&&col<=window[2]+1e-6&&row>=window[1]-1e-6&&row<=window[3]+1e-6,'visible source peak was clipped');
   assert.ok(col>=selected.range[0]&&col<=selected.range[2]&&row>=selected.range[1]&&row<=selected.range[3]);
  }
  assert.ok(visible>100);assert.equal(buildTerrainMesh(model,selected.step,selected.range).count,selected.count);
 }
 assert.throws(()=>buildTerrainMesh(renderer.model,2,[1,0,64,64]),/window/);
 renderer.destroy();
});

test('cropping the software mesh preserves actual terrain, cartography, mask and draped-route pixels',t=>{
 const source={...grid(129,129),bounds:[40,43,40.08,43.08]};source.elevations=source.elevations.map((_,i)=>100+50*Math.sin(i%129/8)+30*Math.cos(Math.floor(i/129)/11));
 const env=environment(t,{width:128,height:96}),renderer=new TerrainRenderer(env.canvas,source,{navigation:'map',forceCanvas:true,displayMask:displayMask(source,[255,0,255,255])});
 renderer.setCartography(cartography(source));renderer.setGeometry({type:'LineString',coordinates:[[40.025,43.045],[40.055,43.035]]});
 const draw=renderer.software.render.bind(renderer.software);let args;
 renderer.software.render=(...value)=>{args=value;draw(...value);};
 for(const [yaw,pitch] of[[0,.85],[1.1,.65],[-1.4,1.15]]){
  renderer.setView({longitude:40.04,latitude:43.04,yaw,pitch,distanceM:900});env.flush();
  const [cropped,...rest]=args,pixels=env.ctx.lastImage.data.slice(),depth=renderer.software.depth.slice();
  const full=buildTerrainMesh(renderer.model,cropped.step);assert.ok(cropped.count<full.count);
  draw(full,...rest);assert.deepEqual(env.ctx.lastImage.data,pixels,'same measured triangles must produce identical visible pixels');assert.deepEqual(renderer.software.depth,depth);
 }
 assert.ok(renderer.software.shadowCache.size<=4);renderer.destroy();
});

test('map inset and canvas resize preserve physical camera distance and report the actual completed viewport',t=>{
 const env=environment(t,{width:390,height:844}),frames=[];
 const renderer=new TerrainRenderer(env.canvas,grid(17,17),{navigation:'map',forceCanvas:true,viewportInsets:{top:192,right:64,bottom:64,left:16},initialView:{longitude:40.01,latitude:43.01,yaw:.3,pitch:.85,distanceM:5000},onRender:frame=>frames.push(frame)});
 renderer.software.render=()=>{};env.flush();const opening=renderer.getView();
 const check=()=>{const view=renderer.getView();for(const key of['longitude','latitude','yaw','pitch','distanceM'])assert.ok(Math.abs(view[key]-opening[key])<1e-8,key);assert.ok(Math.abs(frames.at(-1).geographicView.distanceM-opening.distanceM)<1e-8);};
 assert.deepEqual(frames.at(-1).viewport,{width:390,height:844,insets:{top:192,right:64,bottom:64,left:16}});check();
 renderer.setViewportInsets({bottom:400,left:16,right:16});env.flush();check();
 env.resize(1262,580);assert.ok(Math.abs(renderer.getView().distanceM-opening.distanceM)<1e-8,'a layout resize cannot silently change the desired physical view');
 renderer.setViewportInsets({top:180,right:88,bottom:36,left:20});env.flush();check();
 assert.deepEqual(frames.at(-1).viewport,{width:1262,height:580,insets:{top:180,right:88,bottom:36,left:20}});
 // Also cover a RAF that arrives before the host ResizeObserver callback.
 env.resize(640,480);renderer.request();env.flush();check();assert.equal(frames.at(-1).viewport.width,640);
 renderer.setViewportInsets({top:10000,right:10000,bottom:10000,left:10000});env.flush();check();
 const measured=frames.at(-1).viewport.insets;assert.ok(Math.abs(measured.top+measured.bottom-480*.88)<1e-8);assert.ok(Math.abs(measured.left+measured.right-640*.88)<1e-8);
 renderer.destroy();
});


test('GPU map refines native visible samples and bounds mesh resources across pending frames and context recovery',t=>{
 const source=JSON.parse(readFileSync(new URL('../public/terrain-regions/south-sakhalin-v1/terrain-grid.json',import.meta.url),'utf8'));
 const record=recordingGL(),env=environment(t,{gl:record.gl,width:1262,height:580}),frames=[];
 const renderer=new TerrainRenderer(env.canvas,source,{navigation:'map',initialView:{longitude:142.81,latitude:46.955,yaw:0,pitch:.85,distanceM:26590},onRender:frame=>frames.push(frame)});env.flush();
 const heightTexture=renderer.gpu.heightTexture,normalTexture=renderer.gpu.normalTexture,uploads=record.counts.uploads.length;
 assert.equal(frames.at(-1).meshStride,2);assert.ok(frames.at(-1).renderedVertices<=263169);
 renderer.setView({...renderer.getView(),distanceM:2659});env.flush();assert.equal(frames.at(-1).meshStride,1);
 renderer.setView({...renderer.getView(),distanceM:600});env.flush();
 const close=frames.at(-1),mesh=[...renderer.windowMeshes.values()].at(-1),draw=record.counts.draws.filter(value=>value.kind==='elements').at(-1),meshUploads=record.counts.bufferUploads.slice(-3);
 assert.equal(close.meshStride,1);assert.ok(close.renderedVertices<16641);assert.equal(draw.args[1],close.triangles*3);
 assert.equal(meshUploads[0].length,mesh.uv.length);assert.deepEqual(meshUploads[0].values,mesh.uv.slice(0,16));assert.equal(meshUploads[1].length,mesh.indices.length);
 for(const longitude of[142.795,142.8,142.81,142.82]){
  renderer.setView({...renderer.getView(),longitude});env.flush();
  assert.equal(frames.at(-1).meshStride,1);assert.ok(renderer.windowMeshes.size<=2);assert.ok(renderer.gpu.meshes.size<=2);
  assert.ok(record.liveBuffers()<=7);assert.ok(record.liveVertexArrays()<=6);
 }
 assert.equal(renderer.gpu.heightTexture,heightTexture);assert.equal(renderer.gpu.normalTexture,normalTexture);assert.equal(record.counts.uploads.length,uploads,'panning cannot upload or invent elevation/material texels');
 assert.ok(record.counts.deletedBuffers>=12);assert.equal(record.counts.invalidObjectCalls,0);
 record.setFrameStatus('pending');renderer.setView({...renderer.getView(),longitude:142.815});env.flush();assert.equal(record.pendingSyncs(),1);
 const before={buffers:record.counts.buffers,vaos:record.counts.vertexArrays,deleted:record.counts.deletedBuffers,frames:frames.length};
 renderer.setView({...renderer.getView(),longitude:142.805});env.flush();
 assert.deepEqual({buffers:record.counts.buffers,vaos:record.counts.vertexArrays,deleted:record.counts.deletedBuffers,frames:frames.length},before,'pending GPU work must retain its mesh until the fence completes');
 record.setFrameStatus('ready');env.flush();env.flush();assert.equal(frames.at(-1).geographicView.longitude,142.805);assert.ok(renderer.gpu.meshes.size<=2);
 record.loseContext();env.canvas.events.get('webglcontextlost')({preventDefault(){}});env.canvas.events.get('webglcontextrestored')();env.flush();
 assert.equal(frames.at(-1).renderer,'webgl2');assert.equal(frames.at(-1).meshStride,1);assert.equal(renderer.gpu.meshes.size,1);assert.equal(record.counts.invalidObjectCalls,0);
 renderer.destroy();assert.equal(record.liveBuffers(),0);assert.equal(record.liveVertexArrays(),0);assert.equal(record.liveTextures(),0);assert.equal(record.pendingSyncs(),0);
 assert.equal(record.counts.deletedBuffers+record.counts.contextReleasedBuffers,record.counts.buffers);assert.equal(record.counts.deletedVertexArrays+record.counts.contextReleasedVertexArrays,record.counts.vertexArrays);assert.equal(record.counts.invalidObjectCalls,0);
});
