import type {StyleSpecification} from 'maplibre-gl';

/** The 2016 vintage is the provider's CC BY 4.0 public, commercial-use layer.
 * Newer annual mosaics require a separate licence and must not be substituted.
 * Source: https://cloudless.eox.at/documentation/faq (checked 2026-11-09). */
export const SATELLITE_SOURCE = 'tropnik-satellite';
export const SATELLITE_TILES = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg';
export const SATELLITE_MAX_ZOOM = 14;
export const SATELLITE_ERROR = 'Спутниковые снимки не загрузились. Показана обычная карта. Повторите выбор в слоях при устойчивой связи.';
export const SATELLITE_OVERVIEW_SOURCE = 'tropnik-satellite-overview';
export const SATELLITE_OVERVIEW_TILES = 'https://tiles.maps.eox.at/wmts/1.0.0/bluemarble_3857/default/g/{z}/{y}/{x}.jpg';
export const SATELLITE_OVERVIEW_MAX_ZOOM = 8;
export type SatelliteSourceId = 'eox-s2' | 'eox-bluemarble';
export type SatelliteBounds = {west:number;south:number;east:number;north:number};

/** Conservative regional fallback envelope, NOT an inferred nodata mask.
 * The provider's opaque 2016 JPEGs contain blank land on both sides of 180°,
 * including Wrangel. See docs/satellite-map.md and its source receipts. */
export const SATELLITE_OVERVIEW_BOUNDS = [176,61,183,72.5] as const;
export const SATELLITE_PROVIDERS = {
  'eox-s2': {source:SATELLITE_SOURCE,tiles:SATELLITE_TILES,maxzoom:SATELLITE_MAX_ZOOM,
    attribution:'EOxCloudless by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016 & 2017), CC BY 4.0'},
  'eox-bluemarble': {source:SATELLITE_OVERVIEW_SOURCE,tiles:SATELLITE_OVERVIEW_TILES,maxzoom:SATELLITE_OVERVIEW_MAX_ZOOM,
    attribution:'NASA Earth Observatory · Blue Marble · EOX::Maps'},
} as const;

/** Accept continuous renderer bounds or a canonical west>east dateline pair.
 * Compare world copies without shifting the map or any rendered geometry. */
export function satelliteSourceForBounds({west,south,east,north}:SatelliteBounds):SatelliteSourceId {
  if(![west,south,east,north].every(Number.isFinite))return 'eox-s2';
  const [problemWest,problemSouth,problemEast,problemNorth]=SATELLITE_OVERVIEW_BOUNDS;
  if(north<problemSouth||south>problemNorth)return 'eox-s2';
  if(east<west)east+=360*Math.ceil((west-east)/360);
  if(east-west>=360)return 'eox-bluemarble';
  const copy=Math.ceil((west-problemEast)/360);
  return problemWest+copy*360<=east?'eox-bluemarble':'eox-s2';
}

/** Replace only the ground drawing. Keep the Russia mask, geographic anchors,
 * paths, roads, labels and selected route above the real satellite imagery. */
export function satelliteStyle(base: StyleSpecification): StyleSpecification {
  const next = structuredClone(base);
  next.name = 'Тропник · спутниковая карта';
  for(const provider of Object.values(SATELLITE_PROVIDERS))next.sources[provider.source] = {type:'raster',tiles:[provider.tiles],tileSize:256,
    minzoom:0,maxzoom:provider.maxzoom,attribution:provider.attribution};
  const retainedFill = new Set(['land', 'overview-land', 'region-fill', 'region-selected', 'russia-outside-mask']);
  next.layers = next.layers.filter(layer =>
    layer.type !== 'raster' && layer.type !== 'hillshade' &&
    (layer.type !== 'fill' || retainedFill.has(layer.id)));
  const ground = next.layers.findIndex(layer => layer.id === 'land' || layer.id === 'overview-land');
  // Hidden sources do not request tiles. The session reveals only the current
  // source, plus a transparent replacement while it loads behind that source.
  next.layers.splice(ground + 1, 0, ...Object.values(SATELLITE_PROVIDERS).map(provider=>({
    id:provider.source,type:'raster' as const,source:provider.source,layout:{visibility:'none' as const},
    paint:{'raster-fade-duration':0,'raster-resampling':'linear' as const,'raster-opacity':0,'raster-opacity-transition':{duration:0}},
  })));
  return next;
}
