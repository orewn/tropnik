import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {RUSSIA_BOUNDS,russiaCamera,displayGeoJSON,inRussiaCoverage,coveredRussiaBounds,russiaLongitude} from '../public/maps/russia-viewport.js';

const source=await readFile(new URL('../public/offline.js',import.meta.url),'utf8');
const viewer=await readFile(new URL('../public/offline-viewer.html',import.meta.url),'utf8');
const start=source.slice(source.indexOf('async function createMap(){'),source.indexOf('\nfunction connect(){'));
assert.ok(start.startsWith('async function createMap(){'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const copy=value=>JSON.parse(JSON.stringify(value));
const area={type:'MultiPolygon',coordinates:[[[[40,43],[41,43],[41,44],[40,44],[40,43]]],[[[177,50],[191,50],[191,71],[177,71],[177,50]]]]};

class Element{
 constructor(rect={left:360,top:72,right:1280,bottom:800,width:920,height:728}){this.rect=rect;this.children=[];this.style={};this.dataset={};this.attributes={};this.hidden=false;this.textContent='';}
 getBoundingClientRect(){return this.rect;}
 setAttribute(name,value){this.attributes[name]=value;}
 appendChild(child){child.parentElement=this;this.children.push(child);return child;}
 insertBefore(child,before){child.parentElement=this;const index=this.children.indexOf(before);if(index<0)this.children.push(child);else this.children.splice(index,0,child);}
 get firstElementChild(){return this.children[0];}
 get nextSibling(){const children=this.parentElement?.children??[];return children[children.indexOf(this)+1];}
 remove(){this.removed=true;if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);}
}
function routeCoordinates(data){
 const points=[];const walk=value=>{if(Array.isArray(value)){if(typeof value[0]==='number')points.push(value);else value.forEach(walk);}else if(value&&typeof value==='object')walk(value.features??value.geometry??value.geometries??value.coordinates);};walk(data);return points;
}
async function launch({importFails=false,startupError='',online=false,coarse=false}={}){
 const calls={imports:[],visible:[],status:[],fit:[],routes:[],markers:[],cameras:[],layers:[],modes:[],pitches:[],floors:[],padding:[],obstacles:[],destroy:0,observerStops:0,coverageStops:0};
 const wrapper=new Element(),element=new Element();wrapper.appendChild(element);
 const nodes={map:element,'map-status':new Element({left:384,top:96,right:610,bottom:130,width:226,height:34}),
  'map-credits':new Element({left:900,top:700,right:1268,bottom:788,width:368,height:88})};
 const tools=new Element({left:1200,top:96,right:1256,bottom:360,width:56,height:264});
 let resize,subscriber;const instances=[];
 const session={area,status:{},subscribe(callback){subscriber=callback;return()=>{subscriber=undefined;calls.coverageStops++;};}};
 let view={camera:russiaCamera(920,728,undefined,256),padding:{top:96,bottom:112,left:40,right:88}};
 class CustomMapEngine{
  constructor(host,options){this.options=options;this.camera=options.camera;this.canvas=host.appendChild(new Element());this.markers=host.appendChild(new Element());instances.push(this);
   queueMicrotask(()=>{if(startupError)options.onState({error:startupError});else options.onReady(this);});}
  getCoverage(){return session;}
  setPadding(value){calls.padding.push(copy(value));}
  setObstacles(value){calls.obstacles.push(copy(value));}
  setFloor(value){calls.floors.push(copy(value));}
  setPitch(value){calls.pitches.push(value);}
  setMode(value){calls.modes.push(value);}
  setLayers(value){calls.layers.push(copy(value));}
  setRoute(value,id){calls.routes.push({geometry:value,id});}
  setMarkers(value){calls.markers.push(copy(value));}
  setCamera(value,animate){this.camera=value;calls.cameras.push({camera:copy(value),animate});}
  fit(bounds,padding,maxZoom,animate){calls.fit.push({bounds:copy(bounds),padding:copy(padding),maxZoom,animate});}
  zoomBy(value){calls.zoom=value;this.options.onGesture?.();}
  project(coordinate){return{x:coordinate[0]*2,y:-coordinate[1]*2};}
  destroy(){calls.destroy++;this.canvas.remove();this.markers.remove();}
 }
 const context={RUSSIA_BOUNDS,russiaCamera,displayGeoJSON,inRussiaCoverage,russiaLongitude,
  navigator:{onLine:online},window:{matchMedia:()=>({matches:coarse})},coverage:null,selected:null,reduced:false,
  byId:id=>nodes[id],cameraView:()=>view,
  document:{querySelector:selector=>selector==='.map-tools'?tools:undefined,createElementNS:()=>new Element()},
  mapVisible:value=>calls.visible.push(value),status:value=>{calls.status.push(value);nodes['map-status'].textContent=value;},
  coveredBounds:data=>coveredRussiaBounds(routeCoordinates(data),context.coverage),
  observeMap:callback=>{resize=callback;return()=>{calls.observerStops++;};},
  importEngine:async path=>{calls.imports.push(path);if(importFails)throw new Error('Custom bundle unavailable');return {CustomMapEngine};},
 };
 const promise=vm.runInNewContext(start.replace("import('/custom-map/map-runtime.js')","importEngine('/custom-map/map-runtime.js')")+'\ncreateMap()',context);
 // Attach before yielding so a deliberately rejected startup remains handled.
 const outcome=promise.then(value=>({value}),error=>({error}));
 await tick();
 return {calls,context,nodes,wrapper,get engine(){return instances.at(-1);},outcome,
  resize:camera=>{if(camera)view={...view,camera};resize?.();},
  updateCoverage:status=>{session.status=status;subscriber?.(session);}};
}

test('every offline device starts the same own engine and reveals geography only after its first painted frame',async()=>{
 for(const coarse of [true,false]){
  const env=await launch({coarse,online:false}),{value:driver,error}=await env.outcome;
  assert.ifError(error);assert.ok(driver);
  assert.deepEqual(env.calls.imports,['/custom-map/map-runtime.js']);assert.deepEqual(env.calls.visible,[false]);
  env.engine.options.onFrame(env.engine.camera);assert.deepEqual(env.calls.visible,[false,true]);
  assert.ok(env.calls.obstacles[0].some(rect=>rect.left===24&&rect.top===24),'labels avoid the actual status panel in local CSS coordinates');
  driver.destroy();
 }
 assert.match(viewer,/href="\/custom-map\/map\.css"/);
 assert.doesNotMatch(viewer,/maplibre|leaflet|protomaps/i);
 assert.doesNotMatch(source,/maplibre|leaflet|protomaps/i);
});

test('missing runtime or geographic coverage rejects startup without a ready map or a second map implementation',async()=>{
 const missing=await launch({importFails:true});assert.match((await missing.outcome).error.message,/bundle unavailable/);
 assert.equal(missing.engine,undefined);assert.deepEqual(missing.calls.visible,[false]);
 const coverage=await launch({startupError:'Coverage unavailable'});assert.match((await coverage.outcome).error.message,/Coverage unavailable/);
 assert.equal(coverage.calls.destroy,1);assert.deepEqual(coverage.calls.visible,[false]);
});

test('saved source line parts retain exact coordinates and identity; outside coverage never causes an invented camera fit',async()=>{
 const env=await launch(),{value:driver}=await env.outcome;
 env.context.selected={id:'saved-chukotka'};
 const geometry={type:'MultiLineString',coordinates:[[[179,60],[-179,60.2]],[[-178,61],[-177,61.1]]]},original=structuredClone(geometry);
 driver.draw(geometry);
 const actual=env.calls.routes[0];assert.equal(actual.id,'saved-chukotka');
 assert.equal(actual.geometry.type,'MultiLineString');assert.equal(actual.geometry.coordinates.length,2);
 assert.deepEqual(copy(actual.geometry.coordinates),[[[179,60],[181,60.2]],[[182,61],[183,61.1]]]);
 assert.deepEqual(geometry,original);assert.deepEqual(env.calls.fit[0].bounds,[179,60,183,61.1]);
 driver.draw({type:'LineString',coordinates:[[0,0],[1,1]]});
 assert.equal(env.calls.fit.length,1);assert.match(env.calls.status.at(-1),/нет точек внутри покрытия/);
 driver.draw(null);assert.equal(env.calls.routes.at(-1).geometry,undefined);assert.equal(env.wrapper.dataset.mapRoute,'none');
 driver.destroy();
});

test('geolocation preserves the continuous Russian world and rejects a location outside actual coverage',async()=>{
 const env=await launch(),{value:driver}=await env.outcome;
 assert.equal(driver.locate({coords:{longitude:-179,latitude:60}}),true);
 assert.deepEqual(env.calls.markers[0][0].coordinate,[181,60]);assert.equal(env.calls.markers[0][0].kind,'position');
 assert.equal(env.calls.cameras[0].camera.zoom,13);
 assert.equal(driver.locate({coords:{longitude:0,latitude:0}}),false);assert.equal(env.calls.cameras.length,1);
 driver.destroy();
});

test('the pilot keeps real relief/path layers, its geographic package outline, and the selected source route',async()=>{
 const env=await launch(),{value:driver}=await env.outcome;
 env.context.selected={id:'pilot-line',geometry:{type:'LineString',coordinates:[[40.32,43.7],[40.40,43.75]]}};
 await driver.pilot();
 assert.deepEqual(env.calls.layers,[{paths:true,boundaries:true,relief:true}]);assert.equal(env.calls.modes[0],'detail');
 assert.deepEqual(env.calls.fit[0].bounds,[40.29,43.64,40.49,43.82]);
 assert.equal(env.calls.routes.at(-1).id,'pilot-line');
 const outline=env.nodes.map.children.find(node=>node.firstElementChild);
 assert.ok(outline);assert.equal(outline.style.pointerEvents,'none');
 assert.equal(outline.firstElementChild.attributes.points,'80.58,-87.28 80.98,-87.28 80.98,-87.64 80.58,-87.64');
 env.engine.options.onFrame();assert.ok(outline.firstElementChild.attributes.points);
 driver.destroy();assert.equal(outline.removed,true);
});

test('layout changes update safe insets and label obstacles without resetting a manual route view',async()=>{
 const env=await launch(),{value:driver}=await env.outcome;
 env.engine.options.onGesture();
 env.resize({center:[100,45],zoom:1});assert.equal(env.calls.fit.length,0);
 assert.deepEqual(env.calls.floors.at(-1),{center:[100,45],zoom:1});
 driver.overview();assert.deepEqual(env.calls.fit.at(-1).bounds,[...RUSSIA_BOUNDS[0],...RUSSIA_BOUNDS[1]]);
 const fits=env.calls.fit.length;
 env.resize({center:[101,46],zoom:1.1});assert.equal(env.calls.fit.length,fits+1);
 env.resize({center:[101,46],zoom:1.1});assert.equal(env.calls.fit.length,fits+1,'unchanged geometry cannot refit on status mutations');
 driver.destroy();
});

test('detailed coverage failures keep the usable map; cleanup removes subscriptions and ignores late frames',async()=>{
 const env=await launch(),{value:driver}=await env.outcome;
 env.updateCoverage({error:'not saved',pending:false});assert.match(env.calls.status.at(-1),/сохранён только обзор/);
 env.updateCoverage({error:null,pending:false});assert.equal(env.calls.status.at(-1),'Подробные контуры загружены.');
 env.engine.options.onState({error:'A detail tile unavailable'});assert.equal(env.calls.status.at(-1),'A detail tile unavailable');
 assert.equal(env.calls.destroy,0);
 driver.destroy();driver.destroy();
 assert.equal(env.calls.destroy,1);assert.equal(env.calls.observerStops,1);assert.equal(env.calls.coverageStops,1);
 env.engine.options.onFrame();assert.deepEqual(env.calls.visible,[false]);
});
