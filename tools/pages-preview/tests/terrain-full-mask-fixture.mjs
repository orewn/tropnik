import {terrainMaskFixture} from './terrain-mask-fixture.mjs';

export function terrainFullMaskFixture(){
 const fixture=terrainMaskFixture(),{grid}=fixture;
 for(let y=0;y<grid.height;y++)for(let x=0;x<grid.width;x++){
  const u=x/(grid.width-1),v=y/(grid.height-1);
  grid.elevations[y*grid.width+x]=400+650*u+180*Math.sin(v*Math.PI*4)+1700*Math.exp(-((u-.43)**2/.016+(v-.48)**2/.12));
 }
 const [west,south,east,north]=grid.bounds,point=(u,v)=>[west+u*(east-west),north-v*(north-south)];
 fixture.geometry={type:'MultiLineString',coordinates:[
  [point(-.05,.5),point(1.05,.5)],
  [point(.001,.03),point(.001,.97)],[point(.999,.03),point(.999,.97)],
  [point(.03,.001),point(.97,.001)],
  [point(.749,.16),point(.749,.84)],
 ]};
 return fixture;
}

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

// Both constructors are the production module. The test server changes only
// the baseline shader-selection function body, never any draw/height code.
// Readback happens in onRender while preserveDrawingBuffer is still false.
export async function runTerrainFullMaskCase(OptimizedRenderer,BaselineRenderer,{maskKind='full',rotate=0,zoom=1,restore=false}={}){
 const fixture=terrainFullMaskFixture(),{grid,cartography,geometry}=fixture,captures=[],variants=[],comparisons=[],errors=[];
 const inputHeightSHA256=await digest(grid.elevations),minElevation=Math.min(...grid.elevations),maxElevation=Math.max(...grid.elevations);
 check(maxElevation-minElevation>1000,'The source fixture must have a real non-flat ridge');
 let phase='baseline',current;
 const close=()=>{
  if(!current)return;const {renderer,canvas,host}=current;renderer.destroy();canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();host.remove();current=undefined;
 };
 const runVariant=async(Renderer,variant)=>{
  close();const host=document.createElement('div'),canvas=document.createElement('canvas');canvas.style.cssText='display:block;width:512px;height:384px';host.appendChild(canvas);document.body.appendChild(host);
  const shaderSources=[],getContext=canvas.getContext.bind(canvas);let observedContext;
  canvas.getContext=function(kind,attributes){
   const gl=getContext(kind,attributes);
   if(kind==='webgl2'&&gl&&observedContext!==gl){
    observedContext=gl;const shaderSource=gl.shaderSource.bind(gl);
    gl.shaderSource=function(shader,source){
     if(source.includes('uniform sampler2D uCartography;')&&source.includes('vec3 perturbNormal('))shaderSources.push({kind:'terrain-fragment',source});
     if(source.includes('vPosition=vec3((aUV.x-.5)'))shaderSources.push({kind:'terrain-vertex',source});
     return shaderSource(shader,source);
    };
   }
   return gl;
  };
  const ownedInput=fixture.mask(maskKind==='full'?'full':'known'),allowedPixels=ownedInput.source.allowedPixels;
  let next,frame=0,last,fatal;
  const renderer=new Renderer(canvas,grid,{displayMask:ownedInput,onError:message=>errors.push(String(message)),onFatal:message=>{fatal=new Error(String(message));next?.reject(fatal);},onRender:info=>{
   try{
    const surface=host.querySelector('canvas');check(surface===canvas&&info.renderer==='webgl2','Canvas fallback cannot stand in for the real WebGL2 shader proof');
    const gl=canvas.getContext('webgl2');check(gl&&gl.getParameter(gl.STENCIL_BITS)>=1,'The real display mask must retain its stencil');
    const {width,height}=canvas,raw=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,raw);check(gl.getError()===gl.NO_ERROR,'WebGL readback failed');
    const pixels=new Uint8Array(raw.length);for(let row=0;row<height;row++)pixels.set(raw.subarray((height-1-row)*width*4,(height-row)*width*4),row*width*4);
    check(info.graphicsFallback===null,'A graphics fallback occurred');check(info.displayMask?.allowedPixels===allowedPixels,'Caller mutation changed the owned mask');
    check(canvas.dataset.heightScale==='1'&&info.sourceVertices===grid.width*grid.height,'Source height resolution or metre scale changed');
    last={width,height,pixels,png:canvas.toDataURL('image/png').split(',')[1],renderer:info.renderer,view:info.view,pixelRatio:info.pixelRatio,meshStride:info.meshStride,sourceVertices:info.sourceVertices,triangles:info.triangles,heightScale:canvas.dataset.heightScale,displayMask:info.displayMask,contextAttributes:gl.getContextAttributes(),samples:gl.getParameter(gl.SAMPLES),stencilBits:gl.getParameter(gl.STENCIL_BITS)};frame++;next?.resolve(last);
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
  check(fragments.every(shader=>shader.maskDiscard===(variant==='baseline'||maskKind!=='full')),'The actual compiled shader did not select the intended full/mixed path');
  const summary={variant,renderer:'webgl2',allowedPixels,callerMaskMutationChecked:true,witnesses,recovery,shaders};variants.push(summary);return{frames,summary};
 };
 try{
  const baseline=await runVariant(BaselineRenderer,'baseline'),optimized=await runVariant(OptimizedRenderer,'optimized');
  for(const name of ['terrain','route',...(restore?['restored']:[])]){
   const old=baseline.frames[name],current=optimized.frames[name],result=difference(old,current);comparisons.push({phase:name,...result,baselinePixelSHA256:await digest(old.pixels),optimizedPixelSHA256:await digest(current.pixels)});
   check(result.differentPixels===0,`${maskKind}/${name}: ${result.differentPixels} pixels changed, maximum channel delta ${result.maxChannelDelta}`);
   for(const key of ['view','pixelRatio','meshStride','sourceVertices','triangles','heightScale','displayMask','contextAttributes','samples','stencilBits'])check(JSON.stringify(old[key])===JSON.stringify(current[key]),`${key} changed with shader selection`);
  }
  const oldVertices=baseline.summary.shaders.filter(shader=>shader.kind==='terrain-vertex').map(shader=>shader.sha256),newVertices=optimized.summary.shaders.filter(shader=>shader.kind==='terrain-vertex').map(shader=>shader.sha256);
  check(JSON.stringify(oldVertices)===JSON.stringify(newVertices),'The full-resolution height vertex shader changed');
  check(await digest(grid.elevations)===inputHeightSHA256,'Rendering changed the source height data');
  return{verified:true,phase:'complete',maskKind,view:{rotate,zoom},restore,grid:{width:grid.width,height:grid.height,minElevation,maxElevation,heightSHA256:inputHeightSHA256,unchanged:true},variants,comparisons,captures,errors};
 }catch(error){return{verified:false,phase,maskKind,view:{rotate,zoom},restore,variants,comparisons,captures,errors,error:String(error?.stack||error).slice(0,6000)};}
 finally{close();}
}
