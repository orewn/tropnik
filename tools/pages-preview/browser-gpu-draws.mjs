/** Diagnostic-only public WebGL2 observer, serialized into the existing CDP
 * preload. It never reads MapLibre objects, changes GL drawing state, submits a
 * draw, or waits for the GPU. Query results follow the Khronos availability and
 * disjoint rules: https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/
 * Sampling is the first bounded calls per program/FBO/viewport group, not a
 * statistically representative estimate of all GPU work. */
export function installTerrainGPUDraws(root=globalThis,{maxQueries=128,maxQueriesPerGroup=8,maxEvents=2048,maxGroups=128}={}){
 if(root.__tropnikTerrainGPUDraws)return root.__tropnikTerrainGPUDraws;
 const bounded=(value,maximum)=>Number.isInteger(value)&&value>=0?Math.min(value,maximum):maximum;
 maxQueries=bounded(maxQueries,128);maxQueriesPerGroup=bounded(maxQueriesPerGroup,8);maxEvents=bounded(maxEvents,2048);maxGroups=bounded(maxGroups,128);
 const now=()=>root.performance?.now?.()??Date.now(),errors=[],contexts=[],events=[],groups=[],programs=[],querySamples=[],restorations=[];
 const receipt={schemaVersion:1,diagnosticOnly:true,verified:false,releaseEligible:false,method:'EXT_disjoint_timer_query_webgl2',scope:'one-native-action-maplibre-canvas-only',started:false,stopped:false,recording:false,limits:{maxQueries,maxQueriesPerGroup,maxEvents,maxGroups},sampling:'first-calls-per-program-framebuffer-viewport-group',contexts,events,groups,programs,querySamples,errors,totals:{calls:0,drawCalls:0,mipmapCalls:0,submittedVerticesOrIndices:0,eventsDropped:0,groupsDropped:0},queries:{attempted:0,started:0,pending:0,completed:0,unsupported:0,interference:0,limitSkipped:0,groupLimitSkipped:0,disjoint:0,unavailable:0,errors:0},collectionPasses:0};
 const states=[],seen=new WeakSet(),groupMap=new Map();
 const error=(phase,value)=>{if(errors.length<24)errors.push({phase,message:String(value?.message??value).slice(0,300)});};
 const safe=(phase,fn)=>{try{return fn();}catch(value){error(phase,value);return undefined;}};
 const snapshot=()=>JSON.parse(JSON.stringify(receipt));
 const restore=()=>{for(const fn of restorations.splice(0).reverse())safe('restore',fn);};
 const wrap=(object,name,after,around)=>{
  const original=object[name];if(typeof original!=='function')return;
  const descriptor=Object.getOwnPropertyDescriptor(object,name);
  const replacement=function(...args){
   if(around)return around.call(this,original,args);
   const result=Reflect.apply(original,this,args);
   if(this===object)safe(name,()=>after(args,result));
   return result;
  };
  Object.defineProperty(object,name,{configurable:true,writable:true,value:replacement});
  restorations.push(()=>{if(object[name]===replacement){if(descriptor)Object.defineProperty(object,name,descriptor);else delete object[name];}});
 };
 const hash=source=>{let value=2166136261;for(let index=0;index<source.length;index++)value=Math.imul(value^source.charCodeAt(index),16777619);return(value>>>0).toString(16).padStart(8,'0');};
 const attach=gl=>{
  if(!gl||seen.has(gl)||states.length>=1||receipt.stopped)return;seen.add(gl);
  const info={id:contexts.length+1,canvas:{className:String(gl.canvas?.className??''),width:gl.drawingBufferWidth,height:gl.drawingBufferHeight},timer:{supported:false,reason:'not-armed'}};
  const state={gl,info,program:null,drawFramebuffer:null,viewport:[0,0,gl.drawingBufferWidth,gl.drawingBufferHeight],activeUnit:0,units:new Map(),textures:new WeakMap(),framebuffers:new WeakMap(),programStates:new WeakMap(),uniformLocations:new WeakMap(),nextTexture:1,nextFramebuffer:1,nextProgram:1,ext:null,pending:[],invalid:false};
  contexts.push(info);states.push(state);
  const texture=value=>{
   if(!value)return null;
   let item=state.textures.get(value);
   if(!item){item={id:state.nextTexture++,width:null,height:null,levels:null,internalFormat:null,anisotropy:1,minFilter:gl.NEAREST_MIPMAP_LINEAR,magFilter:gl.LINEAR,allocation:'unobserved'};state.textures.set(value,item);}
   return item;
  };
  const framebuffer=value=>{
   if(!value)return null;
   let item=state.framebuffers.get(value);if(!item){item={id:state.nextFramebuffer++,attachments:new Map()};state.framebuffers.set(value,item);}return item;
  };
  const program=value=>{
   if(!value)return null;
   let item=state.programStates.get(value);if(!item){item={id:state.nextProgram++,object:value,uniforms:new Map(),metadata:null};state.programStates.set(value,item);}return item;
  };
  const boundTexture=target=>state.units.get(state.activeUnit)?.get(target)??null;
  const metadata=item=>{
   if(!item)return null;if(item.metadata)return item.metadata;
   const shaders=(gl.getAttachedShaders(item.object)||[]).map(shader=>{
    const source=gl.getShaderSource(shader)||'',shaderName=source.match(/\b(?:shader_name|SHADER_NAME)\s*(?::|=)?\s*["']?([\w.-]+)/)?.[1]??null;
    const type=gl.getShaderParameter(shader,gl.SHADER_TYPE),samplers=[...source.matchAll(/\buniform\s+(?:(?:lowp|mediump|highp)\s+)?((?:[iu]?sampler)\w*)\s+(\w+)/g)].map(match=>({type:match[1],name:match[2]}));
    return{type:type===gl.VERTEX_SHADER?'vertex':type===gl.FRAGMENT_SHADER?'fragment':type,shaderName,hash:hash(source),length:source.length,samplers,sourceTail:source.slice(-4096)};
   });
   const explicit=shaders.map(shader=>shader.shaderName).find(Boolean),fragment=shaders.find(shader=>shader.type==='fragment')?.sourceTail??'';
   // These signatures are the main functions in the installed MapLibre 6.16
   // terrain shaders, read through getShaderSource, not private program fields.
   const inferred=/surface_color\s*=\s*texture\(u_texture,/.test(fragment)?'terrain':/fragColor\s*=\s*pack\(v_depth\)/.test(fragment)?'terrain_depth':/fragColor\s*=\s*vec4\(v_elevation,/.test(fragment)?'terrain_height':null;
   const samplerTypes=new Set(['SAMPLER_2D','SAMPLER_3D','SAMPLER_CUBE','SAMPLER_2D_SHADOW','SAMPLER_2D_ARRAY','SAMPLER_2D_ARRAY_SHADOW','SAMPLER_CUBE_SHADOW','INT_SAMPLER_2D','INT_SAMPLER_3D','INT_SAMPLER_CUBE','INT_SAMPLER_2D_ARRAY','UNSIGNED_INT_SAMPLER_2D','UNSIGNED_INT_SAMPLER_3D','UNSIGNED_INT_SAMPLER_CUBE','UNSIGNED_INT_SAMPLER_2D_ARRAY'].map(name=>gl[name]).filter(value=>value!==undefined));
   const samplers=[];
   for(let index=0,count=gl.getProgramParameter(item.object,gl.ACTIVE_UNIFORMS);index<count;index++){
    const uniform=gl.getActiveUniform(item.object,index);if(uniform&&samplerTypes.has(uniform.type))samplers.push({name:uniform.name,type:uniform.type,size:uniform.size});
   }
   item.metadata={id:item.id,contextId:info.id,label:explicit??inferred??`program-${item.id}`,labelSource:explicit?'public-shader-source-name':inferred?'installed-shader-main-signature':'public-shader-source-hash',samplers,samplerEnumeration:'public-active-uniforms',shaders};
   if(programs.length<64)programs.push(item.metadata);
   return item.metadata;
  };
  const sampledTextures=item=>{
   const result=[],definitions=item?.metadata?.samplers||[],names=new Set();
   for(const definition of definitions){
    if(names.has(definition.name)||result.length>=16)continue;names.add(definition.name);
    const units=item.uniforms.get(definition.name)||item.uniforms.get(definition.name.replace(/\[0\]$/,''))||[0];
    const target=[gl.SAMPLER_CUBE,gl.SAMPLER_CUBE_SHADOW,gl.INT_SAMPLER_CUBE,gl.UNSIGNED_INT_SAMPLER_CUBE].includes(definition.type)?gl.TEXTURE_CUBE_MAP:[gl.SAMPLER_3D,gl.INT_SAMPLER_3D,gl.UNSIGNED_INT_SAMPLER_3D].includes(definition.type)?gl.TEXTURE_3D:[gl.SAMPLER_2D_ARRAY,gl.SAMPLER_2D_ARRAY_SHADOW,gl.INT_SAMPLER_2D_ARRAY,gl.UNSIGNED_INT_SAMPLER_2D_ARRAY].includes(definition.type)?gl.TEXTURE_2D_ARRAY:gl.TEXTURE_2D;
    for(const unit of units.slice(0,8))result.push({uniform:definition.name,samplerType:definition.type,unit,target,texture:texture(state.units.get(unit)?.get(target))});
   }
   return JSON.parse(JSON.stringify(result));
  };
  const fboMetadata=()=>{
   const item=framebuffer(state.drawFramebuffer);
   return item?{kind:'offscreen',id:item.id,attachments:[...item.attachments].map(([attachment,value])=>({attachment,level:value.level,texture:texture(value.texture)}))}:{kind:'default',id:0};
  };
  const begin=(method,args)=>{
   if(!receipt.recording)return null;
   const mipmap=method==='generateMipmap',item=program(state.program),programInfo=mipmap?null:metadata(item),fbo=fboMetadata();
   const count=mipmap?0:method==='drawRangeElements'?args[3]:method.includes('Arrays')?args[2]:args[1];
   const instances=method==='drawArraysInstanced'?args[3]:method==='drawElementsInstanced'?args[4]:1;
   const event={sequence:++receipt.totals.calls,timeMs:now(),method,contextId:info.id,programId:programInfo?.id??null,programLabel:programInfo?.label??(mipmap?'generateMipmap':'no-program'),framebuffer:JSON.parse(JSON.stringify(fbo)),viewport:[...state.viewport],mode:mipmap?null:args[0],count,instances,submittedVerticesOrIndices:count*instances,indexType:mipmap||method.includes('Arrays')?null:method==='drawRangeElements'?args[4]:args[2],textures:mipmap?[{unit:state.activeUnit,target:args[0],texture:JSON.parse(JSON.stringify(texture(boundTexture(args[0]))))}]:sampledTextures(item),timerStatus:'not-sampled',gpuNanoseconds:null};
   if(mipmap)receipt.totals.mipmapCalls++;else receipt.totals.drawCalls++;
   receipt.totals.submittedVerticesOrIndices+=event.submittedVerticesOrIndices;
   const key=JSON.stringify([method,event.programId,fbo.id,event.viewport,event.mode]);let group=groupMap.get(key);
   if(!group&&groups.length<maxGroups){group={id:groups.length+1,method,contextId:info.id,programId:event.programId,programLabel:event.programLabel,framebufferKind:fbo.kind,framebufferId:fbo.id,viewport:event.viewport,mode:event.mode,calls:0,submittedVerticesOrIndices:0,queryAttempts:0,timedCalls:0,gpuNanoseconds:0,firstSequence:event.sequence,lastSequence:event.sequence,textureExamples:[]};groupMap.set(key,group);groups.push(group);}
   if(group){group.calls++;group.submittedVerticesOrIndices+=event.submittedVerticesOrIndices;group.lastSequence=event.sequence;event.groupId=group.id;if(group.textureExamples.length<3)group.textureExamples.push(event.textures);}
   else receipt.totals.groupsDropped++;
   if(events.length<maxEvents)events.push(event);else receipt.totals.eventsDropped++;
   const token={event,group,state,query:null};
   if(!state.ext){event.timerStatus='unsupported';receipt.queries.unsupported++;return token;}
   if(!group||group.queryAttempts>=maxQueriesPerGroup){event.timerStatus='group-limit';receipt.queries.groupLimitSkipped++;return token;}
   if(receipt.queries.attempted>=maxQueries){event.timerStatus='query-limit';receipt.queries.limitSkipped++;return token;}
   if(gl.getQuery(state.ext.TIME_ELAPSED_EXT,gl.CURRENT_QUERY)){event.timerStatus='interference';receipt.queries.interference++;return token;}
   receipt.queries.attempted++;group.queryAttempts++;
   const query=gl.createQuery();if(!query){event.timerStatus='query-unavailable';receipt.queries.unavailable++;return token;}
   token.query=query;querySamples.push(event);
   try{
    gl.beginQuery(state.ext.TIME_ELAPSED_EXT,query);
    if(gl.getQuery(state.ext.TIME_ELAPSED_EXT,gl.CURRENT_QUERY)!==query){event.timerStatus='query-not-active';receipt.queries.errors++;gl.deleteQuery(query);token.query=null;return token;}
    event.timerStatus='active';receipt.queries.started++;
   }catch(value){event.timerStatus='query-error';receipt.queries.errors++;safe('delete-failed-query',()=>gl.deleteQuery(query));token.query=null;error('begin-query',value);}
   return token;
  };
  const end=token=>{
   if(!token?.query)return;
   const {query,event}=token;
   try{
    if(gl.getQuery(state.ext.TIME_ELAPSED_EXT,gl.CURRENT_QUERY)===query){gl.endQuery(state.ext.TIME_ELAPSED_EXT);event.timerStatus='pending';state.pending.push(token);receipt.queries.pending++;}
    else{event.timerStatus='query-owner-changed';receipt.queries.interference++;gl.deleteQuery(query);}
   }catch(value){event.timerStatus='query-error';receipt.queries.errors++;error('end-query',value);safe('delete-failed-query',()=>gl.deleteQuery(query));}
  };
  for(const method of ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced','drawRangeElements','generateMipmap'])wrap(gl,method,null,function(original,args){
   const token=this===gl?safe('record-draw',()=>begin(method,args)):null;
   try{return Reflect.apply(original,this,args);}catch(value){if(token)token.event.originalError=String(value?.message??value).slice(0,300);throw value;}finally{if(token)safe('finish-draw',()=>end(token));}
  });
  wrap(gl,'useProgram',args=>{state.program=args[0];program(args[0]);});
  wrap(gl,'bindFramebuffer',args=>{if(args[0]===gl.FRAMEBUFFER||args[0]===gl.DRAW_FRAMEBUFFER)state.drawFramebuffer=args[1];});
  wrap(gl,'framebufferTexture2D',args=>{if(args[0]===gl.FRAMEBUFFER||args[0]===gl.DRAW_FRAMEBUFFER)framebuffer(state.drawFramebuffer)?.attachments.set(args[1],{texture:args[3],level:args[4]});});
  wrap(gl,'viewport',args=>{state.viewport=args.slice(0,4);});
  wrap(gl,'activeTexture',args=>{state.activeUnit=args[0]-gl.TEXTURE0;});
  wrap(gl,'bindTexture',args=>{let unit=state.units.get(state.activeUnit);if(!unit){unit=new Map();state.units.set(state.activeUnit,unit);}unit.set(args[0],args[1]);texture(args[1]);});
  wrap(gl,'texStorage2D',args=>{const item=texture(boundTexture(args[0]));if(item)Object.assign(item,{width:args[3],height:args[4],levels:args[1],internalFormat:args[2],allocation:'texStorage2D'});});
  wrap(gl,'texImage2D',args=>{const item=texture(boundTexture(args[0]));if(!item||args[1]!==0)return;const image=args[5],explicit=args.length>=9;Object.assign(item,{width:explicit?args[3]:image?.videoWidth??image?.naturalWidth??image?.width??null,height:explicit?args[4]:image?.videoHeight??image?.naturalHeight??image?.height??null,internalFormat:args[2],allocation:'texImage2D'});});
  for(const method of ['texParameterf','texParameteri'])wrap(gl,method,args=>{const item=texture(boundTexture(args[0]));if(!item)return;if(args[1]===0x84FE)item.anisotropy=args[2];if(args[1]===gl.TEXTURE_MIN_FILTER)item.minFilter=args[2];if(args[1]===gl.TEXTURE_MAG_FILTER)item.magFilter=args[2];});
  wrap(gl,'getUniformLocation',(args,result)=>{if(result)state.uniformLocations.set(result,{program:args[0],name:args[1]});});
  wrap(gl,'uniform1i',args=>{const location=state.uniformLocations.get(args[0]);if(location)program(location.program)?.uniforms.set(location.name,[args[1]]);});
  wrap(gl,'uniform1iv',args=>{const location=state.uniformLocations.get(args[0]);if(location)program(location.program)?.uniforms.set(location.name,Array.from(args[1]).slice(args[2]||0,(args[2]||0)+Math.min(args[3]||8,8)));});
  wrap(gl,'linkProgram',args=>{const item=program(args[0]);if(item)item.metadata=null;});
 };
 const invalidate=(state,reason='disjoint')=>{
  state.invalid=true;state.info.timer.invalidReason=reason;state.info.timer.disjoint=reason==='disjoint';
  for(const sample of querySamples.filter(sample=>sample.contextId===state.info.id)){if(reason==='disjoint'&&sample.timerStatus!=='disjoint')receipt.queries.disjoint++;sample.timerStatus=reason;sample.gpuNanoseconds=null;}
  for(const group of groups.filter(group=>group.contextId===state.info.id)){group.gpuNanoseconds=0;group.timedCalls=0;}
  receipt.queries.completed=querySamples.filter(sample=>sample.timerStatus==='complete').length;
 };
 const controller={
  start(label={}){
   if(receipt.started||receipt.stopped)return snapshot();receipt.started=true;receipt.label=label;receipt.startedAtMs=now();
   for(const state of states)safe('timer-setup',()=>{
    const {gl,info}=state,ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if(!ext){info.timer={supported:false,reason:'extension-unavailable'};return;}
    const counterBits=gl.getQuery(ext.TIME_ELAPSED_EXT,ext.QUERY_COUNTER_BITS_EXT);
    if(!(counterBits>0)){info.timer={supported:false,reason:'zero-counter-bits',counterBits};return;}
    if(gl.getQuery(ext.TIME_ELAPSED_EXT,gl.CURRENT_QUERY)){info.timer={supported:false,reason:'external-query-active',counterBits};return;}
    info.timer={supported:true,counterBits,disjointAtStart:Boolean(gl.getParameter(ext.GPU_DISJOINT_EXT))};state.ext=ext;
   });
   receipt.recording=states.length>0;receipt.availability=states.length?'attached':'maplibre-webgl2-context-not-observed';return snapshot();
  },
  stop(reason='action-complete'){
   if(!receipt.stopped){receipt.recording=false;receipt.stopped=true;receipt.stopReason=reason;receipt.stoppedAtMs=now();restore();}return snapshot();
  },
  collect({final=false}={}){
   if(!receipt.stopped)return snapshot();receipt.collectionPasses++;
   for(const state of states){
    const {gl,ext}=state;if(!ext||!state.pending.length)continue;
    let blocked=true;
    safe('query-disjoint',()=>{if(gl.getQuery(ext.TIME_ELAPSED_EXT,gl.CURRENT_QUERY))return;const disjoint=gl.getParameter(ext.GPU_DISJOINT_EXT);if(disjoint===true)invalidate(state);else if(disjoint===false)blocked=false;});
    const pending=[];
    for(const token of state.pending){
     let dispose=state.invalid;const {query,event,group}=token;
     try{
      if(!state.invalid&&!blocked&&gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE)){
       const value=gl.getQueryParameter(query,gl.QUERY_RESULT);
       if(Number.isFinite(value)&&value>=0){event.gpuNanoseconds=value;event.timerStatus='complete';group.gpuNanoseconds+=value;group.timedCalls++;receipt.queries.completed++;}
       else{event.timerStatus='invalid-result';receipt.queries.errors++;}
       dispose=true;
      }
     }catch(value){event.timerStatus='query-error';receipt.queries.errors++;error('collect-query',value);dispose=true;}
     if(final&&!dispose){event.timerStatus=blocked?'external-query-active-at-collection':'unavailable-after-bounded-collection';receipt.queries.unavailable++;dispose=true;}
     if(dispose){safe('delete-query',()=>gl.deleteQuery(query));receipt.queries.pending--;}else pending.push(token);
    }
    state.pending=pending;
    if(!blocked){
     let confirmed=false;
     safe('query-disjoint-after',()=>{const disjoint=gl.getParameter(ext.GPU_DISJOINT_EXT);if(disjoint===true)invalidate(state);else if(disjoint===false)confirmed=true;});
     if(!confirmed&&!state.invalid)invalidate(state,'disjoint-state-unverified');
    }
   }
   receipt.collectionFinal=final;return snapshot();
  },
 };
 root.__tropnikTerrainGPUDraws=controller;
 const prototype=root.HTMLCanvasElement?.prototype;
 if(prototype?.getContext){
  const original=prototype.getContext,descriptor=Object.getOwnPropertyDescriptor(prototype,'getContext');
  const replacement=function(...args){const result=Reflect.apply(original,this,args);safe('attach-context',()=>{if(args[0]==='webgl2'&&this.matches?.('canvas.maplibregl-canvas'))attach(result);});return result;};
  safe('wrap-canvas',()=>{Object.defineProperty(prototype,'getContext',{configurable:true,writable:true,value:replacement});restorations.push(()=>{if(prototype.getContext===replacement)Object.defineProperty(prototype,'getContext',descriptor);});});
 }else receipt.availability='canvas-api-unavailable';
 return controller;
}

/** Arm once, preserve the exact action result/failure, stop before collecting.
 * Three bounded asynchronous collection passes cannot extend the settle gate.
 * Missing/failed observer calls are evidence, never a reason to retry input. */
export async function observeTerrainGPUDraws(action,{control,receipt={},sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 Object.assign(receipt,{diagnosticOnly:true,verified:false,releaseEligible:false,status:'running',collectionErrors:[]});
 const read=async(method,value)=>{try{return await control(method,value);}catch(error){receipt.collectionErrors.push({method,message:String(error?.message??error)});return null;}};
 receipt.before=await read('start',receipt.label??{});let result,failure,failed=false;
 try{result=await action();receipt.status='completed';}
 catch(error){failed=true;failure=error;receipt.status='failed';receipt.actionError=String(error?.message??error);}
 finally{
  receipt.stopped=await read('stop',failed?'action-error':'action-complete');
  for(let pass=0;pass<3;pass++){
   if(pass)try{await sleep(50);}catch(error){receipt.collectionErrors.push({method:'collection-wait',message:String(error?.message??error)});}
   const current=await read('collect',{final:pass===2});if(current)receipt.result=current;
   if(current?.queries?.pending===0)break;
  }
 }
 if(failed)throw failure;return result;
}

export function browserGPUDrawsEnabled(value,diagnostic){
 if(value===undefined||value==='')return false;
 if(value!=='1')throw new Error('Unknown TROPNIK_BROWSER_GPU_DRAWS value');
 if(diagnostic!=='terrain-close')throw new Error('GPU draw instrumentation requires the terrain-close diagnostic');
 return true;
}

export function shouldObserveTerrainGPUDraws(profile,mode,direction,zoom,alreadyObserved,enabled){
 return enabled&&!alreadyObserved&&profile.name==='desktop-webgl'&&profile.engine==='maplibre'&&!profile.mobile&&mode==='terrain-diagnostic'&&direction>0&&zoom>=14&&zoom<15;
}
