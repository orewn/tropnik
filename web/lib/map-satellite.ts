import type {StyleSpecification} from 'maplibre-gl';

/** The 2016 vintage is the provider's CC BY 4.0 public, commercial-use layer.
 * Newer annual mosaics require a separate licence and must not be substituted.
 * Source: https://cloudless.eox.at/documentation/faq (checked 2026-11-09). */
export const SATELLITE_SOURCE = 'tropnik-satellite';
export const SATELLITE_TILES = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg';
export const SATELLITE_MAX_ZOOM = 14;
export const SATELLITE_ERROR = 'Спутниковые снимки не загрузились. Показана обычная карта. Повторите выбор в слоях при устойчивой связи.';

/** Replace only the ground drawing. Keep the Russia mask, geographic anchors,
 * paths, roads, labels and selected route above the real satellite imagery. */
export function satelliteStyle(base: StyleSpecification): StyleSpecification {
  const next = structuredClone(base);
  next.name = 'Тропник · спутниковая карта';
  next.sources[SATELLITE_SOURCE] = {type: 'raster', tiles: [SATELLITE_TILES], tileSize: 256,
    minzoom: 0, maxzoom: SATELLITE_MAX_ZOOM,
    attribution: 'EOxCloudless by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016 & 2017), CC BY 4.0'};
  const retainedFill = new Set(['land', 'overview-land', 'region-fill', 'region-selected', 'russia-outside-mask']);
  next.layers = next.layers.filter(layer =>
    layer.type !== 'raster' && layer.type !== 'hillshade' &&
    (layer.type !== 'fill' || retainedFill.has(layer.id)));
  const ground = next.layers.findIndex(layer => layer.id === 'land' || layer.id === 'overview-land');
  next.layers.splice(ground + 1, 0, {id: SATELLITE_SOURCE, type: 'raster', source: SATELLITE_SOURCE,
    paint: {'raster-fade-duration': 0, 'raster-resampling': 'linear'}});
  return next;
}
