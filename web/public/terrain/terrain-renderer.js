/**
 * Georeferenced DEM viewer; no external dependencies, assets or network requests.
 * Heights stay at 1:1 scale. Optional source cartography is georeferenced colour;
 * the untextured material makes no land-cover observation claim.
 * WebGL2: full-resolution height/normal textures, LOD mesh, cached terrain shadows.
 * Canvas2D: smooth, depth-buffered compatibility rendering. No idle animation loop.
 */
const PI=Math.PI,TAU=PI*2,EARTH_RADIUS=6371008.8;
const DEFAULT_VIEW=Object.freeze({yaw:-.48,pitch:.72,zoom:1});
const MAP_VIEW=Object.freeze({yaw:0,pitch:.85,zoom:2.2});
const longitudeNear=(longitude,reference)=>longitude+360*Math.round((reference-longitude)/360);
const SKY=[223,230,218],MAX_VERTICES=1050625,MAX_ROUTE_SEGMENTS=50000;
const SHADOW_COMPACT_QUERIES=32,SHADOW_FULL_QUERIES=48,SHADOW_MAX_DEPTH=20;
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const mix=(a,b,t)=>a+(b-a)*t;
const smoothstep=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const normalize=v=>{const n=Math.hypot(...v)||1;return v.map(x=>x/n);};
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];

export function validateTerrainDisplayMask(mask,grid){
 const source=mask?.source,b=source?.bounds;
 if(!mask||!Number.isInteger(mask.width)||!Number.isInteger(mask.height)||mask.width<2||mask.height<2||mask.width>2048||mask.height>2048||
 !(mask.pixels instanceof Uint8Array)||mask.pixels.length!==mask.width*mask.height)throw new TypeError('Invalid or oversized terrain display mask');
 if(!source||source.scope!=='russia-display-area'||!/^[a-f0-9]{16}$/.test(source.coverageVersion)||!['overview','regional','local','source'].includes(source.lod)||
 !Array.isArray(source.cells)||!source.cells.length||source.cells.length>1024||source.cells.some(id=>typeof id!=='string'||id.length>100)||
 !Array.isArray(b)||b.length!==4||!b.every(Number.isFinite)||!grid?.bounds||!b.every((value,index)=>Math.abs(value-grid.bounds[index])<1e-9)||
 source.projection!=='regular-longitude-latitude'||source.sampleLayout!=='pixel-cells'||source.rowOrder!=='north-to-south'||source.columnOrder!=='west-to-east'||
 source.boundaryRule!=='exclude-intersecting-texels'||!Number.isInteger(source.allowedPixels))throw new TypeError('Terrain display mask does not match the source grid');
 let allowed=0;for(const pixel of mask.pixels){if(pixel!==0&&pixel!==255)throw new TypeError('Invalid terrain display mask coverage');if(pixel)allowed++;}
 if(allowed!==source.allowedPixels)throw new TypeError('Invalid terrain display mask count');return mask;
}
export function sampleTerrainDisplayMask(mask,u,v){
 if(!mask)return true;
 if(!Number.isFinite(u)||!Number.isFinite(v)||u<0||v<0||u>1||v>1)return false;
 return mask.pixels[Math.min(mask.height-1,Math.floor(v*mask.height))*mask.width+Math.min(mask.width-1,Math.floor(u*mask.width))]===255;
}

export function validateTerrainCartography(surface,grid){
 const source=surface?.source,b=source?.bounds;
 if(!surface||!Number.isInteger(surface.width)||!Number.isInteger(surface.height)||surface.width<2||surface.height<2||surface.width>2048||surface.height>2048||
 !(surface.pixels instanceof Uint8ClampedArray)||surface.pixels.length!==surface.width*surface.height*4)throw new TypeError('Invalid or oversized terrain cartography');
 if(!source||typeof source.name!=='string'||!source.name||source.name.length>200||!Array.isArray(b)||b.length!==4||!b.every(Number.isFinite)||
 !grid?.bounds||!b.every((value,i)=>Math.abs(value-grid.bounds[i])<1e-9)||source.projection!=='regular-longitude-latitude'||source.sampleLayout!=='grid-nodes'||
 source.rowOrder!=='north-to-south'||source.columnOrder!=='west-to-east'||!Number.isInteger(source.requestedTiles)||source.requestedTiles<1||source.requestedTiles>16||
 !Number.isInteger(source.loadedTiles)||source.loadedTiles<0||source.loadedTiles>source.requestedTiles)throw new TypeError('Terrain cartography does not match the source grid');
 return surface;
}
export function sampleTerrainCartography(surface,u,v,output=[0,0,0,0]){
 if(!surface||!Number.isFinite(u)||!Number.isFinite(v)){output.fill(0);return output;}
 const w=surface.width,h=surface.height,p=surface.pixels,x=clamp(u,0,1)*(w-1),y=clamp(v,0,1)*(h-1),x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(x0+1,w-1),y1=Math.min(y0+1,h-1),fx=x-x0,fy=y-y0;
 const a=(y0*w+x0)*4,b=(y0*w+x1)*4,c=(y1*w+x0)*4,d=(y1*w+x1)*4;
 const wa=(1-fx)*(1-fy)*p[a+3],wb=fx*(1-fy)*p[b+3],wc=(1-fx)*fy*p[c+3],wd=fx*fy*p[d+3],alpha=wa+wb+wc+wd;
 output[3]=alpha;for(let k=0;k<3;k++)output[k]=alpha?(p[a+k]*wa+p[b+k]*wb+p[c+k]*wc+p[d+k]*wd)/alpha:0;
 return output;
}

export function validateTerrainGrid(grid){
 if(!grid||!Number.isInteger(grid.width)||!Number.isInteger(grid.height)||grid.width<2||grid.height<2||
 grid.width*grid.height>MAX_VERTICES||!grid.elevations||grid.elevations.length!==grid.width*grid.height)
  throw new TypeError('Invalid or oversized elevation grid');
 const b=grid.bounds;
 if(!Array.isArray(b)||b.length!==4||!b.every(Number.isFinite)||b[0]>=b[2]||b[1]>=b[3]||
 b[2]-b[0]>360||b[1]<-85||b[3]>85)throw new TypeError('Invalid terrain bounds');
 if(grid.units&&grid.units!=='meters')throw new TypeError('Terrain heights must be in metres');
 if(grid.rowOrder&&grid.rowOrder!=='north-to-south')throw new TypeError('Unsupported terrain row order');
 if(grid.columnOrder&&grid.columnOrder!=='west-to-east')throw new TypeError('Unsupported terrain column order');
 let min=Infinity,max=-Infinity;
 for(let i=0;i<grid.elevations.length;i++){
  const h=grid.elevations[i];
  if(!Number.isFinite(h)||h<-12000||h>10000)throw new TypeError('Invalid terrain elevation');
  min=Math.min(min,h);max=Math.max(max,h);
 }
 return{min,max};
}
function terrainModelDimensions(grid){
 const range=validateTerrainGrid(grid),b=grid.bounds,W=grid.width,H=grid.height,metresPerDegree=EARTH_RADIUS*PI/180;
 const widthM=(b[2]-b[0])*metresPerDegree*Math.cos((b[1]+b[3])*PI/360),heightM=(b[3]-b[1])*metresPerDegree;
 const scale=Math.max(widthM,heightM),base=(range.min+range.max)/2,cellX=widthM/(W-1),cellY=heightM/(H-1);
 if(![widthM,heightM,scale,cellX,cellY].every(v=>Number.isFinite(v)&&v>0)||!Number.isFinite(Math.fround((range.max-base)/scale)))throw new TypeError('Invalid terrain scale');
 return{grid,widthM,heightM,width:widthM/scale,height:heightM/scale,scale,base,min:range.min,max:range.max,cellX,cellY};
}
function terrainModelDraft(grid){
 const model=terrainModelDimensions(grid),count=grid.width*grid.height;
 return{...model,heights:new Float32Array(count),normals:new Float32Array(count*3),normalTexture:new Uint8Array(count*4)};
}
function prepareTerrainRange(model,start,end){
 const{grid,scale,base,cellX,cellY,heights,normals,normalTexture}=model,W=grid.width,H=grid.height,values=grid.elevations;
 const directions=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
 for(let i=start;i<end;i++){
  const x=i%W,y=Math.floor(i/W),h=values[i];heights[i]=(h-base)/scale;
  const xl=Math.max(0,x-1),xr=Math.min(W-1,x+1),yn=Math.max(0,y-1),ys=Math.min(H-1,y+1);
  const sx=(values[y*W+xr]-values[y*W+xl])/((xr-xl)*cellX),sy=(values[yn*W+x]-values[ys*W+x])/((ys-yn)*cellY);
  const length=Math.hypot(sx,sy,1),n=[-sx/length,-sy/length,1/length];
  let occlusion=0,samples=0;
  for(const radius of[2,8])for(const[dx,dy]of directions){
   const nx=clamp(x+dx*radius,0,W-1),ny=clamp(y+dy*radius,0,H-1),distance=Math.hypot((nx-x)*cellX,(ny-y)*cellY);
   if(distance){occlusion+=Math.atan(Math.max(0,values[ny*W+nx]-h)/distance);samples++;}
  }
  const ao=clamp(1-.56*occlusion/Math.max(1,samples),.58,1);
  for(let k=0;k<3;k++){normals[i*3+k]=n[k];normalTexture[i*4+k]=Math.round((n[k]*.5+.5)*255);}
  normalTexture[i*4+3]=Math.round(ao*255);
 }
}
export function createTerrainModel(grid){
 const model=terrainModelDraft(grid);prepareTerrainRange(model,0,grid.width*grid.height);return model;
}
export async function createTerrainModelAsync(grid,{signal}={}){
 const aborted=()=>{if(signal?.aborted){const error=new Error('Terrain preparation aborted');error.name='AbortError';throw error;}};
 aborted();await new Promise(resolve=>setTimeout(resolve,0));aborted();
 const model=terrainModelDraft(grid),count=grid.width*grid.height;
 for(let start=0;start<count;start+=1024){
  aborted();prepareTerrainRange(model,start,Math.min(count,start+1024));
  if(start+1024<count)await new Promise(resolve=>setTimeout(resolve,0));
 }
 aborted();return model;
}
export function validatePreparedTerrainModel(grid,model){
 const expected=terrainModelDimensions(grid),count=grid.width*grid.height,source=model?.grid;
 const invalid=()=>{throw new TypeError('Prepared terrain model does not match its source grid');};
 if(!model||!source||source.width!==grid.width||source.height!==grid.height||!Array.isArray(source.bounds)||source.bounds.length!==4||source.bounds.some((v,i)=>v!==grid.bounds[i])||source.elevations?.length!==count)invalid();
 for(const key of['schemaVersion','units','rowOrder','columnOrder','source','attribution'])if(JSON.stringify(source[key])!==JSON.stringify(grid[key]))invalid();
 for(const key of['widthM','heightM','width','height','scale','base','min','max','cellX','cellY']){
  if(!Number.isFinite(model[key])||Math.abs(model[key]-expected[key])>Math.max(1,Math.abs(expected[key]))*1e-12)invalid();
 }
 if(!(model.heights instanceof Float32Array)||model.heights.length!==count||!(model.normals instanceof Float32Array)||model.normals.length!==count*3||!(model.normalTexture instanceof Uint8Array)||model.normalTexture.length!==count*4)invalid();
 if(![model.heights,model.normals,model.normalTexture].every(v=>v.buffer instanceof ArrayBuffer))invalid();
 for(let i=0;i<count;i++){
  if((source!==grid&&source.elevations[i]!==grid.elevations[i])||!Number.isFinite(model.heights[i])||model.heights[i]!==Math.fround((grid.elevations[i]-expected.base)/expected.scale))invalid();
  const x=model.normals[i*3],y=model.normals[i*3+1],z=model.normals[i*3+2],length=x*x+y*y+z*z;
  if(!Number.isFinite(length)||length<.999||length>1.001||z<=0)invalid();
 }
 if(model.shadowPyramid!==undefined){
  let width=2**Math.ceil(Math.log2(grid.width-1)),height=2**Math.ceil(Math.log2(grid.height-1)),index=0;
  if(!Array.isArray(model.shadowPyramid))invalid();
  while(true){
   const level=model.shadowPyramid[index++];
   if(!level||level.width!==width||level.height!==height||!(level.data instanceof Float32Array)||level.data.length!==width*height||!(level.data.buffer instanceof ArrayBuffer)||!level.data.every(Number.isFinite))invalid();
   if(width===1&&height===1)break;width=Math.max(1,width/2);height=Math.max(1,height/2);
  }
  if(index!==model.shadowPyramid.length)invalid();
 }
 return model;
}
function terrainShadowPyramid(model){
 if(model.shadowPyramid)return model.shadowPyramid;
 const W=model.grid.width,H=model.grid.height,width=2**Math.ceil(Math.log2(W-1)),height=2**Math.ceil(Math.log2(H-1));
 const data=new Float32Array(width*height);data.fill(-3.4e38);
 // Each cell bounds all four samples, and therefore every bilinear height inside it.
 for(let y=0;y<H-1;y++)for(let x=0;x<W-1;x++){
  const i=y*W+x;data[y*width+x]=Math.max(model.heights[i],model.heights[i+1],model.heights[i+W],model.heights[i+W+1]);
 }
 const levels=[{width,height,data}];let previous=levels[0];
 while(previous.width>1||previous.height>1){
  const next={width:Math.max(1,previous.width/2),height:Math.max(1,previous.height/2)};next.data=new Float32Array(next.width*next.height);
  for(let y=0;y<next.height;y++)for(let x=0;x<next.width;x++){
   const x0=x*2,x1=Math.min(x0+1,previous.width-1),y0=y*2,y1=Math.min(y0+1,previous.height-1),v=previous.data;
   next.data[y*next.width+x]=Math.max(v[y0*previous.width+x0],v[y0*previous.width+x1],v[y1*previous.width+x0],v[y1*previous.width+x1]);
  }
  levels.push(next);previous=next;
 }
 model.shadowPyramid=levels;return levels;
}
function maximumShadowHeight(model,pyramid,u0,v0,u1,v1){
 const W=model.grid.width,H=model.grid.height;
 const x0=clamp(Math.floor(Math.min(u0,u1)*(W-1)),0,W-2),x1=clamp(Math.floor(Math.max(u0,u1)*(W-1)),0,W-2);
 const y0=clamp(Math.floor(Math.min(v0,v1)*(H-1)),0,H-2),y1=clamp(Math.floor(Math.max(v0,v1)*(H-1)),0,H-2);
 const level=Math.ceil(Math.log2(Math.max(x1-x0+1,y1-y0+1))),block=2**level,p=pyramid[level];
 const a=Math.floor(x0/block),b=Math.floor(x1/block),c=Math.floor(y0/block),d=Math.floor(y1/block),v=p.data;
 return Math.max(v[c*p.width+a],v[c*p.width+b],v[d*p.width+a],v[d*p.width+b]);
}
export function sampleTerrainShadow(model,x,y,height,light,requestedBudget=SHADOW_FULL_QUERIES,stats){
 const budget=Number.isFinite(requestedBudget)?clamp(Math.floor(requestedBudget),1,SHADOW_FULL_QUERIES):SHADOW_FULL_QUERIES;
 if(stats){stats.queries=0;stats.limitReached=false;}
 const horizontal=Math.hypot(light[0],light[1]);if(horizontal<1e-8||light[2]<=0)return 1;
 const u=x/model.widthM+.5,v=.5-y/model.heightM;if(u<0||u>1||v<0||v>1)return 1;
 const du=light[0]/horizontal/model.width,dv=-light[1]/horizontal/model.height,slope=light[2]/horizontal;
 const cell=Math.min(model.cellX,model.cellY)/model.scale,start=cell*1.1,h=(height-model.base)/model.scale;
 let end=.8;
 if(du>1e-12)end=Math.min(end,(1-u)/du);else if(du< -1e-12)end=Math.min(end,-u/du);
 if(dv>1e-12)end=Math.min(end,(1-v)/dv);else if(dv< -1e-12)end=Math.min(end,-v/dv);
 if(end<=start)return 1;
 const pyramid=terrainShadowPyramid(model),span=end-start;let level=0,index=0,visibility=1;
 // Dyadic interval traversal needs no growing stack. Bounds only skip clear space;
 // a high off-ray texel can never darken a pixel without a real on-ray height sample.
 for(let work=0;work<budget;work++){
  if(stats)stats.queries=work+1;
  const length=span*2**-level,lo=start+index*length,hi=lo+length,softness=cell*.25+lo*.014;
  const maximum=maximumShadowHeight(model,pyramid,u+du*lo,v+dv*lo,u+du*hi,v+dv*hi);
  if(maximum>h+lo*slope+cell*.18-softness){
   if(length>cell*.65&&level<SHADOW_MAX_DEPTH){level++;index*=2;continue;}
   const d=(lo+hi)/2,next=sampleElevation(model,x+light[0]/horizontal*d*model.scale,y+light[1]/horizontal*d*model.scale);
   if(next!==null){const s=cell*.25+d*.014;visibility=Math.min(visibility,smoothstep(-s,s,h+d*slope+cell*.18-(next-model.base)/model.scale));}
   if(visibility<.005)return visibility;
  }
  for(let up=0;up<SHADOW_MAX_DEPTH;up++){
   if(level===0)return visibility;
   if((index&1)===0){index++;break;}
   index=Math.floor(index/2);level--;
  }
 }
 if(stats)stats.limitReached=true;return visibility;
}
export function sampleElevation(model,x,y){
 if(!Number.isFinite(x)||!Number.isFinite(y))return null;
 const{grid,widthM,heightM}=model,W=grid.width,H=grid.height;
 let gx=(x/widthM+.5)*(W-1),gy=(.5-y/heightM)*(H-1);
 if(gx< -1e-7||gy< -1e-7||gx>W-1+1e-7||gy>H-1+1e-7)return null;
 gx=clamp(gx,0,W-1);gy=clamp(gy,0,H-1);
 const ix=Math.min(W-2,Math.floor(gx)),iy=Math.min(H-2,Math.floor(gy)),a=gx-ix,b=gy-iy,v=grid.elevations;
 return mix(mix(v[iy*W+ix],v[iy*W+ix+1],a),mix(v[(iy+1)*W+ix],v[(iy+1)*W+ix+1],a),b);
}
function meshCell(grid,gx,gy,step){
 const x=Math.min(Math.floor(gx/step),Math.ceil((grid.width-1)/step)-1)*step;
 const y=Math.min(Math.floor(gy/step),Math.ceil((grid.height-1)/step)-1)*step;
 return[x,y,Math.min(grid.width-1,x+step),Math.min(grid.height-1,y+step)];
}
function meshHeight(model,gx,gy,step){
 const W=model.grid.width,[x,y,x1,y1]=meshCell(model.grid,gx,gy,step),s=(gx-x)/(x1-x),t=(gy-y)/(y1-y),v=model.heights;
 const a=v[y*W+x],b=v[y*W+x1],c=v[y1*W+x],d=v[y1*W+x1];
 // The same a-c-b / b-c-d diagonal used by buildTerrainMesh, including ragged edge cells.
 return s+t<=1?a+(b-a)*s+(c-a)*t:d+(c-d)*(1-s)+(b-d)*(1-t);
}
export function sampleTerrainMeshElevation(model,x,y,step){
 if(!Number.isInteger(step)||step<1)throw new TypeError('Invalid mesh stride');
 if(!Number.isFinite(x)||!Number.isFinite(y))return null;
 const W=model.grid.width,H=model.grid.height,gx=(x/model.widthM+.5)*(W-1),gy=(.5-y/model.heightM)*(H-1);
 if(gx< -1e-7||gy< -1e-7||gx>W-1+1e-7||gy>H-1+1e-7)return null;
 return meshHeight(model,clamp(gx,0,W-1),clamp(gy,0,H-1),step)*model.scale+model.base;
}
export function drapeTerrainRoute(model,segments,step){
 if(!Number.isInteger(step)||step<1)throw new TypeError('Invalid mesh stride');
 if(!Array.isArray(segments)||segments.length>MAX_ROUTE_SEGMENTS)throw new RangeError('Route exceeds the terrain preview limit');
 const W=model.grid.width,H=model.grid.height,result=[],lift=Math.max(1.5,Math.min(model.cellX,model.cellY)*.08)/model.scale;
 for(const[a,b]of segments){
  const gx=(a[0]/model.width+.5)*(W-1),gy=(.5-a[1]/model.height)*(H-1);
  const dx=(b[0]-a[0])/model.width*(W-1),dy=-(b[1]-a[1])/model.height*(H-1),cuts=[0,1];
  if(![gx,gy,dx,dy].every(Number.isFinite))throw new TypeError('Invalid terrain route point');
  if(Math.min(gx,gx+dx)<-1e-7||Math.max(gx,gx+dx)>W-1+1e-7||Math.min(gy,gy+dy)<-1e-7||Math.max(gy,gy+dy)>H-1+1e-7)throw new RangeError('Terrain route point is outside the grid');
  const boundaries=(start,delta,limit)=>{
   if(Math.abs(delta)<1e-12)return;
   const low=Math.min(start,start+delta),high=Math.max(start,start+delta);
   for(let n=Math.max(1,Math.floor(low/step)+1);n*step<Math.min(high,limit);n++){
    const t=(n*step-start)/delta;if(t>1e-10&&t<1-1e-10)cuts.push(t);
   }
  };
  boundaries(gx,dx,W-1);boundaries(gy,dy,H-1);cuts.sort((a,b)=>a-b);
  const cellCuts=cuts.filter((t,i)=>!i||t-cuts[i-1]>1e-10),allCuts=[0];
  for(let i=1;i<cellCuts.length;i++){
   const lo=cellCuts[i-1],hi=cellCuts[i],mid=(lo+hi)/2;
   const[x,y,x1,y1]=meshCell(model.grid,clamp(gx+dx*mid,0,W-1),clamp(gy+dy*mid,0,H-1),step);
   const aSide=(gx+dx*lo-x)/(x1-x)+(gy+dy*lo-y)/(y1-y)-1;
   const bSide=(gx+dx*hi-x)/(x1-x)+(gy+dy*hi-y)/(y1-y)-1;
   if(aSide*bSide<0){const crossing=lo-aSide*(hi-lo)/(bSide-aSide);if(crossing-lo>1e-10&&hi-crossing>1e-10)allCuts.push(crossing);}
   allCuts.push(hi);
  }
  let previous;
  for(const t of allCuts){
   const x=mix(a[0],b[0],t),y=mix(a[1],b[1],t),height=meshHeight(model,clamp(gx+dx*t,0,W-1),clamp(gy+dy*t,0,H-1),step);
   const point=[x,y,height+lift];
   if(previous){if(result.length>=MAX_ROUTE_SEGMENTS)throw new RangeError('Draped route exceeds the terrain preview limit');result.push([previous,point]);}
   previous=point;
  }
 }
 return result;
}
export function buildTerrainMesh(model,step,range=null){
 if(!Number.isInteger(step)||step<1)throw new TypeError('Invalid mesh stride');
 const W=model.grid.width,H=model.grid.height,xs=[],ys=[],r=range||[0,0,W-1,H-1];
 if(!Array.isArray(r)||r.length!==4||!r.every(Number.isInteger)||r[0]<0||r[1]<0||r[2]>=W||r[3]>=H||r[0]>=r[2]||r[1]>=r[3]||r[0]%step||r[1]%step||r[2]!==W-1&&r[2]%step||r[3]!==H-1&&r[3]%step)throw new TypeError('Invalid terrain mesh window');
 for(let x=r[0];x<r[2];x+=step)xs.push(x);xs.push(r[2]);
 for(let y=r[1];y<r[3];y+=step)ys.push(y);ys.push(r[3]);
 const count=xs.length*ys.length,uv=new Float32Array(count*2),sampleIds=new Uint32Array(count);
 for(let y=0;y<ys.length;y++)for(let x=0;x<xs.length;x++){
  const i=y*xs.length+x;uv[i*2]=xs[x]/(W-1);uv[i*2+1]=ys[y]/(H-1);sampleIds[i]=ys[y]*W+xs[x];
 }
 const IndexType=count>65535?Uint32Array:Uint16Array,indices=new IndexType((xs.length-1)*(ys.length-1)*6);let j=0;
 for(let y=0;y<ys.length-1;y++)for(let x=0;x<xs.length-1;x++){
  const a=y*xs.length+x,b=a+1,c=a+xs.length,d=c+1;
  for(const id of[a,c,b,b,c,d])indices[j++]=id;
 }
 return{uv,sampleIds,indices,count,step,triangles:indices.length/3,...range?{window:[...range]}:{}};
}
/** Conservative XY envelope of the actual camera frustum over measured min/max
 * elevations. Eliminating Z independently from each plane can retain extra
 * cells, never remove a visible peak. The tiny convex polygon has <=10 vertices. */
export function visibleTerrainSampleWindow(model,camera){
 const m=camera?.matrix,offset=camera?.offset;
 if(!m||m.length!==16||!Array.from(m).every(Number.isFinite)||!offset||offset.length!==2||!offset.every(Number.isFinite))throw new TypeError('Invalid terrain clipping camera');
 let polygon=[[-model.width/2,-model.height/2],[model.width/2,-model.height/2],[model.width/2,model.height/2],[-model.width/2,model.height/2]];
 const low=(model.min-model.base)/model.scale,high=(model.max-model.base)/model.scale;
 for(const axis of[0,1,2])for(const sign of[-1,1]){
  const multiplier=(axis===2?1:1.06)+sign*(axis===2?0:offset[axis]);
  const a=multiplier*m[3]+sign*m[axis],b=multiplier*m[7]+sign*m[4+axis],c=multiplier*m[11]+sign*m[8+axis],d=multiplier*m[15]+sign*m[12+axis]+c*(c>=0?high:low);
  const value=p=>a*p[0]+b*p[1]+d,next=[];
  for(let i=0;i<polygon.length;i++){
   const p=polygon[i],q=polygon[(i+1)%polygon.length],vp=value(p),vq=value(q),pin=vp>=-1e-9,qin=vq>=-1e-9;
   if(pin)next.push(p);
   if(pin!==qin){const t=clamp(vp/(vp-vq),0,1);next.push([mix(p[0],q[0],t),mix(p[1],q[1],t)]);}
  }
  polygon=next;if(!polygon.length)return null;
 }
 const W=model.grid.width-1,H=model.grid.height-1,x=polygon.map(p=>clamp((p[0]/model.width+.5)*W,0,W)),y=polygon.map(p=>clamp((.5-p[1]/model.height)*H,0,H));
 return[Math.min(...x),Math.min(...y),Math.max(...x),Math.max(...y)];
}
function alignedTerrainWindow(grid,window,step){
 const block=step*8;
 return[Math.max(0,Math.floor((window[0]-step*2)/block)*block),Math.max(0,Math.floor((window[1]-step*2)/block)*block),
  Math.min(grid.width-1,Math.ceil((window[2]+step*2)/block)*block),Math.min(grid.height-1,Math.ceil((window[3]+step*2)/block)*block)];
}
/** Spend the fixed compatibility budget on the visible real samples instead of
 * decimating an entire 20km region when only a few kilometres fill the screen. */
export function selectVisibleTerrainMesh(model,camera,budget,previous=0){
 if(!Number.isFinite(budget)||budget<4)throw new TypeError('Invalid visible terrain budget');
 const limit=Math.min(MAX_VERTICES,Math.floor(budget)),grid=model.grid,window=visibleTerrainSampleWindow(model,camera)||[0,0,grid.width-1,grid.height-1];
 const selection=step=>{const range=alignedTerrainWindow(grid,window,step);return{step,range,count:(Math.ceil((range[2]-range[0])/step)+1)*(Math.ceil((range[3]-range[1])/step)+1)};};
 let current=selection(Number.isInteger(previous)&&previous>=1&&Number.isInteger(Math.log2(previous))?previous:1);
 while(current.count>limit)current=selection(current.step*2);
 const refineLimit=previous?limit*.96:limit;
 while(current.step>1){const finer=selection(current.step/2);if(finer.count>refineLimit)break;current=finer;}
 return current;
}
export function selectTerrainMeshStride(grid,budget,previous=0,hardLimit=MAX_VERTICES){
 if(!Number.isFinite(budget)||budget<4||!Number.isFinite(hardLimit)||hardLimit<4)throw new TypeError('Invalid terrain vertex budget');
 const count=step=>(Math.ceil((grid.width-1)/step)+1)*(Math.ceil((grid.height-1)/step)+1),limit=Math.min(MAX_VERTICES,hardLimit);
 let step=Number.isInteger(previous)&&previous>=1?previous:1;
 const coarseThreshold=Math.min(limit,budget*(previous?1.25:1));
 while(count(step)>coarseThreshold)step*=2;
 const fineThreshold=budget>=limit?limit:budget*.75;
 while(step>1&&count(step/2)<=fineThreshold)step/=2;
 return step;
}
export function terrainLight(yaw,pitch){
 const altitude=.58+clamp(pitch,.28,1.32)*.12,azimuth=yaw-2.246;
 return[Math.cos(azimuth)*Math.cos(altitude),Math.sin(azimuth)*Math.cos(altitude),Math.sin(altitude)];
}
/** A schematic cut edge, never a claim about subsurface geology. Its rim uses the exact active mesh samples. */
export function buildTerrainBoundary(model,step){
 if(!Number.isInteger(step)||step<1)throw new TypeError('Invalid mesh stride');
 const W=model.grid.width,H=model.grid.height,xs=[],ys=[],vertices=[],floor=(model.min-model.base)/model.scale-.012;
 for(let x=0;x<W-1;x+=step)xs.push(x);xs.push(W-1);
 for(let y=0;y<H-1;y+=step)ys.push(y);ys.push(H-1);
 const point=(x,y)=>[(x/(W-1)-.5)*model.width,(.5-y/(H-1))*model.height,model.heights[y*W+x]];
 const edge=(a,b,normal)=>{
  const lowA=[a[0],a[1],floor],lowB=[b[0],b[1],floor];
  for(const p of[a,lowA,b,b,lowA,lowB])vertices.push(...p,...normal);
 };
 for(let i=1;i<xs.length;i++){
  edge(point(xs[i-1],0),point(xs[i],0),[0,1,0]);
  edge(point(xs[i],H-1),point(xs[i-1],H-1),[0,-1,0]);
 }
 for(let i=1;i<ys.length;i++){
  edge(point(0,ys[i]),point(0,ys[i-1]),[-1,0,0]);
  edge(point(W-1,ys[i-1]),point(W-1,ys[i]),[1,0,0]);
 }
 return{vertices:new Float32Array(vertices),floor,count:vertices.length/6,triangles:vertices.length/18};
}
// Liang–Barsky keeps crossing segments whose source vertices are both outside.
export function clipTerrainSegment(a,b,bounds){
 let start=0,end=1;const dx=b[0]-a[0],dy=b[1]-a[1],p=[-dx,dx,-dy,dy],q=[a[0]-bounds[0],bounds[2]-a[0],a[1]-bounds[1],bounds[3]-a[1]];
 for(let i=0;i<4;i++){
  if(Math.abs(p[i])<1e-15){if(q[i]<0)return null;continue;}
  const t=q[i]/p[i];if(p[i]<0)start=Math.max(start,t);else end=Math.min(end,t);if(start>end)return null;
 }
 return[[mix(a[0],b[0],start),mix(a[1],b[1],start)],[mix(a[0],b[0],end),mix(a[1],b[1],end)]];
}
export function terrainRoute(model,data){
 const lines=[],segments=[],bounds=model.grid.bounds;
 const visit=(g,depth=0)=>{
  if(!g||depth>16)return;
  if(g.type==='FeatureCollection'&&Array.isArray(g.features))g.features.forEach(f=>visit(f,depth+1));
  else if(g.type==='Feature')visit(g.geometry,depth+1);
  else if(g.type==='GeometryCollection'&&Array.isArray(g.geometries))g.geometries.forEach(f=>visit(f,depth+1));
  else if(g.type==='LineString'&&Array.isArray(g.coordinates))lines.push(g.coordinates);
  else if(g.type==='MultiLineString'&&Array.isArray(g.coordinates))lines.push(...g.coordinates.filter(Array.isArray));
 };visit(data);
 const valid=p=>Array.isArray(p)&&p.length>=2&&Number.isFinite(p[0])&&Number.isFinite(p[1])&&p[1]>=-90&&p[1]<=90;
 const longitudeNear=(longitude,reference)=>longitude+360*Math.round((reference-longitude)/360),centerLongitude=(bounds[0]+bounds[2])/2;
 const local=p=>[((p[0]-bounds[0])/(bounds[2]-bounds[0])-.5)*model.widthM,((p[1]-bounds[1])/(bounds[3]-bounds[1])-.5)*model.heightM];
 const lift=Math.max(1.5,Math.min(model.cellX,model.cellY)*.08),step=Math.max(5,Math.min(model.cellX,model.cellY)*.75);
 let clipped=false,sourceSegments=0;
 for(const line of lines)for(let i=1;i<line.length;i++){
  if(++sourceSegments>250000)throw new RangeError('Route exceeds the terrain preview limit');
  const sourceA=line[i-1],sourceB=line[i];
  if(!valid(sourceA)||!valid(sourceB)){clipped=true;continue;}
  // Keep an actual crossing of 180 degrees adjacent in the grid's continuous
  // world. These display coordinates never mutate or replace the source line.
  const a=[longitudeNear(sourceA[0],centerLongitude),sourceA[1]],b=[longitudeNear(sourceB[0],a[0]),sourceB[1]];
  const part=clipTerrainSegment(a,b,bounds);if(!part){clipped=true;continue;}
  if(part[0][0]!==a[0]||part[0][1]!==a[1]||part[1][0]!==b[0]||part[1][1]!==b[1])clipped=true;
  const p=local(part[0]),q=local(part[1]),length=Math.hypot(q[0]-p[0],q[1]-p[1]);if(length<.01)continue;
  const count=Math.ceil(length/step);if(segments.length+count>MAX_ROUTE_SEGMENTS)throw new RangeError('Route exceeds the terrain preview limit');
  let previous;
  for(let j=0;j<=count;j++){
   const x=mix(p[0],q[0],j/count),y=mix(p[1],q[1],j/count),h=sampleElevation(model,x,y);
   if(h===null){previous=undefined;continue;}
   const point=[x/model.scale,y/model.scale,(h-model.base+lift)/model.scale];
   if(previous)segments.push([previous,point]);previous=point;
  }
 }
 return{segments,clipped,sourceSegments};
}
function multiplyMatrix(a,b){
 const out=new Float32Array(16);
 for(let col=0;col<4;col++)for(let row=0;row<4;row++)for(let k=0;k<4;k++)out[col*4+row]+=a[k*4+row]*b[col*4+k];
 return out;
}
function normalizedInsets(value){
 if(value===null||value===undefined)return null;
 const result={};for(const key of['top','right','bottom','left'])result[key]=Number.isFinite(value[key])?Math.max(0,value[key]):0;return result;
}
const terrainFitCache=new WeakMap();
function canonicalTerrainFit(model,aspect){
 let cache=terrainFitCache.get(model);
 if(!cache){
  const yaw=DEFAULT_VIEW.yaw,pitch=DEFAULT_VIEW.pitch,z=[Math.sin(yaw)*Math.cos(pitch),-Math.cos(yaw)*Math.cos(pitch),Math.sin(pitch)];
  const x=[Math.cos(yaw),Math.sin(yaw),0],y=cross(z,x),floor=(model.min-model.base)/model.scale-.012;
  let near=Infinity,far=-Infinity;
  for(const a of[-model.width/2,model.width/2])for(const b of[-model.height/2,model.height/2])for(const c of[floor,(model.max-model.base)/model.scale]){
   const depth=a*z[0]+b*z[1]+(c-.005)*z[2];near=Math.min(near,depth);far=Math.max(far,depth);
  }
  const count=64,bins=Array.from({length:count},()=>[Infinity,-Infinity,Infinity,-Infinity,Infinity,-Infinity]);
  const include=(east,north,height)=>{
   const h=height-.005,a=east*x[0]+north*x[1],b=east*y[0]+north*y[1]+h*y[2],c=east*z[0]+north*z[1]+h*z[2];
   const bin=bins[clamp(Math.floor((c-near)/Math.max(1e-9,far-near)*count),0,count-1)];
   bin[0]=Math.min(bin[0],a);bin[1]=Math.max(bin[1],a);bin[2]=Math.min(bin[2],b);bin[3]=Math.max(bin[3],b);bin[4]=Math.min(bin[4],c);bin[5]=Math.max(bin[5],c);
  };
  // One source pass for the canonical view. All later zoom/orbit/resize fits use only 64 depth bounds.
  const W=model.grid.width,H=model.grid.height;
  for(let row=0;row<H;row++)for(let col=0;col<W;col++)include((col/(W-1)-.5)*model.width,(.5-row/(H-1))*model.height,model.heights[row*W+col]);
  for(const east of[-model.width/2,model.width/2])for(const north of[-model.height/2,model.height/2])include(east,north,floor);
  cache={bins:bins.filter(b=>Number.isFinite(b[0])),fits:new Map()};terrainFitCache.set(model,cache);
 }
 const key=String(aspect);if(cache.fits.has(key))return cache.fits.get(key);
 const bounds=distance=>{
  let left=Infinity,right=-Infinity,bottom=Infinity,top=-Infinity;
  for(const b of cache.bins){
   const close=distance-b[5],away=distance-b[4];
   left=Math.min(left,b[0]/(b[0]<=0?close:away));right=Math.max(right,b[1]/(b[1]>=0?close:away));
   bottom=Math.min(bottom,b[2]/(b[2]<=0?close:away));top=Math.max(top,b[3]/(b[3]>=0?close:away));
  }
  return{left,right,bottom,top};
 };
 const tan=Math.tan(42*PI/360),frame=.78,maxX=2*tan*aspect*frame,maxY=2*tan*frame;
 const fits=b=>b.right-b.left<=maxX&&b.top-b.bottom<=maxY;
 let lo=Math.max(...cache.bins.map(b=>b[5]))+.02,hi=Math.max(2,lo*2);
 for(let i=0;i<24&&!fits(bounds(hi));i++)hi*=2;
 for(let i=0;i<20;i++){const mid=(lo+hi)/2;if(fits(bounds(mid)))hi=mid;else lo=mid;}
 const b=bounds(hi),fit={distance:hi,centerX:(b.left+b.right)/2,centerY:(b.bottom+b.top)/2};
 if(cache.fits.size>=8)cache.fits.delete(cache.fits.keys().next().value);cache.fits.set(key,fit);return fit;
}
function cameraFor(model,state,width,height,compact){
 const insets=state.viewportInsets||{top:0,right:0,bottom:compact&&width<700?height*.47:0,left:0};
 const horizontal=insets.left+insets.right,vertical=insets.top+insets.bottom;
 const sx=horizontal?Math.min(1,width*.88/horizontal):1,sy=vertical?Math.min(1,height*.88/vertical):1;
 const left=insets.left*sx,right=insets.right*sx,top=insets.top*sy,bottom=insets.bottom*sy;
 const usableW=Math.max(1,width-left-right),usableH=Math.max(1,height-top-bottom),aspect=usableW/usableH,fov=42*PI/180;
 const z=[Math.sin(state.yaw)*Math.cos(state.pitch),-Math.cos(state.yaw)*Math.cos(state.pitch),Math.sin(state.pitch)];
 const x=normalize(cross([0,0,1],z)),y=cross(z,x),tan=Math.tan(fov/2),fit=canonicalTerrainFit(model,aspect);
 const mapped=state.options?.navigation==='map',distance=fit.distance/state.zoom;
 const targetHeight=mapped?sampleElevation(model,state.offset[0]*model.scale,state.offset[1]*model.scale):null;
 const target=[state.offset[0],state.offset[1],targetHeight===null?.005:(targetHeight-model.base)/model.scale],eye=target.map((v,i)=>v+z[i]*distance);
 const view=new Float32Array([x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-dot(x,eye),-dot(y,eye),-dot(z,eye),1]);
 const f=1/tan*usableH/height,near=mapped?Math.max(.00002,Math.min(.012,distance*.01)):.012,far=Math.max(12,distance+2*Math.hypot(model.width,model.height,(model.max-model.min)/model.scale));
 const projection=new Float32Array([f/(width/height),0,0,0,0,f,0,0,0,0,(far+near)/(near-far),-1,0,0,2*far*near/(near-far),0]);
 return{matrix:multiplyMatrix(projection,view),offset:[(left-right)/width-(mapped?0:fit.centerX/tan*usableH/width),(bottom-top)/height-(mapped?0:fit.centerY/tan*usableH/height)],eye,target,distance,near,usableW,usableH,right:x,up:y,forward:z,insets:{left,right,top,bottom}};
}
function projectPoint(point,camera,width,height){
 const m=camera.matrix,[x,y,z]=point,w=m[3]*x+m[7]*y+m[11]*z+m[15];if(w<=(camera.near??.012))return null;
 return[((m[0]*x+m[4]*y+m[8]*z+m[12])/w+camera.offset[0])*width*.5+width*.5,
  (1-(m[1]*x+m[5]*y+m[9]*z+m[13])/w-camera.offset[1])*height*.5,
  (m[2]*x+m[6]*y+m[10]*z+m[14])/w,1/w];
}
const GLSL_HEIGHT=`
uniform highp sampler2D uHeight;
uniform vec2 uGrid;
uniform vec2 uExtent;
float heightAt(vec2 uv) {
 vec2 p=clamp(uv,0.0,1.0)*(uGrid-1.0);
 ivec2 a=ivec2(floor(p)),b=min(a+ivec2(1),ivec2(uGrid)-1);
 vec2 f=fract(p);
 return mix(mix(texelFetch(uHeight,a,0).r,texelFetch(uHeight,ivec2(b.x,a.y),0).r,f.x),
  mix(texelFetch(uHeight,ivec2(a.x,b.y),0).r,texelFetch(uHeight,b,0).r,f.x),f.y);
}
`;
const TERRAIN_VERTEX=`#version 300 es
precision highp float;
layout(location=0) in vec2 aUV;
uniform mat4 uMatrix;
uniform vec2 uOffset;
out vec2 vUV;
out vec3 vPosition;
`+GLSL_HEIGHT+`
void main(){
 vUV=aUV;vPosition=vec3((aUV.x-.5)*uExtent.x,(.5-aUV.y)*uExtent.y,heightAt(aUV));
 gl_Position=uMatrix*vec4(vPosition,1.0);gl_Position.xy+=uOffset*gl_Position.w;
}
`;
export function surfaceNoise(x,y,period,seed=0){
 const hash=(a,b)=>{
  a=((a%period)+period)%period;b=((b%period)+period)%period;
  let n=Math.imul(a+1,374761393)^Math.imul(b+1,668265263)^Math.imul(seed+1,1274126177);
  n=Math.imul(n^(n>>>13),1274126177);return((n^(n>>>16))>>>0)/4294967295;
 };
 const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy;
 const u=fx*fx*fx*(fx*(fx*6-15)+10),v=fy*fy*fy*(fy*(fy*6-15)+10);
 return mix(mix(hash(ix,iy),hash(ix+1,iy),u),mix(hash(ix,iy+1),hash(ix+1,iy+1),u),v);
}
export function createSurfaceTexture(size=128){
 if(!Number.isInteger(size)||size<32||size>256||(size&(size-1)))throw new TypeError('Surface texture must be a bounded power of two');
 const pixels=new Uint8Array(size*size*4);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const u=x/size,v=y/size;
  const coarse=surfaceNoise(u*4,v*4,4,3),middle=surfaceNoise(u*16,v*16,16,7);
  const fine=surfaceNoise(u*32,v*32,32,19),grain=surfaceNoise(u*64,v*64,64,41);
  const ridges=1-Math.abs(2*middle-1),strata=.5+.5*Math.sin((v+coarse*.12)*Math.PI*16);
  const values=[.32*middle+.42*fine+.26*grain,.54*ridges+.46*strata,coarse,.56*fine+.44*grain];
  for(let k=0;k<4;k++)pixels[(y*size+x)*4+k]=Math.round(clamp(values[k],0,1)*255);
 }
 return{size,pixels};
}
export function terrainMaterialColor(height){
 const stops=[[500,[.16,.29,.24]],[1400,[.30,.43,.31]],[2100,[.51,.55,.36]],[2700,[.64,.62,.52]],[3400,[.76,.75,.68]]];
 let a=stops[0],b=stops[1];for(let i=1;i<stops.length-1&&height>=stops[i][0];i++){a=stops[i];b=stops[i+1];}
 const t=smoothstep(a[0],b[0],height);return a[1].map((v,i)=>mix(v,b[1][i],t));
}


const TERRAIN_FRAGMENT="#version 300 es\nprecision highp float;\nin vec2 vUV;\nin vec3 vPosition;\nuniform sampler2D uNormal;\nuniform sampler2D uShadow;\nuniform sampler2D uSurface;\nuniform sampler2D uCartography;\nuniform sampler2D uDisplayMask;\nuniform vec2 uCartographySize;\nuniform vec2 uGrid;\nuniform vec3 uLight;\nuniform vec3 uEye;\nuniform float uBase;\nuniform float uScale;\nuniform float uShadowTexel;\nout vec4 outColor;\nvec3 palette(float h){\n vec3 a=vec3(.16,.29,.24),b=vec3(.30,.43,.31),c=vec3(.51,.55,.36),d=vec3(.64,.62,.52),e=vec3(.76,.75,.68);\n if(h<1400.0)return mix(a,b,smoothstep(500.0,1400.0,h));\n if(h<2100.0)return mix(b,c,smoothstep(1400.0,2100.0,h));\n if(h<2700.0)return mix(c,d,smoothstep(2100.0,2700.0,h));\n return mix(d,e,smoothstep(2700.0,3400.0,h));\n}\nvec4 surfaceAt(vec3 p,vec3 n){\n vec3 w=pow(abs(n),vec3(4.0));w/=max(dot(w,vec3(1)),.001);\n return texture(uSurface,p.yz)*w.x+texture(uSurface,p.xz)*w.y+texture(uSurface,p.xy)*w.z;\n}\nvec3 perturbNormal(vec3 p,vec3 n,float height){\n vec3 dp1=dFdx(p),dp2=dFdy(p),r1=cross(dp2,n),r2=cross(n,dp1);\n float determinant=dot(dp1,r1);\n if(abs(determinant)<1e-14)return n;\n vec3 gradient=dFdx(height)*r1+dFdy(height)*r2;\n return normalize(abs(determinant)*n-sign(determinant)*gradient);\n}\nvoid main(){\n if(texture(uDisplayMask,vUV).r<.5)discard;\n vec2 nUV=(vUV*(uGrid-1.0)+.5)/uGrid;\n vec4 tex=texture(uNormal,nUV);vec3 baseNormal=normalize(tex.rgb*2.0-1.0);\n float elevation=vPosition.z*uScale+uBase;\n vec3 metres=vPosition*uScale;\n vec4 macro=surfaceAt(metres/820.0,baseNormal),detail=surfaceAt(metres/96.0,baseNormal);\n float rock=smoothstep(.17,.52,1.0-baseNormal.z);\n rock=max(rock,smoothstep(2300.0,3050.0,elevation)*(.26+macro.b*.35));\n vec3 limestone=mix(vec3(.49,.51,.47),vec3(.72,.69,.61),macro.b*.64+detail.g*.36);\n vec3 albedo=mix(palette(elevation)*(.91+macro.b*.18),limestone,rock*.83);\n albedo*=.94+detail.r*.12;\n vec2 coverUV=(vUV*(uCartographySize-1.0)+.5)/uCartographySize;\n vec4 cover=texture(uCartography,coverUV);\n albedo=mix(albedo,cover.rgb/max(cover.a,.00001),cover.a);\n // Triplanar detail is filtered with mipmaps and never changes terrain positions.\n float bump=(detail.g*.7+detail.r*.3-.5)*mix(.12,.55,rock)*(1.0-cover.a*.85)/uScale;\n vec3 n=perturbNormal(vPosition,baseNormal,bump);\n float contourDistance=abs(fract(elevation/100.0+.5)-.5)*100.0;\n float contour=1.0-smoothstep(0.0,max(.7,fwidth(elevation)*.85),contourDistance);\n albedo*=1.0-contour*.035;\n float shadow=texture(uShadow,vUV).r*.5;\n shadow+=(texture(uShadow,vUV+vec2(uShadowTexel,0)).r+texture(uShadow,vUV-vec2(uShadowTexel,0)).r+\n  texture(uShadow,vUV+vec2(0,uShadowTexel)).r+texture(uShadow,vUV-vec2(0,uShadowTexel)).r)*.125;\n vec3 view=normalize(uEye-vPosition),halfVector=normalize(view+uLight);\n float NoL=max(dot(n,uLight),0.0),NoV=max(dot(n,view),.001),NoH=max(dot(n,halfVector),0.0),VoH=max(dot(view,halfVector),0.0);\n float roughness=mix(.94,.76,rock),alpha=roughness*roughness,a2=alpha*alpha;\n float denominator=NoH*NoH*(a2-1.0)+1.0;\n float distribution=a2/(3.14159265*denominator*denominator);\n float k=(roughness+1.0)*(roughness+1.0)/8.0;\n float visibility=NoV/(NoV*(1.0-k)+k)*NoL/(NoL*(1.0-k)+k);\n float fresnel=.035+.965*pow(1.0-VoH,5.0);\n float specular=distribution*visibility*fresnel/max(4.0*NoL*NoV,.001);\n vec3 linearAlbedo=pow(albedo,vec3(2.2));\n vec3 ambient=mix(vec3(.25,.29,.24),vec3(.35,.43,.46),clamp(n.z*.5+.5,0.0,1.0))*tex.a;\n vec3 lit=linearAlbedo*ambient+(linearAlbedo*.965+vec3(specular)) *vec3(1.15,1.06,.91)*NoL*shadow;\n vec3 color=pow(max(lit,vec3(0)),vec3(1.0/2.2));\n float haze=clamp((distance(uEye,vPosition)-.9)*.10,0.0,.22);\n float edge=min(min(vUV.x,1.0-vUV.x),min(vUV.y,1.0-vUV.y));\n haze=max(haze,(1.0-smoothstep(0.0,.003,edge))*.15);\n outColor=vec4(mix(color,vec3(.875,.902,.855),haze),1.0);\n}\n";
const SHADOW_VERTEX=`#version 300 es
precision highp float;
out vec2 vUV;
void main(){
 vec2 p=vec2(gl_VertexID==1?3.0:-1.0,gl_VertexID==2?3.0:-1.0);
 vUV=p*.5+.5;gl_Position=vec4(p,0,1);
}
`;
const SHADOW_FRAGMENT=`#version 300 es
precision highp float;
precision highp int;
in vec2 vUV;
uniform vec3 uLight;
uniform int uSteps;
uniform highp sampler2D uHeightMax;
out vec4 outColor;
`+GLSL_HEIGHT+`
float maximumHeight(vec2 a,vec2 b){
 ivec2 lo=clamp(ivec2(floor(min(a,b)*(uGrid-1.0))),ivec2(0),ivec2(uGrid)-2);
 ivec2 hi=clamp(ivec2(floor(max(a,b)*(uGrid-1.0))),ivec2(0),ivec2(uGrid)-2);
 int level=int(ceil(log2(float(max(hi.x-lo.x+1,hi.y-lo.y+1))))),block=1<<level;lo/=block;hi/=block;
 return max(max(texelFetch(uHeightMax,lo,level).r,texelFetch(uHeightMax,ivec2(hi.x,lo.y),level).r),
  max(texelFetch(uHeightMax,ivec2(lo.x,hi.y),level).r,texelFetch(uHeightMax,hi,level).r));
}
float visibilityAt(){
 float h=heightAt(vUV),cell=min(uExtent.x/(uGrid.x-1.0),uExtent.y/(uGrid.y-1.0));
 float horizontal=length(uLight.xy),slope=uLight.z/max(horizontal,.01);
 vec2 dir=vec2(uLight.x/uExtent.x,-uLight.y/uExtent.y)/max(horizontal,.01);
 float start=cell*1.1,end=.8;
 if(dir.x>1e-12)end=min(end,(1.0-vUV.x)/dir.x);else if(dir.x< -1e-12)end=min(end,-vUV.x/dir.x);
 if(dir.y>1e-12)end=min(end,(1.0-vUV.y)/dir.y);else if(dir.y< -1e-12)end=min(end,-vUV.y/dir.y);
 if(end<=start)return 1.0;
 float span=end-start,visibility=1.0;int level=0,index=0;
 for(int work=0;work<${SHADOW_FULL_QUERIES};work++){
  if(work>=uSteps)break;
  float segment=span*exp2(-float(level)),lo=start+float(index)*segment,hi=lo+segment;
  float maximum=maximumHeight(vUV+dir*lo,vUV+dir*hi),softness=cell*.25+lo*.014;
  if(maximum>h+lo*slope+cell*.18-softness){
   if(segment>cell*.65&&level<${SHADOW_MAX_DEPTH}){level++;index*=2;continue;}
   float d=(lo+hi)*.5,s=cell*.25+d*.014,clearance=h+d*slope+cell*.18-heightAt(vUV+dir*d);
   visibility=min(visibility,smoothstep(-s,s,clearance));if(visibility<.005)return visibility;
  }
  for(int up=0;up<${SHADOW_MAX_DEPTH};up++){
   if(level==0)return visibility;
   if((index&1)==0){index++;break;}index/=2;level--;
  }
 }
 return visibility;
}
void main(){
 float visibility=visibilityAt();
 outColor=vec4(visibility,visibility,visibility,1);
}
`;
const ROUTE_VERTEX=`#version 300 es
precision highp float;
layout(location=0) in vec3 aStart;
layout(location=1) in vec3 aEnd;
layout(location=2) in vec2 aCorner;
uniform mat4 uMatrix;
uniform vec2 uOffset;
uniform vec2 uViewport;
uniform float uHalfWidth;
out vec2 vDistance;
out vec2 vWorld;
flat out float vLength;
void main(){
 vec4 a=uMatrix*vec4(aStart,1),b=uMatrix*vec4(aEnd,1);
 if(a.w<=.012||b.w<=.012){gl_Position=vec4(2,2,2,1);vDistance=vec2(0);vLength=0.0;return;}
 vec2 delta=(b.xy/b.w-a.xy/a.w)*uViewport*.5;
 float len=max(length(delta),.001);vec2 direction=delta/len,normal=vec2(-direction.y,direction.x);
 vec4 point=mix(a,b,aCorner.x);
 point.xy+=(normal*aCorner.y*uHalfWidth+direction*(aCorner.x*2.0-1.0)*uHalfWidth)*2.0/uViewport*point.w;
 point.xy+=uOffset*point.w;gl_Position=point;
 vWorld=mix(aStart.xy,aEnd.xy,aCorner.x);
 vDistance=vec2(aCorner.x*len+(aCorner.x*2.0-1.0)*uHalfWidth,aCorner.y*uHalfWidth);vLength=len;
}
`;
const ROUTE_FRAGMENT=`#version 300 es
precision highp float;
in vec2 vDistance;
in vec2 vWorld;
flat in float vLength;
uniform vec4 uColor;
uniform float uHalfWidth;
uniform sampler2D uDisplayMask;
uniform vec2 uExtent;
out vec4 outColor;
void main(){
 vec2 uv=vec2(vWorld.x/uExtent.x+.5,.5-vWorld.y/uExtent.y);
 if(any(lessThan(uv,vec2(0)))||any(greaterThan(uv,vec2(1)))||texture(uDisplayMask,uv).r<.5)discard;
 float cap=max(max(-vDistance.x,vDistance.x-vLength),0.0),dist=length(vec2(cap,vDistance.y));
 float alpha=1.0-smoothstep(uHalfWidth-.8,uHalfWidth,dist);if(alpha<=0.0)discard;
 outColor=vec4(uColor.rgb,uColor.a*alpha);
}
`;
const BOUNDARY_VERTEX=`#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
uniform mat4 uMatrix;
uniform vec2 uOffset;
out vec3 vPosition;
out vec3 vNormal;
void main(){vPosition=aPosition;vNormal=aNormal;gl_Position=uMatrix*vec4(aPosition,1);gl_Position.xy+=uOffset*gl_Position.w;}
`;
const BOUNDARY_FRAGMENT=`#version 300 es
precision highp float;
in vec3 vPosition;
in vec3 vNormal;
uniform vec3 uLight;
uniform float uFloor;
out vec4 outColor;
void main(){
 float elevation=clamp((vPosition.z-uFloor)/.17,0.0,1.0);
 vec3 color=mix(vec3(.34,.38,.33),vec3(.49,.53,.46),elevation);
 float light=.40+.60*max(dot(normalize(vNormal),uLight),0.0);
 outColor=vec4(color*light,1);
}
`;
const GROUND_VERTEX=`#version 300 es
precision highp float;
uniform mat4 uMatrix;
uniform vec2 uOffset;
uniform vec2 uExtent;
uniform float uFloor;
out vec2 vPoint;
void main(){
 int id=gl_VertexID;
 vec2 uv=vec2(id==1||id==4||id==5?1.0:0.0,id==2||id==3||id==5?1.0:0.0);
 vPoint=(uv-.5)*(uExtent+vec2(.08));
 gl_Position=uMatrix*vec4(vPoint,uFloor-.001,1);gl_Position.xy+=uOffset*gl_Position.w;
}
`;
const GROUND_FRAGMENT=`#version 300 es
precision highp float;
uniform vec2 uExtent;
in vec2 vPoint;
out vec4 outColor;
void main(){
 float distanceToBase=length(max(abs(vPoint)-uExtent*.5,vec2(0)));
 float contact=1.0-smoothstep(0.0,.04,distanceToBase);
 outColor=vec4(.20,.27,.21,contact*contact*.18);
}
`;
function terrainFragmentForMask(displayMask){
 // TerrainRenderer validated every binary texel before making this owned copy.
 // A fully allowed mask never discards, including clamp-to-edge sampling. Keep
 // the mask itself: it still suppresses the decorative ground/rim and bounds
 // the route through the existing stencil and route-fragment checks.
 return displayMask&&displayMask.source.allowedPixels===displayMask.width*displayMask.height
  ?TERRAIN_FRAGMENT.replace(' if(texture(uDisplayMask,vUV).r<.5)discard;\n','')
  :TERRAIN_FRAGMENT;
}
const PRESENT_FRAGMENT=`#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uCompleted;
out vec4 outColor;
void main(){outColor=vec4(texelFetch(uCompleted,ivec2(gl_FragCoord.xy),0).rgb,1.0);}
`;
function terrainFrameTargetFormat(gl,displayMask){
 // Keep the original direct path if the default surface cannot be reproduced
 // exactly. In particular, do not reduce the default MSAA or depth precision.
 const samples=gl.getParameter(gl.SAMPLES),depth=gl.getParameter(gl.DEPTH_BITS),stencil=gl.getParameter(gl.STENCIL_BITS);
 if(!Number.isInteger(samples)||samples<0||gl.getParameter(gl.RED_BITS)!==8||gl.getParameter(gl.GREEN_BITS)!==8||gl.getParameter(gl.BLUE_BITS)!==8||gl.getParameter(gl.ALPHA_BITS)!==0)return null;
 if(gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER,gl.BACK,gl.FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING)!==gl.LINEAR)return null;
 const depthFormat=displayMask?(stencil===8&&(depth===24?gl.DEPTH24_STENCIL8:depth===32?gl.DEPTH32F_STENCIL8:null))
  :depth===16?gl.DEPTH_COMPONENT16:depth===24?gl.DEPTH_COMPONENT24:depth===32?gl.DEPTH_COMPONENT32F:null;
 if(!depthFormat)return null;
 for(const format of[gl.RGB8,depthFormat])if(samples&&!Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER,format,gl.SAMPLES)||[]).includes(samples))return null;
 return{samples,depth,stencil:displayMask?stencil:0,depthFormat};
}
class TerrainGPU{
 constructor(gl,model,displayMask=null,mapMode=false){
  this.mapMode=mapMode;this.gl=gl;this.model=model;this.displayMask=displayMask;this.resources=[];this.meshes=new Map();this.shadows=new Map();this.routeCount=0;
  try{
   if(gl.getParameter(gl.MAX_TEXTURE_SIZE)<Math.max(model.grid.width,model.grid.height)||gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS)<1)throw new Error('Terrain GPU limits');
   if(displayMask&&(gl.getParameter(gl.MAX_TEXTURE_SIZE)<Math.max(displayMask.width,displayMask.height)||gl.getParameter(gl.STENCIL_BITS)<1))throw new Error('Terrain display mask GPU limits');
   // Query once per context, never per frame. The same bounded oblique-angle
   // filter applies to real cartography and full-resolution terrain normals.
   this.anisotropy=gl.getExtension('EXT_texture_filter_anisotropic');
   this.maxAnisotropy=this.anisotropy?Math.min(4,gl.getParameter(this.anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)):1;
   this.terrain=this.program(TERRAIN_VERTEX,terrainFragmentForMask(displayMask));this.shadow=this.program(SHADOW_VERTEX,SHADOW_FRAGMENT);this.line=this.program(ROUTE_VERTEX,ROUTE_FRAGMENT);
   this.boundary=this.program(BOUNDARY_VERTEX,BOUNDARY_FRAGMENT);
   this.ground=this.program(GROUND_VERTEX,GROUND_FRAGMENT);
   this.frameFormat=terrainFrameTargetFormat(gl,displayMask);this.frameTarget=null;
   this.present=this.frameFormat?this.program(SHADOW_VERTEX,PRESENT_FRAGMENT):null;
   this.heightTexture=this.texture(gl.R32F,model.grid.width,model.grid.height,gl.RED,gl.FLOAT,model.heights,gl.NEAREST);
   this.maskTexture=this.texture(gl.R8,displayMask?.width||1,displayMask?.height||1,gl.RED,gl.UNSIGNED_BYTE,displayMask?.pixels||new Uint8Array([255]),gl.NEAREST);
   this.normalTexture=this.texture(gl.RGBA8,model.grid.width,model.grid.height,gl.RGBA,gl.UNSIGNED_BYTE,model.normalTexture,gl.LINEAR);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.generateMipmap(gl.TEXTURE_2D);
   const pyramid=terrainShadowPyramid(model),first=pyramid[0];
   this.maxHeightTexture=this.texture(gl.R32F,first.width,first.height,gl.RED,gl.FLOAT,first.data,gl.NEAREST);
   for(let level=1;level<pyramid.length;level++){const p=pyramid[level];gl.texImage2D(gl.TEXTURE_2D,level,gl.R32F,p.width,p.height,0,gl.RED,gl.FLOAT,p.data);}
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAX_LEVEL,pyramid.length-1);
   if(gl.getError()!==gl.NO_ERROR)throw new Error('Terrain texture allocation failed');
   const surface=createSurfaceTexture(128);
   this.surfaceTexture=this.texture(gl.RGBA8,surface.size,surface.size,gl.RGBA,gl.UNSIGNED_BYTE,surface.pixels,gl.LINEAR);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.REPEAT);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.generateMipmap(gl.TEXTURE_2D);
   this.setCartography(null);
   this.emptyVAO=this.track(gl.createVertexArray(),'VertexArray');this.routeVAO=this.track(gl.createVertexArray(),'VertexArray');this.routeBuffer=this.track(gl.createBuffer(),'Buffer');
   gl.bindVertexArray(this.routeVAO);gl.bindBuffer(gl.ARRAY_BUFFER,this.routeBuffer);
   for(const[location,size,offset]of[[0,3,0],[1,3,12],[2,2,24]]){gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,size,gl.FLOAT,false,32,offset);}
   gl.bindVertexArray(null);
  }catch(error){this.destroy();throw error;}
 }
 track(object,type){if(!object)throw new Error('Terrain GPU allocation failed');this.resources.push([object,type]);return object;}
 release(object,type){if(!object)return;this.gl['delete'+type](object);this.resources=this.resources.filter(([resource])=>resource!==object);}
 renderbufferParameter(buffer,parameter){
  const gl=this.gl;
  // Re-establish the native binding before each synchronous driver query.
  // A repeated same-object bind may be elided by the WebGL command cache.
  gl.bindRenderbuffer(gl.RENDERBUFFER,null);gl.bindRenderbuffer(gl.RENDERBUFFER,buffer);
  return gl.getRenderbufferParameter(gl.RENDERBUFFER,parameter);
 }
 targetFor(width,height){
  if(this.frameTarget?.width===width&&this.frameTarget?.height===height)return this.frameTarget;
  if(this.frameTarget)for(const[object,type]of this.frameTarget.resources)this.release(object,type);
  this.frameTarget=null;
  const gl=this.gl,format=this.frameFormat,resources=[],own=(object,type)=>{resources.push([object,type]);return this.track(object,type);};
  const target={width,height,resources,framebuffer:own(gl.createFramebuffer(),'Framebuffer'),resolve:own(gl.createFramebuffer(),'Framebuffer')};
  try{
   gl.bindFramebuffer(gl.FRAMEBUFFER,target.framebuffer);
   const color=own(gl.createRenderbuffer(),'Renderbuffer'),depth=own(gl.createRenderbuffer(),'Renderbuffer');
   for(const[buffer,internal,attachment]of[[color,gl.RGB8,gl.COLOR_ATTACHMENT0],[depth,format.depthFormat,this.displayMask?gl.DEPTH_STENCIL_ATTACHMENT:gl.DEPTH_ATTACHMENT]]){
    gl.bindRenderbuffer(gl.RENDERBUFFER,buffer);
    if(format.samples)gl.renderbufferStorageMultisample(gl.RENDERBUFFER,format.samples,internal,width,height);else gl.renderbufferStorage(gl.RENDERBUFFER,internal,width,height);
    if(this.renderbufferParameter(buffer,gl.RENDERBUFFER_SAMPLES)!==format.samples)throw new Error('Terrain framebuffer sample count changed');
    const sizes=buffer===color?[[gl.RENDERBUFFER_RED_SIZE,8],[gl.RENDERBUFFER_GREEN_SIZE,8],[gl.RENDERBUFFER_BLUE_SIZE,8],[gl.RENDERBUFFER_ALPHA_SIZE,0]]
     :[[gl.RENDERBUFFER_DEPTH_SIZE,format.depth],[gl.RENDERBUFFER_STENCIL_SIZE,format.stencil]];
    for(const[parameter,expected]of sizes)if(this.renderbufferParameter(buffer,parameter)!==expected)throw new Error('Terrain framebuffer precision changed');
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER,attachment,gl.RENDERBUFFER,buffer);
   }
   if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Terrain multisample framebuffer unavailable');
   target.texture=this.texture(gl.RGB8,width,height,gl.RGB,gl.UNSIGNED_BYTE,null,gl.NEAREST);resources.push([target.texture,'Texture']);
   gl.bindFramebuffer(gl.FRAMEBUFFER,target.resolve);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,target.texture,0);
   if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE||gl.getError()!==gl.NO_ERROR)throw new Error('Terrain resolve framebuffer unavailable');
   this.frameTarget=target;return target;
  }catch(error){for(const[object,type]of resources)this.release(object,type);throw error;}
  finally{gl.bindRenderbuffer(gl.RENDERBUFFER,null);gl.bindFramebuffer(gl.FRAMEBUFFER,null);}
 }
 beginFrame(mesh,camera,light,width,height,dpr,profile){
  const gl=this.gl,target=this.targetFor(width,height);
  this.render(mesh,camera,light,width,height,dpr,profile,target.framebuffer);
  // WebGL2 permits resolving MSAA into a same-format single-sample FBO,
  // never blitting into the multisampled default framebuffer.
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER,target.framebuffer);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,target.resolve);
  gl.blitFramebuffer(0,0,width,height,0,0,width,height,gl.COLOR_BUFFER_BIT,gl.NEAREST);
  const sync=this.track(gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0),'Sync');gl.flush();
  return{target,sync};
 }
 frameReady(frame){
  const gl=this.gl,status=gl.clientWaitSync(frame.sync,0,0);
  if(status===gl.TIMEOUT_EXPIRED)return false;
  if(status!==gl.ALREADY_SIGNALED&&status!==gl.CONDITION_SATISFIED)throw new Error('Terrain frame completion failed');
  this.release(frame.sync,'Sync');frame.sync=null;return true;
 }
 presentFrame(frame){
  const gl=this.gl,{target}=frame;
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,target.width,target.height);
  gl.disable(gl.SCISSOR_TEST);gl.disable(gl.DEPTH_TEST);gl.disable(gl.STENCIL_TEST);gl.disable(gl.CULL_FACE);gl.disable(gl.BLEND);gl.depthMask(false);gl.colorMask(true,true,true,true);
  gl.useProgram(this.present.program);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,target.texture);gl.uniform1i(this.uniform(this.present,'uCompleted'),0);
  gl.bindVertexArray(this.emptyVAO);gl.drawArrays(gl.TRIANGLES,0,3);gl.bindVertexArray(null);gl.depthMask(true);gl.flush();
  if(gl.getError()!==gl.NO_ERROR)throw new Error('Terrain completed frame presentation failed');
 }
 setCartography(surface){
  const gl=this.gl,width=surface?.width||1,height=surface?.height||1;
  // Premultiplied texels make mipmaps and partial-source borders fade into the
  // neutral material without inventing colours in unavailable source tiles.
  const pixels=surface?new Uint8Array(surface.pixels):new Uint8Array(4);
  if(surface)for(let i=0;i<pixels.length;i+=4){const alpha=pixels[i+3]/255;for(let k=0;k<3;k++)pixels[i+k]=Math.round(pixels[i+k]*alpha);}
  const texture=this.texture(gl.RGBA8,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.generateMipmap(gl.TEXTURE_2D);
  if(gl.getError()!==gl.NO_ERROR){gl.deleteTexture(texture);this.resources=this.resources.filter(([item])=>item!==texture);throw new Error('Terrain cartography texture allocation failed');}
  if(this.cartographyTexture){gl.deleteTexture(this.cartographyTexture);this.resources=this.resources.filter(([item])=>item!==this.cartographyTexture);}
  this.cartographyTexture=texture;this.cartographySize=[width,height];
 }
 program(vertex,fragment){
  const gl=this.gl,shaders=[];
  try{
   for(const[type,source]of[[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]){
    const shader=gl.createShader(type);if(!shader)throw new Error('Terrain shader unavailable');shaders.push(shader);
    gl.shaderSource(shader,source);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error('Terrain shader: '+gl.getShaderInfoLog(shader));
   }
   const program=this.track(gl.createProgram(),'Program');shaders.forEach(shader=>gl.attachShader(program,shader));gl.linkProgram(program);
   if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('Terrain shader link: '+gl.getProgramInfoLog(program));
   return{program,uniforms:new Map()};
  }finally{shaders.forEach(shader=>gl.deleteShader(shader));}
 }
 uniform(program,name){if(!program.uniforms.has(name))program.uniforms.set(name,this.gl.getUniformLocation(program.program,name));return program.uniforms.get(name);}
 texture(internal,width,height,format,type,data,filtering){
  const gl=this.gl,texture=this.track(gl.createTexture(),'Texture');gl.bindTexture(gl.TEXTURE_2D,texture);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filtering);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filtering);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  if(filtering===gl.LINEAR&&this.anisotropy)gl.texParameterf(gl.TEXTURE_2D,this.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,this.maxAnisotropy);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.texImage2D(gl.TEXTURE_2D,0,internal,width,height,0,format,type,data);return texture;
 }
 heightUniforms(program){
  const gl=this.gl,m=this.model;gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.heightTexture);
  gl.uniform1i(this.uniform(program,'uHeight'),0);gl.uniform2f(this.uniform(program,'uGrid'),m.grid.width,m.grid.height);
  gl.uniform2f(this.uniform(program,'uExtent'),m.width,m.height);
 }
 maskUniforms(program){const gl=this.gl;gl.activeTexture(gl.TEXTURE6);gl.bindTexture(gl.TEXTURE_2D,this.maskTexture);gl.uniform1i(this.uniform(program,'uDisplayMask'),6);}
 ensureMesh(mesh){
  const key=mesh.window?mesh.step+':'+mesh.window.join(':'):mesh.step;
  if(this.meshes.has(key))return this.meshes.get(key);
  const gl=this.gl,resources=[],own=(object,type)=>{this.track(object,type);resources.push([object,type]);return object;};
  const vao=own(gl.createVertexArray(),'VertexArray'),buffer=own(gl.createBuffer(),'Buffer'),index=own(gl.createBuffer(),'Buffer');
  gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,mesh.uv,gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,8,0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,index);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,mesh.indices,gl.STATIC_DRAW);gl.bindVertexArray(null);
  const cut=this.displayMask||this.mapMode?{vertices:new Float32Array(0),count:0,floor:0}:buildTerrainBoundary(this.model,mesh.step),boundaryVAO=own(gl.createVertexArray(),'VertexArray'),boundaryBuffer=own(gl.createBuffer(),'Buffer');
  gl.bindVertexArray(boundaryVAO);gl.bindBuffer(gl.ARRAY_BUFFER,boundaryBuffer);gl.bufferData(gl.ARRAY_BUFFER,cut.vertices,gl.STATIC_DRAW);
  for(const[location,offset]of[[0,0],[1,12]]){gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,3,gl.FLOAT,false,24,offset);}
  gl.bindVertexArray(null);
  const result={vao,count:mesh.indices.length,type:mesh.indices instanceof Uint32Array?gl.UNSIGNED_INT:gl.UNSIGNED_SHORT,boundaryVAO,boundaryCount:cut.count,floor:cut.floor,resources};
  // A new deferred frame is not submitted while another one is pending. The
  // direct path follows GL command order, which retains deleted objects until
  // outstanding draws finish. Keep only two map windows after allocation.
  if(this.mapMode&&this.meshes.size>=2){const oldest=this.meshes.keys().next().value;for(const[object,type]of this.meshes.get(oldest).resources)this.release(object,type);this.meshes.delete(oldest);}
  this.meshes.set(key,result);return result;
 }
 setRoute(segments){
  const gl=this.gl,vertices=new Float32Array(segments.length*6*8),corners=[[0,-1],[1,-1],[0,1],[0,1],[1,-1],[1,1]];let i=0;
  for(const[a,b]of segments)for(const corner of corners){vertices.set(a,i);vertices.set(b,i+3);vertices.set(corner,i+6);i+=8;}
  gl.bindBuffer(gl.ARRAY_BUFFER,this.routeBuffer);gl.bufferData(gl.ARRAY_BUFFER,vertices,gl.STATIC_DRAW);this.routeCount=segments.length*6;
 }
 shadowMap(light,profile){
  const gl=this.gl,size=profile.shadowSize,steps=profile.shadowQueries;let target=this.shadows.get(size);
  if(!target){
   const texture=this.texture(gl.RGBA8,size,size,gl.RGBA,gl.UNSIGNED_BYTE,null,gl.LINEAR),framebuffer=this.track(gl.createFramebuffer(),'Framebuffer');
   gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
   if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Terrain shadow target unavailable');
   target={texture,framebuffer,key:''};this.shadows.set(size,target);
  }
  const key=steps+':'+light.join(':');
  if(target.key!==key){
   gl.bindFramebuffer(gl.FRAMEBUFFER,target.framebuffer);gl.viewport(0,0,size,size);
   gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);gl.disable(gl.CULL_FACE);gl.useProgram(this.shadow.program);this.heightUniforms(this.shadow);
   gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,this.maxHeightTexture);gl.uniform1i(this.uniform(this.shadow,'uHeightMax'),3);
   gl.uniform3fv(this.uniform(this.shadow,'uLight'),light);gl.uniform1i(this.uniform(this.shadow,'uSteps'),steps);
   gl.bindVertexArray(this.emptyVAO);gl.drawArrays(gl.TRIANGLES,0,3);target.key=key;
  }
  return{texture:target.texture,size};
 }
 render(mesh,camera,light,width,height,dpr,profile,framebuffer=null){
  const gl=this.gl,m=this.model,shadow=this.shadowMap(light,profile),gpuMesh=this.ensureMesh(mesh);
  gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.viewport(0,0,width,height);gl.clearColor(SKY[0]/255,SKY[1]/255,SKY[2]/255,1);
  gl.disable(gl.STENCIL_TEST);gl.clearDepth(1);gl.depthMask(true);
  if(this.displayMask){gl.stencilMask(255);gl.clearStencil(0);}
  gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT|(this.displayMask?gl.STENCIL_BUFFER_BIT:0));
  if(!this.displayMask&&!this.mapMode){
  gl.disable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);gl.depthMask(false);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(this.ground.program);gl.uniformMatrix4fv(this.uniform(this.ground,'uMatrix'),false,camera.matrix);gl.uniform2fv(this.uniform(this.ground,'uOffset'),camera.offset);
  gl.uniform2f(this.uniform(this.ground,'uExtent'),m.width,m.height);gl.uniform1f(this.uniform(this.ground,'uFloor'),gpuMesh.floor);
  gl.bindVertexArray(this.emptyVAO);gl.drawArrays(gl.TRIANGLES,0,6);gl.depthMask(true);
  }
  if(this.displayMask){gl.enable(gl.STENCIL_TEST);gl.stencilFunc(gl.ALWAYS,1,255);gl.stencilOp(gl.KEEP,gl.KEEP,gl.REPLACE);}
  gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.disable(gl.CULL_FACE);gl.disable(gl.BLEND);gl.useProgram(this.terrain.program);this.heightUniforms(this.terrain);this.maskUniforms(this.terrain);
  gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,this.normalTexture);gl.uniform1i(this.uniform(this.terrain,'uNormal'),1);
  gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,shadow.texture);gl.uniform1i(this.uniform(this.terrain,'uShadow'),2);
  gl.activeTexture(gl.TEXTURE4);gl.bindTexture(gl.TEXTURE_2D,this.surfaceTexture);gl.uniform1i(this.uniform(this.terrain,'uSurface'),4);
  gl.activeTexture(gl.TEXTURE5);gl.bindTexture(gl.TEXTURE_2D,this.cartographyTexture);gl.uniform1i(this.uniform(this.terrain,'uCartography'),5);gl.uniform2fv(this.uniform(this.terrain,'uCartographySize'),this.cartographySize);
  gl.uniformMatrix4fv(this.uniform(this.terrain,'uMatrix'),false,camera.matrix);gl.uniform2fv(this.uniform(this.terrain,'uOffset'),camera.offset);
  gl.uniform3fv(this.uniform(this.terrain,'uLight'),light);gl.uniform3fv(this.uniform(this.terrain,'uEye'),camera.eye);
  gl.uniform1f(this.uniform(this.terrain,'uBase'),m.base);gl.uniform1f(this.uniform(this.terrain,'uScale'),m.scale);gl.uniform1f(this.uniform(this.terrain,'uShadowTexel'),1/shadow.size);
  gl.bindVertexArray(gpuMesh.vao);gl.drawElements(gl.TRIANGLES,gpuMesh.count,gpuMesh.type,0);
  if(this.displayMask){gl.stencilMask(0);gl.stencilFunc(gl.EQUAL,1,255);gl.stencilOp(gl.KEEP,gl.KEEP,gl.KEEP);}
  if(!this.displayMask&&!this.mapMode){
  gl.useProgram(this.boundary.program);gl.uniformMatrix4fv(this.uniform(this.boundary,'uMatrix'),false,camera.matrix);gl.uniform2fv(this.uniform(this.boundary,'uOffset'),camera.offset);
  gl.uniform3fv(this.uniform(this.boundary,'uLight'),light);gl.uniform1f(this.uniform(this.boundary,'uFloor'),gpuMesh.floor);
  gl.bindVertexArray(gpuMesh.boundaryVAO);gl.drawArrays(gl.TRIANGLES,0,gpuMesh.boundaryCount);
  }
  if(this.routeCount){
   gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(false);gl.useProgram(this.line.program);
   gl.uniformMatrix4fv(this.uniform(this.line,'uMatrix'),false,camera.matrix);gl.uniform2fv(this.uniform(this.line,'uOffset'),camera.offset);
   this.maskUniforms(this.line);gl.uniform2f(this.uniform(this.line,'uExtent'),m.width,m.height);
   gl.uniform2f(this.uniform(this.line,'uViewport'),width,height);gl.bindVertexArray(this.routeVAO);
   for(const[size,color]of[[4.3,[1,.985,.91,.94]],[2.25,[.74,.30,.12,1]]]){
    gl.uniform1f(this.uniform(this.line,'uHalfWidth'),size*dpr);gl.uniform4fv(this.uniform(this.line,'uColor'),color);gl.drawArrays(gl.TRIANGLES,0,this.routeCount);
   }
   gl.depthMask(true);gl.disable(gl.BLEND);
  }
  gl.disable(gl.STENCIL_TEST);gl.bindVertexArray(null);gl.flush();
 }
 // Context loss invalidates every WebGLObject. Passing those old handles to
 // delete* after restoration itself raises INVALID_OPERATION, poisoning the
 // new context's first allocation check. The browser already released them.
 abandon(){
  this.resources=[];this.meshes.clear();this.shadows.clear();this.routeCount=0;this.frameTarget=null;
  for(const key of['terrain','shadow','line','boundary','ground','present','heightTexture','maskTexture','normalTexture','maxHeightTexture','surfaceTexture','cartographyTexture','emptyVAO','routeVAO','routeBuffer','anisotropy'])this[key]=null;
 }
 destroy(){const gl=this.gl;for(const[object,type]of this.resources.reverse())gl['delete'+type](object);this.abandon();}
}
function palette(height){return terrainMaterialColor(height);}

class TerrainCanvas{
 constructor(context,model,displayMask=null,mapMode=false){this.mapMode=mapMode;this.ctx=context;this.model=model;this.displayMask=displayMask;this.shadowCache=new Map();this.boundaries=new Map();this.cartography=null;}
 setCartography(surface){this.cartography=surface;}
 shadows(mesh,light,profile){
  const key=mesh.step+':'+(mesh.window?.join(':')||'full')+':'+profile.shadowQueries+':'+light.join(':');if(this.shadowCache.has(key))return this.shadowCache.get(key);
  const values=new Float32Array(mesh.count),m=this.model;
  for(let i=0;i<mesh.count;i++){
   const x=(mesh.uv[i*2]-.5)*m.widthM,y=(.5-mesh.uv[i*2+1])*m.heightM;
   values[i]=sampleTerrainShadow(m,x,y,m.grid.elevations[mesh.sampleIds[i]],light,profile.shadowQueries);
  }
  if(this.shadowCache.size>=4)this.shadowCache.delete(this.shadowCache.keys().next().value);this.shadowCache.set(key,values);return values;
 }
 render(mesh,camera,light,width,height,dpr,profile,segments){
  const m=this.model,ctx=this.ctx;
  if(!this.image||this.image.width!==width||this.image.height!==height){this.image=ctx.createImageData(width,height);this.depth=new Float32Array(width*height);}
  const pixels=this.image.data,depth=this.depth;
  for(let p=0;p<pixels.length;p+=4){pixels[p]=SKY[0];pixels[p+1]=SKY[1];pixels[p+2]=SKY[2];pixels[p+3]=255;}depth.fill(Infinity);
  if(!this.boundaries.has(mesh.step))this.boundaries.set(mesh.step,this.displayMask||this.mapMode?{count:0,vertices:new Float32Array(0),floor:0}:buildTerrainBoundary(m,mesh.step));
  const boundary=this.boundaries.get(mesh.step),shadows=this.shadows(mesh,light,profile),vertices=new Array(mesh.count+boundary.count),colors=new Float32Array((mesh.count+boundary.count)*3);
  const cartography=this.cartography,lighting=cartography?new Float32Array(mesh.count*3):null,hazes=cartography?new Float32Array(mesh.count):null,cover=[0,0,0,0];
  for(let i=0;i<mesh.count;i++){
   const sample=mesh.sampleIds[i],n=[m.normals[sample*3],m.normals[sample*3+1],m.normals[sample*3+2]],u=mesh.uv[i*2],v=mesh.uv[i*2+1];
   const point=[(u-.5)*m.width,(.5-v)*m.height,m.heights[sample]];vertices[i]=projectPoint(point,camera,width,height);
   const base=palette(m.grid.elevations[sample]),slope=smoothstep(.18,.57,1-n[2]),ao=m.normalTexture[sample*4+3]/255,diffuse=Math.max(0,dot(n,light))*shadows[i]*.94;
   const haze=Math.max(clamp((Math.hypot(...point.map((x,k)=>x-camera.eye[k]))-.68)*.13,0,.32),(1-smoothstep(0,.003,Math.min(u,1-u,v,1-v)))*.15);
   if(hazes)hazes[i]=haze;
   for(let k=0;k<3;k++){
    const albedo=mix(base[k],[.57,.55,.48][k],slope*.68),illumination=[.34,.41,.40][k]*(.55+.45*n[2])*ao+[1.05,.99,.85][k]*diffuse;
    colors[i*3+k]=mix(Math.max(0,albedo**2.2*illumination)**(1/2.2)*255,SKY[k],haze);
    if(lighting)lighting[i*3+k]=Math.max(0,illumination)**(1/2.2);
   }
  }
  for(let i=0;i<boundary.count;i++){
   const source=i*6,point=Array.from(boundary.vertices.subarray(source,source+3)),normal=Array.from(boundary.vertices.subarray(source+3,source+6)),target=mesh.count+i;
   vertices[target]=projectPoint(point,camera,width,height);
   const elevation=clamp((point[2]-boundary.floor)/.17,0,1),illumination=.40+.60*Math.max(dot(normal,light),0);
   for(let k=0;k<3;k++)colors[target*3+k]=mix([.34,.38,.33][k],[.49,.53,.46][k],elevation)*illumination*255;
  }
  const ids=mesh.indices;
  for(let i=0;i<ids.length+boundary.count;i+=3){
   const ia=i<ids.length?ids[i]:mesh.count+i-ids.length,ib=i<ids.length?ids[i+1]:ia+1,ic=i<ids.length?ids[i+2]:ia+2,a=vertices[ia],b=vertices[ib],c=vertices[ic];if(!a||!b||!c)continue;
   const minX=Math.max(0,Math.floor(Math.min(a[0],b[0],c[0]))),maxX=Math.min(width-1,Math.ceil(Math.max(a[0],b[0],c[0])));
   const minY=Math.max(0,Math.floor(Math.min(a[1],b[1],c[1]))),maxY=Math.min(height-1,Math.ceil(Math.max(a[1],b[1],c[1])));if(minX>maxX||minY>maxY)continue;
   const denominator=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);if(Math.abs(denominator)<.00001)continue;
   const inverse=1/denominator,waX=(b[1]-c[1])*inverse,waY=(c[0]-b[0])*inverse,wbX=(c[1]-a[1])*inverse,wbY=(a[0]-c[0])*inverse;
   let rowA=((b[1]-c[1])*(minX+.5-c[0])+(c[0]-b[0])*(minY+.5-c[1]))*inverse;
   let rowB=((c[1]-a[1])*(minX+.5-c[0])+(a[0]-c[0])*(minY+.5-c[1]))*inverse;
   for(let y=minY;y<=maxY;y++,rowA+=waY,rowB+=wbY){
    let wa=rowA,wb=rowB,index=y*width+minX;
    for(let x=minX;x<=maxX;x++,index++,wa+=waX,wb+=wbX){
     const wc=1-wa-wb;if(wa<-.00001||wb<-.00001||wc<-.00001)continue;
     const z=wa*a[2]+wb*b[2]+wc*c[2];if(z>depth[index]||z<-1||z>1)continue;
     const pa=wa*a[3],pb=wb*b[3],pc=wc*c[3],reciprocal=1/(pa+pb+pc),offset=index*4;
     const u=i<ids.length&&(cartography||this.displayMask)?(pa*mesh.uv[ia*2]+pb*mesh.uv[ib*2]+pc*mesh.uv[ic*2])*reciprocal:0;
     const v=i<ids.length&&(cartography||this.displayMask)?(pa*mesh.uv[ia*2+1]+pb*mesh.uv[ib*2+1]+pc*mesh.uv[ic*2+1])*reciprocal:0;
     if(this.displayMask&&!sampleTerrainDisplayMask(this.displayMask,u,v))continue;depth[index]=z;
     let alpha=0,haze=0;
     if(cartography&&i<ids.length){
      sampleTerrainCartography(cartography,u,v,cover);alpha=cover[3]/255;haze=(pa*hazes[ia]+pb*hazes[ib]+pc*hazes[ic])*reciprocal;
     }
     for(let k=0;k<3;k++){
      const neutral=(pa*colors[ia*3+k]+pb*colors[ib*3+k]+pc*colors[ic*3+k])*reciprocal;
      const mapped=alpha?mix(cover[k]*(pa*lighting[ia*3+k]+pb*lighting[ib*3+k]+pc*lighting[ic*3+k])*reciprocal,SKY[k],haze):neutral;
      pixels[offset+k]=mix(neutral,mapped,alpha);
     }
    }
   }
  }
  // Route capsules use the terrain depth buffer, so a hidden trail stays hidden.
  const projected=segments.map(([a,b])=>[projectPoint(a,camera,width,height),projectPoint(b,camera,width,height),[a[0]/m.width+.5,.5-a[1]/m.height],[b[0]/m.width+.5,.5-b[1]/m.height]]);
  for(const[radius,color]of[[4.3*dpr,[255,251,232]],[2.25*dpr,[189,77,31]]])for(const[a,b,uvA,uvB]of projected)if(a&&b)this.routeCapsule(a,b,radius,color,width,height,pixels,depth,uvA,uvB);
  ctx.putImageData(this.image,0,0);
 }
 routeCapsule(a,b,radius,color,width,height,pixels,depth,uvA,uvB){
  const dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy;if(length<.00001)return;
  const minX=Math.max(0,Math.floor(Math.min(a[0],b[0])-radius)),maxX=Math.min(width-1,Math.ceil(Math.max(a[0],b[0])+radius));
  const minY=Math.max(0,Math.floor(Math.min(a[1],b[1])-radius)),maxY=Math.min(height-1,Math.ceil(Math.max(a[1],b[1])+radius));
  for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
   const t=clamp(((x+.5-a[0])*dx+(y+.5-a[1])*dy)/length,0,1),distance=Math.hypot(x+.5-a[0]-dx*t,y+.5-a[1]-dy*t);if(distance>=radius)continue;
   const index=y*width+x,z=mix(a[2],b[2],t);if(z>depth[index]||z<-1||z>1)continue;
   if(this.displayMask){
    const reciprocal=1/mix(a[3],b[3],t),u=mix(uvA[0]*a[3],uvB[0]*b[3],t)*reciprocal,v=mix(uvA[1]*a[3],uvB[1]*b[3],t)*reciprocal;
    if(!Number.isFinite(depth[index])||!sampleTerrainDisplayMask(this.displayMask,u,v))continue;
   }
   const alpha=clamp(radius-distance,0,1),offset=index*4;for(let k=0;k<3;k++)pixels[offset+k]=mix(pixels[offset+k],color[k],alpha);
  }
 }
 destroy(){this.shadowCache.clear();this.boundaries.clear();this.image=null;this.depth=null;this.cartography=null;this.displayMask=null;}
}
export class TerrainRenderer{
 constructor(canvas,grid,options={}){
  this.originalCanvas=canvas;this.canvas=canvas;this.grid=grid;this.options={...options,displayMask:undefined};
  const mask=options.displayMask?validateTerrainDisplayMask(options.displayMask,grid):null;
  this.displayMask=mask?{width:mask.width,height:mask.height,pixels:new Uint8Array(mask.pixels),source:{...mask.source,bounds:[...mask.source.bounds],cells:[...mask.source.cells]}}:null;
  this.model=options.preparedModel===undefined?createTerrainModel(grid):validatePreparedTerrainModel(grid,options.preparedModel);
  this.widthM=this.model.widthM;this.heightM=this.model.heightM;this.base=this.model.base;
  const initial=options.navigation==='map'?MAP_VIEW:DEFAULT_VIEW;
  this.yaw=initial.yaw;this.pitch=initial.pitch;this.zoom=initial.zoom;this.offset=[0,0];
  this.viewportInsets=normalizedInsets(options.viewportInsets);this.viewViewport=this.viewportSize();
  this.visible=true;this.destroyed=false;this.failed=false;this.contextLost=false;this.frame=0;this.dirty=true;this.warmRequested=false;this.graphicsFallback=null;
  this.pointers=new Map();this.events=[];this.meshes=new Map();this.windowMeshes=new Map();this.meshStride=0;this.renderProfile=null;this.route=[];this.routeMeshes=new Map();this.gpuRoute=null;this.dragging=false;this.wheeling=false;this.cartography=null;this.pendingGPU=null;this.gpuCartographyDirty=false;
  if(options.initialView)this.applyView(options.initialView);
  this.previousTouchAction=canvas.style?.touchAction;if(canvas.style)canvas.style.touchAction='none';
  try{
   let gl;
   if(!options.forceCanvas)try{gl=canvas.getContext('webgl2',{alpha:false,antialias:true,depth:true,stencil:!!this.displayMask,preserveDrawingBuffer:false,powerPreference:'default',failIfMajorPerformanceCaveat:true});}catch(error){this.recordGraphicsFallback('context-create',error);}
   if(gl){try{this.gpu=new TerrainGPU(gl,this.model,this.displayMask,this.options.navigation==='map');this.gl=gl;}catch(error){this.recordGraphicsFallback('initialization',error);gl.getExtension('WEBGL_lose_context')?.loseContext();this.useCanvas(true);}}
   else this.useCanvas(false);
   this.bindControls();this.observe();this.document=canvas.ownerDocument||(typeof document!=='undefined'?document:null);
   this.onVisibility=()=>{if(this.document?.visibilityState!=='hidden')this.request();else this.cancelFrame();};
   this.document?.addEventListener('visibilitychange',this.onVisibility);this.request();
  }catch(error){this.destroy();throw error;}
 }
 useCanvas(replace){
  let next=this.canvas;
  if(replace){
   next=this.canvas.cloneNode?.(false);if(!next||!this.canvas.parentNode)throw new Error('Аппаратная сцена недоступна. Откройте плоскую карту.');
  }
  const ctx=next.getContext('2d',{alpha:false});if(!ctx)throw new Error('На этом устройстве недоступен рендер карты.');
  // Commit the DOM replacement only after its context succeeds; failed retries retain React's canvas.
  if(replace){this.canvas.parentNode.replaceChild(next,this.canvas);this.canvas=next;}
  this.software=new TerrainCanvas(ctx,this.model,this.displayMask,this.options.navigation==='map');this.software.setCartography(this.cartography);this.gl=null;this.gpu=null;
 }
 recordGraphicsFallback(stage,error){this.graphicsFallback={stage,reason:String(error?.message??error??'Graphics context unavailable').replace(/[\r\n\t ]+/g,' ').slice(0,512)};}
 notify(name,value){try{this.options[name]?.(value);}catch{/* Host callbacks must not interrupt rendering or context recovery. */}}
 bind(name,handler,options){this.canvas.addEventListener(name,handler,options);this.events.push([this.canvas,name,handler,options]);}
 bindControls(){
  this.bind('pointerdown',e=>{
   if(e.button!==undefined&&![0,1,2].includes(e.button))return;try{this.canvas.setPointerCapture(e.pointerId);}catch{}
   const alternate=e.button===1||e.button===2||e.shiftKey;
   this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY,pan:this.options.navigation==='map'?!alternate:alternate});this.dragging=true;this.request();
  });
  this.bind('pointermove',e=>{
   const old=this.pointers.get(e.pointerId);if(!old)return;const before=[...this.pointers.values()];
   this.pointers.set(e.pointerId,{...old,x:e.clientX,y:e.clientY});const after=[...this.pointers.values()];
   if(after.length===1){
    if(old.pan)this.panBy(e.clientX-old.x,e.clientY-old.y);
    else{this.yaw+=(e.clientX-old.x)*.0045;this.pitch=clamp(this.pitch+(e.clientY-old.y)*.003,.28,1.32);}
   }else if(after.length===2){
    const oldDistance=Math.hypot(before[0].x-before[1].x,before[0].y-before[1].y),newDistance=Math.hypot(after[0].x-after[1].x,after[0].y-after[1].y);
    if(oldDistance>2)this.zoom=clamp(this.zoom*newDistance/oldDistance,...this.zoomLimits());
    this.panBy((after[0].x+after[1].x-before[0].x-before[1].x)/2,(after[0].y+after[1].y-before[0].y-before[1].y)/2);
   }
   this.yaw=((this.yaw+PI)%TAU+TAU)%TAU-PI;this.request();
  });
  const up=e=>{
   this.pointers.delete(e.pointerId);try{if(this.canvas.hasPointerCapture?.(e.pointerId))this.canvas.releasePointerCapture(e.pointerId);}catch{}
   this.dragging=this.pointers.size>0;this.request();if(!this.dragging)this.scheduleViewChange('gesture',0);
  };
  this.bind('pointerup',up);this.bind('pointercancel',up);this.bind('lostpointercapture',up);this.bind('contextmenu',e=>e.preventDefault());
  this.bind('wheel',e=>{
   e.preventDefault();const unit=e.deltaMode===1?16:e.deltaMode===2?300:1;
   this.zoom=clamp(this.zoom*Math.exp(-clamp(e.deltaY*unit,-800,800)*.001),...this.zoomLimits());
   this.wheeling=true;clearTimeout(this.wheelTimer);this.wheelTimer=setTimeout(()=>{this.wheeling=false;this.request();this.scheduleViewChange('wheel',0);},140);this.request();
  },{passive:false});
  this.bind('keydown',e=>{
   if(this.options.navigation==='map'&&!e.shiftKey&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){
    this.panBy(e.key==='ArrowLeft'?64:e.key==='ArrowRight'?-64:0,e.key==='ArrowUp'?64:e.key==='ArrowDown'?-64:0);this.request();this.scheduleViewChange('keyboard');
   }else if(e.key==='ArrowLeft')this.rotate(-.1);else if(e.key==='ArrowRight')this.rotate(.1);
   else if(e.key==='ArrowUp'){this.pitch=clamp(this.pitch+.06,.28,1.32);this.request();}
   else if(e.key==='ArrowDown'){this.pitch=clamp(this.pitch-.06,.28,1.32);this.request();}
   else if(e.key==='+'||e.key==='=')this.zoomBy(1.15);else if(e.key==='-'||e.key==='−')this.zoomBy(1/1.15);
   else if(e.key==='Home')this.reset();else return;this.scheduleViewChange('keyboard');e.preventDefault();
  });
  this.bind('webglcontextlost',e=>{
   e.preventDefault();this.contextLost=true;this.cancelFrame();this.pendingGPU=null;this.canvas.dataset.terrainPending='false';this.gpu?.abandon();this.gpuRoute=null;this.notify('onError','Графический контекст прерван. Восстанавливаем сцену…');
   clearTimeout(this.restoreTimer);this.restoreTimer=setTimeout(()=>{this.recordGraphicsFallback('context-timeout','Graphics context did not restore');this.fallbackAfterLoss();},2500);
  });
  this.bind('webglcontextrestored',()=>{
   if(this.destroyed||!this.gl)return;clearTimeout(this.restoreTimer);
   try{this.gpu?.abandon();this.gpu=new TerrainGPU(this.gl,this.model,this.displayMask,this.options.navigation==='map');this.gpu.setCartography(this.cartography);this.gpuCartographyDirty=false;this.gpuRoute=null;this.contextLost=false;this.request();}
   catch(error){this.recordGraphicsFallback('context-restoration',error);this.fallbackAfterLoss();}
  });
 }
 fallbackAfterLoss(){
  if(this.destroyed||!this.contextLost)return;clearTimeout(this.restoreTimer);this.unbindControls();this.resize?.disconnect();
  this.pointers.clear();this.dragging=false;this.wheeling=false;clearTimeout(this.wheelTimer);this.gpuRoute=null;this.pendingGPU=null;this.gpuCartographyDirty=false;this.canvas.dataset.terrainPending='false';
  try{this.gpu?.destroy();this.useCanvas(true);this.contextLost=false;this.bindControls();this.observe();this.request();}
  catch{this.terminalFailure('Не удалось восстановить ландшафт. Подготовьте сцену заново.');}
 }
 /** An ended graphics session cannot be made ready again by merely unhiding it.
  * Release it before notifying the host; retry must own a new renderer/canvas. */
 terminalFailure(message){
  if(this.destroyed)return;this.failed=true;this.destroy();
  this.notify('onError',message);this.notify('onFatal',message);
 }
 unbindControls(){this.events.forEach(([target,name,handler,options])=>target.removeEventListener(name,handler,options));this.events=[];}
 observe(){
  if(typeof ResizeObserver!=='undefined'){this.resize=new ResizeObserver(()=>this.options.navigation==='map'?this.setViewportInsets(this.viewportInsets):this.request());this.resize.observe(this.canvas);}
  else if(typeof window!=='undefined'&&!this.onResize){this.onResize=()=>this.options.navigation==='map'?this.setViewportInsets(this.viewportInsets):this.request();window.addEventListener('resize',this.onResize);}
 }
 zoomLimits(){return this.options.navigation==='map'?[.2,1024]:[.65,5];}
 /** Settled navigation only. Programmatic view/data updates never recurse into the host loader. */
 scheduleViewChange(reason,delay=160){
  if(this.destroyed||!this.options.onViewChange)return;clearTimeout(this.viewTimer);
  this.viewTimer=setTimeout(()=>{this.viewTimer=0;if(!this.destroyed&&!this.dragging&&!this.wheeling)this.notifyViewChange(reason);},delay);
 }
 notifyViewChange(reason){try{this.options.onViewChange?.(this.getView(),reason);}catch{/* The host owns loading errors. */}}
 viewportSize(){const rect=this.canvas.getBoundingClientRect();return{width:Math.max(1,rect.width),height:Math.max(1,rect.height)};}
 syncViewport(){
  if(this.options.navigation!=='map')return;const rect=this.viewportSize();
  if(!this.viewViewport||rect.width!==this.viewViewport.width||rect.height!==this.viewViewport.height)this.applyView(this.getView());
 }
 getView(){
  const b=this.grid.bounds,rect=this.options.navigation==='map'&&this.viewViewport?this.viewViewport:this.viewportSize(),camera=cameraFor(this.model,this,rect.width,rect.height,this.options.compactViewport);
  return{longitude:(b[0]+b[2])/2+this.offset[0]/this.model.width*(b[2]-b[0]),latitude:(b[1]+b[3])/2+this.offset[1]/this.model.height*(b[3]-b[1]),
   yaw:this.yaw,pitch:this.pitch,distanceM:camera.distance*this.model.scale,zoom:this.zoom,bounds:[...b]};
 }
 applyView(view){
  if(!view||!['longitude','latitude','yaw','pitch','distanceM'].every(key=>Number.isFinite(view[key]))||view.latitude<-85||view.latitude>85||view.distanceM<=0)throw new TypeError('Invalid geographic terrain view');
  const b=this.grid.bounds,longitude=longitudeNear(view.longitude,(b[0]+b[2])/2),rect=this.canvas.getBoundingClientRect();
  this.yaw=((view.yaw+PI)%TAU+TAU)%TAU-PI;this.pitch=clamp(view.pitch,.28,1.32);
  this.offset=[(longitude-(b[0]+b[2])/2)/(b[2]-b[0])*this.model.width,(view.latitude-(b[1]+b[3])/2)/(b[3]-b[1])*this.model.height];
  const before=this.zoom,camera=cameraFor(this.model,this,Math.max(1,rect.width),Math.max(1,rect.height),this.options.compactViewport);
  this.zoom=clamp(camera.distance*before*this.model.scale/view.distanceM,...this.zoomLimits());
  if(this.options.navigation==='map')this.viewViewport={width:Math.max(1,rect.width),height:Math.max(1,rect.height)};
 }
 setView(view){if(this.destroyed)return;this.applyView(view);this.request();}
 panBy(dx,dy){
  if(this.destroyed||!Number.isFinite(dx)||!Number.isFinite(dy))return;this.syncViewport();
  const rect=this.canvas.getBoundingClientRect(),cr=Math.cos(this.yaw),sr=Math.sin(this.yaw);
  if(this.options.navigation==='map'){
   const camera=cameraFor(this.model,this,Math.max(1,rect.width),Math.max(1,rect.height),this.options.compactViewport);
   const factor=2*camera.distance*Math.tan(42*PI/360)/camera.usableH,north=dy/Math.max(.25,Math.sin(this.pitch));
   this.offset[0]-=(dx*cr+north*sr)*factor;this.offset[1]-=(dx*sr-north*cr)*factor;
   const b=this.grid.bounds,latitude=(b[1]+b[3])/2+this.offset[1]/this.model.height*(b[3]-b[1]);
   this.offset[1]+=(clamp(latitude,-85,85)-latitude)/(b[3]-b[1])*this.model.height;
  }else{
   const factor=1/Math.max(200,Math.min(rect.width,rect.height))/this.zoom;
   this.offset[0]=clamp(this.offset[0]-(dx*cr+dy*sr)*factor,-this.model.width*.42,this.model.width*.42);
   this.offset[1]=clamp(this.offset[1]-(dx*sr-dy*cr)*factor,-this.model.height*.42,this.model.height*.42);
  }
  this.request();if(!this.dragging&&!this.wheeling)this.scheduleViewChange('gesture');
 }
 /** Build replacement resources before releasing the current model. The canvas keeps its last completed frame. */
 setTerrain(grid,{preparedModel,displayMask=null}={}){
  if(this.destroyed)return;
  const model=preparedModel===undefined?createTerrainModel(grid):validatePreparedTerrainModel(grid,preparedModel);
  const validated=displayMask?validateTerrainDisplayMask(displayMask,grid):null;
  const mask=validated?{width:validated.width,height:validated.height,pixels:new Uint8Array(validated.pixels),source:{...validated.source,bounds:[...validated.source.bounds],cells:[...validated.source.cells]}}:null;
  const view=this.getView(),mapped=this.options.navigation==='map';let gpu=null,software=null;
  if(this.gpu&&!this.contextLost){this.gl.bindFramebuffer(this.gl.FRAMEBUFFER,null);gpu=new TerrainGPU(this.gl,model,mask,mapped);}
  else if(this.software)software=new TerrainCanvas(this.software.ctx,model,mask,mapped);
  // No state mutation before the source, mask and graphics allocations all succeed.
  this.cancelFrame();this.pendingGPU=null;this.gpu?.destroy();this.software?.destroy();this.gpu=gpu;this.software=software;
  this.grid=grid;this.model=model;this.displayMask=mask;this.widthM=model.widthM;this.heightM=model.heightM;this.base=model.base;
  this.meshes.clear();this.windowMeshes.clear();this.routeMeshes.clear();this.meshStride=0;this.renderProfile=null;this.route=[];this.gpuRoute=null;this.cartography=null;this.gpuCartographyDirty=false;
  this.canvas.dataset.cartography='none';this.canvas.dataset.cartographyTiles='0';this.canvas.dataset.routeSegments='0';this.canvas.dataset.routeClipped='false';
  this.applyView(view);this.request();
 }
 /** Canvas CSS coordinates. Projection does not assert visibility behind an intervening ridge. */
 project(longitude,latitude,elevationM){
  if(this.destroyed||![longitude,latitude].every(Number.isFinite))return null;this.syncViewport();
  const b=this.grid.bounds,lon=longitudeNear(longitude,(b[0]+b[2])/2),u=(lon-b[0])/(b[2]-b[0]),v=(b[3]-latitude)/(b[3]-b[1]);
  if(u<0||u>1||v<0||v>1||!sampleTerrainDisplayMask(this.displayMask,u,v))return null;
  const x=(u-.5)*this.model.widthM,y=(.5-v)*this.model.heightM,height=elevationM===undefined?sampleTerrainMeshElevation(this.model,x,y,this.meshStride||1):elevationM;
  if(!Number.isFinite(height))return null;const rect=this.canvas.getBoundingClientRect();if(rect.width<1||rect.height<1)return null;
  const camera=cameraFor(this.model,this,rect.width,rect.height,this.options.compactViewport),point=projectPoint([x/this.model.scale,y/this.model.scale,(height-this.model.base)/this.model.scale],camera,rect.width,rect.height);
  return point&&point[2]>=-1&&point[2]<=1?{x:point[0],y:point[1],depth:point[2]}:null;
 }
 /** Pick the exact active LOD triangles, including ragged cells, without reading the GPU. */
 unproject(x,y){
  if(this.destroyed||![x,y].every(Number.isFinite))return null;this.syncViewport();
  const rect=this.canvas.getBoundingClientRect();if(rect.width<1||rect.height<1||x<0||y<0||x>rect.width||y>rect.height)return null;
  const model=this.model,camera=cameraFor(model,this,rect.width,rect.height,this.options.compactViewport),f=1/Math.tan(42*PI/360)*camera.usableH/rect.height;
  const sx=(x/rect.width*2-1-camera.offset[0])*(rect.width/rect.height)/f,sy=(1-y/rect.height*2-camera.offset[1])/f;
  const ray=normalize(camera.right.map((value,i)=>value*sx+camera.up[i]*sy-camera.forward[i])),origin=camera.eye;
  const minima=[-model.width/2,-model.height/2,(model.min-model.base)/model.scale-1e-7],maxima=[model.width/2,model.height/2,(model.max-model.base)/model.scale+1e-7];
  let lo=0,hi=Infinity;
  for(let i=0;i<3;i++){
   if(Math.abs(ray[i])<1e-12){if(origin[i]<minima[i]||origin[i]>maxima[i])return null;continue;}
   const a=(minima[i]-origin[i])/ray[i],b=(maxima[i]-origin[i])/ray[i];lo=Math.max(lo,Math.min(a,b));hi=Math.min(hi,Math.max(a,b));
  }
  if(!(hi>=lo)||!Number.isFinite(hi))return null;
  const at=t=>origin.map((value,i)=>value+ray[i]*t),a=at(lo),b=at(hi),step=this.meshStride||1;
  // Numeric interval clipping can land a few ulps outside the last row/column.
  for(const point of[a,b]){point[0]=clamp(point[0],-model.width/2,model.width/2);point[1]=clamp(point[1],-model.height/2,model.height/2);}
  let hit=null;
  if(Math.hypot(ray[0],ray[1])<1e-10){
   const h=sampleTerrainMeshElevation(model,a[0]*model.scale,a[1]*model.scale,step);if(h===null)return null;
   const t=((h-model.base)/model.scale-origin[2])/ray[2];if(t>=lo-1e-8&&t<=hi+1e-8)hit=at(t);
  }else{
   const axis=Math.abs(ray[0])>=Math.abs(ray[1])?0:1,lift=Math.max(1.5,Math.min(model.cellX,model.cellY)*.08)/model.scale;
   for(const[p,q]of drapeTerrainRoute(model,[[a,b]],step)){
    const ta=(p[axis]-origin[axis])/ray[axis],tb=(q[axis]-origin[axis])/ray[axis],da=origin[2]+ray[2]*ta-p[2]+lift,db=origin[2]+ray[2]*tb-q[2]+lift;
    if(Math.abs(da)<1e-8){hit=at(ta);break;}
    if(da*db<=0&&Math.abs(da-db)>1e-14){hit=at(ta+(tb-ta)*da/(da-db));break;}
   }
  }
  if(!hit)return null;const u=hit[0]/model.width+.5,v=.5-hit[1]/model.height;
  if(!sampleTerrainDisplayMask(this.displayMask,u,v))return null;
  return{longitude:model.grid.bounds[0]+u*(model.grid.bounds[2]-model.grid.bounds[0]),latitude:model.grid.bounds[3]-v*(model.grid.bounds[3]-model.grid.bounds[1]),elevationM:hit[2]*model.scale+model.base};
 }
 heightAt(x,y){return sampleElevation(this.model,x,y);}
 setCartography(surface){
  if(this.destroyed)return;
  if(surface)validateTerrainCartography(surface,this.grid);
  const next=surface&&surface.source.loadedTiles>0?{width:surface.width,height:surface.height,pixels:new Uint8ClampedArray(surface.pixels),source:{...surface.source,bounds:[...surface.source.bounds]}}:null;
  this.cartography=next;this.software?.setCartography(next);
  this.canvas.dataset.cartography=next&&next.source.loadedTiles>0?'source':'none';this.canvas.dataset.cartographyTiles=String(next?.source.loadedTiles||0);
  try{if(this.gpu&&!this.contextLost){if(this.pendingGPU)this.gpuCartographyDirty=true;else{this.gpu.setCartography(next);this.gpuCartographyDirty=false;}}}
  catch(error){this.recordGraphicsFallback('cartography',error);this.contextLost=true;this.fallbackAfterLoss();return;}
  this.request();
 }
 setGeometry(data){
  if(this.destroyed)return;
  try{
   const result=terrainRoute(this.model,data);this.route=result.segments;this.routeMeshes.clear();this.gpuRoute=null;
   this.canvas.dataset.routeClipped=String(result.clipped);this.canvas.dataset.routeSegments=String(result.segments.length);
   this.request();return{segments:result.segments.length,clipped:result.clipped};
  }catch{
   this.route=[];this.routeMeshes.clear();this.gpuRoute=null;this.request();this.notify('onError','Геометрия не помещается в предпросмотр. Откройте маршрут на основной карте.');
   this.canvas.dataset.routeClipped='true';this.canvas.dataset.routeSegments='0';
   return{segments:0,clipped:true};
  }
 }
 setVisible(value){
  this.visible=Boolean(value);
  if(this.visible)this.request();else{this.cancelFrame();this.pointers.clear();this.dragging=false;this.wheeling=false;clearTimeout(this.wheelTimer);if(this.warmRequested||this.pendingGPU?.warm)this.schedule();}
 }
 setViewportInsets(insets){if(this.destroyed)return;const view=this.options.navigation==='map'?this.getView():null;this.viewportInsets=normalizedInsets(insets);if(view)this.applyView(view);this.request();}
 warmup(){if(this.destroyed)return;this.warmRequested=true;this.request();}
 cancelFrame(){if(this.frame){cancelAnimationFrame(this.frame);this.frame=0;}}
 request(){
  if(this.destroyed)return;this.dirty=true;if(this.gpu?.frameFormat)this.canvas.dataset.terrainPending='true';this.schedule();
 }
 schedule(){
  if(this.destroyed||(!this.visible&&!this.warmRequested&&!this.pendingGPU?.warm)||this.contextLost||this.frame||this.document?.visibilityState==='hidden')return;
  if(!this.pendingGPU&&!this.dirty&&!this.warmRequested)return;
  this.frame=requestAnimationFrame(()=>{
   this.frame=0;const warm=this.warmRequested;this.warmRequested=false;
   if(!this.destroyed&&(this.visible||warm||this.pendingGPU?.warm)&&!this.contextLost&&this.document?.visibilityState!=='hidden'){
    if(this.pendingGPU){this.pendingGPU.warm||=warm;this.pollGPUFrame();}
    else{this.dirty=false;this.render(warm);}
   }
  });
 }
 frameDimensions(rect){
  const profile=this.profileFor(rect,typeof navigator!=='undefined'?navigator:{}),wantedDpr=Math.min(typeof devicePixelRatio==='number'?devicePixelRatio:1,profile.maxDpr);
  const dpr=Math.min(wantedDpr,Math.sqrt(profile.pixelLimit/(rect.width*rect.height)),4096/rect.width,4096/rect.height);
  return{profile,dpr,width:Math.max(1,Math.round(rect.width*dpr)),height:Math.max(1,Math.round(rect.height*dpr))};
 }
 frameState(rect,dpr){return[rect.width,rect.height,dpr,this.yaw,this.pitch,this.zoom,this.offset[0],this.offset[1],this.viewportInsets,this.cartography,this.route];}
 pollGPUFrame(){
  const pending=this.pendingGPU;if(!pending||pending.gpu!==this.gpu||this.destroyed||this.contextLost)return;
  try{
   if(!this.gpu.frameReady(pending)){
    if(performance.now()-pending.started>10000)throw new Error('Terrain frame completion timed out');
    this.schedule();return;
   }
   this.pendingGPU=null;
   const rect=this.canvas.getBoundingClientRect(),dimensions=this.frameDimensions(rect),state=this.frameState(rect,dimensions.dpr);
   if(rect.width<1||rect.height<1||!pending.state.every((value,index)=>value===state[index])){
    this.dirty=true;this.warmRequested||=pending.warm;this.schedule();return;
   }
   // Do not resize/clear the visible canvas while expensive work is pending.
   // The completed texture is copied immediately after the deferred resize.
   const started=performance.now();
   if(this.canvas.width!==pending.width||this.canvas.height!==pending.height){this.canvas.width=pending.width;this.canvas.height=pending.height;}
   this.gpu.presentFrame(pending);pending.info.ms+=performance.now()-started;
   this.publishFrame(pending.info,pending.routeLength,'deferred-msaa');
   this.schedule();
  }catch(error){
   this.recordGraphicsFallback('presentation',error);this.warmRequested||=pending.warm;this.contextLost=true;this.fallbackAfterLoss();
  }
 }
 meshFor(step,window){
  if(window){const key=step+':'+window.join(':');if(!this.windowMeshes.has(key)){if(this.windowMeshes.size>=2)this.windowMeshes.delete(this.windowMeshes.keys().next().value);this.windowMeshes.set(key,buildTerrainMesh(this.model,step,window));}return this.windowMeshes.get(key);}
  if(!this.meshes.has(step))this.meshes.set(step,buildTerrainMesh(this.model,step));return this.meshes.get(step);
 }
 profileFor(rect,hardware){
  const lowMemory=hardware.deviceMemory!==undefined&&hardware.deviceMemory<4,compact=lowMemory||rect.width<700;
  const key=Boolean(this.gpu)+':'+lowMemory+':'+compact;
  if(this.renderProfile?.key!==key)this.renderProfile={key,pixelLimit:this.gpu?(lowMemory?1600000:2800000):900000,maxDpr:this.gpu?2:1.5,
   vertexLimit:this.gpu?(lowMemory?66049:263169):16641,shadowSize:compact?128:256,shadowQueries:compact?SHADOW_COMPACT_QUERIES:SHADOW_FULL_QUERIES};
  return this.renderProfile;
 }
 routeFor(step){
  if(this.routeMeshes.has(step))return this.routeMeshes.get(step);
  let route;
  try{route=drapeTerrainRoute(this.model,this.route,step);}
  catch{route=[];this.notify('onError','Геометрия не помещается в предпросмотр. Откройте маршрут на основной карте.');}
  if(this.routeMeshes.size>=2)this.routeMeshes.delete(this.routeMeshes.keys().next().value);this.routeMeshes.set(step,route);return route;
 }
 render(warm=false){
  if(this.pendingGPU){this.dirty=true;return;}
  const started=performance.now(),rect=this.canvas.getBoundingClientRect();if(rect.width<1||rect.height<1){if(warm)this.warmRequested=true;return;}
  this.syncViewport();
  const motion=this.dragging||this.wheeling,{profile,dpr,width:W,height:H}=this.frameDimensions(rect);
  const camera=cameraFor(this.model,this,rect.width,rect.height,this.options.compactViewport);
  const budget=this.gpu?Math.max(4225,camera.usableW*camera.usableH*.55*Math.min(2,this.zoom)):16641;
  const selection=this.options.navigation==='map'?selectVisibleTerrainMesh(this.model,camera,Math.min(budget,profile.vertexLimit),this.meshStride):null;
  const step=selection?.step??selectTerrainMeshStride(this.grid,budget,this.meshStride,profile.vertexLimit);this.meshStride=step;
  const mesh=this.meshFor(step,selection?.range),light=this.options.navigation==='map'?terrainLight(0,.85):terrainLight(this.yaw,this.pitch),route=this.routeFor(step);
  const info={ms:0,triangles:mesh.triangles,quality:motion?'motion':'full',renderer:this.gpu?'webgl2':'canvas2d',pixelRatio:dpr,meshStride:step,sourceVertices:this.grid.width*this.grid.height,graphicsFallback:this.graphicsFallback?{...this.graphicsFallback}:null,
   view:{yaw:this.yaw,pitch:this.pitch,zoom:this.zoom,offset:[...this.offset]},
   geographicView:{...this.getView(),distanceM:camera.distance*this.model.scale},
   viewport:{width:rect.width,height:rect.height,insets:{...camera.insets}},meshWindow:mesh.window?[...mesh.window]:null,renderedVertices:mesh.count,
   cartography:this.cartography?{loadedTiles:this.cartography.source.loadedTiles,requestedTiles:this.cartography.source.requestedTiles,width:this.cartography.width,height:this.cartography.height}:null,
   displayMask:this.displayMask?{width:this.displayMask.width,height:this.displayMask.height,allowedPixels:this.displayMask.source.allowedPixels,coverageVersion:this.displayMask.source.coverageVersion}:null};
  try{
   if(this.gpu){
    if(this.gpuCartographyDirty){this.gpu.setCartography(this.cartography);this.gpuCartographyDirty=false;}
    if(this.gpuRoute!==route){this.gpu.setRoute(route);this.gpuRoute=route;}
    if(this.gpu.frameFormat){
     const frame=this.gpu.beginFrame(mesh,camera,light,W,H,dpr,profile);info.ms=performance.now()-started;
     this.pendingGPU={...frame,gpu:this.gpu,info,width:W,height:H,routeLength:route.length,warm,started,state:this.frameState(rect,dpr)};
     this.canvas.dataset.terrainPending='true';this.pollGPUFrame();return;
    }
   }
   if(this.canvas.width!==W||this.canvas.height!==H){this.canvas.width=W;this.canvas.height=H;}
   if(this.gpu)this.gpu.render(mesh,camera,light,W,H,dpr,profile);else this.software.render(mesh,camera,light,W,H,dpr,profile,route);
  }catch(error){
   if(this.gpu){this.recordGraphicsFallback('render',error);this.warmRequested=warm;this.contextLost=true;this.fallbackAfterLoss();return;}
   this.terminalFailure('Не удалось нарисовать ландшафт. Подготовьте сцену заново.');return;
  }
  info.ms=performance.now()-started;this.publishFrame(info,route.length,this.gpu?'direct':'canvas2d');
 }
 publishFrame(info,routeLength,presentation){
  this.canvas.dataset.renderMs=info.ms.toFixed(1);this.canvas.dataset.triangles=String(info.triangles);
  this.canvas.dataset.quality=info.quality;this.canvas.dataset.renderer=info.renderer;this.canvas.dataset.meshStride=String(info.meshStride);
  this.canvas.dataset.routeMeshStride=String(info.meshStride);this.canvas.dataset.routeRenderSegments=String(routeLength);
  this.canvas.dataset.sourceVertices=String(info.sourceVertices);this.canvas.dataset.heightScale='1';this.canvas.dataset.material='cartographic';
  this.canvas.dataset.displayMask=info.displayMask?'russia-display-area':'none';this.canvas.dataset.terrainPresentation=presentation;this.canvas.dataset.terrainPending=String(this.dirty||this.warmRequested);
  // ms is CPU submission/presentation time. GPU completion is asynchronous;
  // this callback describes only the completed view actually copied to canvas.
  this.notify('onRender',info);
 }
 rotate(delta){if(this.destroyed||!Number.isFinite(delta))return;this.yaw=((this.yaw+delta+PI)%TAU+TAU)%TAU-PI;this.request();this.scheduleViewChange('rotate');}
 zoomBy(factor){if(this.destroyed||!Number.isFinite(factor)||factor<=0)return;const next=clamp(this.zoom*factor,...this.zoomLimits());if(next===this.zoom)return;this.zoom=next;this.request();this.scheduleViewChange('zoom');}
 reset(){if(this.destroyed)return;const initial=this.options.navigation==='map'?MAP_VIEW:DEFAULT_VIEW;this.yaw=initial.yaw;this.pitch=initial.pitch;this.zoom=initial.zoom;this.offset=[0,0];this.request();this.scheduleViewChange('reset');}
 destroy(){
  if(this.destroyed)return;this.destroyed=true;this.cancelFrame();clearTimeout(this.wheelTimer);clearTimeout(this.restoreTimer);clearTimeout(this.viewTimer);
  this.resize?.disconnect();if(this.onResize&&typeof window!=='undefined')window.removeEventListener('resize',this.onResize);
  this.document?.removeEventListener('visibilitychange',this.onVisibility);this.unbindControls();this.pointers.clear();
  this.gpu?.destroy();this.software?.destroy();this.pendingGPU=null;this.meshes.clear();this.windowMeshes.clear();this.routeMeshes.clear();this.route=[];this.gpuRoute=null;this.cartography=null;this.displayMask=null;this.warmRequested=false;this.canvas.dataset.terrainPending='false';
  if(this.canvas!==this.originalCanvas&&this.canvas.parentNode)this.canvas.parentNode.replaceChild(this.originalCanvas,this.canvas);
  if(this.originalCanvas.style)this.originalCanvas.style.touchAction=this.previousTouchAction||'';
 }
}
