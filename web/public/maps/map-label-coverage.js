import {labelGeometryInCoverage} from './map-label-geometry.js';
import {displayGeoJSON} from './russia-viewport.js';

export const MAP_LABEL_SOURCE = 'tropnik-covered-labels';
const LABEL_GROUP = '__tropnik_label_group';
const LABEL_ORIGIN = 'tropnik:label-origin';
const EMPTY = {type:'FeatureCollection',features:[]};
const MAX_GEOMETRY_CACHE = 4096;


export const MAP_LABEL_DIAGNOSTIC_EVENT = 'tropnik:inspect-map-labels';
const LABEL_DIAGNOSTIC_LIMIT = 100;
const LABEL_DIAGNOSTIC_PROPERTIES = ['class','name','name:ru','name:latin','rank','osm_id','osm_type','place_id','feature_id','wikidata','ref',LABEL_GROUP];

/** Explicit, read-only inspection for the native browser audit. Nothing is
 * polled or retained. Layer IDs must refer to this map's covered place labels;
 * filters, counts and returned tile metadata are observations, not a promise
 * that tile-local feature IDs identify the same real place across zooms. */
export function inspectMapLabels(map, request) {
  const result={schemaVersion:1,readOnly:true,idScope:'not-established',tileMetadata:'observed-optional',limit:LABEL_DIAGNOSTIC_LIMIT};
  try {
    if(request?.schemaVersion!==1||!Array.isArray(request.layerIds)||!request.layerIds.length||request.layerIds.length>16
      ||!request.layerIds.every(id=>typeof id==='string'&&id.length>0&&id.length<=128)
      ||!Array.isArray(request.names)||!request.names.length||request.names.length>8
      ||!request.names.every(name=>typeof name==='string'&&name.length>0&&name.length<=128)
      ||!Number.isInteger(request.limit)||request.limit<1||request.limit>LABEL_DIAGNOSTIC_LIMIT)throw new Error('Invalid bounded label inspection');
    result.limit=request.limit;
    const style=map.getStyle(),byId=new Map((style.layers??[]).map(layer=>[layer.id,layer]));
    const layers=[...new Set(request.layerIds)].map(id=>byId.get(id));
    if(layers.some(layer=>layer?.type!=='symbol'||layer.source!==MAP_LABEL_SOURCE||layer.metadata?.[LABEL_ORIGIN]?.sourceLayer!=='place'))throw new Error('Only covered place-label layers may be inspected');
    const camera=()=>{const center=map.getCenter();return{longitude:center.lng,latitude:center.lat,zoom:map.getZoom(),bearing:map.getBearing(),pitch:map.getPitch()};};
    const before=camera(),names=[...new Set(request.names)],nameFilter=['in',['coalesce',['get','name:ru'],['get','name'],['get','name:latin'],''],['literal',names]];
    Object.assign(result,{names,layerIds:layers.map(layer=>layer.id),before});
    result.layers=layers.map(layer=>({id:layer.id,minzoom:layer.minzoom??0,maxzoom:layer.maxzoom??24,
      origin:structuredClone(layer.metadata[LABEL_ORIGIN]),layout:Object.fromEntries(['text-field','text-variable-anchor','text-anchor','text-padding','text-radial-offset','text-allow-overlap','text-ignore-placement','symbol-avoid-edges'].filter(key=>Object.hasOwn(layer.layout??{},key)).map(key=>[key,structuredClone(layer.layout[key])]))}));
    const snapshot=features=>{
      const points=features.filter(feature=>feature.geometry?.type==='Point');
      return{total:features.length,pointCount:points.length,truncated:points.length>request.limit,features:points.slice(0,request.limit).map(feature=>{
        const coordinates=feature.geometry.coordinates.slice(0,2),projected=map.project(coordinates),properties={};
        for(const key of LABEL_DIAGNOSTIC_PROPERTIES){const value=feature.properties?.[key];if(typeof value==='number'&&Number.isFinite(value)||typeof value==='string')properties[key]=typeof value==='string'?value.slice(0,256):value;}
        const tile=feature.tile,validTile=tile&&['z','x','y'].every(key=>Number.isInteger(tile[key]))&&tile.z>=0&&tile.z<=24&&tile.x>=0&&tile.x<2**tile.z&&tile.y>=0&&tile.y<2**tile.z;
        return{id:typeof feature.id==='number'?feature.id:typeof feature.id==='string'?feature.id.slice(0,128):null,idTruncated:typeof feature.id==='string'&&feature.id.length>128,idSafe:typeof feature.id==='number'?Number.isSafeInteger(feature.id):typeof feature.id==='string',
          ...(feature.layer?.id?{layerId:feature.layer.id}:{}),coordinates,screen:{x:projected.x,y:projected.y},
          observedTile:validTile?{z:tile.z,x:tile.x,y:tile.y}:null,properties,propertyKeys:Object.keys(feature.properties??{}).sort().slice(0,40).map(key=>key.slice(0,128))};
      })};
    };
    const groups=new Map();
    for(const layer of layers){
      if(before.zoom<(layer.minzoom??0)||before.zoom>=(layer.maxzoom??24))continue;
      const origin=layer.metadata[LABEL_ORIGIN];let group=groups.get(origin.key);
      if(!group){group={source:origin.source,sourceLayer:origin.sourceLayer,filters:[]};groups.set(origin.key,group);}group.filters.push(origin.filter);
    }
    result.sources=[...groups.values()].map(group=>{
      const filter=group.filters.some(value=>!value)?nameFilter:['all',nameFilter,['any',...group.filters]];
      return{source:group.source,sourceLayer:group.sourceLayer,filter,...snapshot(map.querySourceFeatures(group.source,{sourceLayer:group.sourceLayer,filter}))};
    });
    const overlayFilter=['all',nameFilter,['in',['get',LABEL_GROUP],['literal',[...new Set(layers.map(layer=>layer.metadata[LABEL_ORIGIN].key))]]]];
    result.overlay={source:MAP_LABEL_SOURCE,filter:overlayFilter,...snapshot(map.querySourceFeatures(MAP_LABEL_SOURCE,{filter:overlayFilter}))};
    result.rendered={layerIds:layers.map(layer=>layer.id),filter:nameFilter,...snapshot(map.queryRenderedFeatures({layers:layers.map(layer=>layer.id),filter:nameFilter}))};
    result.after=camera();result.cameraPreserved=JSON.stringify(result.before)===JSON.stringify(result.after);
  } catch(error) {result.error=error?.message??String(error);}
  return result;
}

function bindMapLabelInspection(map) {
  const container=map.getContainer?.();
  if(!container?.addEventListener)return()=>{};
  const inspect=event=>{const detail=event.detail;if(!detail||typeof detail!=='object'||!Object.isExtensible(detail))return;detail.result=inspectMapLabels(map,detail.request);};
  container.addEventListener(MAP_LABEL_DIAGNOSTIC_EVENT,inspect);
  return()=>container.removeEventListener(MAP_LABEL_DIAGNOSTIC_EVENT,inspect);
}

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
  let area = coverage?.area ?? coverage;
  const defer = environment.defer ?? (callback => setTimeout(callback,48));
  const cancelDefer = environment.cancelDefer ?? clearTimeout;
  let disposed = false, timer, revision = 0, groups = [], sourceIds = new Set(), previousKeys;
  const geometryCache = new Map();
  const unbindInspection = bindMapLabelInspection(map);

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
  const unsubscribeCoverage = coverage?.subscribe?.(() => {
    if (coverage.area === area) return;
    area = coverage.area;geometryCache.clear();previousKeys = undefined;schedule();
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true; revision++;
    if (timer !== undefined) cancelDefer(timer);
    timer = undefined; geometryCache.clear(); groups = []; sourceIds.clear(); previousKeys = [];
    unsubscribeCoverage?.();unbindInspection();
    map.off('style.load',styleLoaded);map.off('sourcedata',sourceLoaded);map.off('moveend',schedule);map.off('remove',dispose);
  };
  map.on('style.load',styleLoaded);map.on('sourcedata',sourceLoaded);map.on('moveend',schedule);map.on('remove',dispose);
  styleLoaded();
  return dispose;
}
