import type * as GeoJSON from 'geojson';
import {loadMapCoverage, type MapCoverage} from '../public/maps/map-coverage-lod.js';
import type {TerrainDisplayMask} from '../public/terrain/terrain-renderer.js';

export const TERRAIN_MASK_LIMITS = Object.freeze({size:2048,edges:1_200_000,polygonEdges:180_000,edgeRows:16_000_000});
type Bounds=[number,number,number,number];
type Options={signal?:AbortSignal;width?:number;height?:number;yield?:()=>Promise<void>};
type Edge={x:number;y:number;end:number;dx:number};
const nextTurn=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
const abort=(signal?:AbortSignal)=>{if(signal?.aborted)throw signal.reason??new DOMException('Landscape mask cancelled','AbortError');};
function checkedBounds(value:readonly number[]):Bounds{
  if(value.length!==4||!value.every(Number.isFinite)||value[0]>=value[2]||value[1]>=value[3]||value[2]-value[0]>360||value[1]<-85||value[3]>85)throw new RangeError('Invalid landscape mask bounds');
  return [...value] as Bounds;
}

/** Rasterize the existing excluded geometry, not the elevation grid. Scanline
 * fill is O(edges + active intersections), without point-in-polygon per vertex.
 * Every texel touched by an excluded boundary is also excluded: even subpixel
 * holes cannot leak foreign terrain through a centre-only coverage test. */
export async function rasterizeTerrainExclusions(geometry:GeoJSON.FeatureCollection,bounds:readonly number[],options:Options={}):Promise<Uint8Array>{
  const b=checkedBounds(bounds),width=options.width??TERRAIN_MASK_LIMITS.size,height=options.height??TERRAIN_MASK_LIMITS.size;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<2||height<2||width>TERRAIN_MASK_LIMITS.size||height>TERRAIN_MASK_LIMITS.size)throw new RangeError('Landscape mask pixel budget exceeded');
  if(geometry?.type!=='FeatureCollection'||!Array.isArray(geometry.features))throw new TypeError('Invalid landscape exclusion geometry');
  abort(options.signal);const pixels=new Uint8Array(width*height);pixels.fill(255);
  const yieldControl=options.yield??nextTurn;let edges=0,work=0,sinceYield=0;
  const checkpoint=async(amount=1)=>{work+=amount;sinceYield+=amount;if(work>TERRAIN_MASK_LIMITS.edgeRows)throw new RangeError('Landscape mask work budget exceeded');if(sinceYield>=4096){sinceYield=0;abort(options.signal);await yieldControl();abort(options.signal);}};
  const clearSpan=(row:number,left:number,right:number)=>{
    if(row<0||row>=height||right<0||left>width)return;
    // Include both cells when the real boundary lies on an integer grid line.
    const start=Math.max(0,Math.floor(left)-(Math.abs(left-Math.round(left))<1e-8?1:0));
    const end=Math.min(width,Math.floor(right)+1);if(end>start)pixels.fill(0,row*width+start,row*width+end);
  };
  const boundary=async(ax:number,ay:number,bx:number,by:number)=>{
    const dy=by-ay,low=Math.min(ay,by),high=Math.max(ay,by);
    if(high<0||low>height||Math.max(ax,bx)<0||Math.min(ax,bx)>width)return;
    const first=Math.max(0,Math.floor(low)-(Math.abs(low-Math.round(low))<1e-8?1:0)),last=Math.min(height-1,Math.floor(high));
    for(let row=first;row<=last;row++){
      if(!dy)clearSpan(row,Math.min(ax,bx),Math.max(ax,bx));
      else{
        const t0=Math.max(0,Math.min(1,(row-ay)/dy)),t1=Math.max(0,Math.min(1,(row+1-ay)/dy));
        const x0=ax+(bx-ax)*t0,x1=ax+(bx-ax)*t1;clearSpan(row,Math.min(x0,x1),Math.max(x0,x1));
      }
      await checkpoint();
    }
  };
  for(const feature of geometry.features){
    abort(options.signal);const g=feature?.geometry;if(!g)throw new TypeError('Missing landscape exclusion geometry');
    if(g.type!=='Polygon'&&g.type!=='MultiPolygon')throw new TypeError('Landscape mask requires polygons');
    const polygons=g.type==='Polygon'?[g.coordinates]:g.coordinates;
    const explicitShift=feature.properties?.terrainWorldShift;
    if(explicitShift!==undefined&&(!Number.isFinite(explicitShift)||explicitShift%360!==0))throw new TypeError('Invalid landscape mask world copy');
    for(const polygon of polygons){
      const buckets:Array<Edge[]|undefined>=new Array(height);let first=height,last=-1,polygonEdges=0;
      for(const ring of polygon){
        if(ring.length<4)throw new TypeError('Invalid landscape mask ring');
        let reference=(b[0]+b[2])/2,previous:[number,number]|undefined,initial:[number,number]|undefined;
        for(let index=0;index<ring.length;index++){
          const position=ring[index];if(position.length<2||!Number.isFinite(position[0])||!Number.isFinite(position[1])||Math.abs(position[1])>85.05113)throw new TypeError('Invalid landscape mask coordinate');
          const lon=explicitShift===undefined?position[0]+360*Math.round((reference-position[0])/360):position[0]+explicitShift;reference=lon;
          const point:[number,number]=[(lon-b[0])/(b[2]-b[0])*width,(b[3]-position[1])/(b[3]-b[1])*height];
          if(!initial)initial=point;
          if(previous){
            if(++edges>TERRAIN_MASK_LIMITS.edges||++polygonEdges>TERRAIN_MASK_LIMITS.polygonEdges)throw new RangeError('Landscape mask geometry budget exceeded');
            const [ax,ay]=previous,[bx,by]=point;
            await boundary(ax,ay,bx,by);
            if(ay!==by){
              const start=Math.max(0,Math.ceil(Math.min(ay,by)-.5)),end=Math.min(height-1,Math.ceil(Math.max(ay,by)-.5)-1);
              if(start<=end){const dx=(bx-ax)/(by-ay),edge={x:ax+(start+.5-ay)*dx,y:start,end,dx};(buckets[start]??=[]).push(edge);first=Math.min(first,start);last=Math.max(last,end);}
            }
            await checkpoint();
          }
          previous=point;
        }
        if(!initial||!previous||Math.abs(initial[0]-previous[0])>1e-6||Math.abs(initial[1]-previous[1])>1e-6)throw new TypeError('Unclosed landscape mask ring');
      }
      let active:Edge[]=[];
      for(let row=first;row<=last;row++){
        active=active.filter(edge=>edge.end>=row);if(buckets[row])for(const edge of buckets[row]!)active.push(edge);
        const crossings=active.map(edge=>edge.x+(row-edge.y)*edge.dx).sort((a,b)=>a-b);
        if(crossings.length%2)throw new TypeError('Invalid landscape mask topology');
        for(let index=0;index<crossings.length;index+=2){
          const start=Math.max(0,Math.ceil(crossings[index]-.5)),end=Math.min(width,Math.ceil(crossings[index+1]-.5));
          if(end>start)pixels.fill(0,row*width+start,row*width+end);
        }
        await checkpoint(Math.max(1,active.length));
      }
    }
  }
  abort(options.signal);return pixels;
}

function visibleCells(coverage:MapCoverage,bounds:Bounds){
  const result:Array<{id:string;bounds:Bounds;shift:number}>=[];
  for(const cell of coverage.manifest.cells){
    const centre=(bounds[0]+bounds[2])/2,baseShift=360*Math.round((centre-(cell.bounds[0]+cell.bounds[2])/2)/360);
    for(const shift of [baseShift-360,baseShift,baseShift+360]){
      const b:Bounds=[cell.bounds[0]+shift,cell.bounds[1],cell.bounds[2]+shift,cell.bounds[3]];
      if(b[2]<=bounds[0]||b[0]>=bounds[2]||b[3]<=bounds[1]||b[1]>=bounds[3])continue;
      result.push({id:cell.id,bounds:b,shift});
    }
  }
  // Prove the descriptors cover the complete rectangle before defaulting any
  // texel to allowed. A missing cell must fail closed, never expose a rectangle.
  const xs=[...new Set([bounds[0],bounds[2],...result.flatMap(cell=>[Math.max(bounds[0],cell.bounds[0]),Math.min(bounds[2],cell.bounds[2])])])].sort((a,b)=>a-b);
  for(let index=1;index<xs.length;index++){
    const x=(xs[index-1]+xs[index])/2,intervals=result.filter(cell=>cell.bounds[0]<=x&&cell.bounds[2]>=x).map(cell=>[cell.bounds[1],cell.bounds[3]]).sort((a,b)=>a[0]-b[0]);
    let north=bounds[1];for(const [south,end] of intervals){if(south>north+1e-8)break;north=Math.max(north,end);}if(north<bounds[3]-1e-8)throw new Error('Landscape mask coverage is incomplete');
  }
  if(!result.length)throw new Error('Landscape mask coverage is incomplete');return result;
}

export async function createRussiaTerrainMask(bounds:readonly number[],options:Options&{loadCoverage?:()=>Promise<MapCoverage>}={}):Promise<TerrainDisplayMask>{
  const b=checkedBounds(bounds);abort(options.signal);const cleanup:Array<()=>void>=[];
  const loadCoverage=options.loadCoverage??(()=>loadMapCoverage({fetch:((input,init={})=>{
    const controller=new AbortController(),signals=[options.signal,init.signal].filter((value):value is AbortSignal=>!!value);
    for(const signal of signals){const cancel=()=>controller.abort(signal.reason);if(signal.aborted)cancel();else{signal.addEventListener('abort',cancel,{once:true});cleanup.push(()=>signal.removeEventListener('abort',cancel));}}
    return fetch(input,{...init,signal:controller.signal});
  }) as typeof fetch}));
  let coverage:MapCoverage|undefined;
  try{
    coverage=await loadCoverage();abort(options.signal);
    const width=options.width??TERRAIN_MASK_LIMITS.size,height=options.height??TERRAIN_MASK_LIMITS.size;
    const zoom=Math.max(0,Math.min(18,Math.floor(Math.log2(width*360/((b[2]-b[0])*256)))));
    await coverage.updateView(b,zoom);abort(options.signal);
    if(!coverage.status.ready||coverage.status.error||coverage.status.pending)throw new Error('Landscape mask source is unavailable');
    const cells=visibleCells(coverage,b),features:GeoJSON.Feature[]=[];
    for(const cell of cells){
      const source=coverage.cellFeatures.get(cell.id);
      if(!source?.length)throw new Error('Landscape mask cell is unavailable');
      for(const feature of source)if(feature.properties?.role==='mask')features.push({...feature,properties:{...feature.properties,terrainWorldShift:cell.shift}});
    }
    const pixels=await rasterizeTerrainExclusions({type:'FeatureCollection',features},b,{...options,width,height});
    let allowedPixels=0;for(const pixel of pixels)if(pixel)allowedPixels++;
    return{width,height,pixels,source:{scope:'russia-display-area',coverageVersion:coverage.version,lod:coverage.status.lod,cells:[...new Set(cells.map(cell=>cell.id))],bounds:b,
      projection:'regular-longitude-latitude',sampleLayout:'pixel-cells',rowOrder:'north-to-south',columnOrder:'west-to-east',boundaryRule:'exclude-intersecting-texels',allowedPixels}};
  }finally{coverage?.dispose();for(const dispose of cleanup)dispose();}
}
