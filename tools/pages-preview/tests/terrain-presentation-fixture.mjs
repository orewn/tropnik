import {terrainFullMaskFixture} from './terrain-full-mask-fixture.mjs';

const check=(value,message)=>{if(!value)throw new Error(message);};
const digest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
function difference(a,b){
 check(a.width===b.width&&a.height===b.height,'Different pixel dimensions');let differentPixels=0,maxChannelDelta=0;
 for(let i=0;i<a.pixels.length;i+=4){let changed=false;for(let c=0;c<4;c++){const delta=Math.abs(a.pixels[i+c]-b.pixels[i+c]);if(delta){changed=true;maxChannelDelta=Math.max(maxChannelDelta,delta);}}if(changed)differentPixels++;}
 return{differentPixels,maxChannelDelta,totalPixels:a.width*a.height};
}
function inspectRoute(terrain,route){
 const {width,height}=terrain,sky=[223,230,218],isSky=index=>sky.every((value,c)=>Math.abs(terrain.pixels[index*4+c]-value)<=2);
 let terrainPixels=0,routePixels=0,outsideWitnesses=0,routeLeaks=0;
 for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
  const index=y*width+x;if(!isSky(index))terrainPixels++;
  if([0,1,2].some(c=>Math.abs(terrain.pixels[index*4+c]-route.pixels[index*4+c])>8))routePixels++;
  let outside=true;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(!isSky((y+dy)*width+x+dx))outside=false;
  if(outside){outsideWitnesses++;if(sky.some((value,c)=>Math.abs(route.pixels[index*4+c]-value)>2))routeLeaks++;}
 }
 check(terrainPixels>=512&&routePixels>=32&&outsideWitnesses>=128,'Non-flat terrain, route and outside witnesses must be visible');
 check(routeLeaks===0,'A thick route halo escaped the rendered terrain/territory stencil');
 return{terrainPixels,routePixels,outsideWitnesses,routeLeaks};
}

// These wrappers observe real calls and always delegate unchanged. They do not
// fake fence readiness, draw pixels, or force the renderer onto a test path.
function observePresentation(canvas,deferred,afterFence){
 const state={fencesCreated:0,fencesDeleted:0,maxPending:0,waitCalls:0,waitFlags:[],waitTimeouts:[],readyFences:0,defaultSceneDraws:0,defaultPresentationDraws:0,pendingDefaultDraws:0,pendingDefaultClears:0,unreadyPresentationDraws:0,offscreenSceneDraws:0,resolves:0,badResolves:0,pendingResizes:0,onRenderWithoutPresentation:0,completedCallbacks:0,queuedAtCompletion:0,nullFences:0,allocations:[]};
 const fences=new Map(),shaderSources=[],shaderText=new WeakMap(),programShaders=new WeakMap(),programKinds=new WeakMap();let sequence=0,lastReady=0,lastPresented=0,drawFramebuffer=null,readFramebuffer=null,program=null,observedContext,reportedPresentations=0;
 for(const property of ['width','height']){
  const descriptor=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,property);
  Object.defineProperty(canvas,property,{configurable:true,get:()=>descriptor.get.call(canvas),set:value=>{if(fences.size)state.pendingResizes++;descriptor.set.call(canvas,value);}});
 }
 const getContext=canvas.getContext.bind(canvas);
 canvas.getContext=function(kind,attributes){
  const gl=getContext(kind,attributes);if(kind!=='webgl2'||!gl||observedContext===gl)return gl;observedContext=gl;
  const wrap=(name,observe)=>{const original=gl[name].bind(gl);gl[name]=(...args)=>observe(original,...args);};
  wrap('shaderSource',(original,shader,source)=>{
   shaderText.set(shader,source);
   if(source.includes('uniform sampler2D uCartography;')&&source.includes('vec3 perturbNormal('))shaderSources.push({kind:'terrain-fragment',source});
   if(source.includes('vPosition=vec3((aUV.x-.5)'))shaderSources.push({kind:'terrain-vertex',source});
   if(source.includes('uniform highp sampler2D uCompleted;'))shaderSources.push({kind:'presentation-fragment',source});
   check(shaderSources.length<=16,'Unbounded observed shader programs');return original(shader,source);
  });
  wrap('attachShader',(original,value,shader)=>{const shaders=programShaders.get(value)||[];shaders.push(shader);programShaders.set(value,shaders);return original(value,shader);});
  wrap('linkProgram',(original,value)=>{const sources=(programShaders.get(value)||[]).map(shader=>shaderText.get(shader)||'');programKinds.set(value,sources.some(source=>source.includes('uniform highp sampler2D uCompleted;'))?'presentation':'scene');return original(value);});
  wrap('useProgram',(original,value)=>{program=value;return original(value);});
  wrap('bindFramebuffer',(original,target,value)=>{if(target===gl.FRAMEBUFFER||target===gl.DRAW_FRAMEBUFFER)drawFramebuffer=value;if(target===gl.FRAMEBUFFER||target===gl.READ_FRAMEBUFFER)readFramebuffer=value;return original(target,value);});
  wrap('fenceSync',(original,...args)=>{const sync=original(...args);state.fencesCreated++;if(sync){fences.set(sync,{sequence:++sequence,ready:false});state.maxPending=Math.max(state.maxPending,fences.size);}else state.nullFences++;if(afterFence)queueMicrotask(()=>afterFence());return sync;});
  wrap('clientWaitSync',(original,sync,flags,timeout)=>{
   state.waitCalls++;if(!state.waitFlags.includes(flags))state.waitFlags.push(flags);if(!state.waitTimeouts.includes(timeout))state.waitTimeouts.push(timeout);
   const result=original(sync,flags,timeout),frame=fences.get(sync);
   if(frame&&!frame.ready&&(result===gl.ALREADY_SIGNALED||result===gl.CONDITION_SATISFIED)){frame.ready=true;state.readyFences++;lastReady=frame.sequence;}
   return result;
  });
  wrap('deleteSync',(original,sync)=>{if(fences.delete(sync))state.fencesDeleted++;return original(sync);});
  for(const name of ['drawArrays','drawElements'])wrap(name,(original,...args)=>{
   if(drawFramebuffer===null){
    if(fences.size)state.pendingDefaultDraws++;
    if(programKinds.get(program)==='presentation'){state.defaultPresentationDraws++;if(!lastReady||lastReady===lastPresented||fences.size)state.unreadyPresentationDraws++;lastPresented=lastReady;}
    else state.defaultSceneDraws++;
   }else if(programKinds.get(program)!=='presentation')state.offscreenSceneDraws++;
   return original(...args);
  });
  for(const name of ['clear','clearBufferfv','clearBufferiv','clearBufferuiv','clearBufferfi'])wrap(name,(original,...args)=>{if(drawFramebuffer===null&&fences.size)state.pendingDefaultClears++;return original(...args);});
  wrap('blitFramebuffer',(original,...args)=>{state.resolves++;if(!drawFramebuffer||!readFramebuffer||args[0]!==args[4]||args[1]!==args[5]||args[2]!==args[6]||args[3]!==args[7]||args[8]!==gl.COLOR_BUFFER_BIT||args[9]!==gl.NEAREST)state.badResolves++;return original(...args);});
  wrap('renderbufferStorageMultisample',(original,...args)=>{
   const result=original(...args);state.allocations.push({samples:gl.getRenderbufferParameter(gl.RENDERBUFFER,gl.RENDERBUFFER_SAMPLES),format:gl.getRenderbufferParameter(gl.RENDERBUFFER,gl.RENDERBUFFER_INTERNAL_FORMAT),width:gl.getRenderbufferParameter(gl.RENDERBUFFER,gl.RENDERBUFFER_WIDTH),height:gl.getRenderbufferParameter(gl.RENDERBUFFER,gl.RENDERBUFFER_HEIGHT),depthBits:gl.getRenderbufferParameter(gl.RENDERBUFFER,gl.RENDERBUFFER_DEPTH_SIZE),stencilBits:gl.getRenderbufferParameter(gl.RENDERBUFFER,gl.RENDERBUFFER_STENCIL_SIZE)});check(state.allocations.length<=32,'Unbounded framebuffer allocations');return result;
  });
  return gl;
 };
 return{shaderSources,onRender(pending){state.completedCallbacks++;if(pending==='true')state.queuedAtCompletion++;if(deferred&&state.defaultPresentationDraws<=reportedPresentations)state.onRenderWithoutPresentation++;reportedPresentations=state.defaultPresentationDraws;},summary(){return{...state,liveFences:fences.size,mode:deferred?'deferred-msaa':'immutable-direct-reference'};}};
}

// The reference constructor is an immutable, byte-checked f36 module. The
// optimized constructor is the current production renderer, without overrides.
// Readback happens in onRender while preserveDrawingBuffer is still false.
export async function runTerrainPresentationCase(OptimizedRenderer,BaselineRenderer,{maskKind='full',rotate=0,zoom=1,restore=false}={}){
 const fixture=terrainFullMaskFixture(),{grid,cartography,geometry}=fixture,captures=[],variants=[],comparisons=[],errors=[];
 const inputHeightSHA256=await digest(grid.elevations),minElevation=Math.min(...grid.elevations),maxElevation=Math.max(...grid.elevations);
 check(maxElevation-minElevation>1000,'The source fixture must have a real non-flat ridge');
 let phase='baseline',current;
 const close=()=>{
  if(!current)return;const {renderer,canvas,host}=current;renderer.destroy();canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();host.remove();current=undefined;
 };
 const runVariant=async(Renderer,variant)=>{
  close();const host=document.createElement('div'),canvas=document.createElement('canvas');canvas.style.cssText='display:block;width:512px;height:384px';host.appendChild(canvas);document.body.appendChild(host);
  const observation=observePresentation(canvas,variant==='optimized'),{shaderSources}=observation;
  const ownedInput=fixture.mask(maskKind==='full'?'full':'known'),allowedPixels=ownedInput.source.allowedPixels;
  let next,frame=0,last,fatal;
  const renderer=new Renderer(canvas,grid,{displayMask:ownedInput,onError:message=>errors.push(String(message)),onFatal:message=>{fatal=new Error(String(message));next?.reject(fatal);},onRender:info=>{
   try{
    const surface=host.querySelector('canvas');check(surface===canvas&&info.renderer==='webgl2','Canvas fallback cannot stand in for the real WebGL2 shader proof');
    const gl=canvas.getContext('webgl2');check(gl&&gl.getParameter(gl.STENCIL_BITS)>=1,'The real display mask must retain its stencil');
    check(gl.getParameter(gl.READ_FRAMEBUFFER_BINDING)===null&&gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)===null,'onRender must expose the completed default framebuffer');
    observation.onRender(canvas.dataset.terrainPending);if(variant==='optimized'){
     check(canvas.dataset.terrainPresentation==='deferred-msaa','The optimized renderer fell back to the direct path');
     check(['true','false'].includes(canvas.dataset.terrainPending),'Missing pending diagnostic');
     // A completed frame may still have an identical redraw queued by ResizeObserver.
     // Observe every actual presentation, but retain only bounded settled captures.
     if(canvas.dataset.terrainPending==='true')return;
    }
    const {width,height}=canvas,raw=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,raw);check(gl.getError()===gl.NO_ERROR,'WebGL readback failed');
    const pixels=new Uint8Array(raw.length);for(let row=0;row<height;row++)pixels.set(raw.subarray((height-1-row)*width*4,(height-row)*width*4),row*width*4);
    check(info.graphicsFallback===null,'A graphics fallback occurred');check(info.displayMask?.allowedPixels===allowedPixels,'Caller mutation changed the owned mask');
    check(canvas.dataset.heightScale==='1'&&info.sourceVertices===grid.width*grid.height,'Source height resolution or metre scale changed');
    last={width,height,pixels,png:canvas.toDataURL('image/png').split(',')[1],renderer:info.renderer,view:info.view,pixelRatio:info.pixelRatio,meshStride:info.meshStride,sourceVertices:info.sourceVertices,triangles:info.triangles,heightScale:canvas.dataset.heightScale,displayMask:info.displayMask,contextAttributes:gl.getContextAttributes(),samples:gl.getParameter(gl.SAMPLES),stencilBits:gl.getParameter(gl.STENCIL_BITS),depthBits:gl.getParameter(gl.DEPTH_BITS),presentation:variant==='optimized'?canvas.dataset.terrainPresentation:'immutable-direct-reference',pending:variant==='optimized'?canvas.dataset.terrainPending:null};frame++;next?.resolve(last);
   }catch(error){fatal=error;next?.reject(error);}
  }});
  const wait=(before=frame)=>new Promise((resolve,reject)=>{
   if(fatal){reject(fatal);return;}if(frame>before){resolve(last);return;}
   const timer=setTimeout(()=>{next=undefined;reject(new Error('Full mask fixture frame timed out'));},12000);
   next={resolve:value=>{clearTimeout(timer);next=undefined;resolve(value);},reject:error=>{clearTimeout(timer);next=undefined;reject(error);}};
  });
  current={renderer,canvas,host};
  // Both pixels and metadata are caller-owned. Neither the first frame nor
  // context recovery may reread this altered input for shader selection.
  ownedInput.pixels.fill(maskKind==='full'?0:255);ownedInput.source.allowedPixels=maskKind==='full'?0:ownedInput.pixels.length;
  renderer.setCartography(cartography);if(rotate)renderer.rotate(rotate);if(zoom!==1)renderer.zoomBy(zoom);
  const frames={};
  const retain=async(name,value)=>{frames[name]=value;const {pixels,...capture}=value;captures.push({variant,phase:name,...capture,pixelSHA256:await digest(pixels)});};
  phase=variant+'-terrain';await retain('terrain',await wait(0));
  phase=variant+'-route';let before=frame;const route=renderer.setGeometry(geometry);check(route?.segments>=3,'The actual edge/diagonal route geometry was not accepted');await retain('route',await wait(before));
  const witnesses=inspectRoute(frames.terrain,frames.route);let recovery=null;
  if(restore){
   phase=variant+'-restore';const extension=canvas.getContext('webgl2').getExtension('WEBGL_lose_context');check(extension,'The real context loss extension is unavailable');
   let lost=0,restored=0,trusted=true;
   canvas.addEventListener('webglcontextlost',event=>{lost++;trusted=trusted&&event.isTrusted;},{once:true});canvas.addEventListener('webglcontextrestored',event=>{restored++;trusted=trusted&&event.isTrusted;},{once:true});
   const loss=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('No actual WebGL loss event')),2000);canvas.addEventListener('webglcontextlost',()=>{clearTimeout(timer);resolve();},{once:true});});
   extension.loseContext();await loss;await new Promise(resolve=>setTimeout(resolve,80));before=frame;extension.restoreContext();await retain('restored',await wait(before));
   check(lost===1&&restored===1&&trusted,'Real trusted context recovery was not observed');
   const parity=difference(frames.route,frames.restored);check(parity.differentPixels===0,'Context recovery changed the exact route/terrain pixels');
   recovery={lost,restored,trusted,comparison:parity,witnesses:inspectRoute(frames.terrain,frames.restored)};
  }
  const shaders=[];for(const shader of shaderSources)shaders.push({kind:shader.kind,sha256:await digest(new TextEncoder().encode(shader.source)),maskDiscard:shader.source.includes('if(texture(uDisplayMask,vUV).r<.5)discard;')});
  const fragments=shaders.filter(shader=>shader.kind==='terrain-fragment'),vertices=shaders.filter(shader=>shader.kind==='terrain-vertex');
  check(fragments.length===(restore?2:1)&&vertices.length===fragments.length,'Every initial/restored program must be observed');
  check(fragments.every(shader=>shader.maskDiscard===(maskKind!=='full')),'The actual compiled shader did not select the intended full/mixed path');
  close();const observed=observation.summary();
  if(variant==='optimized'){
   check(observed.maxPending===1&&observed.liveFences===0&&observed.fencesDeleted===observed.fencesCreated,'The presentation must own at most one pending frame and release it');
   check(observed.defaultPresentationDraws>0&&observed.offscreenSceneDraws>0&&observed.resolves>0,'The real offscreen scene and presentation paths were not observed');
   for(const key of ['defaultSceneDraws','pendingDefaultDraws','pendingDefaultClears','unreadyPresentationDraws','badResolves','pendingResizes','onRenderWithoutPresentation','nullFences'])check(observed[key]===0,'Unsafe presentation observation: '+key);
   check(JSON.stringify(observed.waitFlags)==='[0]'&&JSON.stringify(observed.waitTimeouts)==='[0]','The completion poll must be nonblocking');
  }else check(observed.fencesCreated===0&&observed.defaultPresentationDraws===0&&observed.defaultSceneDraws>0,'The immutable reference must retain direct rendering');
  const summary={variant,renderer:'webgl2',allowedPixels,callerMaskMutationChecked:true,witnesses,recovery,shaders,observation:observed};variants.push(summary);return{frames,summary};
 };
 try{
  const baseline=await runVariant(BaselineRenderer,'baseline'),optimized=await runVariant(OptimizedRenderer,'optimized');
  for(const name of ['terrain','route',...(restore?['restored']:[])]){
   const old=baseline.frames[name],current=optimized.frames[name],result=difference(old,current);comparisons.push({phase:name,...result,baselinePixelSHA256:await digest(old.pixels),optimizedPixelSHA256:await digest(current.pixels)});
   check(result.differentPixels===0,`${maskKind}/${name}: ${result.differentPixels} pixels changed, maximum channel delta ${result.maxChannelDelta}`);
   for(const key of ['view','pixelRatio','meshStride','sourceVertices','triangles','heightScale','displayMask','contextAttributes','samples','stencilBits','depthBits'])check(JSON.stringify(old[key])===JSON.stringify(current[key]),`${key} changed with deferred presentation`);
  }
  const oldVertices=baseline.summary.shaders.filter(shader=>shader.kind==='terrain-vertex').map(shader=>shader.sha256),newVertices=optimized.summary.shaders.filter(shader=>shader.kind==='terrain-vertex').map(shader=>shader.sha256);
  check(JSON.stringify(oldVertices)===JSON.stringify(newVertices),'The full-resolution height vertex shader changed');
  check(await digest(grid.elevations)===inputHeightSHA256,'Rendering changed the source height data');
  return{verified:true,phase:'complete',maskKind,view:{rotate,zoom},restore,grid:{width:grid.width,height:grid.height,minElevation,maxElevation,heightSHA256:inputHeightSHA256,unchanged:true},variants,comparisons,captures,errors};
 }catch(error){return{verified:false,phase,maskKind,view:{rotate,zoom},restore,variants,comparisons,captures,errors,error:String(error?.stack||error).slice(0,6000)};}
 finally{close();}
}
