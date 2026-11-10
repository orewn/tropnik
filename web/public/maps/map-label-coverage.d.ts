import type {Map,StyleSpecification} from 'maplibre-gl';

export const MAP_LABEL_SOURCE: 'tropnik-covered-labels';
export function withMapLabelCoverage(style: StyleSpecification): StyleSpecification;
export function bindMapLabelCoverage(map: Map, coverage: GeoJSON.GeoJSON | {area:GeoJSON.GeoJSON}, environment?: {
  defer?: (callback:()=>void)=>ReturnType<typeof setTimeout>;
  cancelDefer?: (id:ReturnType<typeof setTimeout>)=>void;
}): ()=>void;
