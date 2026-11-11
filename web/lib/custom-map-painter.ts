import type {VectorTile} from './custom-map-vector';
import {isPriorityCity} from '../public/maps/map-city-labels.js';
import {sourceMapSymbol,type MapSymbol} from './custom-map-symbols.ts';

/** Tropnik's cartography. Input is source geometry, never a vendor map style. */
export const CARTOGRAPHY = Object.freeze({
  land: '#e0e7d3', forest: '#b9cfaa', scrub: '#ccd8b5', grass: '#d5dfbd',
  water: '#acd0d6', waterLine: '#7facb8', sand: '#e7ddbc', rock: '#d7d3c4',
  glacier: '#eef3ed', urban: '#e5e0d2', farmland: '#dce0bd',
  road: '#fffaf0', roadEdge: '#b9b49b', path: '#a2784e', ink: '#315342',
});
export type MapTileLabel = {x:number;y:number;text:string;kind:'place'|'peak'|'water'|'poi'|'path';rank:number;elevation?:number;priorityCity?:boolean;symbol?:MapSymbol};
export type PaintContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type TilePaintBounds = {left:number;top:number;right:number;bottom:number};
export type VectorPaintOptions = {symbolScale?:number;labelBounds?:TilePaintBounds;geometryBounds?:TilePaintBounds;boundaries?:boolean};
export type ReliefHaloOffset={dx:-1|0|1;dy:-1|0|1};
export type ReliefHaloKey='-1,-1'|'0,-1'|'1,-1'|'-1,0'|'1,0'|'-1,1'|'0,1'|'1,1';
export type ReliefHalo=Partial<Record<ReliefHaloKey,Float32Array>>;
export type ReliefHaloMissing=ReliefHaloOffset&{reason:'coverage'|'unavailable'|'budget'|'invalid'|'resolution'};
export type ReliefHaloSource=ReliefHaloOffset&{sourceKey:string;mime:string;bytes:ArrayBuffer;reduceToArchive?:boolean};
export type ReliefHaloPayload={tiles:ReliefHaloSource[];missing:ReliefHaloMissing[]};
export type ReliefCoverage={sourceSize:number;required:number;available:number;missing:ReliefHaloMissing[];resampled:ReliefHaloOffset[];missingDataFilled:false};
type TileFeature = VectorTile['layers'][string]['features'][number];
const text = (value:unknown) => typeof value==='string'?value:'';
const classes = (feature:TileFeature) => text(feature.properties.class)||text(feature.properties.subclass);
const featureBounds=new WeakMap<TileFeature,TilePaintBounds>();
function intersects(feature:TileFeature,extent:number,bounds:TilePaintBounds|undefined,padding:number){
  if(!bounds)return true;
  let box=featureBounds.get(feature);
  if(!box){
    box={left:Infinity,top:Infinity,right:-Infinity,bottom:-Infinity};
    for(const part of feature.geometry)for(const point of part){box.left=Math.min(box.left,point.x);box.top=Math.min(box.top,point.y);box.right=Math.max(box.right,point.x);box.bottom=Math.max(box.bottom,point.y);}
    featureBounds.set(feature,box);
  }
  return box.right/extent>=bounds.left-padding&&box.left/extent<=bounds.right+padding&&box.bottom/extent>=bounds.top-padding&&box.top/extent<=bounds.bottom+padding;
}

function trace(context:PaintContext, feature:TileFeature, extent:number, size:number) {
  const scale=size/extent;context.beginPath();
  for(const part of feature.geometry){
    if(!part.length)continue;
    context.moveTo(part[0].x*scale,part[0].y*scale);
    for(let i=1;i<part.length;i++)context.lineTo(part[i].x*scale,part[i].y*scale);
    if(feature.type===3)context.closePath();
  }
}
function fill(context:PaintContext, feature:TileFeature, extent:number, size:number,color:string) {
  trace(context,feature,extent,size);context.fillStyle=color;context.fill('evenodd');
}
function stroke(context:PaintContext, feature:TileFeature, extent:number, size:number,color:string,width:number,dash:number[]=[]) {
  trace(context,feature,extent,size);context.strokeStyle=color;context.lineWidth=width;
  context.setLineDash(dash);context.stroke();context.setLineDash([]);
}
function anchor(feature:TileFeature) {
  const points=feature.geometry[0];if(!points?.length)return;
  if(feature.type===1)return points[0];
  return points[Math.floor(points.length/2)];
}
type SourcePoint={x:number;y:number};
function clippedLine(a:SourcePoint,b:SourcePoint,bounds:TilePaintBounds):[number,number,number,number]|undefined{
  let start=0,end=1;const dx=b.x-a.x,dy=b.y-a.y;
  const directions=[-dx,dx,-dy,dy],distances=[a.x-bounds.left,bounds.right-a.x,a.y-bounds.top,bounds.bottom-a.y];
  for(let i=0;i<4;i++){
    if(directions[i]===0){if(distances[i]<0)return;continue;}
    const t=distances[i]/directions[i];if(directions[i]<0)start=Math.max(start,t);else end=Math.min(end,t);if(start>end)return;
  }
  return[a.x+dx*start,a.y+dy*start,a.x+dx*end,a.y+dy*end];
}
/** The midpoint of the longest visible, connected source line fragment.
 * Clipping chooses a label anchor only; it never alters the source geometry
 * or joins disconnected fragments. Two passes retain no copied point arrays. */
function visibleLineAnchor(feature:TileFeature,extent:number,requested:TilePaintBounds|undefined):SourcePoint|undefined{
  const crop=requested??{left:0,top:0,right:1,bottom:1};
  const bounds={left:Math.max(0,crop.left)*extent,top:Math.max(0,crop.top)*extent,right:Math.min(1,crop.right)*extent,bottom:Math.min(1,crop.bottom)*extent};
  let best:{part:SourcePoint[];start:number;end:number;length:number}|undefined;
  for(const part of feature.geometry){
    let length=0,start=1,previous:[number,number]|undefined;
    for(let i=1;i<part.length;i++){
      const segment=clippedLine(part[i-1],part[i],bounds);
      if(!segment){previous=undefined;length=0;continue;}
      const distance=Math.hypot(segment[2]-segment[0],segment[3]-segment[1]);if(!distance)continue;
      if(!previous||Math.hypot(segment[0]-previous[0],segment[1]-previous[1])>1e-7){start=i;length=0;}
      length+=distance;previous=[segment[2],segment[3]];
      if(!best||length>best.length)best={part,start,end:i,length};
    }
  }
  if(!best)return;
  let remaining=best.length/2;
  for(let i=best.start;i<=best.end;i++){
    const segment=clippedLine(best.part[i-1],best.part[i],bounds);if(!segment)continue;
    const distance=Math.hypot(segment[2]-segment[0],segment[3]-segment[1]);if(!distance)continue;
    if(remaining<=distance){const t=remaining/distance;return{x:segment[0]+(segment[2]-segment[0])*t,y:segment[1]+(segment[3]-segment[1])*t};}
    remaining-=distance;
  }
}

/** Draw real OpenMapTiles thematic layers into a cacheable, bounded tile. */
export function paintVectorTile(context:PaintContext,tile:VectorTile,z:number,size=512,paths=true,transparent=false,options:VectorPaintOptions={}):MapTileLabel[]{
  context.clearRect(0,0,size,size);
  if(!transparent){context.fillStyle=CARTOGRAPHY.land;context.fillRect(0,0,size,size);}
  context.lineJoin='round';context.lineCap='round';
  // Geometry can span a 32768px parent, while the visible child is still 512px.
  // Widths/dashes belong to that output resolution, never to the parent extent.
  const ratio=options.symbolScale??size/256;
  if(!Number.isFinite(ratio)||ratio<=0)throw new Error('Invalid symbol scale');
  const visible=(feature:TileFeature,extent:number)=>intersects(feature,extent,options.geometryBounds,8*ratio/size);
  const each=(name:string,run:(f:TileFeature,extent:number)=>void)=>{
    const layer=tile.layers[name];if(layer)for(const feature of layer.features)if(visible(feature,layer.extent))run(feature,layer.extent);
  };
  if(!transparent){
    each('landcover',(f,e)=>{if(f.type!==3)return;const c=classes(f);
      const color=/wood|forest/.test(c)?CARTOGRAPHY.forest:/grass|meadow/.test(c)?CARTOGRAPHY.grass:/scrub|heath/.test(c)?CARTOGRAPHY.scrub:/sand|dune/.test(c)?CARTOGRAPHY.sand:/ice|glacier|snow/.test(c)?CARTOGRAPHY.glacier:/wetland/.test(c)?'#bbd2bd':/bare_rock/.test(c)?CARTOGRAPHY.rock:undefined;
      if(color)fill(context,f,e,size,color);
    });
    each('landuse',(f,e)=>{if(f.type!==3)return;const c=classes(f);
      const color=/residential|commercial|industrial/.test(c)?CARTOGRAPHY.urban:/farmland|farm|orchard|vineyard/.test(c)?CARTOGRAPHY.farmland:/park|cemetery|recreation/.test(c)?'#c8dab7':undefined;
      if(color)fill(context,f,e,size,color);
    });
    if(z>=7)each('park',(f,e)=>{if(f.type===3)fill(context,f,e,size,'rgba(193,213,178,.22)');});
    each('water',(f,e)=>{if(f.type===3)fill(context,f,e,size,CARTOGRAPHY.water);});
    if(z>=13)each('building',(f,e)=>{if(f.type!==3)return;fill(context,f,e,size,'#c8c4b2');stroke(context,f,e,size,'#aaa991',.35*ratio);});
  }
  if(z>=9)each('park',(f,e)=>{if(f.type===3)stroke(context,f,e,size,'rgba(120,155,101,.65)',.9*ratio,[2.7*ratio,2.7*ratio]);});
  each('waterway',(f,e)=>{if(f.type!==2)return;const c=classes(f);stroke(context,f,e,size,CARTOGRAPHY.waterLine,(c==='river'?1.5:.6)*ratio);});
  if(options.boundaries!==false)each('boundary',(f,e)=>{if(f.type!==2||Number(f.properties.admin_level)>4)return;stroke(context,f,e,size,transparent?'#e5eee1':'#97aa8e',.65*ratio,[3*ratio,4*ratio]);});
  const roads=tile.layers.transportation;
  if(roads){
    for(const f of roads.features){
      if(f.type!==2||!visible(f,roads.extent))continue;const c=classes(f);
      if(/path|track|footway|bridleway|steps|cycleway/.test(c))continue;
      if(/rail/.test(c)){if(z>=9)stroke(context,f,roads.extent,size,'#879488',.7*ratio,[3*ratio,3*ratio]);continue;}
      const width=(/motorway|trunk/.test(c)?3.4:/primary|secondary/.test(c)?2.6:/tertiary|minor/.test(c)?1.8:1.1)*ratio;
      stroke(context,f,roads.extent,size,transparent?'rgba(255,254,246,.68)':CARTOGRAPHY.roadEdge,width+ratio);
      stroke(context,f,roads.extent,size,CARTOGRAPHY.road,width);
    }
    if(paths)for(const f of roads.features){
      if(f.type!==2||!visible(f,roads.extent)||!/path|track|footway|bridleway|steps|cycleway/.test(classes(f)))continue;
      stroke(context,f,roads.extent,size,transparent?'rgba(255,254,246,.8)':'rgba(255,254,246,.65)',2.3*ratio);
      stroke(context,f,roads.extent,size,transparent?'#e6c598':CARTOGRAPHY.path,1.1*ratio,[3*ratio,2.5*ratio]);
    }
  }
  const labels:MapTileLabel[]=[];
  for(const [layerName,kind] of [['place','place'],['mountain_peak','peak'],['water_name','water'],['poi','poi']] as const){
    if(kind==='poi'&&z<13||kind==='peak'&&z<10)continue;
    each(layerName,(f,e)=>{
      const p=anchor(f),name=text(f.properties['name:ru'])||text(f.properties.name)||text(f.properties['name:latin']);
      const symbol=kind==='peak'||kind==='poi'?sourceMapSymbol(f.properties,kind):undefined;
      if(!p||!name&&!symbol||name.length>110||p.x<0||p.y<0||p.x>e||p.y>e)return;
      const bounds=options.labelBounds,x=p.x/e,y=p.y/e;
      if(bounds&&(x<bounds.left||x>bounds.right||y<bounds.top||y>bounds.bottom))return;
      if(kind==='place'&&z<5&&!/country|state|city/.test(classes(f)))return;
      const rank=Number(f.properties.rank)||(/city/.test(classes(f))?1:symbol?3:4);
      if(kind==='poi'&&!symbol&&rank>3)return;
      const rawElevation=f.properties.ele,elevation=typeof rawElevation==='number'?rawElevation:typeof rawElevation==='string'&&rawElevation.trim()?Number(rawElevation):NaN;
      labels.push({x,y,text:name,kind,rank:Number.isFinite(rank)?rank:4,...(kind==='peak'&&Number.isFinite(elevation)?{elevation}:{}),...(symbol?{symbol}:{}),...(kind==='place'&&isPriorityCity(f.properties)?{priorityCity:true}:{})});
    });
  }
  if(paths&&z>=14)each('transportation_name',(f,e)=>{
    if(f.type!==2||!['path','track'].includes(classes(f)))return;
    const name=text(f.properties['name:ru'])||text(f.properties.name)||text(f.properties['name:latin']);if(!name||name.length>110)return;
    const p=visibleLineAnchor(f,e,options.labelBounds);if(!p)return;
    const rank=Number(f.properties.rank)||4;
    labels.push({x:p.x/e,y:p.y/e,text:name,kind:'path',rank:Number.isFinite(rank)?rank:4});
  });
  return labels.sort((a,b)=>a.rank-b.rank).slice(0,96);
}

/** Full source samples are retained. Shading and isolines add no invented elevations. */
export function decodeTerrarium(rgba:Uint8ClampedArray,width:number,height:number):Float32Array {
  if(width!==height||width<2||width>1024||rgba.length!==width*height*4)throw new Error('Invalid elevation raster');
  const heights=new Float32Array(width*height);
  for(let i=0;i<heights.length;i++){
    const height=rgba[i*4]*256+rgba[i*4+1]+rgba[i*4+2]/256-32768;
    if(rgba[i*4+3]!==255||!Number.isFinite(height)||height<-12000||height>10000)throw new Error('Unavailable or invalid elevation sample');
    heights[i]=height;
  }
  return heights;
}
/** A neighbour contributes only its measured boundary, never a copied edge.
 * The optional 2:1 reduction is precisely the archived PNG's scalar 2x2 mean
 * followed by Terrarium round-to-even quantization, not RGB interpolation. */
export function elevationBorder(heights:Float32Array,sourceSize:number,size:number,dx:number,dy:number,reduceToArchive=false):Float32Array{
  if(!Number.isInteger(sourceSize)||sourceSize<2||heights.length!==sourceSize*sourceSize||!Number.isInteger(size)||size<2||![dx,dy].every(value=>Number.isInteger(value)&&Math.abs(value)<=1)||!dx&&!dy)throw new Error('Invalid elevation border');
  const reduction=sourceSize===size?1:reduceToArchive&&sourceSize===size*2?2:0;
  if(!reduction)throw new Error('Incompatible elevation resolution');
  const border=new Float32Array(dx&&dy?1:size);
  for(let i=0;i<border.length;i++){
    const x=dx<0?size-1:dx>0?0:i,y=dy<0?size-1:dy>0?0:i;
    let value=0;
    for(let yy=0;yy<reduction;yy++)for(let xx=0;xx<reduction;xx++){
      const measured=heights[(y*reduction+yy)*sourceSize+x*reduction+xx];
      if(!Number.isFinite(measured)||measured<-12000||measured>10000)throw new Error('Invalid elevation border sample');
      value+=measured;
    }
    value/=reduction*reduction;
    if(reduction===2){const encoded=value*256,lower=Math.floor(encoded),fraction=encoded-lower;value=(fraction===.5?lower+(Math.abs(lower%2)===1?1:0):Math.round(encoded))/256;}
    border[i]=value;
  }
  return border;
}
function elevationAt(heights:Float32Array,size:number,x:number,y:number,halo:ReliefHalo):number|undefined{
  if(x>=0&&x<size&&y>=0&&y<size)return heights[y*size+x];
  const dx=x<0?-1:x>=size?1:0,dy=y<0?-1:y>=size?1:0,key=`${dx},${dy}` as ReliefHaloKey;
  const border=halo[key];
  if(border&&border.length!==(dx&&dy?1:size))throw new Error('Invalid elevation halo');
  return border?.[dx&&dy?0:dx?y:x];
}
export function reliefPixels(heights:Float32Array,size:number,tileY:number,z:number,halo:ReliefHalo={}):Uint8ClampedArray {
  if(heights.length!==size*size)throw new Error('Invalid elevation samples');
  const pixels=new Uint8ClampedArray(size*size*4);
  const lights=[[-.55,-.55,.63],[.45,-.55,.7],[-.3,.45,.84]];
  const lightX=lights.reduce((sum,l,i)=>sum+l[0]*(i===0?.6:.2),0),lightY=lights.reduce((sum,l,i)=>sum+l[1]*(i===0?.6:.2),0),flat=lights.reduce((sum,l,i)=>sum+l[2]*(i===0?.6:.2),0);
  for(let y=0;y<size;y++){
    const latitude=Math.atan(Math.sinh(Math.PI*(1-2*(tileY+(y+.5)/size)/2**z)));
    const metres=40075016.68557849*Math.cos(latitude)/(2**z*size);
    for(let x=0;x<size;x++){
      const left=elevationAt(heights,size,x-1,y,halo),right=elevationAt(heights,size,x+1,y,halo),top=elevationAt(heights,size,x,y-1,halo),bottom=elevationAt(heights,size,x,y+1,halo);
      // A missing derivative is transparent. It is not a fabricated zero slope
      // or a clamped substitute presented as measured neighbouring terrain.
      if(left===undefined||right===undefined||top===undefined||bottom===undefined)continue;
      if(!Number.isFinite(left)||!Number.isFinite(right)||!Number.isFinite(top)||!Number.isFinite(bottom)||Math.min(left,right,top,bottom)<-12000||Math.max(left,right,top,bottom)>10000)throw new Error('Invalid relief elevation');
      const dx=(right-left)/(metres*2),dy=(bottom-top)/(metres*2);
      const length=Math.hypot(dx,dy,1);
      const illumination=(-dx*lightX-dy*lightY+flat)/length,delta=illumination-flat;
      const at=(y*size+x)*4,dark=delta<0;
      pixels[at]=dark?35:255;pixels[at+1]=dark?57:250;pixels[at+2]=dark?43:226;pixels[at+3]=Math.min(120,Math.abs(delta)*200);
    }
  }
  return pixels;
}

/** Marching squares uses the measured DEM, including interpolated crossing positions. */
export function paintContours(context:PaintContext,heights:Float32Array,gridSize:number,z:number,size=512,options:{lineScale?:number;bounds?:TilePaintBounds;halo?:ReliefHalo}={}):number {
  if(z<10)return 0;
  if(!Number.isInteger(gridSize)||gridSize<2||heights.length!==gridSize*gridSize||!Number.isFinite(size)||size<=0)throw new Error('Invalid contour grid');
  const interval=z>=14?25:z>=12?50:100,scale=size/gridSize;
  // At close zoom every measured source sample contributes. Coarse overview
  // cells remain at most four output pixels; no enlarged contour bitmap.
  const step=Math.max(1,Math.min(gridSize>256?4:2,Math.floor(4/scale)));
  const bounds=options.bounds??{left:0,top:0,right:1,bottom:1};
  const halo=options.halo??{};
  // Interior decimation keeps its global phase. The two half-pixel edge cells
  // always use actual adjacent samples; both neighbouring tiles thus trace the
  // same cell and the output canvas clips it at the exact geographic boundary.
  const axis=[-1,0];for(let index=step;index<gridSize-1;index+=step)axis.push(index);axis.push(gridSize-1,gridSize);
  const cells=(low:number,high:number)=>axis.slice(0,-1).map((value,index)=>[value,axis[index+1]]).filter(([a,b])=>b+.5>=low*gridSize&&a+.5<=high*gridSize);
  const columns=cells(bounds.left,bounds.right),rows=cells(bounds.top,bounds.bottom);
  context.strokeStyle='rgba(102,91,65,.22)';context.lineWidth=(options.lineScale??size/512)*.65;context.beginPath();
  let segments=0;
  const segment=(a:number[],b:number[])=>{if(++segments>262144)throw new Error('Contour geometry exceeds the tile budget');context.moveTo(a[0],a[1]);context.lineTo(b[0],b[1]);};
  for(const [y,nextY] of rows)for(const [x,nextX] of columns){
    const points=[[x,y],[nextX,y],[nextX,nextY],[x,nextY]];
    const samples=points.map(([px,py])=>elevationAt(heights,gridSize,px,py,halo));
    if(samples.some(value=>value===undefined))continue;
    const h=samples as number[];
    if(h.some(value=>!Number.isFinite(value)||value<-12000||value>10000))throw new Error('Invalid contour elevation');
    const low=Math.ceil(Math.min(...h)/interval)*interval,high=Math.max(...h);
    for(let level=low;level<high;level+=interval){
      const crossings:number[][]=[];
      for(let i=0;i<4;i++){const j=(i+1)%4;if((h[i]>=level)===(h[j]>=level))continue;
        // XYZ DEM samples are pixel centres, not the tile's outer corners.
        const t=(level-h[i])/(h[j]-h[i]);crossings.push([(points[i][0]+(points[j][0]-points[i][0])*t+.5)*scale,(points[i][1]+(points[j][1]-points[i][1])*t+.5)*scale]);}
      if(crossings.length===4){
        const determinant=(h[0]-level)*(h[2]-level)-(h[1]-level)*(h[3]-level);
        if(determinant<0){segment(crossings[0],crossings[3]);segment(crossings[1],crossings[2]);}
        else{segment(crossings[0],crossings[1]);segment(crossings[2],crossings[3]);}
      }else if(crossings.length===2)segment(crossings[0],crossings[1]);
    }
  }
  context.stroke();return segments;
}
