// Map-only correctness fixture. The reference changes only meshFor's choice of
// source window: it draws the complete grid at the exact same source stride.
// Camera, shaders, textures, display mask, route and presentation are production
// code in both variants. No reference image or synthetic renderer is supplied.
const VIEWS=[{name:'initial',yaw:0,pitch:.85},{name:'rotated',yaw:1.1,pitch:.65},{name:'steep',yaw:-1.4,pitch:1.15}];

export function terrainWindowFixture(){
 const bounds=[40,43,40.04,43.04],width=129,height=129;
 const elevations=Array.from({length:width*height},(_,i)=>100+90*Math.sin(i%width/21)+60*Math.cos(Math.floor(i/width)/17));
 const grid={width,height,bounds,elevations,units:'meters',rowOrder:'north-to-south',columnOrder:'west-to-east'};
 const pixels=new Uint8Array(128*128);for(let y=0;y<128;y++)for(let x=0;x<128;x++)if(x<64||y<40)pixels[y*128+x]=255;
 const displayMask={width:128,height:128,pixels,source:{scope:'russia-display-area',coverageVersion:'b'.repeat(16),lod:'source',cells:['synthetic-window-pixel-gate'],bounds:[...bounds],projection:'regular-longitude-latitude',sampleLayout:'pixel-cells',rowOrder:'north-to-south',columnOrder:'west-to-east',boundaryRule:'exclude-intersecting-texels',allowedPixels:pixels.filter(value=>value===255).length}};
 const color=new Uint8ClampedArray(256*256*4);for(let y=0;y<256;y++)for(let x=0;x<256;x++)color.set([40+x*.6,80+y*.4,180,255],(y*256+x)*4);
 const cartography={width:256,height:256,pixels:color,source:{name:'Synthetic pixel test; not geographic source data',bounds:[...bounds],projection:'regular-longitude-latitude',sampleLayout:'grid-nodes',rowOrder:'north-to-south',columnOrder:'west-to-east',requestedTiles:1,loadedTiles:1}};
 const geometry={type:'LineString',coordinates:[[40.006,43.024],[40.034,43.016]]};
 return{grid,displayMask,cartography,geometry};
}

export function compareTerrainWindowPixels(reference,windowed){
 const {width,height,pixels}=reference;
 if(width!==512||height!==384||windowed.width!==width||windowed.height!==height||pixels?.length!==width*height*4||windowed.pixels?.length!==pixels.length)throw new Error('Invalid map mesh pixel frames');
 const result={width,height,differentPixels:0,maxChannelDelta:0,terrainPixels:0,skyPixels:0,routeCorePixels:0};
 for(let i=0;i<pixels.length;i+=4){
  let delta=0;for(let k=0;k<4;k++)delta=Math.max(delta,Math.abs(pixels[i+k]-windowed.pixels[i+k]));
  if(delta)result.differentPixels++;result.maxChannelDelta=Math.max(result.maxChannelDelta,delta);
  const [r,g,b]=pixels.subarray(i,i+3),sky=Math.max(Math.abs(r-223),Math.abs(g-230),Math.abs(b-218));
  if(sky<=2)result.skyPixels++;else if(sky>12)result.terrainPixels++;
  if(r>=170&&r<=205&&g>=60&&g<=95&&b>=15&&b<=55)result.routeCorePixels++;
 }
 if(result.differentPixels||result.maxChannelDelta)throw new Error('Visible source triangles changed map pixels: '+JSON.stringify(result));
 if(result.terrainPixels<1000||result.skyPixels<1000||result.routeCorePixels<12)throw new Error('Insufficient real terrain, mask and route pixel witnesses: '+JSON.stringify(result));
 return result;
}

export async function runTerrainWindowCase(TerrainRenderer,{forceCanvas=false}={}){
 class CompleteMeshReference extends TerrainRenderer{meshFor(step){return super.meshFor(step);}}
 const fixture=terrainWindowFixture(),expected=forceCanvas?'canvas2d':'webgl2',captures=[],comparisons=[],errors=[];
 const initialHeights=fixture.grid.elevations.slice();let current,phase='initial',recovery=null;
 const pixelHash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
 const retain=async(name,frame)=>{const {pixels,...rest}=frame;const capture={...rest,phase:name,pixelSHA256:await pixelHash(pixels)};captures.push(capture);return capture;};
 const close=()=>{if(!current)return;const {renderer,canvas,host}=current;renderer.destroy();if(!forceCanvas)canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();host.remove();current=null;};
 const open=async(complete,view)=>{
  close();const host=document.createElement('div'),canvas=document.createElement('canvas');canvas.style.cssText='display:block;width:512px;height:384px';host.appendChild(canvas);document.body.appendChild(host);
  let frameCount=0,next,last,fatal;
  const capture=(surface,info)=>{
   if(info.renderer!==expected)throw new Error(`Expected ${expected}, received ${info.renderer}: ${JSON.stringify(info.graphicsFallback)}`);
   const {width,height}=surface;let pixels;
   if(info.renderer==='webgl2'){
    const gl=surface.getContext('webgl2'),raw=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,raw);
    if(gl.getError()!==gl.NO_ERROR)throw new Error('Map mesh WebGL pixel read failed');
    pixels=new Uint8Array(raw.length);for(let row=0;row<height;row++)pixels.set(raw.subarray((height-1-row)*width*4,(height-row)*width*4),row*width*4);
   }else pixels=surface.getContext('2d').getImageData(0,0,width,height).data;
   return{width,height,pixels,png:surface.toDataURL('image/png').split(',')[1],renderer:info.renderer,view:info.geographicView,viewport:info.viewport,meshStride:info.meshStride,meshWindow:info.meshWindow,renderedVertices:info.renderedVertices,triangles:info.triangles,sourceVertices:info.sourceVertices};
  };
  const Renderer=complete?CompleteMeshReference:TerrainRenderer,renderer=new Renderer(canvas,fixture.grid,{forceCanvas,navigation:'map',displayMask:fixture.displayMask,viewportInsets:{top:40,right:36,bottom:24,left:12},initialView:{longitude:40.02,latitude:43.02,distanceM:650,...view},onError:message=>errors.push(String(message)),onFatal:message=>{fatal=new Error(String(message));next?.reject(fatal);},onRender:info=>{
   try{last=capture(host.querySelector('canvas'),info);frameCount++;next?.resolve(last);}catch(error){fatal=error;next?.reject(error);}
  }});
  const wait=(before=frameCount)=>new Promise((resolve,reject)=>{
   if(fatal){reject(fatal);return;}if(frameCount>before){resolve(last);return;}
   const timer=setTimeout(()=>{next=null;reject(new Error('Map mesh pixel fixture frame timeout'));},10000);
   next={resolve:value=>{clearTimeout(timer);next=null;resolve(value);},reject:error=>{clearTimeout(timer);next=null;reject(error);}};
  });
  current={renderer,canvas,host,wait,get frameCount(){return frameCount;}};
  renderer.setCartography(fixture.cartography);renderer.setGeometry(fixture.geometry);return wait(0);
 };
 try{
  for(const view of VIEWS){
   phase=view.name;const reference=await open(true,view),full=await retain(view.name+'-full',reference),windowed=await open(false,view),cropped=await retain(view.name+'-window',windowed);
   if(reference.meshWindow!==null||!Array.isArray(windowed.meshWindow)||windowed.renderedVertices>=reference.renderedVertices||reference.meshStride!==1||windowed.meshStride!==1)throw new Error('The map case did not compare a real cropped mesh with the same complete source lattice');
   if(JSON.stringify(reference.view)!==JSON.stringify(windowed.view)||JSON.stringify(reference.viewport)!==JSON.stringify(windowed.viewport))throw new Error('Full and visible meshes used different cameras');
   const metrics=compareTerrainWindowPixels(reference,windowed);comparisons.push({name:view.name,reference:full.phase,window:cropped.phase,pixelSHA256:full.pixelSHA256,metrics});
   if(view.name==='steep'&&!forceCanvas){
    phase='context-restoration';const canvas=current.canvas,extension=canvas.getContext('webgl2').getExtension('WEBGL_lose_context');if(!extension)throw new Error('No real context restore extension');
    let lost=0,restored=0,trusted=true;canvas.addEventListener('webglcontextlost',event=>{lost++;trusted&&=event.isTrusted;},{once:true});canvas.addEventListener('webglcontextrestored',event=>{restored++;trusted&&=event.isTrusted;},{once:true});
    const loss=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('No real map context-lost event')),2000);canvas.addEventListener('webglcontextlost',()=>{clearTimeout(timer);resolve();},{once:true});});
    extension.loseContext();await loss;await new Promise(resolve=>setTimeout(resolve,80));const before=current.frameCount;extension.restoreContext();
    const recovered=await current.wait(before),retained=await retain('steep-restored',recovered);recovery={lost,restored,trusted,reference:cropped.phase,frame:retained.phase,metrics:compareTerrainWindowPixels(windowed,recovered)};
    if(lost!==1||restored!==1||!trusted)throw new Error('Map graphics context did not restore through browser events');
   }
  }
  if(fixture.grid.elevations.some((value,index)=>value!==initialHeights[index]))throw new Error('Map clipping modified source heights');
  return{verified:true,phase:'complete',renderer:expected,navigation:'map',sourceHeightsUnchanged:true,captures,comparisons,recovery,errors};
 }catch(error){return{verified:false,phase,renderer:expected,navigation:'map',captures,comparisons,recovery,errors,error:String(error?.stack||error).slice(0,6000)};}
 finally{close();}
}
