import type {Map as GLMap} from 'maplibre-gl';
import type {Map as CanvasMap,Canvas,CanvasOptions,GeoJSON,PathOptions,Polyline,Polygon,Layer} from 'leaflet';
import type {Feature} from 'geojson';
import type {MapCoverage} from './map-coverage-lod.js';
export function createMapLibreCoverage(map:GLMap):{apply(coverage:MapCoverage):Promise<void>|undefined;destroy():void};
export function createCanvasCoverage(L:typeof import('leaflet'),map:CanvasMap,options?:{
 renderer?:(options:CanvasOptions)=>Canvas;cull?:(renderer:Canvas)=>(layer:Polyline|Polygon)=>void;
 territoryStyle?:(feature?:Feature)=>PathOptions;
 onTerritory?:(feature:Feature,layer:Layer)=>void;
}):{apply(coverage:MapCoverage):void;territories:GeoJSON;restyle():void;destroy():void};
