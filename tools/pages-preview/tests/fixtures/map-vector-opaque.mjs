// Independent protobuf fixture encoder. The browser gives these bytes to the
// production decoder; it never substitutes decoded feature objects.
const join=(...parts)=>parts.flat(Infinity);
const varint=value=>{const out=[];do{const low=value%128;value=Math.floor(value/128);out.push(low+(value?128:0));}while(value);return out;};
const uint=(field,value)=>join(varint(field*8),varint(value));
const bytes=(field,value)=>join(varint(field*8+2),varint(value.length),value);
const string=(field,value)=>bytes(field,[...new TextEncoder().encode(value)]);
const packed=(field,values)=>bytes(field,values.flatMap(varint));
const zigzag=value=>value<0?-2*value-1:2*value;
const shape=(type,parts,properties={})=>({type,parts,properties});
const rectangle=(left,top,right,bottom)=>[[left,top],[right,top],[right,bottom],[left,bottom]];

function geometry({type,parts}){
 let x=0,y=0;const out=[];
 for(const part of parts){
  out.push(9,zigzag(part[0][0]-x),zigzag(part[0][1]-y));[x,y]=part[0];
  if(part.length>1){out.push((part.length-1)*8+2);for(const p of part.slice(1)){out.push(zigzag(p[0]-x),zigzag(p[1]-y));[x,y]=p;}}
  if(type===3)out.push(15);
 }
 return out;
}
function layer(name,features){
 const keys=[],values=[];
 const featureBytes=features.map(feature=>{
  const tags=[];for(const [key,value]of Object.entries(feature.properties)){let k=keys.indexOf(key);if(k<0){k=keys.length;keys.push(key);}const v=values.length;values.push(value);tags.push(k,v);}
  return bytes(2,join(packed(2,tags),uint(3,feature.type),packed(4,geometry(feature))));
 });
 return bytes(3,join(string(1,name),featureBytes,keys.map(key=>string(3,key)),values.map(value=>bytes(4,typeof value==='number'?uint(5,value):string(1,value))),uint(5,4096),uint(15,2)));
}
export function opaqueVectorFixtureBytes(){
 const roads=[
  shape(2,[[[-96,900],[1200,1250],[2200,2100],[4192,2700]]],{class:'primary'}),
  shape(2,[[[100,2900],[1700,2100],[4090,500]]],{class:'secondary',brunnel:'bridge'}),
  shape(2,[[[50,2200],[1700,1200],[4050,3500]]],{class:'minor',brunnel:'tunnel'}),
  shape(2,[[[300,4090],[1800,100]]],{class:'rail'}),
  ...Array.from({length:16},(_,i)=>shape(2,[[[-32,i*256+80],[4128,i*256+208]]],{class:'path'})),
 ];
 return join(
  layer('landcover',[shape(3,[rectangle(-64,-64,4160,4160),rectangle(1280,1280,2816,2816).reverse()],{class:'wood'}),shape(3,[rectangle(600,3000,2800,4096)],{class:'grass',subclass:'scrub'})]),
  layer('landuse',[shape(3,[rectangle(160,256,1800,2600)],{class:'residential'})]),
  layer('water',[shape(3,[[[2200,300],[4096,0],[3900,2200],[2500,1850]],rectangle(3000,700,3400,1050).reverse()],{class:'lake'})]),
  layer('park',[shape(3,[[[400,900],[3300,500],[3800,3400],[900,3700]]],{class:'park'})]),
  layer('building',[shape(3,[rectangle(800,800,1500,1350)],{class:'building'}),shape(3,[rectangle(3300,2700,3950,3700)],{class:'building'})]),
  layer('waterway',[shape(2,[[[-64,3600],[900,2500],[2300,1900],[4160,1700]]],{class:'river'}),shape(2,[[[2500,-32],[2800,700],[3400,4160]]],{class:'stream',intermittent:1})]),
  layer('boundary',[shape(2,[[[-64,2048],[1400,1900],[2500,2200],[4160,2048]]],{admin_level:2})]),
  layer('transportation',roads),
  layer('place',[shape(1,[[[1600,1800]]],{class:'city','name:ru':'Пиксельный город',rank:1})]),
  layer('mountain_peak',[shape(1,[[[2300,2600]]],{'name:ru':'Измеренная вершина',ele:2460})]),
  layer('transportation_name',[shape(2,[[[300,2000],[3900,2000]]],{class:'path','name:ru':'Контрольная тропа'})]),
 );
}
export const OPAQUE_VECTOR_CASES=Object.freeze([
 {name:'empty',empty:true,z:7,x:95,y:43,sourceZ:7},
 {name:'altai-scale',z:7,x:95,y:43,sourceZ:7},
 {name:'detailed-ink',z:15,x:24000,y:11000,sourceZ:15},
 {name:'paths-hidden',z:15,x:24000,y:11000,sourceZ:15,paths:false},
 {name:'boundaries-hidden',z:15,x:24000,y:11000,sourceZ:15,boundaries:false},
 {name:'parent-child-16',z:18,x:1605,y:3207,sourceZ:14},
 {name:'parent-child-64',z:18,x:6431,y:12831,sourceZ:12},
 {name:'world-copy-budget',z:6,x:111,y:21,sourceZ:6,paintZoom:7},
]);

// Browser-only: real workers, real transferred ImageBitmaps and the unchanged
// production map draw. Labels/DOM are independent surfaces outside this proof.
export async function runOpaqueVectorPixels(api,options){
 const {CustomMapEngine,mercatorUnproject,geometryPath,MAP_OUTSIDE_COLOR}=api;
 const check=(value,message)=>{if(!value)throw new Error(message);};
 const {dpr,softwareRaster,cases,vectorBytes}=options,width=512,height=384;
 check(devicePixelRatio===dpr,'Emulated device pixel ratio differs');
 const bitmaps=[],workers=[],pending=new Map();let sequence=0;
 const worker=(path)=>{
  const value=new Worker(path);workers.push(value);
  value.onmessage=event=>{const job=pending.get(event.data.id);if(job){pending.delete(event.data.id);clearTimeout(job.timer);event.data.error?job.reject(new Error(event.data.error)):job.resolve(event.data);}};
  value.onerror=event=>{for(const [id,job]of pending)if(job.worker===value){pending.delete(id);clearTimeout(job.timer);job.reject(new Error(event.message||'Worker failed'));}};
  return value;
 };
 const baseline=worker('/worker-baseline.js'),candidate=worker('/worker-production.js'),wrong=worker('/worker-force-opaque.js');
 const send=(target,job,input)=>new Promise((resolve,reject)=>{
  const id=++sequence,buffer=new Uint8Array(input).buffer;
  const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Worker pixel fixture timeout'));},15000);
  pending.set(id,{worker:target,resolve:value=>{try{
   check(value.bitmap instanceof ImageBitmap&&value.bitmap.width===512&&value.bitmap.height===512,'A transferred 512px ImageBitmap is required');
   check(value.__transferListed===true,'Production postMessage must transfer the output bitmap');bitmaps.push(value.bitmap);resolve(value);
  }catch(error){value.bitmap?.close();reject(error);}
  },reject,timer});target.postMessage({...job,id,bytes:buffer,softwareRaster},[buffer]);
 });
 const hash=async data=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(value=>value.toString(16).padStart(2,'0')).join('');
 const diff=(a,b)=>{check(a.length===b.length,'Pixel dimensions differ');let differentPixels=0,maxChannelDelta=0;for(let i=0;i<a.length;i+=4){let changed=false;for(let c=0;c<4;c++){const d=Math.abs(a[i+c]-b[i+c]);if(d){changed=true;maxChannelDelta=Math.max(maxChannelDelta,d);}}if(changed)differentPixels++;}return{differentPixels,maxChannelDelta,totalPixels:a.length/4};};
 const read=bitmap=>{const canvas=new OffscreenCanvas(512,512),ctx=canvas.getContext('2d',{alpha:true,willReadFrequently:true});ctx.drawImage(bitmap,0,0);return ctx.getImageData(0,0,512,512).data;};
 const compare=async(a,b)=>({...diff(a,b),baselinePixelSHA256:await hash(a),candidatePixelSHA256:await hash(b)});
 const metadata=result=>({labels:result.labels,contours:result.contours,reliefCoverage:result.reliefCoverage});
 const outputContext=result=>result.__contexts.find(item=>item.width===512&&item.height===512&&item.type==='2d');
 const imageBytes=async(kind)=>{
  const size=kind==='relief'?64:96,canvas=new OffscreenCanvas(size,size),ctx=canvas.getContext('2d'),data=ctx.createImageData(size,size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
   const at=(y*size+x)*4;
   if(kind==='relief'){
    const value=32768+1200+x*3+y*2+160*Math.sin(x/7)*Math.cos(y/9);data.data[at]=Math.floor(value/256);data.data[at+1]=Math.floor(value)%256;data.data[at+2]=Math.round((value%1)*256);data.data[at+3]=255;
   }else{data.data[at]=25+(x*7)%180;data.data[at+1]=45+(y*9)%150;data.data[at+2]=90+(x+y)%120;data.data[at+3]=x<size/4?0:((x+y)%17===0?128:255);}
  }
  ctx.putImageData(data,0,0);return new Uint8Array(await(await canvas.convertToBlob({type:'image/png'})).arrayBuffer());
 };
 const pair=async(job,bytes)=>{const a=await send(baseline,job,bytes),b=await send(candidate,job,bytes);check(JSON.stringify(metadata(a))===JSON.stringify(metadata(b)),'Worker labels/contours/coverage changed');return[a,b];};
 const frames=[{name:'altai',zoom:6.1,x:0,y:0,bearing:0},{name:'fractional-pan',zoom:6.1,x:.375,y:.625,bearing:0},{name:'rotated-pan',zoom:6.1,x:1.125,y:-.375,bearing:17.3},{name:'enlarged',zoom:8.25,x:-.625,y:.375,bearing:0}];
 const render=(bitmap,relief,raster,move,{transparent=false,omitRelief=false,omitMask=false}={})=>{
  const canvas=document.createElement('canvas');canvas.width=width*dpr;canvas.height=height*dpr;const context=canvas.getContext('2d',{alpha:false,willReadFrequently:softwareRaster});
  const z=7,n=2**z,scale=256*2**move.zoom,center={x:95.5/n-move.x/scale,y:43.5/n-move.y/scale};
  const tile=(kind,x,y,image,level=z)=>({key:`${kind}:${level}/${x}/${y}`,kind,z:level,x,y,bitmap:image,labels:[],transparent:kind==='vector'?transparent:true});
  const vector=[],reliefs=[],images=[];
  for(let y=40;y<=46;y++)for(let x=92;x<=98;x++){vector.push(tile('vector',x,y,bitmap));reliefs.push(tile('relief',x,y,relief));images.push(tile('eox-s2',x,y,raster));}
  const polygon=points=>points.map(([x,y])=>mercatorUnproject({x:(95.5+x)/n,y:(43.5+y)/n}));
  const area=geometryPath({type:'Polygon',coordinates:[polygon([[-2.2,-1.6],[1.9,-1.4],[2.3,1.6],[-1.8,1.4],[-2.2,-1.6]]),polygon([[-.35,-.35],[.4,-.25],[.25,.4],[-.4,.25],[-.35,-.35]])]}).path;
  const mask=new Path2D();mask.rect(-3,-3,8,8);mask.addPath(area);
  const route=geometryPath({type:'LineString',coordinates:polygon([[-2,-1],[0,.2],[2,1]])});
  const batch={kind:'vector',generation:1,tiles:vector},imagery={kind:'eox-s2',generation:1,tiles:images};
  const engine=Object.assign(Object.create(CustomMapEngine.prototype),{canvas,context,element:document.createElement('div'),size:{width,height},pixelRatio:dpr,camera:{center:mercatorUnproject(center),zoom:move.zoom,bearingDegrees:move.bearing},pitch:0,mode:transparent?'satellite':'detail',state:{committedMode:transparent?'satellite':'detail'},active:true,disposed:false,area,mask:omitMask?undefined:mask,boundaries:route.path,selectedArea:area,selectedBoundary:route.path,route,routeId:'pixel-fixture-route',overview:{kind:'overview',generation:1,tiles:images},detail:batch,relief:omitRelief?undefined:{kind:'relief',generation:1,tiles:reliefs},imagery:transparent?imagery:undefined,imageryOverlay:transparent?batch:undefined,boundaryVisible:true,reliefVisible:true,drawRevision:0,pointer:{activePointers:1},animation:0,options:{},drawLabels(){},drawMarkers(){}});
  CustomMapEngine.prototype.draw.call(engine);
  return{canvas,pixels:context.getImageData(0,0,canvas.width,canvas.height).data,contextAttributes:context.getContextAttributes()};
 };
 const results=[],controls=[];
 try{
  const dem=await imageBytes('relief'),image=await imageBytes('raster'),reliefJob={kind:'relief',z:7,x:95,y:43,sourceZ:7,sourceKey:'fixture://dem/7/95/43',mime:'image/png',paths:true},rasterJob={kind:'raster',z:7,x:95,y:43,sourceZ:7,mime:'image/png',paths:true};
  const [oldRelief,newRelief]=await pair(reliefJob,dem),[oldRaster,newRaster]=await pair(rasterJob,image);
  for(const [name,job,data,a,b]of [['relief',reliefJob,dem,oldRelief,newRelief],['raster',rasterJob,image,oldRaster,newRaster]]){
   const raw=await compare(read(a.bitmap),read(b.bitmap)),bad=await send(wrong,job,data),negative=diff(read(a.bitmap),read(bad.bitmap));
   check(outputContext(b).actual.alpha===true&&raw.differentPixels===0,`${name} alpha/pixels changed`);check(negative.differentPixels>0,`The ${name} negative control has no transparent pixels`);
   controls.push({name,outputContext:outputContext(b),comparison:raw,forceOpaque:negative});
  }
  const overlayJob={kind:'vector',z:15,x:24000,y:11000,sourceZ:15,sourceKey:'fixture://vector-rich',paths:true,transparent:true};
  const [oldOverlay,newOverlay]=await pair(overlayJob,vectorBytes),badOverlay=await send(wrong,overlayJob,vectorBytes);
  const overlayPixels=await compare(read(oldOverlay.bitmap),read(newOverlay.bitmap));check(outputContext(newOverlay).actual.alpha===true&&overlayPixels.differentPixels===0,'Satellite overlay changed');
  const satelliteFrame=frames[1],overlayScene=render(oldOverlay.bitmap,oldRelief.bitmap,oldRaster.bitmap,satelliteFrame,{transparent:true}),badScene=render(badOverlay.bitmap,oldRelief.bitmap,oldRaster.bitmap,satelliteFrame,{transparent:true}),overlayNegative=diff(overlayScene.pixels,badScene.pixels);
  check(overlayNegative.differentPixels>0,'Force-opaque satellite overlay must visibly fail');controls.push({name:'satellite-overlay',outputContext:outputContext(newOverlay),comparison:overlayPixels,forceOpaque:overlayNegative});
  for(const entry of cases){
   const input=entry.empty?[]:vectorBytes,job={...entry,kind:'vector',sourceKey:`fixture://vector-${entry.name}-${entry.sourceZ}`,paths:entry.paths!==false,transparent:false};delete job.empty;delete job.name;
   const [a,b]=await pair(job,input),raw=await compare(read(a.bitmap),read(b.bitmap));
   check(outputContext(a).actual.alpha===true&&outputContext(b).actual.alpha===false,'Baseline/candidate actual output context does not exercise alpha true/false');
   const item={name:entry.name,dpr,softwareRaster,sourceBytes:input.length,outputDimensions:[512,512],contexts:{baseline:outputContext(a),candidate:outputContext(b)},raw,frames:[],captures:[]};
   for(const move of frames){
    const old=render(a.bitmap,oldRelief.bitmap,oldRaster.bitmap,move),current=render(b.bitmap,newRelief.bitmap,newRaster.bitmap,move),comparison=await compare(old.pixels,current.pixels);
    item.frames.push({...move,comparison,contextAttributes:current.contextAttributes});
    if(comparison.differentPixels||entry.name==='altai-scale'&&move.name==='fractional-pan')item.captures.push({name:move.name,baseline:old.canvas.toDataURL('image/png').split(',')[1],candidate:current.canvas.toDataURL('image/png').split(',')[1]});
    if(entry.name==='altai-scale'&&move.name==='fractional-pan'){
     const noRelief=render(b.bitmap,newRelief.bitmap,newRaster.bitmap,move,{omitRelief:true}),noMask=render(b.bitmap,newRelief.bitmap,newRaster.bitmap,move,{omitMask:true});
     const reliefDifference=diff(current.pixels,noRelief.pixels),maskDifference=diff(current.pixels,noMask.pixels);check(reliefDifference.differentPixels>0&&maskDifference.differentPixels>0,'The composite must contain visible measured relief and mask pixels');controls.push({name:'composite-witnesses',reliefDifference,maskDifference,outsideColor:MAP_OUTSIDE_COLOR});
    }
   }
   item.verified=raw.differentPixels===0&&item.frames.every(frame=>frame.comparison.differentPixels===0);results.push(item);
   if(!item.verified)return{verified:false,dpr,softwareRaster,cases:results,negativeControls:controls};
  }
  return{verified:true,dpr,softwareRaster,cases:results,negativeControls:controls,workerTransport:'native Worker postMessage ImageBitmap transfer',separateLabelsAndDOMMarkersExcluded:true};
 }finally{for(const value of workers)value.terminate();for(const value of bitmaps)value.close();for(const job of pending.values()){clearTimeout(job.timer);job.reject(new Error('Fixture disposed'));}pending.clear();}
}
