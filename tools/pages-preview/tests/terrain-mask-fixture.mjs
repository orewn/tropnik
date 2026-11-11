// Independent pixel witnesses for the real renderer. A synthetic geographic
// texture marks permitted ground blue and excluded ground red. That texture is
// rendered with a full mask first; it supplies screen-space witnesses without
// importing the renderer's private projection or mask-sampling implementation.
const SIZE=64,BOUNDS=[40,50,40.2,50.2];
const allowed=(x,y)=>x>=8&&x<48&&y>=8&&y<56&&!(x>=24&&x<36&&y>=24&&y<40);

export function terrainMaskFixture(){
 const grid={width:17,height:17,bounds:[...BOUNDS],elevations:new Float32Array(17*17).fill(100),units:'meters',rowOrder:'north-to-south',columnOrder:'west-to-east'};
 const mask=kind=>{
  const pixels=new Uint8Array(SIZE*SIZE);let allowedPixels=0;
  for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++)if(kind==='full'||kind==='known'&&allowed(x,y)){pixels[y*SIZE+x]=255;allowedPixels++;}
  return{width:SIZE,height:SIZE,pixels,source:{scope:'russia-display-area',coverageVersion:'a'.repeat(16),lod:'source',cells:['synthetic-pixel-gate'],bounds:[...BOUNDS],projection:'regular-longitude-latitude',sampleLayout:'pixel-cells',rowOrder:'north-to-south',columnOrder:'west-to-east',boundaryRule:'exclude-intersecting-texels',allowedPixels}};
 };
 // The texture uses its own documented grid-node convention, independently of
 // the mask's pixel-cell lookup. A 1024px texture keeps transition witnesses
 // much thinner than the production route's 8.6px outer stroke.
 const width=1024,height=1024,pixels=new Uint8ClampedArray(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const inside=allowed(Math.min(SIZE-1,Math.floor(x/(width-1)*SIZE)),Math.min(SIZE-1,Math.floor(y/(height-1)*SIZE))),i=(y*width+x)*4;
  pixels[i]=inside?5:250;pixels[i+1]=5;pixels[i+2]=inside?250:5;pixels[i+3]=255;
 }
 const cartography={width,height,pixels,source:{name:'Synthetic pixel gate, not geographic source data',bounds:[...BOUNDS],projection:'regular-longitude-latitude',sampleLayout:'grid-nodes',rowOrder:'north-to-south',columnOrder:'west-to-east',requestedTiles:1,loadedTiles:1}};
 const position=(u,v)=>[BOUNDS[0]+u*(BOUNDS[2]-BOUNDS[0]),BOUNDS[3]-v*(BOUNDS[3]-BOUNDS[1])];
 const geometry={type:'MultiLineString',coordinates:[
  // Cross the outside, the allowed island, the internal hole and the outside.
  [position(.02,.5),position(.98,.5)],
  // A centreline just inside the east boundary makes the thick halo cross it.
  [position(.75-.001,.16),position(.75-.001,.84)],
 ]};
 return{grid,mask,cartography,geometry};
}

function framePixels(frame,name,width,height){
 if(!frame||!Number.isInteger(frame.width)||!Number.isInteger(frame.height)||frame.width<8||frame.height<8||frame.width>1024||frame.height>1024||
  !(frame.pixels instanceof Uint8Array||frame.pixels instanceof Uint8ClampedArray)||frame.pixels.length!==frame.width*frame.height*4||
  width!==undefined&&(frame.width!==width||frame.height!==height))throw new TypeError(`Invalid ${name} pixel frame`);
 return frame.pixels;
}
const difference=(a,b,index)=>Math.max(Math.abs(a[index]-b[index]),Math.abs(a[index+1]-b[index+1]),Math.abs(a[index+2]-b[index+2]));

/** Exclude one physical pixel around colour boundaries for MSAA, then require
 * every remaining forbidden witness to match the independently rendered empty
 * mask. Both the coloured core and pale outer route halo are checked by RGB. */
export function inspectTerrainMaskPixels({reference,empty,terrain,route}){
 const r=framePixels(reference,'reference'),{width,height}=reference,e=framePixels(empty,'empty',width,height),t=framePixels(terrain,'terrain',width,height),p=framePixels(route,'route',width,height);
 const classes=new Uint8Array(width*height);
 for(let index=0;index<classes.length;index++){
  const i=index*4,red=r[i],green=r[i+1],blue=r[i+2];
  if(red>100&&red-green>70&&red-blue>70)classes[index]=1;
  else if(blue>90&&blue-red>50&&blue-green>40)classes[index]=2;
 }
 const result={width,height,outsideWitnesses:0,insideWitnesses:0,nearBoundaryOutside:0,terrainLeaks:0,routeLeaks:0,nearBoundaryRouteLeaks:0,maxTerrainLeak:0,maxRouteLeak:0,insideVisible:0,routeCorePixels:0,routeHaloPixels:0};
 for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
  const index=y*width+x,kind=classes[index];if(!kind)continue;
  let interior=true;
  for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(classes[(y+dy)*width+x+dx]!==kind)interior=false;
  if(!interior)continue;
  const i=index*4;
  if(kind===1){
   result.outsideWitnesses++;
   const terrainDelta=difference(t,e,i),routeDelta=difference(p,e,i);
   if(terrainDelta>6){result.terrainLeaks++;result.maxTerrainLeak=Math.max(result.maxTerrainLeak,terrainDelta);}
   if(routeDelta>6){result.routeLeaks++;result.maxRouteLeak=Math.max(result.maxRouteLeak,routeDelta);}
   let near=false;
   for(let dy=-6;dy<=6&&!near;dy++)for(let dx=-6;dx<=6;dx++){
    const xx=x+dx,yy=y+dy;if(xx>=0&&xx<width&&yy>=0&&yy<height&&classes[yy*width+xx]===2){near=true;break;}
   }
   if(near){result.nearBoundaryOutside++;if(routeDelta>6)result.nearBoundaryRouteLeaks++;}
  }else{
   result.insideWitnesses++;
   if(difference(t,e,i)>24&&difference(t,r,i)<12)result.insideVisible++;
   if(p[i]>90&&p[i]>p[i+1]*1.6&&p[i+1]>p[i+2]*1.3&&p[i+1]<160)result.routeCorePixels++;
   if(Math.min(p[i],p[i+1],p[i+2])>180&&difference(p,t,i)>24)result.routeHaloPixels++;
  }
 }
 result.insideVisibleRatio=result.insideVisible/Math.max(1,result.insideWitnesses);
 return result;
}

export function assertTerrainMaskPixels(result,label='terrain mask'){
 const fail=message=>{throw new Error(`${label}: ${message}: ${JSON.stringify(result)}`);};
 if(result.outsideWitnesses<256||result.insideWitnesses<256||result.nearBoundaryOutside<24)fail('insufficient independent pixel witnesses');
 if(result.terrainLeaks||result.routeLeaks||result.nearBoundaryRouteLeaks)fail('paint escaped the geographic mask');
 if(result.insideVisibleRatio<.95)fail('allowed terrain was missing or replaced');
 if(result.routeCorePixels<24||result.routeHaloPixels<12)fail('the real thick route was not rendered inside the mask');
 return result;
}

// This fixture owns the renderer it creates. It uses only its constructor,
// public controls and onRender callback, plus standard browser pixel/context
// APIs; no application/component instance or private renderer method is read.
export async function runTerrainMaskCase(TerrainRenderer,{forceCanvas=false,rotate=0,zoom=1,restore=false}={}){
 const {grid,mask,cartography,geometry}=terrainMaskFixture(),expected=forceCanvas?'canvas2d':'webgl2',captures=[],errors=[];
 let current,phase='full-mask-reference',metrics=null,recovery=null;
 const capture=(canvas,info)=>{
  const {width,height}=canvas;let pixels;
  if(info.renderer==='webgl2'){
   const gl=canvas.getContext('webgl2'),raw=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,raw);
   if(gl.getError()!==gl.NO_ERROR)throw new Error('WebGL pixel read failed');
   pixels=new Uint8Array(raw.length);for(let row=0;row<height;row++)pixels.set(raw.subarray((height-1-row)*width*4,(height-row)*width*4),row*width*4);
  }else pixels=canvas.getContext('2d').getImageData(0,0,width,height).data;
  return{width,height,pixels,png:canvas.toDataURL('image/png').split(',')[1],renderer:info.renderer,view:info.view,graphicsFallback:info.graphicsFallback??null};
 };
 const close=()=>{
  if(!current)return;
  const {renderer,canvas,host}=current;renderer.destroy();
  if(!forceCanvas)canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
  host.remove();current=undefined;
 };
 const open=async kind=>{
  close();const host=document.createElement('div'),canvas=document.createElement('canvas');canvas.style.cssText='display:block;width:512px;height:384px';host.appendChild(canvas);document.body.appendChild(host);
  let next,frame=0,last,fatal;const displayMask=mask(kind);
  const renderer=new TerrainRenderer(canvas,grid,{forceCanvas,displayMask,onError:message=>errors.push(String(message)),onFatal:message=>{fatal=new Error(String(message));next?.reject(fatal);},onRender:info=>{
   // The renderer can replace a WebGL canvas after a graphics failure. Read
   // the attached surface so a real fallback is reported as such, instead of
   // hiding its cause behind getContext('2d') on the detached WebGL canvas.
   try{const visible=host.querySelector('canvas');if(!visible)throw new Error('The terrain surface was removed');last=capture(visible,info);frame++;next?.resolve(last);}catch(error){fatal=error;next?.reject(error);}
  }});
  const wait=(before=frame)=>new Promise((resolve,reject)=>{
   if(fatal){reject(fatal);return;}if(frame>before){resolve(last);return;}
   const timer=setTimeout(()=>{next=undefined;reject(new Error('Terrain mask fixture frame timeout'));},10000);
   next={resolve:value=>{clearTimeout(timer);next=undefined;resolve(value);},reject:error=>{clearTimeout(timer);next=undefined;reject(error);}};
  });
  // Caller-owned storage must never change an already constructed renderer,
  // including its very first frame and a later graphics-context restoration.
  if(kind==='known')displayMask.pixels.fill(255);
  current={canvas,host,renderer,wait,get frame(){return frame;},get last(){return last;}};
  renderer.setCartography(cartography);if(rotate)renderer.rotate(rotate);if(zoom!==1)renderer.zoomBy(zoom);
  const initial=await wait(0);if(initial.renderer!==expected)throw new Error(`Expected ${expected}, received ${initial.renderer}; graphics fallback: ${JSON.stringify(initial.graphicsFallback)}`);
  return initial;
 };
 const retain=(phase,frame)=>{captures.push({phase,width:frame.width,height:frame.height,png:frame.png,renderer:frame.renderer,view:frame.view});};
 try{
  const reference=await open('full');retain('reference',reference);
  phase='empty-mask-background';
  const empty=await open('empty');retain('empty',empty);
  phase='first-masked-frame';
  const terrain=await open('known');retain('first-masked-frame',terrain);
  phase='masked-route';
  const before=current.frame,result=current.renderer.setGeometry(geometry);
  if(!result||result.segments<2)throw new Error('The crossing route never entered the production renderer');
  const route=await current.wait(before);retain('masked-route',route);
  metrics=inspectTerrainMaskPixels({reference,empty,terrain,route});assertTerrainMaskPixels(metrics,expected);
  if(restore&&!forceCanvas){
   phase='context-restoration';
   const canvas=current.canvas,gl=canvas.getContext('webgl2'),extension=gl.getExtension('WEBGL_lose_context');
   if(!extension)throw new Error('WebGL context loss/restore extension unavailable');
   let lost=0,restored=0,trusted=true;
   canvas.addEventListener('webglcontextlost',event=>{lost++;trusted=trusted&&event.isTrusted;},{once:true});
   canvas.addEventListener('webglcontextrestored',event=>{restored++;trusted=trusted&&event.isTrusted;},{once:true});
   const loss=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('No real WebGL context-lost event')),2000);
    canvas.addEventListener('webglcontextlost',()=>{clearTimeout(timer);resolve();},{once:true});
   });
   extension.loseContext();await loss;await new Promise(resolve=>setTimeout(resolve,80));
   // Start the frame baseline after the actual loss. A resize frame queued
   // before the loss event must never count as restored output.
   const lostFrame=current.frame;extension.restoreContext();
   const recovered=await current.wait(lostFrame);retain('context-restored',recovered);
   if(lost!==1||restored!==1||!trusted||recovered.renderer!=='webgl2')throw new Error(`The real WebGL context did not restore; graphics fallback: ${JSON.stringify(recovered.graphicsFallback)}`);
   recovery={lost,restored,trusted,metrics:inspectTerrainMaskPixels({reference,empty,terrain,route:recovered})};assertTerrainMaskPixels(recovery.metrics,'restored WebGL2');
  }
  return{verified:true,phase:'complete',renderer:expected,view:{rotate,zoom},callerMaskMutationChecked:true,metrics,recovery,captures,errors};
 }catch(error){
  // Return the failed case as evidence so the Node harness can persist its
  // actual PNGs before failing. A rejected evaluation would lose the captures.
  return{verified:false,phase,renderer:expected,view:{rotate,zoom},metrics,recovery,captures,errors,error:String(error?.stack||error).slice(0,6000)};
 }finally{close();}
}
