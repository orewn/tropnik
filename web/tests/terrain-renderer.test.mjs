import test from 'node:test';
import assert from 'node:assert/strict';
import {createTerrainModel, createTerrainModelAsync, validatePreparedTerrainModel, buildTerrainMesh, selectTerrainMeshStride, drapeTerrainRoute, sampleTerrainMeshElevation, sampleTerrainShadow, TerrainRenderer, validateTerrainCartography, sampleTerrainCartography} from '../public/terrain/terrain-renderer.js';

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
  return {canvas,ctx,parent,frames,doc,listeners,flush(){const ready=[...frames.values()];frames.clear();ready.forEach(fn=>fn(0));}};
}

function recordingGL({anisotropy=0}={}){
  const counts={framebuffers:0,buffers:0,shadowBudgets:[],textures:0,deletedTextures:0,contextReleasedTextures:0,invalidObjectCalls:0,uploads:[],anisotropyQueries:0,anisotropyValues:[],shaderSources:[],stencilState:[]},enums=new Map(),generations=new WeakMap(),liveTextures=new Set();let next=1,gl,generation=0,error=0;
  const create=type=>{const object={};generations.set(object,generation);if(type==='Texture')liveTextures.add(object);return object;};
  const remove=(type,object)=>{
    if(generations.get(object)!==generation){counts.invalidObjectCalls++;error=gl.INVALID_OPERATION;return;}
    generations.delete(object);if(type==='Texture'){counts.deletedTextures++;liveTextures.delete(object);}
  };
  const extension={MAX_TEXTURE_MAX_ANISOTROPY_EXT:0x84ff,TEXTURE_MAX_ANISOTROPY_EXT:0x84fe};
  const methods={NO_ERROR:0,getParameter:key=>key===extension.MAX_TEXTURE_MAX_ANISOTROPY_EXT?anisotropy:16384,getError:()=>{const result=error;error=0;return result;},getExtension:name=>{if(name!=='EXT_texture_filter_anisotropic')return null;counts.anisotropyQueries++;return anisotropy?extension:null;},getShaderParameter:()=>true,getProgramParameter:()=>true,
    texParameterf:(_target,key,value)=>{if(key===extension.TEXTURE_MAX_ANISOTROPY_EXT)counts.anisotropyValues.push(value);},
    shaderSource:(_shader,source)=>counts.shaderSources.push(source),
    stencilMask:value=>counts.stencilState.push(['mask',value]),stencilFunc:(...values)=>counts.stencilState.push(['function',...values]),stencilOp:(...values)=>counts.stencilState.push(['operation',...values]),
    checkFramebufferStatus:()=>gl.FRAMEBUFFER_COMPLETE,getUniformLocation:(_program,name)=>name,
    uniform1i:(name,value)=>{if(name==='uSteps')counts.shadowBudgets.push(value);},
    createFramebuffer:()=>{counts.framebuffers++;return create('Framebuffer');},createBuffer:()=>{counts.buffers++;return create('Buffer');},
    createTexture:()=>{counts.textures++;return create('Texture');},deleteTexture:object=>remove('Texture',object),
    texImage2D:(_target,_level,_internal,width,height,_border,_format,_type,data)=>counts.uploads.push({width,height,pixels:data?.slice(0,16)}),
  };
  gl=new Proxy(methods,{get(target,key){
    if(key in target)return target[key];
    if(/^[A-Z0-9_]+$/.test(String(key))){if(!enums.has(key))enums.set(key,next++);return enums.get(key);}
    if(String(key).startsWith('create'))return()=>create(String(key).slice(6));
    if(String(key).startsWith('delete'))return object=>remove(String(key).slice(6),object);return()=>{};
  }});
  return{gl,counts,loseContext(){generation++;counts.contextReleasedTextures+=liveTextures.size;liveTextures.clear();}};
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
      assert.equal(record.counts.shaderSources[11],specialized,'restoration selects from the owned validated mask');
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
 for(const change of[s=>s.width=2048,s=>s.height=1,s=>s.pixels=new Uint8ClampedArray(15),s=>s.source.bounds[0]+=.0001,s=>s.source.projection='EPSG:3857',s=>s.source.sampleLayout='pixel-centres',s=>s.source.rowOrder='south-to-north',s=>s.source.loadedTiles=2,s=>s.source.requestedTiles=17]){
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
