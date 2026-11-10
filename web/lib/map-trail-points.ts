import type {CircleLayerSpecification} from 'maplibre-gl';

type MapCenter=[number,number];
type TrailPointInput={id:string;title:string;center?:[number,number]};
type RegionHint={center:[number,number];bounds?:number[]};

const longitudeDistance=(a:number,b:number)=>Math.min(Math.abs(a-b),Math.abs(a-b-360),Math.abs(a-b+360));
const distanceScore=(point:MapCenter,target:MapCenter)=>{
  const latitudeScale=Math.max(.15,Math.cos(target[1]*Math.PI/180));
  const dx=longitudeDistance(point[0],target[0])*latitudeScale,dy=point[1]-target[1];
  return dx*dx+dy*dy;
};
const insideBounds=(point:MapCenter,bounds?:number[])=>{
  if(!bounds||bounds.length!==4)return false;
  const [west,south,east,north]=bounds;
  return [point[0],point[0]-360,point[0]+360].some(lng=>lng>=west&&lng<=east)&&point[1]>=south&&point[1]<=north;
};
function resolveTrailCenter(center:readonly [number,number],isCovered:(lng:number,lat:number)=>boolean,region?:RegionHint):MapCenter|undefined{
  const direct:MapCenter=[center[0],center[1]],swapped:MapCenter=[center[1],center[0]];
  const candidates=[direct,swapped].filter((point,index,array)=>point.every(Number.isFinite)&&isCovered(point[0],point[1])&&array.findIndex(other=>other[0]===point[0]&&other[1]===point[1])===index);
  if(!candidates.length)return undefined;
  if(candidates.length===1||!region)return candidates[0];
  const bounded=candidates.filter(point=>insideBounds(point,region.bounds)),pool=bounded.length?bounded:candidates;
  return pool.reduce((best,point)=>distanceScore(point,region.center)<distanceScore(best,region.center)?point:best);
}

export type MapTrailPoint = {
  id:string;
  title:string;
  center:[number,number];
  selected:boolean;
};

export function mapTrailPointEntries(
  trails:readonly TrailPointInput[],
  isCovered:(lng:number,lat:number)=>boolean,
  region:RegionHint|undefined,
  selectedId:string|undefined,
):MapTrailPoint[]{
  const result:MapTrailPoint[]=[];
  const seen=new Set<string>();
  for(const trail of trails){
    if(seen.has(trail.id)||!trail.center)continue;
    const center=resolveTrailCenter(trail.center,isCovered,region);
    if(!center)continue;
    seen.add(trail.id);
    result.push({id:trail.id,title:trail.title,center,selected:trail.id===selectedId});
  }
  return result;
}

export function mapTrailPointFeatureCollection(
  trails:readonly TrailPointInput[],
  isCovered:(lng:number,lat:number)=>boolean,
  region:RegionHint|undefined,
  selectedId:string|undefined,
  normalizeLongitude:(lng:number)=>number=(lng=>lng),
):GeoJSON.FeatureCollection<GeoJSON.Point,{id:string;title:string;selected:boolean}>{
  return {
    type:'FeatureCollection',
    features:mapTrailPointEntries(trails,isCovered,region,selectedId).map(item=>({
      type:'Feature',
      geometry:{type:'Point',coordinates:[normalizeLongitude(item.center[0]),item.center[1]]},
      properties:{id:item.id,title:item.title,selected:item.selected},
    })),
  };
}

/** Literal paint lets every point layer share MapLibre's circle shader program.
 * Keep all halos below all dots; selected points sit above unselected points
 * within each role. The final, unsplit layer keeps the same hit geometry. */
export function mapTrailPointLayers(source:string,hitRadius:number):CircleLayerSpecification[]{
  const viewport={'circle-pitch-alignment':'viewport','circle-pitch-scale':'viewport'} as const;
  return [
    {id:'trail-point-halo',type:'circle',source,filter:['!=',['get','selected'],true],paint:{
      'circle-radius':9,'circle-color':'#FFFEFA','circle-opacity':.98,...viewport,
    }},
    {id:'trail-point-halo-selected',type:'circle',source,filter:['==',['get','selected'],true],paint:{
      'circle-radius':11,'circle-color':'#FFFEFA','circle-opacity':.98,...viewport,
    }},
    {id:'trail-point-dot',type:'circle',source,filter:['!=',['get','selected'],true],paint:{
      'circle-radius':6,'circle-color':'#A56736','circle-stroke-color':'#876A43','circle-stroke-width':1,...viewport,
    }},
    {id:'trail-point-dot-selected',type:'circle',source,filter:['==',['get','selected'],true],paint:{
      'circle-radius':7.5,'circle-color':'#244D3C','circle-stroke-color':'#A56736','circle-stroke-width':2,...viewport,
    }},
    {id:'trail-point-hit',type:'circle',source,paint:{
      'circle-radius':hitRadius,'circle-color':'#000000','circle-opacity':.001,'circle-stroke-opacity':0,...viewport,
    }},
  ];
}
