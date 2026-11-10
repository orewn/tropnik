import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {applyMapLibreCoverage,createCanvasCoverage} from '../public/maps/map-coverage-renderers.js';

const require=createRequire(import.meta.url),document={documentElement:{style:{}},createElement:()=>({style:{},getContext:()=>({})})};
const navigator={userAgent:'Node coverage renderer test',platform:'Linux'},window={document,navigator,devicePixelRatio:1,screen:{},addEventListener(){},removeEventListener(){}},leaflet={exports:{}};
vm.runInNewContext(readFileSync(require.resolve('leaflet/dist/leaflet-src.js'),'utf8'),{document,navigator,window,module:leaflet,exports:leaflet.exports,setTimeout:()=>0,clearTimeout(){},console});
const L=leaflet.exports;
const polygon=x=>({type:'Polygon',coordinates:[[[x,50],[x+1,50],[x+1,51],[x,51],[x,50]]]});
const cell=(id,x)=>['area','mask','territory','territory-boundary'].map(role=>({type:'Feature',id:`${id}:${role}`,properties:{cell:id,role,shapeName:'Source'},geometry:role==='territory-boundary'?{type:'LineString',coordinates:[[x+.2,50.1],[x+.8,50.7]]}:polygon(x)}));

test('actual Leaflet cell layers retain geometry and never outline a clipping perimeter',()=>{
  const attached=new Set(),map={addLayer(layer){attached.add(layer);layer._map=this;return this;},removeLayer(layer){if(layer instanceof L.LayerGroup)layer.onRemove(this);attached.delete(layer);layer._map=undefined;return this;}};
  const first=cell('a',20),second=cell('b',25),coverage={cellFeatures:new Map([['a',first],['b',second]])};
  const drawing=createCanvasCoverage(L,map,{territoryStyle:()=>({color:'#486b45',fillOpacity:.1})});
  drawing.apply(coverage);
  const layers=drawing.territories.getLayers(),sourceLine=layers.find(layer=>layer.feature.properties.role==='territory-boundary');
  assert.equal(layers.length,4);assert.deepEqual(JSON.parse(JSON.stringify(sourceLine.toGeoJSON().geometry)),first.at(-1).geometry);
  for(const layer of layers){assert.equal(layer.options.smoothFactor,0);assert.equal(layer.options.stroke,layer.feature.properties.role==='territory-boundary');assert.equal(layer.options.fill,layer.feature.properties.role==='territory');}
  const retained=layers.filter(layer=>layer.feature.properties.cell==='b');
  drawing.apply({cellFeatures:new Map([['a',cell('a',20.1)],['b',second]])});
  assert.ok(retained.every(layer=>drawing.territories.hasLayer(layer)),'unchanged base cells keep their actual Leaflet paths');
  assert.ok(layers.filter(layer=>layer.feature.properties.cell==='a').every(layer=>!drawing.territories.hasLayer(layer)),'only the replaced cell leaves the renderer');
  drawing.destroy();assert.equal(attached.size,0);
});

test('actual Leaflet Canvas selects a territory through its decorative boundary',()=>{
  const attached=new Set(),map={addLayer(layer){attached.add(layer);layer._map=this;return this;},removeLayer(layer){if(layer instanceof L.LayerGroup)layer.onRemove(this);attached.delete(layer);layer._map=undefined;return this;}};
  const selected=[];
  const drawing=createCanvasCoverage(L,map,{onTerritory:(feature,layer)=>layer.on('click',()=>selected.push(feature.id))});
  drawing.apply({cellFeatures:new Map([['a',cell('a',20)]])});
  const layers=drawing.territories.getLayers(),point=L.point(50,40);
  for(const layer of layers){
    const geometry=layer.toGeoJSON().geometry;
    const rings=geometry.type==='Polygon'?geometry.coordinates:[geometry.coordinates];
    layer._parts=rings.map(ring=>ring.map(([x,y])=>L.point((x-20)*100,(y-50)*100)));
    layer._pxBounds=L.bounds(layer._parts.flat());layer._renderer=layer.options.renderer;
    assert.equal(layer._containsPoint(point),true,'the same real point intersects both polygon and outline');
  }
  let picked;
  L.Canvas.prototype._onClick.call({
    _map:{mouseEventToLayerPoint:()=>point,_draggableMoved:()=>false},
    _drawFirst:{layer:layers[0],next:{layer:layers[1]}},
    _fireEvent(targets){picked=targets[0];picked?.fire('click');},
  },{type:'click'});
  assert.equal(picked.feature.properties.role,'territory');
  assert.deepEqual(selected,['a:territory']);
  assert.equal(layers[1].options.stroke,true,'the boundary remains visible');
  drawing.destroy();assert.equal(attached.size,0);
});

function glHarness(){
  const listeners=new Map(),sources=new Map(['land','regions','regions-outline','russia-mask'].map(id=>[id,{loaded:true,setData(data){this.data=data;this.loaded=false;}}]));
  const map={getSource:id=>sources.get(id),isSourceLoaded:id=>sources.get(id).loaded,
    on(type,callback){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(callback);},
    off(type,callback){listeners.get(type)?.delete(callback);}};
  return{map,sources,emit(type){for(const callback of [...(listeners.get(type)??[])])callback();},count:()=>[...listeners.values()].reduce((sum,set)=>sum+set.size,0)};
}
test('MapLibre coverage readiness requires all public GeoJSON workers and a rendered frame',async()=>{
  const h=glHarness(),coverage={area:{role:'area'},mask:{role:'mask'},territories:{role:'territory'},boundaries:{role:'territory-boundary'}};
  let finished=false;const job=applyMapLibreCoverage(h.map,coverage).then(()=>finished=true);
  assert.equal(h.sources.get('regions-outline').data,coverage.boundaries);
  h.sources.get('land').loaded=true;h.emit('render');await Promise.resolve();assert.equal(finished,false);
  for(const source of h.sources.values())source.loaded=true;
  assert.equal(finished,false);h.emit('render');await job;assert.equal(finished,true);assert.equal(h.count(),0);
});
test('a style replacement releases old render readiness listeners instead of claiming completion',async()=>{
  const h=glHarness(),job=applyMapLibreCoverage(h.map,{area:{},mask:{},territories:{},boundaries:{}});
  h.emit('style.load');await assert.rejects(job,/coverage-render-removed/);assert.equal(h.count(),0);
});
