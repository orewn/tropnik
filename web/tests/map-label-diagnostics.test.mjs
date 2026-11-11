import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {withMapLabelCoverage,inspectMapLabels,bindMapLabelCoverage,MAP_LABEL_SOURCE,MAP_LABEL_DIAGNOSTIC_EVENT} from '../public/maps/map-label-coverage.js';
const shipped=JSON.parse(readFileSync(new URL('../public/maps/tropa-style.json',import.meta.url),'utf8'));
const request={schemaVersion:1,layerIds:['city-label','town-label','village-label','russia-priority-city-label'],names:['Приморск','Малые Сопки','Карасёвка','Карасевка'],limit:100};
const point=(id,coordinates,tile)=>({type:'Feature',id,tile,geometry:{type:'Point',coordinates},properties:{name:'Приморск','name:ru':'Приморск',class:'town',wikidata:'Qfixture',unused:'not included'}});
function harness(features=[]){
 const container=new EventTarget(),handlers=new Map(),queries=[];
 const style=withMapLabelCoverage(shipped);
 const map={
  getContainer:()=>container,getStyle:()=>style,getZoom:()=>12,getCenter:()=>({lng:28.6,lat:60.36}),getBearing:()=>0,getPitch:()=>0,
  project:([x,y])=>({x:x*10,y:y*10}),
  querySourceFeatures:(source,query)=>{queries.push({source,query});return features;},
  queryRenderedFeatures:query=>{queries.push({rendered:true,query});return features.map(feature=>({...feature,layer:{id:'town-label'}}));},
  getSource:()=>({setData(){throw new Error('inspection must not write source data');}}),
  on(type,callback){let set=handlers.get(type);if(!set){set=new Set();handlers.set(type,set);}set.add(callback);},
  off(type,callback){handlers.get(type)?.delete(callback);},
  setZoom(){throw new Error('inspection must not move camera');},
 };
 const emit=type=>{for(const callback of handlers.get(type)??[])callback();};
 const inspect=(input=request)=>{const detail={request:input};container.dispatchEvent(new CustomEvent(MAP_LABEL_DIAGNOSTIC_EVENT,{detail}));return detail.result;};
 return{container,map,style,queries,emit,inspect};
}

test('an explicit label diagnostic retains source copies and optional tile metadata without inferring identity',()=>{
 const fixtures=[point(12345,[28.747787475585938,60.71115945414599],{z:8,x:148,y:73}),point(12345,[28.748130798339844,60.71099149589339],{z:9,x:296,y:146})];
 const h=harness(fixtures),before=JSON.stringify(fixtures),result=inspectMapLabels(h.map,request);
 assert.equal(result.error,undefined);
 assert.equal(result.readOnly,true);assert.equal(result.cameraPreserved,true);
 assert.equal(result.idScope,'not-established');assert.equal(result.tileMetadata,'observed-optional');
 assert.equal(result.sources.length,1);assert.equal(result.sources[0].source,'openmaptiles');assert.equal(result.sources[0].sourceLayer,'place');
 assert.equal(result.sources[0].features.length,2,'same ID and nearby parent/child anchors are evidence, not permission to merge');
 assert.deepEqual(result.sources[0].features.map(feature=>feature.observedTile),fixtures.map(feature=>feature.tile));
 assert.deepEqual(result.sources[0].features.map(feature=>feature.coordinates),fixtures.map(feature=>feature.geometry.coordinates));
 assert.equal(result.overlay.source,MAP_LABEL_SOURCE);assert.equal(result.rendered.features[0].layerId,'town-label');
 assert.equal(result.sources[0].features[0].properties.unused,undefined);
 assert.equal(result.sources[0].features[0].properties.wikidata,'Qfixture');
 assert.equal(JSON.stringify(fixtures),before);
 result.layers[0].origin.source='mutated-result';assert.notEqual(h.style.layers.find(layer=>layer.id==='city-label').metadata['tropnik:label-origin'].source,'mutated-result','returned metadata is a detached snapshot');
 assert.equal(h.queries.length,3);
});

test('diagnostics validate layer ownership and bound request names and every returned collection',()=>{
 const h=harness(Array.from({length:150},(_,id)=>point(id,[28.6,60.3],null)));
 const result=inspectMapLabels(h.map,request);
 for(const collection of [...result.sources,result.overlay,result.rendered]){
  assert.equal(collection.total,150);assert.equal(collection.features.length,100);assert.equal(collection.truncated,true);
  assert.equal(collection.features[0].observedTile,null);
 }
 for(const change of [{limit:101},{limit:0},{limit:1.5},{layerIds:['russia-outside-mask']},{layerIds:['__missing__']},{layerIds:[]},{names:Array(9).fill('name')},{names:['x'.repeat(129)]},{schemaVersion:2}]){
  const before=h.queries.length,error=inspectMapLabels(h.map,{...request,...change});
  assert.ok(error.error);assert.equal(h.queries.length,before,'invalid requests never query tiles');
 }
});

test('label inspection is dormant until its event and is removed on dispose or map removal',()=>{
 for(const removal of ['dispose','remove']){
  const h=harness([point(1,[28.6,60.3],null)]);
  const dispose=bindMapLabelCoverage(h.map,{type:'Polygon',coordinates:[[[20,50],[40,50],[40,70],[20,70],[20,50]]]},{defer:()=>1,cancelDefer:()=>{}});
  assert.equal(h.queries.length,0,'no startup query, polling or retained inspection result');
  assert.equal(h.inspect().cameraPreserved,true);const count=h.queries.length;
  if(removal==='dispose')dispose();else h.emit('remove');
  assert.equal(h.inspect(),undefined);assert.equal(h.queries.length,count);
  dispose();assert.equal(h.inspect(),undefined,'cleanup is idempotent');
 }
});
