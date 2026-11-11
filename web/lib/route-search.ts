import {regions,type Trail} from './content';
import {territories} from './territories';
import {createSearchIndex,type SearchDocument} from './search';

const places=new Map([...regions,...territories].map(region=>[region.id,region.name]));
export function trailSearchDocument(trail:Trail):SearchDocument {
  return {id:trail.id,kind:'route',title:trail.title,description:trail.description,href:`/routes/${trail.id}`,regionName:places.get(trail.regionId),regionId:trail.regionId,distanceKm:trail.distanceKm,distanceNote:trail.distanceNote,duration:trail.duration,accessStatus:trail.accessStatus,missingGeometry:!trail.geometryUrl&&!trail.geometry,keywords:[trail.subtitle,trail.sourceTitle||'',trail.id,...[...(trail.regionIds||[]),...(trail.territoryIds||[])].map(id=>places.get(id)||''),trail.sourceName].join(' '),body:[trail.season,...trail.notes,trail.operatingNotice?.body||'',trail.officialEvidence?.summary||''].join(' ')};
}

/** Build once per catalogue revision so live routes and their updated fields
 * are searched by the same index rules as the reference catalogue. */
export function createRouteSearch(catalog:readonly Trail[]) {
  return createSearchIndex(catalog.map(trailSearchDocument));
}
