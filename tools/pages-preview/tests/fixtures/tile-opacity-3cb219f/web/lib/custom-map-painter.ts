import type {VectorTile} from './custom-map-vector';
import {reliefContourIntervals} from './custom-map-relief.ts';
import {isPriorityCity} from '../public/maps/map-city-labels.js';
import {sourceMapSymbol,type MapSymbol} from './custom-map-symbols.ts';
import {mapLabelPriority} from './custom-map-labels.ts';

/** Tropnik's cartography. Input is source geometry, never a vendor map style. */
export const CARTOGRAPHY = Object.freeze({
  land: '#ecebdc', forest: '#b8cda7', scrub: '#cbd5ad', grass: '#dce3bd',
  water: '#a6cbd5', waterLine: '#648fa2', sand: '#e9d9af', rock: '#d9d4c5',
  glacier: '#edf3ef', urban: '#e5ded1', farmland: '#e5dfbb', wetland: '#bdd3c6',
  park: '#d0dfbb', building: '#c9c0af', buildingEdge: '#a99f8c',
  road: '#fffaf0', roadEdge: '#b5aa92', mainRoad: '#f8e7bb',
  path: '#92623e', track: '#9c7952', ink: '#315342',
});
export type MapTileLabel = {x:number;y:number;text:string;kind:'place'|'peak'|'water'|'poi'|'path'|'contour';rank:number;elevation?:number;priorityCity?:boolean;placeClass?:string;symbol?:MapSymbol};
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
/** OpenMapTiles deliberately groups scrub/fell under grass and scree under
 * rock. Read the recorded subclass before the broad class, never the name. */
function landcoverColor(feature:TileFeature):string|undefined{
  for(const value of [text(feature.properties.subclass),text(feature.properties.class)]){
    if(['wood','forest'].includes(value))return CARTOGRAPHY.forest;
    if(['scrub','heath','fell'].includes(value))return CARTOGRAPHY.scrub;
    if(['grass','grassland','meadow'].includes(value))return CARTOGRAPHY.grass;
    if(['sand','dune','beach'].includes(value))return CARTOGRAPHY.sand;
    if(['ice','glacier','snow'].includes(value))return CARTOGRAPHY.glacier;
    if(['wetland','marsh','swamp','bog'].includes(value))return CARTOGRAPHY.wetland;
    if(['rock','bare_rock','scree','shingle'].includes(value))return CARTOGRAPHY.rock;
    if(['farmland','farm','orchard','vineyard'].includes(value))return CARTOGRAPHY.farmland;
    if(value==='park')return CARTOGRAPHY.park;
  }
}
function landuseColor(feature:TileFeature):string|undefined{
  const value=classes(feature);
  if(['residential','commercial','industrial','retail'].includes(value))return CARTOGRAPHY.urban;
  if(['farmland','farm','orchard','vineyard'].includes(value))return CARTOGRAPHY.farmland;
  if(['park','cemetery','recreation_ground','recreation','village_green','garden','playground','pitch'].includes(value))return CARTOGRAPHY.park;
}
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
function stroke(context:PaintContext, feature:TileFeature, extent:number, size:number,color:string,width:number,dash:number[]=[],cap:CanvasLineCap='round') {
  trace(context,feature,extent,size);context.strokeStyle=color;context.lineWidth=width;
  context.lineCap=cap;context.setLineDash(dash);context.stroke();context.setLineDash([]);
}
type TransportStyle={color:string;width:number;edge:string;edgeWidth:number;dash:number[];order:number;cap?:CanvasLineCap;ties?:boolean};
/** Line widths describe the output tile, including when a parent is cropped.
 * An unrecognised source class is never promoted to a paved road. */
function transportStyle(feature:TileFeature,z:number,paths:boolean,satellite:boolean):TransportStyle|undefined{
  const category=classes(feature),subclass=text(feature.properties.subclass),road=category.replace(/_link$/,'');
  const edge=satellite?'rgba(25,43,35,.72)':CARTOGRAPHY.roadEdge;
  if(['motorway','trunk','primary','secondary','tertiary','minor','residential','unclassified','road','living_street','service','busway','raceway'].includes(road)){
    const main=['motorway','trunk'].includes(road),through=['primary','secondary'].includes(road),local=['tertiary','minor','residential','unclassified','road','living_street'].includes(road);
    if(!main&&!through&&(local?z<11:z<13))return;
    const width=main?3.2:through?2.4:road==='tertiary'?1.7:local?1.2:.7;
    return{color:satellite?'rgba(255,251,234,.90)':main?CARTOGRAPHY.mainRoad:CARTOGRAPHY.road,width,edge,edgeWidth:width+((main||through)?.9:.65),dash:[],order:main?5:through?4:local?3:2};
  }
  if(['rail','transit'].includes(category)){
    if(z<9)return;
    return{color:satellite?'#d9ded5':'#7f8981',width:.65,edge:satellite?'rgba(29,44,36,.65)':'rgba(255,253,244,.72)',edgeWidth:1.5,dash:[],order:6,ties:true};
  }
  if(category==='aerialway'){
    if(z<12)return;
    return{color:satellite?'#d8cfde':'#82758a',width:.85,edge:satellite?'rgba(31,39,34,.72)':'rgba(255,253,246,.82)',edgeWidth:1.8,dash:[6,3],order:7};
  }
  if(category==='ferry'){
    return{color:satellite?'#d5e8ec':'#5d8ba0',width:.9,edge:satellite?'rgba(30,56,62,.62)':'rgba(241,250,249,.68)',edgeWidth:1.8,dash:[4,3],order:1};
  }
  if(!paths||!['path','track','footway','bridleway','steps','cycleway','pedestrian'].includes(category)||subclass==='platform'||z<12)return;
  const track=category==='track',steps=category==='steps'||subclass==='steps',pedestrian=category==='pedestrian'||subclass==='pedestrian';
  return{color:satellite?'#f2ce97':track?CARTOGRAPHY.track:CARTOGRAPHY.path,width:steps?1.8:track?1.25:1.1,
    edge:satellite?'rgba(30,43,30,.85)':'rgba(255,252,239,.88)',edgeWidth:steps?2.6:track?2.5:2.3,
    dash:steps?[.65,1.7]:track?[5,2.5]:pedestrian?[1.3,2.3]:[3,2.5],order:8,...(steps?{cap:'butt' as const}:{})};
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
    each('landcover',(f,e)=>{if(f.type!==3)return;const color=landcoverColor(f);if(color)fill(context,f,e,size,color);});
    each('landuse',(f,e)=>{if(f.type!==3)return;const color=landuseColor(f);if(color)fill(context,f,e,size,color);});
    if(z>=7)each('park',(f,e)=>{if(f.type===3)fill(context,f,e,size,'rgba(193,213,178,.22)');});
    each('water',(f,e)=>{if(f.type===3)fill(context,f,e,size,CARTOGRAPHY.water);});
    if(z>=13)each('building',(f,e)=>{if(f.type!==3)return;fill(context,f,e,size,CARTOGRAPHY.building);if(z>=15)stroke(context,f,e,size,CARTOGRAPHY.buildingEdge,.3*ratio);});
  }
  if(z>=9)each('park',(f,e)=>{if(f.type===3)stroke(context,f,e,size,'rgba(120,155,101,.65)',.9*ratio,[2.7*ratio,2.7*ratio]);});
  each('waterway',(f,e)=>{
    if(f.type!==2||text(f.properties.brunnel)==='tunnel')return;
    const c=classes(f),minor=c==='ditch'||c==='drain';if(minor&&z<14)return;
    const intermittent=f.properties.intermittent===1||f.properties.intermittent===true;
    stroke(context,f,e,size,transparent?'#a5cfda':CARTOGRAPHY.waterLine,(c==='river'?1.25:c==='canal'?.95:minor?.45:.65)*ratio,intermittent?[2*ratio,2*ratio]:[]);
  });
  if(options.boundaries!==false)each('boundary',(f,e)=>{if(f.type!==2||Number(f.properties.admin_level)>4)return;stroke(context,f,e,size,transparent?'#e5eee1':'#97aa8e',.65*ratio,[3*ratio,4*ratio]);});
  const roads=tile.layers.transportation;
  if(roads){
    const transport:Array<{feature:TileFeature;style:TransportStyle;level:number}>=[];
    for(const f of roads.features){
      if(f.type!==2||!visible(f,roads.extent))continue;
      const style=transportStyle(f,z,paths,transparent);if(!style)continue;
      const brunnel=text(f.properties.brunnel),level=brunnel==='tunnel'?-1:brunnel==='bridge'?1:0;
      if(level<0){style.dash=[4,3];style.color=transparent?'#c6cbbd':'#aaa594';style.edge=transparent?'rgba(34,48,39,.55)':'rgba(252,249,237,.55)';}
      transport.push({feature:f,style,level});
    }
    // Casings precede interiors at each recorded bridge/tunnel level. Shared
    // road junctions stay open, and source bridges remain above surface roads.
    transport.sort((a,b)=>a.level-b.level||a.style.order-b.style.order);
    for(const level of [-1,0,1]){
      for(const {feature,style,level:sourceLevel} of transport)if(sourceLevel===level){
        stroke(context,feature,roads.extent,size,style.edge,style.edgeWidth*ratio,style.dash.map(value=>value*ratio),style.cap);
      }
      for(const {feature,style,level:sourceLevel} of transport)if(sourceLevel===level){
        stroke(context,feature,roads.extent,size,style.color,style.width*ratio,style.dash.map(value=>value*ratio),style.cap);
        if(style.ties)stroke(context,feature,roads.extent,size,style.color,2*ratio,[.6*ratio,5*ratio],'butt');
      }
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
      const placeClass=kind==='place'?classes(f):undefined;
      if(placeClass&&((['suburb','hamlet','isolated_dwelling'].includes(placeClass)&&z<12)||(['quarter','neighbourhood','neighborhood'].includes(placeClass)&&z<14)))return;
      const rank=Number(f.properties.rank)||(/city/.test(classes(f))?1:symbol?3:4);
      // Hiking labels are admitted by their recorded outdoor classification.
      // A low source rank alone must not turn schools, clinics or shops into
      // map landmarks and crowd out the trail and measured terrain.
      if(kind==='poi'&&!symbol)return;
      const rawElevation=f.properties.ele,elevation=typeof rawElevation==='number'?rawElevation:typeof rawElevation==='string'&&rawElevation.trim()?Number(rawElevation):NaN;
      labels.push({x,y,text:name,kind,rank:Number.isFinite(rank)?rank:4,...(kind==='peak'&&Number.isFinite(elevation)?{elevation}:{}),...(symbol?{symbol}:{}),...(placeClass?{placeClass}:{}),...(kind==='place'&&isPriorityCity(f.properties)?{priorityCity:true}:{})});
    });
  }
  if(paths&&z>=14)each('transportation_name',(f,e)=>{
    if(f.type!==2||!['path','track'].includes(classes(f)))return;
    const name=text(f.properties['name:ru'])||text(f.properties.name)||text(f.properties['name:latin']);if(!name||name.length>110)return;
    const p=visibleLineAnchor(f,e,options.labelBounds);if(!p)return;
    const rank=Number(f.properties.rank)||4;
    labels.push({x:p.x/e,y:p.y/e,text:name,kind:'path',rank:Number.isFinite(rank)?rank:4});
  });
  return labels.sort((a,b)=>mapLabelPriority(a)-mapLabelPriority(b)||a.rank-b.rank).slice(0,96);
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
  const flat=Math.SQRT1_2;
  for(let y=0;y<size;y++){
    const latitude=Math.atan(Math.sinh(Math.PI*(1-2*(tileY+(y+.5)/size)/2**z)));
    const metres=40075016.68557849*Math.cos(latitude)/(2**z*size);
    const row=y*size,innerRow=y>0&&y<size-1;
    for(let x=0;x<size;x++){
      const at=row+x,centre=heights[at];
      let left:number|undefined,right:number|undefined,top:number|undefined,bottom:number|undefined,northWest:number|undefined,northEast:number|undefined,southWest:number|undefined,southEast:number|undefined;
      if(innerRow&&x>0&&x<size-1){
        left=heights[at-1];right=heights[at+1];top=heights[at-size];bottom=heights[at+size];
        northWest=heights[at-size-1];northEast=heights[at-size+1];southWest=heights[at+size-1];southEast=heights[at+size+1];
      }else{
        left=elevationAt(heights,size,x-1,y,halo);right=elevationAt(heights,size,x+1,y,halo);top=elevationAt(heights,size,x,y-1,halo);bottom=elevationAt(heights,size,x,y+1,halo);
        northWest=elevationAt(heights,size,x-1,y-1,halo);northEast=elevationAt(heights,size,x+1,y-1,halo);southWest=elevationAt(heights,size,x-1,y+1,halo);southEast=elevationAt(heights,size,x+1,y+1,halo);
      }
      // Horn's measured 3x3 neighbourhood suppresses quantization noise without
      // inventing edge samples. An unavailable derivative remains transparent.
      if(left===undefined||right===undefined||top===undefined||bottom===undefined||northWest===undefined||northEast===undefined||southWest===undefined||southEast===undefined)continue;
      const low=Math.min(centre,left,right,top,bottom,northWest,northEast,southWest,southEast),high=Math.max(centre,left,right,top,bottom,northWest,northEast,southWest,southEast);
      if(!Number.isFinite(low)||!Number.isFinite(high)||low<-12000||high>10000)throw new Error('Invalid relief elevation');
      const dx=(northEast+2*right+southEast-northWest-2*left-southWest)/(metres*8),dy=(southWest+2*bottom+southEast-northWest-2*top-northEast)/(metres*8);
      const xx=dx*dx,yy=dy*dy,slope=xx+yy;
      let illumination=flat;
      if(slope>1e-12){
        // Mark/GDAL multidirectional weights for dx=east and dy=south. Each
        // 225/270/315/360-degree light is clamped BEFORE aspect weighting;
        // averaging fixed light vectors would reduce this to one weak light.
        const diagonal=dx*dy,w225=.5*slope-diagonal,w315=.5*slope+diagonal;
        illumination=(w225*Math.max(0,flat+(dx-dy)*.5)+xx*Math.max(0,flat+dx*flat)+w315*Math.max(0,flat+(dx+dy)*.5)+yy*Math.max(0,flat+dy*flat))/(2*slope*Math.sqrt(1+slope));
      }
      // A small, bounded cue from the local measured curvature separates
      // ridge crests and valley bottoms. It is exactly zero on a plane and
      // never changes heights, physical slopes, or the contour geometry.
      const curvature=(4*centre-left-right-top-bottom)/(4*metres);
      const delta=illumination-flat+Math.max(-.035,Math.min(.035,curvature*.35));
      if(delta===0)continue;
      const pixel=at*4,dark=delta<0;
      pixels[pixel]=dark?45:255;pixels[pixel+1]=dark?60:251;pixels[pixel+2]=dark?54:231;pixels[pixel+3]=Math.min(dark?148:108,Math.abs(delta)*(dark?300:360));
    }
  }
  return pixels;
}

/** Marching squares uses the measured DEM, including interpolated crossing positions. */
export function paintContours(context:PaintContext,heights:Float32Array,gridSize:number,z:number,size=512,options:{lineScale?:number;bounds?:TilePaintBounds;halo?:ReliefHalo;labels?:MapTileLabel[]}={}):number {
  const intervals=reliefContourIntervals(z);if(!intervals)return 0;
  if(!Number.isInteger(gridSize)||gridSize<2||heights.length!==gridSize*gridSize||!Number.isFinite(size)||size<=0)throw new Error('Invalid contour grid');
  const interval=intervals.minorM,scale=size/gridSize,lineScale=options.lineScale??size/512;
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
  const candidates:({score:number;label:MapTileLabel}|undefined)[]=new Array(4);
  let segments=0;
  const segment=(a:number[],b:number[],level:number,index:boolean)=>{
    if(++segments>262144)throw new Error('Contour geometry exceeds the tile budget');context.moveTo(a[0],a[1]);context.lineTo(b[0],b[1]);
    if(!index||!options.labels||z<12)return;
    const x=(a[0]+b[0])/(2*size),y=(a[1]+b[1])/(2*size),u=(x-bounds.left)/(bounds.right-bounds.left),v=(y-bounds.top)/(bounds.bottom-bounds.top);
    if(u<.1||u>.9||v<.1||v>.9)return;
    const column=u<.5?0:1,row=v<.5?0:1,slot=row*2+column,score=(u-(column*.5+.25))**2+(v-(row*.5+.25))**2;
    if(!candidates[slot]||score<candidates[slot]!.score)candidates[slot]={score,label:{x,y,text:`${level} м`,kind:'contour',rank:9,elevation:level}};
  };
  // Two bounded passes avoid retaining a second full contour graph. Major
  // levels are drawn once, on top, with their own width and contrast.
  for(const index of [false,true]){
    const spacing=index?intervals.indexM:interval,before=segments;
    context.strokeStyle=index?'rgba(102,89,62,.56)':z>=12?'rgba(113,102,76,.34)':'rgba(113,102,76,.26)';
    context.lineWidth=lineScale*(index?1.8:1);context.beginPath();
    for(const [y,nextY] of rows)for(const [x,nextX] of columns){
      const points=[[x,y],[nextX,y],[nextX,nextY],[x,nextY]];
      const samples=points.map(([px,py])=>elevationAt(heights,gridSize,px,py,halo));
      if(samples.some(value=>value===undefined))continue;
      const h=samples as number[];
      if(h.some(value=>!Number.isFinite(value)||value<-12000||value>10000))throw new Error('Invalid contour elevation');
      const low=Math.ceil(Math.min(...h)/spacing)*spacing,high=Math.max(...h);
      for(let level=low;level<high;level+=spacing){
        if(!index&&level%intervals.indexM===0)continue;
        const crossings:number[][]=[];
        for(let i=0;i<4;i++){const j=(i+1)%4;if((h[i]>=level)===(h[j]>=level))continue;
          // XYZ DEM samples are pixel centres, not the tile's outer corners.
          const t=(level-h[i])/(h[j]-h[i]);crossings.push([(points[i][0]+(points[j][0]-points[i][0])*t+.5)*scale,(points[i][1]+(points[j][1]-points[i][1])*t+.5)*scale]);}
        if(crossings.length===4){
          const determinant=(h[0]-level)*(h[2]-level)-(h[1]-level)*(h[3]-level);
          if(determinant<0){segment(crossings[0],crossings[3],level,index);segment(crossings[1],crossings[2],level,index);}
          else{segment(crossings[0],crossings[1],level,index);segment(crossings[2],crossings[3],level,index);}
        }else if(crossings.length===2)segment(crossings[0],crossings[1],level,index);
      }
    }
    if(!index||segments>before)context.stroke();
  }
  if(options.labels)for(const candidate of candidates)if(candidate)options.labels.push(candidate.label);
  return segments;
}
