import {labelGeometryInCoverage} from './map-label-geometry.js';
import {displayGeoJSON} from './russia-viewport.js';

export const MAP_LABEL_SOURCE = 'tropnik-covered-labels';
const LABEL_GROUP = '__tropnik_label_group';
const LABEL_ORIGIN = 'tropnik:label-origin';
const EMPTY = {type:'FeatureCollection',features:[]};
const MAX_GEOMETRY_CACHE = 4096;

function originFor(layer, sources) {
  const previous = layer.metadata?.[LABEL_ORIGIN];
  if (previous && typeof previous.source === 'string' && typeof previous.key === 'string') return previous;
  const source = layer.source, type = sources[source]?.type;
  if (typeof source !== 'string' || source === MAP_LABEL_SOURCE || (type !== 'vector' && type !== 'geojson')) return;
  const sourceLayer = typeof layer['source-layer'] === 'string' ? layer['source-layer'] : undefined;
  return {source, ...(sourceLayer ? {sourceLayer} : {}), key:JSON.stringify([source,sourceLayer ?? null])};
}

/** Keep each basemap label's styling and collision rules, but give the labels
 * one already-filtered source above the country mask. Until the binder has
 * checked the loaded features, the empty source displays no unverified text. */
export function withMapLabelCoverage(style) {
  const mask = style.layers.find(layer => layer.id === 'russia-outside-mask');
  if (!mask) return style;
  const sources = style.sources ?? {}, symbols = [], ground = [];
  for (const layer of style.layers) {
    if (layer.type !== 'symbol') {ground.push(layer); continue;}
    const origin = originFor(layer, sources);
    if (!origin) continue;
    if (layer.source === MAP_LABEL_SOURCE && layer.metadata?.[LABEL_ORIGIN]) {symbols.push(layer); continue;}
    const rest = {...layer};
    delete rest['source-layer'];
    symbols.push({...rest, source:MAP_LABEL_SOURCE,
      metadata:{...layer.metadata,[LABEL_ORIGIN]:{...origin,filter:layer.filter ?? null}},
      filter:['all',['==',['get',LABEL_GROUP],origin.key],...(layer.filter ? [layer.filter] : [])]});
  }
  ground.splice(ground.findIndex(layer => layer.id === mask.id) + 1, 0, ...symbols);
  return {...style, sources:{...sources,[MAP_LABEL_SOURCE]:{type:'geojson',data:EMPTY,tolerance:0,buffer:128,maxzoom:18}},layers:ground};
}

function referencedProperties(value, result) {
  if (!Array.isArray(value)) return;
  if ((value[0] === 'get' || value[0] === 'has') && typeof value[1] === 'string') result.add(value[1]);
  for (const child of value) referencedProperties(child, result);
}

function sourceGroups(style) {
  const groups = new Map();
  for (const layer of style?.layers ?? []) {
    const origin = layer.metadata?.[LABEL_ORIGIN];
    if (layer.type !== 'symbol' || layer.source !== MAP_LABEL_SOURCE || !origin || typeof origin.source !== 'string' || typeof origin.key !== 'string') continue;
    let group = groups.get(origin.key);
    if (!group) {group = {...origin,properties:new Set(),layers:[]};groups.set(origin.key,group);}
    group.layers.push({min:layer.minzoom ?? 0,max:layer.maxzoom ?? 24,filter:origin.filter ?? undefined});
    referencedProperties(layer.filter,group.properties);
    for (const value of Object.values(layer.layout ?? {})) referencedProperties(value,group.properties);
    for (const value of Object.values(layer.paint ?? {})) referencedProperties(value,group.properties);
  }
  return [...groups.values()].map(group => ({...group,properties:[...group.properties].sort()}));
}

/** Read only existing tiles. No fetches, renderer internals or camera changes.
 * Original source events and settled navigation schedule one bounded refresh;
 * the overlay's own source events can never start a refresh loop. */
export function bindMapLabelCoverage(map, coverage, environment = {}) {
  const area = coverage?.area ?? coverage;
  const defer = environment.defer ?? (callback => setTimeout(callback,48));
  const cancelDefer = environment.cancelDefer ?? clearTimeout;
  let disposed = false, timer, revision = 0, groups = [], sourceIds = new Set(), previousKeys;
  const geometryCache = new Map();

  const allowed = (geometry, key) => {
    if (geometryCache.has(key)) return geometryCache.get(key);
    const value = labelGeometryInCoverage(geometry,area);
    geometryCache.set(key,value);
    while (geometryCache.size > MAX_GEOMETRY_CACHE) geometryCache.delete(geometryCache.keys().next().value);
    return value;
  };

  const refresh = () => {
    if (disposed || map.isMoving?.()) return;
    const source = map.getSource(MAP_LABEL_SOURCE);
    if (!source || typeof source.setData !== 'function') return;
    const zoom = map.getZoom?.();
    const candidates = new Map();
    for (const group of groups) {
      const active = group.layers.filter(layer => !Number.isFinite(zoom) || zoom >= layer.min && zoom < layer.max);
      if (!active.length) continue;
      if (!map.getSource(group.source)) continue;
      let features;
      const filters = active.map(layer => layer.filter);
      const filter = filters.some(value => !value) ? undefined : filters.length === 1 ? filters[0] : ['any',...filters];
      const query = {...(group.sourceLayer ? {sourceLayer:group.sourceLayer} : {}),...(filter ? {filter} : {})};
      try {features = map.querySourceFeatures(group.source,query);} catch {continue;}
      for (const feature of features) {
        const rawGeometry = feature.geometry;
        if (!rawGeometry) continue;
        const geometryKey = JSON.stringify(rawGeometry);
        if (!allowed(rawGeometry,geometryKey)) continue;
        // Source queries can return canonical or repeated-world coordinates.
        // Keep Chukotka's short antimeridian lines continuous when retiled as
        // GeoJSON; do not turn a verified 179..181 segment into 179..-179.
        const geometry = displayGeoJSON(rawGeometry);
        const properties = {[LABEL_GROUP]:group.key};
        // Tiles carry many translations. Keep the fields actually referenced
        // by the preserved filters and label paint/layout expressions.
        for (const key of group.properties) {
          if (key !== LABEL_GROUP && Object.prototype.hasOwnProperty.call(feature.properties ?? {},key)) properties[key] = feature.properties[key];
        }
        const id = typeof feature.id === 'string' || typeof feature.id === 'number' ? feature.id : undefined;
        const fingerprint = JSON.stringify([group.key,id ?? null,properties,geometry]);
        // Tile-local IDs can repeat for unrelated anchors. Deduplicate only
        // identical normalized features; the normal collision rules handle
        // parent/child copies with slightly different quantized coordinates.
        candidates.set(fingerprint,{fingerprint,feature:{type:'Feature',...(id !== undefined ? {id} : {}),properties,geometry}});
      }
    }
    const entries = [...candidates.values()].sort((a,b) => a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0);
    const keys = entries.map(entry => entry.fingerprint);
    if (previousKeys && keys.length === previousKeys.length && keys.every((key,index) => key === previousKeys[index])) return;
    previousKeys = keys;
    source.setData({type:'FeatureCollection',features:entries.map(entry => entry.feature)});
  };

  const schedule = () => {
    if (disposed || timer !== undefined) return;
    const current = revision;
    timer = defer(() => {
      if (disposed || current !== revision) return;
      timer = undefined;
      refresh();
    });
  };
  const styleLoaded = () => {
    revision++;
    if (timer !== undefined) cancelDefer(timer);
    timer = undefined; previousKeys = undefined;
    groups = sourceGroups(map.getStyle?.());
    sourceIds = new Set(groups.map(group => group.source));
    schedule();
  };
  const sourceLoaded = event => {
    if (sourceIds.has(event.sourceId) && (event.sourceDataType === 'content' || event.isSourceLoaded)) schedule();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true; revision++;
    if (timer !== undefined) cancelDefer(timer);
    timer = undefined; geometryCache.clear(); groups = []; sourceIds.clear(); previousKeys = [];
    map.off('style.load',styleLoaded);map.off('sourcedata',sourceLoaded);map.off('moveend',schedule);map.off('remove',dispose);
  };
  map.on('style.load',styleLoaded);map.on('sourcedata',sourceLoaded);map.on('moveend',schedule);map.on('remove',dispose);
  styleLoaded();
  return dispose;
}
