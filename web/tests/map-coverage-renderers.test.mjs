import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {createMapLibreCoverage,createCanvasCoverage} from '../public/maps/map-coverage-renderers.js';
import {bindMapCoverage} from '../public/maps/map-coverage-lod.js';

const require=createRequire(import.meta.url),document={documentElement:{style:{}},createElement:()=>({style:{},getContext:()=>({})})};
const navigator={userAgent:'Node coverage renderer test',platform:'Linux'},window={document,navigator,devicePixelRatio:1,screen:{},addEventListener(){},removeEventListener(){}},leaflet={exports:{}};
vm.runInNewContext(readFileSync(require.resolve('leaflet/dist/leaflet-src.js'),'utf8'),{document,navigator,window,module:leaflet,exports:leaflet.exports,setTimeout:()=>0,clearTimeout(){},console});
const L=leaflet.exports;
const polygon=x=>({type:'Polygon',coordinates:[[[x,50],[x+1,50],[x+1,51],[x,51],[x,50]]]});
const cell=(id,x)=>['area','mask','territory','territory-boundary'].map(role=>({type:'Feature',id:`${id}:${role}`,properties:{cell:id,role,shapeName:'Source'},geometry:role==='territory-boundary'?{type:'LineString',coordinates:[[x+.2,50.1],[x+.8,50.7]]}:polygon(x)}));

function canvasMap(){
  const attached=new Set();
  const map=Object.assign(Object.create(L.Map.prototype),{
    options:{preferCanvas:true},_paneRenderers:{},hasLayer:layer=>attached.has(layer),
    addLayer(layer){
      if(attached.has(layer))return this;
      attached.add(layer);layer._map=this;
      if(layer instanceof L.Renderer){layer._bounds=L.bounds([-1000,-1000],[1000,1000]);layer._requestRedraw=()=>{};}
      else if(layer instanceof L.LayerGroup)layer.onAdd(this);
      else{layer.beforeAdd(this);layer.onAdd(this);}
      return this;
    },
    removeLayer(layer){
      if(!attached.has(layer))return this;
      layer.onRemove(this);attached.delete(layer);layer._map=undefined;return this;
    },
    latLngToLayerPoint:latlng=>L.point((latlng.lng-20)*100,(latlng.lat-50)*100),
  });
  return{map,paths:()=>[...attached].filter(layer=>!(layer instanceof L.Renderer))};
}

test('actual Leaflet cell layers retain geometry and never outline a clipping perimeter',()=>{
  const {map,paths}=canvasMap();
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
  drawing.destroy();assert.equal(paths().length,0);
});

test('actual Leaflet Canvas selects a territory through its decorative boundary',()=>{
  const {map,paths}=canvasMap();
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
  drawing.destroy();assert.equal(paths().length,0);
});

// Use the pinned SDK's public GeoJSONSource, actual UpdateQueue and diff merger.
// Only the worker transport is deferred, so error/flush and queued-diff behavior
// match the shipped SDK rather than a synchronous imitation of setData.
const sdkSource=readFileSync(new URL('../node_modules/maplibre-gl/dist/maplibre-gl-dev.mjs',import.meta.url),'utf8');
const sdk=await import('data:text/javascript;base64,'+Buffer.from(sdkSource+
  '\nexport {applySourceDiff,toUpdateable};\n//# sourceURL=maplibre-coverage-test.mjs\n').toString('base64'));
const fc=features=>({type:'FeatureCollection',features});
const roles={land:'area','russia-mask':'mask',regions:'territories','regions-outline':'boundaries'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function glCoverage(cells,{canonicalMask=false}={}){
  const cellFeatures=new Map(cells),features=[...cellFeatures.values()].flat();
  const role=name=>features.filter(feature=>feature.properties.role===name);
  const shift=coordinates=>typeof coordinates[0]==='number'?[coordinates[0]-360,coordinates[1]]:coordinates.map(shift);
  return {cellFeatures,area:fc(role('area')),territories:fc(role('territory')),boundaries:fc(role('territory-boundary')),
    mask:fc(role('mask').map(feature=>canonicalMask?{...feature,geometry:{...feature.geometry,coordinates:shift(feature.geometry.coordinates)}}:feature))};
}
function glHarness(){
  const listeners=new Map(),sources=new Map(),waiting=[],calls=[],submissions=[],workers=new Map(),unloadedTiles=new Set();
  const map={getSource:id=>sources.get(id),isSourceLoaded:id=>sources.get(id)?.loaded()&&!unloadedTiles.has(id),
    getBounds:()=>({getWest:()=>20,getSouth:()=>50,getEast:()=>21,getNorth:()=>51}),getZoom:()=>3,
    on(type,callback){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(callback);},
    off(type,callback){listeners.get(type)?.delete(callback);}};
  const addSource=id=>{
    let source;
    const actor={sendAsync:message=>new Promise((resolve,reject)=>{
      const request={source,id,payload:message.data,resolve,reject};waiting.push(request);calls.push(request);
    })};
    source=new sdk.GeoJSONSource(id,{type:'geojson',data:fc([]),tolerance:0,maxzoom:18},{getActor:()=>Promise.resolve(actor)});
    for(const method of ['setData','updateData']){
      const original=source[method];
      source[method]=function(value){const promise=original.call(this,value);submissions.push({id,source,method,value,promise});return promise;};
    }
    workers.set(source,{});sources.set(id,source);return source;
  };
  for(const id of Object.keys(roles))addSource(id);
  const complete=(request,error)=>{
    if(error){request.reject(error);return;}
    try{
      const state=workers.get(request.source),payload=request.payload;
      if(payload.data){state.data=payload.data;state.features=sdk.toUpdateable(payload.data);}
      else if(payload.dataDiff){
        if(!state.features)throw new Error('worker-missing-base');
        sdk.applySourceDiff(state.features,payload.dataDiff);state.data=fc([...state.features.values()]);
      }
      request.resolve({});
    }catch(failure){request.reject(failure);}
  };
  const drain=async()=>{
    await tick();let batches=0;
    while(waiting.length){assert.ok(++batches<20,'worker queue should settle');for(const request of waiting.splice(0))complete(request);await tick();}
  };
  return {map,sources,addSource,waiting,calls,submissions,workers,unloadedTiles,complete,drain,
    emit(type){for(const callback of [...(listeners.get(type)??[])])callback();},
    count:()=>[...listeners.values()].reduce((sum,set)=>sum+set.size,0)};
}
async function finish(h,job){await h.drain();h.emit('render');await job;}
const ordered=features=>[...features].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
async function assertData(h,coverage){
  for(const [id,role] of Object.entries(roles)){
    assert.deepEqual(ordered((await h.sources.get(id).getData()).features),ordered(coverage[role].features),id);
    assert.deepEqual(ordered(h.workers.get(h.sources.get(id)).data.features),ordered(coverage[role].features),`${id} worker`);
    const specification=h.sources.get(id).serialize();assert.equal(specification.tolerance,0);assert.equal(specification.maxzoom,18);
  }
}

test('MapLibre coverage readiness requires worker completion, all source tiles and a rendered frame',async()=>{
  const h=glHarness(),renderer=createMapLibreCoverage(h.map),coverage=glCoverage([['a',cell('a',20)]]);
  let finished=false;const job=renderer.apply(coverage).then(()=>finished=true);
  await h.drain();assert.equal(finished,false,'worker flush alone is not a rendered frame');
  h.unloadedTiles.add('regions-outline');h.emit('render');await tick();assert.equal(finished,false);
  h.unloadedTiles.clear();h.emit('render');await job;assert.equal(finished,true);
  await assertData(h,coverage);renderer.destroy();assert.equal(h.count(),0);
  assert.ok([...h.sources.values()].every(source=>!source.listens('error')));
});

test('incremental coverage sends only changed cells and retains exact composed mask and feature data',async()=>{
  const h=glHarness(),renderer=createMapLibreCoverage(h.map),a=cell('a',180),b=cell('b',185);
  for(const feature of a)feature.properties.oldProperty='remove me';
  const initial=glCoverage([['a',a],['b',b]],{canonicalMask:true});await finish(h,renderer.apply(initial));
  const changed=cell('a',180.1);changed[0].geometry.coordinates.push([[180.3,50.2],[180.5,50.2],[180.5,50.4],[180.3,50.4],[180.3,50.2]]);
  changed[0].properties.newProperty='full feature replacement';changed[0].foreignMember={preserved:true};
  const next=glCoverage([['a',changed],['b',b]],{canonicalMask:true}),start=h.submissions.length;
  await finish(h,renderer.apply(next));
  for(const operation of h.submissions.slice(start)){
    assert.equal(operation.method,'updateData');assert.equal(operation.value.add.length,1);
    assert.ok(operation.value.add.every(feature=>feature.properties.cell==='a'));
    assert.deepEqual(operation.value.remove,[]);
  }
  assert.ok(h.submissions.slice(start).find(operation=>operation.id==='russia-mask').value.add[0].geometry.coordinates[0][0][0]<0,'mask additions use canonical, not raw cell coordinates');
  await assertData(h,next);renderer.destroy();
});

test('queued coverage revisions diff against the last submission and compose through the real SDK queue',async()=>{
  const h=glHarness(),renderer=createMapLibreCoverage(h.map),a=cell('a',20),b=cell('b',25);
  const initial=glCoverage([['a',a],['b',b]]),first=renderer.apply(initial);await tick();
  const middleCell=cell('a',20.1);middleCell.push({...middleCell[0],id:'a:extra-area'});
  const middle=renderer.apply(glCoverage([['a',middleCell],['b',b]]));
  const final=glCoverage([['a',a],['b',cell('b',25.1)]]),last=renderer.apply(final);
  await h.drain();h.emit('render');await Promise.all([first,middle,last]);
  assert.equal(h.submissions.filter(operation=>operation.method==='setData').length,4);
  assert.ok(h.calls.filter(request=>request.payload.dataDiff).every(request=>request.payload.dataDiff.add.some(feature=>feature.properties.cell==='a')),'reverting A must not be mistaken for unchanged confirmed data');
  await assertData(h,final);renderer.destroy();
});

test('unchanged cells reuse a pending barrier, then resolve without scheduling a new render',async()=>{
  const h=glHarness(),renderer=createMapLibreCoverage(h.map),a=cell('a',180),initial=glCoverage([['a',a]],{canonicalMask:true});
  const first=renderer.apply(initial);let reused=false;
  const pending=renderer.apply(glCoverage([['a',a]],{canonicalMask:true})).then(()=>reused=true);
  await h.drain();assert.equal(reused,false);h.emit('render');await Promise.all([first,pending]);
  const count=h.submissions.length;await renderer.apply(glCoverage([['a',a]],{canonicalMask:true}));
  assert.equal(h.submissions.length,count,'canonical mask wrappers do not resend unchanged cell geometry');renderer.destroy();
});

test('missing or duplicate feature IDs and unsupported diff APIs use full data without dropping features',async()=>{
  const h=glHarness(),renderer=createMapLibreCoverage(h.map),a=cell('a',20);
  h.sources.get('regions').updateData=undefined;
  await finish(h,renderer.apply(glCoverage([['a',a]])));
  const changed=cell('a',20.1);delete changed[0].id;changed.push({...changed[1]});
  const next=glCoverage([['a',changed]]),start=h.submissions.length;await finish(h,renderer.apply(next));
  const operations=new Map(h.submissions.slice(start).map(operation=>[operation.id,operation]));
  for(const id of ['land','russia-mask','regions'])assert.equal(operations.get(id).method,'setData',id);
  assert.equal(operations.get('regions-outline').method,'updateData');
  await assertData(h,next);renderer.destroy();
});

test('a worker error rejects all dependent revisions even though SDK flush resolves and sources become loaded',async()=>{
  const h=glHarness(),renderer=createMapLibreCoverage(h.map),first=renderer.apply(glCoverage([['a',cell('a',20)]]));
  const firstRejected=assert.rejects(first,/worker-failed/);await tick();
  const next=glCoverage([['a',cell('a',20.1)]]),second=renderer.apply(next),secondRejected=assert.rejects(second,/worker-failed/);
  const failed=h.waiting.splice(h.waiting.findIndex(request=>request.id==='land'),1)[0];h.complete(failed,new Error('worker-failed'));
  await h.drain();h.emit('render');await Promise.all([firstRejected,secondRejected]);
  assert.ok([...h.sources.keys()].every(id=>h.map.isSourceLoaded(id)));
  assert.ok((await Promise.allSettled(h.submissions.map(operation=>operation.promise))).every(result=>result.status==='fulfilled'),'the actual SDK flush promise does not report worker failure');
  const start=h.submissions.length;await finish(h,renderer.apply(next));
  assert.equal(h.submissions.slice(start).find(operation=>operation.id==='land').method,'setData','failed optimistic chain requires a complete replacement');
  await assertData(h,next);renderer.destroy();
});

test('DOM coverage readiness stays false after a source error even after flush and render',async()=>{
  const h=glHarness(),renderer=createMapLibreCoverage(h.map),coverage=Object.assign(glCoverage([['a',cell('a',20)]]),{
    status:{version:'fixture',lod:'overview',cells:[],pending:0,error:'',ready:true,revision:0},
    subscribe:()=>()=>{},updateView:async()=>{},dispose(){},
  }),element={dataset:{}};
  const unbind=bindMapCoverage(h.map,coverage,element,renderer.apply);await tick();
  const failed=h.waiting.splice(h.waiting.findIndex(request=>request.id==='land'),1)[0];h.complete(failed,new Error('worker-failed'));
  await h.drain();h.emit('render');await tick();
  assert.equal(h.map.isSourceLoaded('land'),true);assert.equal(element.dataset.mapCoverageReady,'false');assert.equal(element.dataset.mapCoverageError,'coverage-render');
  unbind();renderer.destroy();assert.equal(h.count(),0);
});

test('a replaced source gets full data and a late error from the discarded object cannot poison it',async()=>{
  const h=glHarness(),renderer=createMapLibreCoverage(h.map),coverage=glCoverage([['a',cell('a',20)]]);
  const first=renderer.apply(coverage),rejected=assert.rejects(first,/coverage-render-removed/);await tick();
  const old=h.sources.get('land');old.on('error',()=>{});const replacement=h.addSource('land');
  const next=renderer.apply(coverage);
  const failed=h.waiting.splice(h.waiting.findIndex(request=>request.source===old),1)[0];h.complete(failed,new Error('old-source-failed'));
  await finish(h,next);await rejected;
  assert.equal(h.submissions.find(operation=>operation.source===replacement).method,'setData');
  await assertData(h,coverage);renderer.destroy();
});

test('style reset forces full data and a late error on a reused source conservatively invalidates the new epoch',async()=>{
  const h=glHarness(),renderer=createMapLibreCoverage(h.map),coverage=glCoverage([['a',cell('a',20)]]);
  const first=renderer.apply(coverage),firstRejected=assert.rejects(first,/coverage-render-removed/);await tick();
  h.emit('style.load');const start=h.submissions.length,next=renderer.apply(coverage),nextRejected=assert.rejects(next,/old-style-failed/);
  assert.ok(h.submissions.slice(start).every(operation=>operation.method==='setData'));
  const failed=h.waiting.splice(h.waiting.findIndex(request=>request.id==='land'),1)[0];h.complete(failed,new Error('old-style-failed'));
  await h.drain();h.emit('render');await Promise.all([firstRejected,nextRejected]);
  await finish(h,renderer.apply(coverage));await assertData(h,coverage);renderer.destroy();assert.equal(h.count(),0);
});

test('map removal cancels pending readiness and releases map and source listeners',async()=>{
  const h=glHarness(),renderer=createMapLibreCoverage(h.map),job=renderer.apply(glCoverage([['a',cell('a',20)]]));
  const rejected=assert.rejects(job,/coverage-render-removed/);h.emit('remove');await rejected;
  assert.equal(h.count(),0);assert.ok([...h.sources.values()].every(source=>!source.listens('error')));
  await h.drain();await assert.rejects(renderer.apply(glCoverage([])),/coverage-render-removed/);
});
