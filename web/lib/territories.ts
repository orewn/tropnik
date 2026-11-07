import data from './territories.generated.json';
import type {Region, Trail} from './content';

/** A geographic selection is independent of an editorial tourism collection. */
export type MapRegion = Omit<Region, 'timezone'> & {
  timezone?: string;
  bounds?: [number, number, number, number];
  territory?: boolean;
  geometryUrls?: string[];
};
type TerritoryRecord = {
  id: string; name: string; shapeNames: string[]; center: number[];
  bounds: number[]; outline: string; geometryUrls: string[];
};
const records = data.territories as TerritoryRecord[];
export const territoryArtwork = new Map(records.map(item => [item.id, item.outline]));
export const territories: MapRegion[] = records.map(item => ({
  id: item.id, name: item.name, shapeNames: item.shapeNames,
  center: item.center as [number, number], bounds: item.bounds as [number, number, number, number],
  zoom: 6, territory: true, geometryUrls: item.geometryUrls,
  caption: 'Карта территории и маршруты каталога.',
  description: 'Маршруты относятся к территории по исходной геометрии или описанию места в источнике. Это не подтверждение проходимости или допуска к выходу.',
  terrain: 'Территория на карте', tint: '#d9e2ce',
})).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
const byId = new Map(territories.map(item => [item.id, item]));
const byShape = new Map<string, MapRegion[]>();
for(const territory of territories)for(const name of territory.shapeNames){
  const list=byShape.get(name)??[];list.push(territory);byShape.set(name,list);
}
const routeMembership = new Map(territories.map(item => [item.id, new Set(item.geometryUrls)]));
export const territoryById = (id: string) => byId.get(id);
export const territoriesForShapes = (names: readonly string[]) => {
  const result=new Map<string,MapRegion>();
  for(const name of names)for(const territory of byShape.get(name)??[])result.set(territory.id,territory);
  return [...result.values()];
};
export const territoryForShape = (name: string) => territoriesForShapes([name])[0];

const longitudeDistance=(a:number,b:number)=>Math.min(Math.abs(a-b),Math.abs(a-b-360),Math.abs(a-b+360));
const containsPoint=(territory:MapRegion,[lng,lat]:readonly [number,number])=>{
  const bounds=territory.bounds;if(!bounds)return false;
  const [west,south,east,north]=bounds;
  return [lng,lng-360,lng+360].some(value=>value>=west&&value<=east)&&lat>=south&&lat<=north;
};
const boundsArea=(territory:MapRegion)=>{
  const bounds=territory.bounds;if(!bounds)return Number.POSITIVE_INFINITY;
  const width=Math.min(Math.abs(bounds[2]-bounds[0]),360-Math.min(360,Math.abs(bounds[2]-bounds[0])));
  return Math.max(.000001,width*Math.abs(bounds[3]-bounds[1])*Math.max(.15,Math.cos(territory.center[1]*Math.PI/180)));
};
const centerDistance=(territory:MapRegion,[lng,lat]:readonly [number,number])=>{
  const dx=longitudeDistance(territory.center[0],lng)*Math.max(.15,Math.cos(lat*Math.PI/180));
  const dy=territory.center[1]-lat;return dx*dx+dy*dy;
};

/** Pick the most specific rendered territory under the pointer. MapLibre may
 * return several overlapping or wrapped features; relying on features[0]
 * makes the result dependent on renderer order. */
export function territoryForMapPoint(shapeNames:readonly string[],point:readonly [number,number]){
  return territoriesForShapes(shapeNames).sort((a,b)=>{
    const inside=Number(containsPoint(b,point))-Number(containsPoint(a,point));
    if(inside)return inside;
    const area=boundsArea(a)-boundsArea(b);if(Math.abs(area)>1e-9)return area;
    const distance=centerDistance(a,point)-centerDistance(b,point);if(Math.abs(distance)>1e-9)return distance;
    return a.id.localeCompare(b.id,'en');
  })[0];
}

export function trailBelongsToRegion(trail: Trail, region: MapRegion) {
  if (trail.regionId === region.id || trail.regionIds?.includes(region.id)) return true;
  if (!region.territory) return false;
  // Reviewed descriptions may locate a trail in an administrative territory
  // even when no line has been acquired. No route coordinate is inferred.
  if (trail.territoryIds?.includes(region.id)) return true;
  // Do not infer a territory from its tourism group: Baikal and Altai span multiple regions.
  return !!trail.geometryUrl && !!routeMembership.get(region.id)?.has(trail.geometryUrl);
}
