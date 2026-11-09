import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {MAP_CONFIG} from '../lib/map-config.ts';
import {russiaLongitude,leafletRussiaMask,MAP_OUTSIDE_COLOR} from '../public/maps/russia-viewport.js';
import * as routePresentation from '../lib/map-route-presentation.ts';
import {createLeafletCanvas} from '../lib/leaflet-canvas.ts';
import {maskViewportCulling} from '../lib/leaflet-mask-viewport.ts';

const require=createRequire(new URL('../package.json',import.meta.url));
const ts=require('typescript');
const source=readFileSync(new URL('../components/Atlas2D.tsx',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const component={exports:{}};
new Function('require','module','exports',compiled)(id=>id==='@/lib/map-config'?{MAP_CONFIG}:id==='@/public/maps/russia-viewport.js'?{russiaLongitude,leafletRussiaMask,MAP_OUTSIDE_COLOR}:id==='@/lib/map-route-presentation'?routePresentation:id==='@/lib/leaflet-canvas'?{createLeafletCanvas}:id==='@/lib/leaflet-mask-viewport'?{maskViewportCulling}:{},component,component.exports);
const {createCanvasTrailPoint,createCanvasTrailLine,raiseCanvasTrailPoints,createCanvasRussiaMask}=component.exports;

// Use the installed Leaflet implementation for renderer ownership, projection,
// draw order, hit testing and event bubbling. Only DOM painting is omitted;
// actual browser pointer delivery requires the separate Pages touch smoke.
const document={documentElement:{style:{}},createElement:()=>({style:{},getContext:()=>({})})};
const navigator={userAgent:'Node Leaflet interaction test',platform:'Linux'};
const window={document,navigator,devicePixelRatio:1,screen:{},addEventListener(){},removeEventListener(){}};
const leaflet={exports:{}};
vm.runInNewContext(readFileSync(require.resolve('leaflet/dist/leaflet-src.js'),'utf8'),{
 document,navigator,window,module:leaflet,exports:leaflet.exports,setTimeout:()=>0,clearTimeout(){},console,
});
const L=leaflet.exports;

test('the actual short source route switches edge density with installed Leaflet projections',()=>{
 const data=JSON.parse(readFileSync(new URL('../public/data/imported/osm-relation-2244794.geojson',import.meta.url),'utf8'));
 const before=JSON.stringify(data),edges=routePresentation.routeLineEdges(data);
 assert.equal(edges.length,2);
 for(const [zoom,expected] of [[11,'hidden'],[14,'compact'],[16,'full']]){
  const points=edges.map(edge=>L.CRS.EPSG3857.latLngToPoint(L.latLng(edge.coordinate[1],russiaLongitude(edge.coordinate[0])),zoom).round());
  assert.equal(routePresentation.routeEdgeDensity(points[0],points[1]),expected,`native screen projections at z${zoom}`);
 }
 assert.equal(JSON.stringify(data),before,'all twelve source vertices and their properties stay intact');
});

test('the real mask keeps its shared 45-degree cell edge after Leaflet projects and clips it',()=>{
 const data=JSON.parse(readFileSync(new URL('../public/data/russia-outside-mask.geojson',import.meta.url),'utf8'));
 const original=JSON.stringify(data),zoom=4.5,center=L.latLng(43.719248501487606,40.40214788181817);
 const origin=L.CRS.EPSG3857.latLngToPoint(center,zoom).subtract([206,423.5]).round();
 const map={latLngToLayerPoint:latlng=>L.CRS.EPSG3857.latLngToPoint(latlng,zoom).round().subtract(origin)};
 const renderer={options:{},_bounds:L.bounds([-62,-128],[474,975])};
 const prepare=group=>{
  const layers=[];group.eachLayer(layer=>{layer._map=map;layer._renderer=renderer;layer._project();layer._clipPoints();layer._simplifyPoints();layers.push(layer);});return layers;
 };
 const previous=prepare(L.geoJSON(leafletRussiaMask(data),{style:{stroke:false,fill:true,smoothFactor:1}}));
 const fixed=prepare(createCanvasRussiaMask(L,data));
 for(const y of [450,475,500,525]){
  const point=L.point(280.25,y);
  assert.equal(previous.some(layer=>layer._containsPoint(point)),false,'independent SDK simplification reproduces the visible seam');
  assert.equal(fixed.some(layer=>layer._containsPoint(point)),true,'the existing coverage cells must meet without changing their geometry');
 }
 assert.equal(fixed.length,previous.length,'mask partitions and world copies remain intact');
 assert.ok(fixed.every(layer=>layer.options.interactive===false&&layer.options.stroke===false));
 assert.ok(fixed.every(layer=>layer.options.noClip===false),'viewport clipping remains enabled');
 assert.equal(JSON.stringify(data),original,'the published geometry and provenance cannot be edited by rendering');
});

function mapHarness(){
 const layers=new Set(),renderers=new Set();
 const map=Object.assign(Object.create(L.Map.prototype),{
  options:{preferCanvas:true,renderer:createLeafletCanvas(L)},_paneRenderers:{},
  hasLayer:layer=>layers.has(layer),
  addLayer(layer){
   if(layers.has(layer))return this;
   layers.add(layer);layer._map=this;
   if(layer instanceof L.Renderer){
    renderers.add(layer);layer._bounds=L.bounds([-100,-100],[200,200]);layer._requestRedraw=()=>{};
   }else if(layer instanceof L.LayerGroup)layer.onAdd(this);
   else{layer.beforeAdd(this);layer.onAdd(this);}
   return this;
  },
  removeLayer(layer){
   if(!layers.has(layer))return this;
   layer.onRemove(this);layer._map=null;layers.delete(layer);return this;
  },
  latLngToLayerPoint:latlng=>L.point(latlng.lng,latlng.lat),
  latLngToContainerPoint:latlng=>L.point(latlng.lng,latlng.lat),
  mouseEventToLayerPoint:event=>L.point(event.x,event.y),
  mouseEventToContainerPoint:event=>L.point(event.x,event.y),
  containerPointToLayerPoint:point=>point,
  layerPointToLatLng:point=>L.latLng(point.y,point.x),
  _draggableMoved:()=>false,_findEventTargets:()=>[],
 });
 const click=(x,y)=>{
  assert.equal(renderers.size,1,'Territories, routes and touch targets must share one interactive Canvas');
  [...renderers][0]._onClick({type:'click',x,y});
 };
 return{map,renderers,click};
}
function region(map,onSelect){
 return L.polygon([[0,0],[0,100],[100,100],[100,0]]).on('click',onSelect).addTo(map);
}
const pointInput={id:'route-a',title:'Маршрут A',center:[50,50],selected:false};
const lineGeometry={type:'LineString',coordinates:[[10,50],[90,50]]};

test('one Canvas keeps territories reachable before, during and after route markers',()=>{
 const h=mapHarness(),selected=[];
 region(h.map,()=>selected.push('region'));
 h.click(10,10);
 const point=createCanvasTrailPoint(L,pointInput,()=>selected.push('route'),()=>{});
 const group=L.layerGroup([point.hit,point.marker]).addTo(h.map);
 h.click(50,50);
 h.click(10,10);
 group.clearLayers();
 h.click(50,50);
 assert.deepEqual(selected,['region','route','region','region']);
 assert.deepEqual(Object.keys(h.map._paneRenderers),[],'No empty elevated pane may survive returning to directions');
});

test('a 44px touch target preserves the small dot and selects only inside its radius',()=>{
 const h=mapHarness(),selected=[];
 region(h.map,()=>selected.push('region'));
 const point=createCanvasTrailPoint(L,pointInput,()=>selected.push('route'),()=>{});
 L.layerGroup([point.hit,point.marker]).addTo(h.map);
 assert.equal(point.marker.getRadius(),6.5);
 assert.equal(point.marker.options.interactive,false);
 assert.equal(point.hit.getRadius()*2,44);
 h.click(71,50); // 21px from the center: outside the visible dot, inside the touch target.
 h.click(73,50);
 assert.deepEqual(selected,['route','region']);
});

test('a selected line opens its own route and points retain priority after an asynchronous line load',()=>{
 const h=mapHarness(),selected=[];
 region(h.map,()=>selected.push('region'));
 const point=createCanvasTrailPoint(L,pointInput,()=>selected.push('point'),()=>{});
 L.layerGroup([point.hit,point.marker]).addTo(h.map);
 const line=createCanvasTrailLine(L,lineGeometry,false,()=>selected.push('rendered-route'));
 line.addTo(h.map);
 raiseCanvasTrailPoints(new Map([[pointInput.id,point]]),pointInput.id);
 h.click(15,58); // Wider than the visible 4px route stroke.
 h.click(50,50);
 h.click(10,10);
 assert.deepEqual(selected,['rendered-route','point','region']);
});

test('planner preview lines remain passive and overlapping points prefer the selected route',()=>{
 const h=mapHarness(),selected=[];
 region(h.map,()=>selected.push('region'));
 createCanvasTrailLine(L,lineGeometry,true,()=>selected.push('unexpected-planner-selection')).addTo(h.map);
 h.click(15,50);
 const first=createCanvasTrailPoint(L,pointInput,()=>selected.push('route-a'),()=>{});
 const second=createCanvasTrailPoint(L,{...pointInput,id:'route-b'},()=>selected.push('route-b'),()=>{});
 for(const point of [first,second])L.layerGroup([point.hit,point.marker]).addTo(h.map);
 raiseCanvasTrailPoints(new Map([['route-a',first],['route-b',second]]),'route-a');
 h.click(50,50);
 assert.deepEqual(selected,['region','route-a']);
});
