import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {maskViewportCulling} from '../lib/leaflet-mask-viewport.ts';
import {createLeafletCanvas} from '../lib/leaflet-canvas.ts';
import {leafletRussiaMask,MAP_OUTSIDE_COLOR} from '../public/maps/russia-viewport.js';

const require=createRequire(new URL('../package.json',import.meta.url));
const document={documentElement:{style:{}},createElement:()=>({style:{},getContext:()=>({})})};
const navigator={userAgent:'Node Leaflet mask viewport test',platform:'Linux'};
const window={document,navigator,devicePixelRatio:1,screen:{},addEventListener(){},removeEventListener(){}};
const leaflet={exports:{}};
vm.runInNewContext(readFileSync(require.resolve('leaflet/dist/leaflet-src.js'),'utf8'),{
 document,navigator,window,module:leaflet,exports:leaflet.exports,setTimeout:()=>0,clearTimeout(){},console,
});
const L=leaflet.exports;
const source=JSON.parse(readFileSync(new URL('../public/data/russia-outside-mask.geojson',import.meta.url),'utf8'));
const data=leafletRussiaMask(source),original=JSON.stringify(data);

function environment(culled){
 const camera={lng:40.40214788181817,lat:43.719248501487606,zoom:12.58772159520626,width:412,height:847};
 const counts={vertices:0,polygons:0,viewportReads:0};
 let origin,invalid=false;
 const size=()=>L.point(camera.width,camera.height);
 const worldTopLeft=()=>L.CRS.EPSG3857.latLngToPoint(L.latLng(camera.lat,camera.lng),camera.zoom).subtract(size().divideBy(2));
 const map={
  getSize:size,
  getPixelBounds(){counts.viewportReads++;if(invalid==='unavailable')throw new Error('viewport unavailable');return invalid?L.bounds([NaN,NaN],[NaN,NaN]):L.bounds(worldTopLeft(),worldTopLeft().add(size()));},
  unproject:point=>L.CRS.EPSG3857.pointToLatLng(L.point(point),camera.zoom),
  latLngToLayerPoint:latlng=>{counts.vertices++;return L.CRS.EPSG3857.latLngToPoint(latlng,camera.zoom).round().subtract(origin);},
 };
 const renderer=createLeafletCanvas(L,{pane:'russia-mask',padding:.15});renderer._map=map;
 const layers=[];
 L.geoJSON(data,{style:{renderer,smoothFactor:0,stroke:false,fillColor:MAP_OUTSIDE_COLOR,fillOpacity:1,fillRule:'evenodd'},interactive:false}).eachLayer(layer=>{
  layer._map=map;layer._renderer=renderer;
  const project=layer._project;layer._project=function(){counts.polygons++;project.call(this);};
  renderer._layers[L.stamp(layer)]=layer;layers.push(layer);
 });
 if(culled){const attach=maskViewportCulling(renderer);layers.forEach(attach);}
 const set=(next={})=>{
  const changedZoom=next.zoom!==undefined&&next.zoom!==camera.zoom;
  Object.assign(camera,next);if(!origin||changedZoom)origin=worldTopLeft().round();
  const minimum=worldTopLeft().subtract(origin).subtract(size().multiplyBy(.15)).round();
  renderer._bounds=L.bounds(minimum,minimum.add(size().multiplyBy(1.3)).round());
 };
 set();
 const resetCounts=()=>{counts.vertices=counts.polygons=counts.viewportReads=0;};
 const project=()=>{resetCounts();renderer._onZoomEnd();return{...counts};};
 const update=()=>{resetCounts();renderer._updatePaths();return{...counts};};
 const snapshot=()=>layers.map(layer=>Array.from(layer._parts??[],part=>Array.from(part,point=>[point.x,point.y])));
 return{camera,counts,layers,renderer,set,project,update,snapshot,invalid:value=>{invalid=value;}};
}

function samePixels(ordinary,culled,message){
 assert.deepEqual(culled.snapshot(),ordinary.snapshot(),message);
 assert.equal(culled.layers.length,ordinary.layers.length,'culling cannot add or remove geometry layers');
 assert.equal(JSON.stringify(data),original,'published vertices and world copies remain unmodified');
}

test('exact burst zooms skip off-screen mask projections while retaining every buffered clipped ring',()=>{
 const ordinary=environment(false),culled=environment(true);
 for(const zoom of [12.58772159520626,11.83772159520626,11.08772159520626,10.33772159520626,9.58772159520626]){
  ordinary.set({zoom});culled.set({zoom});
  const before=ordinary.project(),after=culled.project();
  assert.equal(before.polygons,864);
  assert.equal(after.viewportReads,1,'the whole zoom projection pass shares one measured viewport');
  assert.ok(after.polygons<=4,`z${zoom}: only nearby cells need projection`);
  assert.ok(after.vertices<before.vertices*.1,`z${zoom}: more than 90% of vertex projection is avoided`);
  ordinary.update();const paint=culled.update();assert.equal(paint.viewportReads,1);
  samePixels(ordinary,culled,`z${zoom}: native clipping is identical`);
 }
});

test('pan and reverse pan restore newly visible mask cells without a zoom event',()=>{
 const ordinary=environment(false),culled=environment(true);
 ordinary.set({zoom:9.5});culled.set({zoom:9.5});ordinary.project();culled.project();ordinary.update();culled.update();
 for(const [lng,lat,entersNewCell] of [[60,45,true],[61,45,false],[85,45,true],[40.40214788181817,43.719248501487606,true]]){
  ordinary.set({lng,lat});culled.set({lng,lat});ordinary.update();const restored=culled.update();
  if(entersNewCell)assert.ok(restored.polygons>0,'entering a new cell must recover its projection during updatePaths');
  else assert.equal(restored.polygons,0,'panning inside an already projected cell must reuse its rings');
  assert.equal(restored.viewportReads,1);
  samePixels(ordinary,culled,`pan to ${lng},${lat}: no uncovered strip can appear`);
 }
});

test('zooming to the country view and resizing preserve the complete padded viewport',()=>{
 const ordinary=environment(false),culled=environment(true);
 ordinary.project();culled.project();ordinary.update();culled.update();
 for(const state of [
  {lng:105,lat:62,zoom:1.337721595206259},
  {width:1360,height:868},
  {lng:40.40214788181817,lat:43.719248501487606,zoom:4.5,width:412,height:847},
 ]){
  const zoomChanges=state.zoom!==undefined&&state.zoom!==ordinary.camera.zoom;
  ordinary.set(state);culled.set(state);
  if(zoomChanges){ordinary.project();culled.project();}
  ordinary.update();culled.update();samePixels(ordinary,culled,'country/resize coverage matches ordinary Leaflet exactly');
 }
});

test('the dateline and adjacent world copies use continuous longitudes for culling',()=>{
 const ordinary=environment(false),culled=environment(true);
 for(const state of [
  {lng:191,lat:65.8,zoom:6},
  {lng:-169,lat:65.8,zoom:6},
  {lng:551,lat:65.8,zoom:6},
  {lng:-319.5978521181818,lat:43.719248501487606,zoom:4.5},
  {lng:400.4021478818182,lat:43.719248501487606,zoom:4.5},
 ]){
  ordinary.set(state);culled.set(state);ordinary.project();culled.project();ordinary.update();culled.update();
  samePixels(ordinary,culled,`world copy at ${state.lng}: geometry is neither wrapped nor discarded`);
 }
});

test('unknown viewport dimensions fail open and restore all previously skipped source rings',()=>{
 const ordinary=environment(false),culled=environment(true);
 ordinary.project();culled.project();ordinary.update();culled.update();
 assert.ok(culled.layers.some(layer=>!layer._rings.length));
 for(const invalid of [true,'unavailable']){
  culled.invalid(invalid);const restored=culled.project();
  assert.equal(restored.polygons,864,'invalid or unavailable pixel bounds must use normal projection, never hide the mask');
 }
 culled.invalid(false);ordinary.update();culled.update();samePixels(ordinary,culled,'valid rendering recovers after the unknown viewport');
});
