import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {withMapLabelCoverage,bindMapLabelCoverage,MAP_LABEL_SOURCE} from '../public/maps/map-label-coverage.js';

const require = createRequire(import.meta.url);
const {featureFilter,validateStyleMin} = createRequire(require.resolve('maplibre-gl/package.json'))('@maplibre/maplibre-gl-style-spec');
const read = path => JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'));
const shipped = read('../public/maps/tropa-style.json');
const russia = read('../public/data/russia-display-area.geojson');
const rectangle = {type:'Polygon',coordinates:[[[10,50],[20,50],[20,60],[10,60],[10,50]]]};
const withHole = {type:'Polygon',coordinates:[...rectangle.coordinates,[[14,54],[16,54],[16,56],[14,56],[14,54]]]};
const point = (id,coordinates,properties = {}) => ({type:'Feature',id,geometry:{type:'Point',coordinates},properties});
const line = (id,coordinates,properties = {}) => ({type:'Feature',id,geometry:{type:'LineString',coordinates},properties});
const keyFor = (source,layer) => JSON.stringify([source,layer ?? null]);
const matches = (filter,feature,zoom) => !filter || featureFilter(filter,'layers.labels.filter').filter({zoom},{
  id:feature.id,properties:feature.properties,
  type:{Point:1,MultiPoint:1,LineString:2,MultiLineString:2,Polygon:3,MultiPolygon:3}[feature.geometry.type],
});

function harness(style = withMapLabelCoverage(shipped),features = {},initialZoom = 14) {
  const handlers = new Map(), timers = new Map(), canceled = [], writes = [], queries = [];
  let nextTimer = 0, currentStyle = style, zoom = initialZoom, moving = false;
  const emit = (type,event = {}) => {for (const callback of handlers.get(type) ?? []) callback(event);};
  const sources = new Map();
  const installSources = () => {
    sources.clear();
    for (const [id,spec] of Object.entries(currentStyle.sources ?? {})) {
      sources.set(id,{...spec,setData(data){this.data=data;writes.push(data);emit('sourcedata',{sourceId:id,sourceDataType:'content',isSourceLoaded:true});}});
    }
  };
  installSources();
  const map = {
    on(type,callback){let listeners=handlers.get(type);if(!listeners){listeners=new Set();handlers.set(type,listeners);}listeners.add(callback);return this;},
    off(type,callback){handlers.get(type)?.delete(callback);return this;},
    getStyle:()=>currentStyle,
    getSource:id=>sources.get(id),
    getZoom:()=>zoom,
    isMoving:()=>moving,
    querySourceFeatures(source,query){
      const input=features[keyFor(source,query.sourceLayer)] ?? [];
      const output=input.filter(feature=>matches(query.filter,feature,zoom));
      queries.push({source,query,count:output.length});return output;
    },
  };
  const environment = {
    defer(callback){const id=++nextTimer;timers.set(id,callback);return id;},
    cancelDefer(id){const callback=timers.get(id);if(callback)canceled.push(callback);timers.delete(id);},
  };
  return {
    map,environment,emit,writes,queries,features,canceled,
    get pending(){return timers.size;},
    get listeners(){return [...handlers.values()].reduce((count,listeners)=>count+listeners.size,0);},
    flush(){const callbacks=[...timers.values()];timers.clear();callbacks.forEach(callback=>callback());},
    setZoom(value){zoom=value;},setMoving(value){moving=value;},
    setStyle(value){currentStyle=value;installSources();emit('style.load');},
  };
}

test('every shipped symbol keeps its rules and ID above the mask with an initially empty verified source',()=>{
  const before=JSON.stringify(shipped), style=withMapLabelCoverage(shipped);
  assert.equal(JSON.stringify(shipped),before,'the generator output is not mutated');
  assert.deepEqual(style.sources[MAP_LABEL_SOURCE].data,{type:'FeatureCollection',features:[]});
  const mask=style.layers.findIndex(layer=>layer.id==='russia-outside-mask');
  assert.ok(mask>=0);
  assert.deepEqual(style.layers.filter(layer=>layer.type!=='symbol'),shipped.layers.filter(layer=>layer.type!=='symbol'));
  const symbols=shipped.layers.filter(layer=>layer.type==='symbol');
  assert.deepEqual(style.layers.filter(layer=>layer.type==='symbol').map(layer=>layer.id),symbols.map(layer=>layer.id));
  const sampleProperties = [
    {class:'city',name:'Санкт-Петербург'}, {class:'city',name:'Выборг'},
    {class:'town',name:'Светогорск'}, {class:'country',name:'Россия'},
    {class:'state',name:'Ленинградская область'}, {class:'village'}, {class:'peak'},
    {class:'camp_site'}, {class:'shop',subclass:'viewpoint'}, {class:'path'}, {class:'track'}, {class:'shop'}, {},
  ];
  for(const original of symbols){
    const index=style.layers.findIndex(layer=>layer.id===original.id), actual=style.layers[index];
    assert.ok(index>mask,original.id);
    assert.equal(actual.source,MAP_LABEL_SOURCE);
    assert.equal(actual['source-layer'],undefined);
    for(const property of ['minzoom','maxzoom','layout','paint'])assert.deepEqual(actual[property],original[property],`${original.id} ${property}`);
    const origin=actual.metadata['tropnik:label-origin'];
    assert.equal(origin.source,original.source);assert.equal(origin.sourceLayer,original['source-layer']);
    assert.deepEqual(origin.filter,original.filter ?? null);
    for(const properties of sampleProperties){
      const feature=point(1,[15,55],properties), expected=matches(original.filter,feature,14);
      assert.equal(matches(actual.filter,{...feature,properties:{...properties,__tropnik_label_group:origin.key}},14),expected,original.id);
      assert.equal(matches(actual.filter,{...feature,properties:{...properties,__tropnik_label_group:'another-source'}},14),false,original.id);
    }
  }
  assert.deepEqual(withMapLabelCoverage(style),style,'wrapping an already prepared style is idempotent');
  // Use the installed renderer specification, not a duplicate filter evaluator.
  assert.deepEqual(validateStyleMin(style),[]);
});

test('RF coastal labels remain whole, and a priority city name cannot admit foreign geometry',()=>{
  const fixtures = [
    point(1,[28.748,60.711],{class:'city',name:'Выборг','name:ru':'Выборг','name:fi':'Viipuri',unused:'large translation payload'}),
    point(1,[28.748,60.711],{class:'city',name:'Выборг','name:ru':'Выборг'}),
    point(1,[37.617,55.755],{class:'city',name:'Другой город с тем же tile-local ID'}),
    point(2,[28.872,61.111],{class:'town',name:'Светогорск'}),
    point(3,[30.315,59.9386],{class:'city',name:'Санкт-Петербург'}),
    point(4,[24.938,60.17],{class:'city',name:'Санкт-Петербург'}),
    point(5,[24.938,60.17],{class:'city',name:'Хельсинки'}),
  ];
  const h=harness(undefined,{[keyFor('openmaptiles','place')]:fixtures});
  const original=JSON.stringify(fixtures),unbind=bindMapLabelCoverage(h.map,russia,h.environment);
  h.flush();
  assert.deepEqual(h.writes.at(-1).features.map(feature=>feature.id).sort(),[1,1,2,3],'equal local IDs do not merge different anchors');
  const city=h.writes.at(-1).features.find(feature=>feature.properties.name==='Выборг');
  assert.equal(city.properties['name:ru'],'Выборг');
  assert.equal(city.properties['name:fi'],undefined);assert.equal(city.properties.unused,undefined);
  assert.equal(JSON.stringify(fixtures),original);
  assert.equal(h.pending,0,'setData events from our own source must not schedule another query');
  unbind();
});

test('water and path lines require their complete geometry to stay covered, including holes',()=>{
  const water=[
    line(1,[[11,52],[19,52]],{name:'Covered river'}),
    line(2,[[11,55],[19,55]],{name:'Hole crossing'}),
    line(3,[[9,53],[19,53]],{name:'Foreign endpoint'}),
    point(4,[11,55],{name:'Covered lake'}),
  ];
  const h=harness(undefined,{[keyFor('openmaptiles','water_name')]:water,[keyFor('openmaptiles','transportation_name')]:water.map(feature=>({...feature,properties:{...feature.properties,class:'path'}}))});
  bindMapLabelCoverage(h.map,withHole,h.environment);h.flush();
  assert.deepEqual(h.writes.at(-1).features.map(feature=>feature.id).sort(),[1,1,4,4]);
  assert.equal(h.writes.at(-1).features.filter(feature=>feature.geometry.type==='LineString').length,2);
});

test('a coverage LOD commit invalidates cached admissions without reloading vector tiles',()=>{
  const h=harness(undefined,{[keyFor('openmaptiles','place')]:[point(1,[15,55],{class:'city',name:'Source coast'})]});
  const listeners=new Set(),coverage={area:rectangle,subscribe(callback){listeners.add(callback);return()=>listeners.delete(callback);}};
  const dispose=bindMapLabelCoverage(h.map,coverage,h.environment);h.flush();
  assert.equal(h.writes.at(-1).features.length,1);
  coverage.area=withHole;for(const notify of listeners)notify();h.flush();
  assert.equal(h.writes.at(-1).features.length,0,'same feature must be rechecked against the source-level hole');
  coverage.area=rectangle;for(const notify of listeners)notify();h.flush();
  assert.equal(h.writes.at(-1).features.length,1);
  dispose();assert.equal(listeners.size,0);
});

test('source queries use active original filters before expensive geometry conversion',()=>{
  const poi=[point(1,[15,55],{class:'shop'}),point(2,[15,55],{class:'viewpoint'}),point(3,[15,55],{class:'shop',subclass:'camp_site'})];
  const place=['city','town','village','country','state','continent'].map((value,index)=>point(index,[15,55],{class:value,name:value}));
  const h=harness(undefined,{[keyFor('openmaptiles','poi')]:poi,[keyFor('openmaptiles','place')]:place},11);
  bindMapLabelCoverage(h.map,rectangle,h.environment);h.flush();
  assert.deepEqual(h.queries.map(query=>query.query.sourceLayer).sort(),['mountain_peak','place','water_name']);
  assert.deepEqual(h.writes.at(-1).features.map(feature=>feature.properties.class).sort(),['city','town','village']);
  h.queries.length=0;h.setZoom(14);h.emit('moveend');h.flush();
  assert.equal(h.queries.filter(query=>query.query.sourceLayer==='poi').length,1,'icon and text share a single query');
  assert.equal(h.queries.find(query=>query.query.sourceLayer==='poi').count,2,'unrelated shops are rejected by the SDK query filter');
  assert.equal(h.queries.find(query=>query.query.sourceLayer==='water_name').query.filter,undefined,'unfiltered water labels retain their original behavior');
  h.queries.length=0;h.setZoom(18);h.emit('moveend');h.flush();
  const result=h.writes.at(-1).features.filter(feature=>feature.properties.__tropnik_label_group===keyFor('openmaptiles','place'));
  assert.deepEqual(result.map(feature=>feature.properties.class),['village'],'maxzoom is exclusive for ordinary city/town labels');
});

test('source bursts coalesce, moving cameras wait for moveend, unchanged data avoids worker updates',()=>{
  const h=harness(undefined,{[keyFor('openmaptiles','place')]:[point(1,[15,55],{class:'city',name:'City'})]});
  const unbind=bindMapLabelCoverage(h.map,rectangle,h.environment);
  for(let index=0;index<10;index++)h.emit('sourcedata',{sourceId:'openmaptiles',sourceDataType:'content'});
  assert.equal(h.pending,1);h.flush();assert.equal(h.writes.length,1);
  const queryCount=h.queries.length;
  for(const sourceId of [MAP_LABEL_SOURCE,'hillshade-dem','terrain-dem'])h.emit('sourcedata',{sourceId,sourceDataType:'content',isSourceLoaded:true});
  h.emit('sourcedata',{sourceId:'openmaptiles',sourceDataType:'metadata'});
  assert.equal(h.pending,0);assert.equal(h.queries.length,queryCount);
  h.emit('sourcedata',{sourceId:'openmaptiles',sourceDataType:'content'});h.flush();
  assert.equal(h.writes.length,1,'identical features do not re-tile GeoJSON');
  h.setMoving(true);h.emit('sourcedata',{sourceId:'openmaptiles',sourceDataType:'content'});h.flush();
  const afterMoving=h.queries.length;
  h.setMoving(false);h.emit('moveend');h.flush();assert.ok(h.queries.length>afterMoving);
  h.emit('moveend');const pendingCallbackCount=h.canceled.length;unbind();
  assert.equal(h.pending,0);assert.equal(h.listeners,0);assert.equal(h.canceled.length,pendingCallbackCount+1);
  h.canceled.at(-1)();h.emit('moveend');h.flush();assert.equal(h.writes.length,1,'disposed deferred work cannot write');
});

test('style reload invalidates pending work, and a style with no origin metadata clears stale labels',()=>{
  const h=harness(undefined,{[keyFor('openmaptiles','place')]:[point(1,[15,55],{class:'city',name:'City'})]});
  bindMapLabelCoverage(h.map,rectangle,h.environment);
  h.setStyle(withMapLabelCoverage(shipped));
  assert.equal(h.canceled.length,1);h.canceled[0]();assert.equal(h.writes.length,0);
  h.flush();assert.equal(h.writes.at(-1).features.length,1);
  const cleared={version:8,sources:{[MAP_LABEL_SOURCE]:{type:'geojson',data:h.writes.at(-1)}},layers:[]};
  h.setStyle(cleared);h.flush();assert.deepEqual(h.writes.at(-1),{type:'FeatureCollection',features:[]});
  h.emit('remove');assert.equal(h.listeners,0);assert.equal(h.pending,0);
});

test('missing coverage fails closed, while canonical dateline lines are normalized without mutating input',()=>{
  const coverage={type:'Polygon',coordinates:[[[170,40],[190,40],[190,60],[170,60],[170,40]]]};
  const features=[line(1,[[179,50],[-179,50]],{name:'Dateline river'}),point(2,[-179,51],{name:'Eastern point'})];
  const original=JSON.stringify(features),data={[keyFor('openmaptiles','water_name')]:features};
  const absent=harness(undefined,data);bindMapLabelCoverage(absent.map,null,absent.environment);absent.flush();
  assert.deepEqual(absent.writes.at(-1).features,[]);
  const h=harness(undefined,data);bindMapLabelCoverage(h.map,coverage,h.environment);h.flush();
  assert.deepEqual(h.writes.at(-1).features.find(feature=>feature.id===1).geometry.coordinates,[[179,50],[181,50]]);
  assert.deepEqual(h.writes.at(-1).features.find(feature=>feature.id===2).geometry.coordinates,[181,51]);
  assert.equal(JSON.stringify(features),original);
});
