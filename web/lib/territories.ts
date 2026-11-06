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
const byShape = new Map(territories.flatMap(item => item.shapeNames.map(name => [name, item] as const)));
const routeMembership = new Map(territories.map(item => [item.id, new Set(item.geometryUrls)]));
export const territoryById = (id: string) => byId.get(id);
export const territoryForShape = (name: string) => byShape.get(name);

export function trailBelongsToRegion(trail: Trail, region: MapRegion) {
  if (trail.regionId === region.id || trail.regionIds?.includes(region.id)) return true;
  if (!region.territory) return false;
  // Reviewed descriptions may locate a trail in an administrative territory
  // even when no line has been acquired. No route coordinate is inferred.
  if (trail.territoryIds?.includes(region.id)) return true;
  // Do not infer a territory from its tourism group: Baikal and Altai span multiple regions.
  return !!trail.geometryUrl && !!routeMembership.get(region.id)?.has(trail.geometryUrl);
}
