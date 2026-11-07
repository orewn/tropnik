export type MapCenter = [number, number];
type RegionHint = {center: [number, number]; bounds?: number[]};

const longitudeDistance = (a:number,b:number) => Math.min(Math.abs(a-b),Math.abs(a-b-360),Math.abs(a-b+360));
const distanceScore = (point:MapCenter,target:MapCenter) => {
  const latitudeScale=Math.max(.15,Math.cos(target[1]*Math.PI/180));
  const dx=longitudeDistance(point[0],target[0])*latitudeScale;
  const dy=point[1]-target[1];
  return dx*dx+dy*dy;
};
const insideBounds=(point:MapCenter,bounds?:number[]) => {
  if(!bounds||bounds.length!==4)return false;
  const [west,south,east,north]=bounds;
  return [point[0],point[0]-360,point[0]+360].some(lng=>lng>=west&&lng<=east)&&point[1]>=south&&point[1]<=north;
};

/**
 * Route imports may contain GeoJSON [longitude, latitude] or human-facing
 * [latitude, longitude] centres. Resolve the display point once at the map
 * boundary. When both orders are geographically possible, the selected
 * territory bounds and centre decide; no route geometry is invented.
 */
export function resolveTrailCenter(
  center:readonly [number,number],
  isCovered:(lng:number,lat:number)=>boolean,
  region?:RegionHint,
):MapCenter|undefined{
  const direct:MapCenter=[center[0],center[1]],swapped:MapCenter=[center[1],center[0]];
  const candidates=[direct,swapped].filter((point,index,array)=>
    point.every(Number.isFinite)&&isCovered(point[0],point[1])&&
    array.findIndex(other=>other[0]===point[0]&&other[1]===point[1])===index);
  if(!candidates.length)return undefined;
  if(candidates.length===1||!region)return candidates[0];
  const bounded=candidates.filter(point=>insideBounds(point,region.bounds));
  const pool=bounded.length?bounded:candidates;
  return pool.reduce((best,point)=>distanceScore(point,region.center)<distanceScore(best,region.center)?point:best);
}
